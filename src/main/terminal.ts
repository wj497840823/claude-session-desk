import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { spawn, type IPty } from 'node-pty'
import type { BrowserWindow } from 'electron'
import type {
  TerminalExitEvent,
  TerminalStartOptions,
  TerminalStartResult
} from '@shared/types'
import { IPC } from '@shared/ipc'
import {
  buildClaudeLaunch,
  CLAUDE_CLI_HINT,
  resolveClaudeLauncher
} from './claudeCli'
import {
  buildClaudeTerminalArgs,
  normalizeTerminalOptions
} from './terminalArgs'
import { isPathInside } from './validation'
import type { FileScope } from './files'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function findGitBash(): string | undefined {
  const configured = process.env.CLAUDE_CODE_GIT_BASH_PATH
  if (configured && existsSync(configured)) return configured

  const candidates = [
    process.env.ProgramFiles
      ? join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe')
      : '',
    process.env['ProgramFiles(x86)']
      ? join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe')
      : '',
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
      : ''
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  try {
    const output = execFileSync('where.exe', ['bash.exe'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2000
    })
    const found = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().endsWith('bash.exe'))
    if (found && existsSync(found)) return found
  } catch {
    // Git Bash is optional.
  }
  return undefined
}

export function terminalEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  delete env.ELECTRON_RUN_AS_NODE
  // Never inherit the parent Claude Code session identity. Otherwise the
  // embedded CLI believes it is a child session and disables transcripts.
  delete env.CLAUDE_CODE_CHILD_SESSION
  delete env.CLAUDE_CODE_SESSION_ID
  delete env.CLAUDE_CODE_PARENT_SESSION_ID
  delete env.CLAUDE_CODE_SESSION_ATTENDED
  delete env.CLAUDE_CODE_MESSAGING_SOCKET
  delete env.CLAUDE_CODE_MESSAGING_TOKEN
  delete env.CLAUDE_CODE_ENTRYPOINT
  delete env.CLAUDE_CODE_EXECPATH
  env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1'
  // Claude's simulated cursor leaves the real cursor parked on the status
  // line. xterm anchors IME composition to that real cursor, so use Claude's
  // native cursor to keep the candidate window beside the input caret.
  env.CLAUDE_CODE_NATIVE_CURSOR = '1'

  if (process.platform === 'win32') {
    const gitBash = findGitBash()
    if (gitBash) env.CLAUDE_CODE_GIT_BASH_PATH = gitBash
  }

  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}

export class TerminalService {
  private readonly sessions = new Map<string, IPty>()
  private readonly sessionIds = new Map<string, string>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly fileContexts = new Map<string, FileScope>()

  getFileContext(sessionId: string): FileScope | undefined {
    return this.fileContexts.get(sessionId)
  }

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  private send(channel: string, payload: unknown): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }

  start(rawOptions: unknown): TerminalStartResult {
    let options: TerminalStartOptions
    try {
      options = normalizeTerminalOptions(rawOptions)
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }

    const cwd = resolve(options.cwd)
    try {
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        return { ok: false, message: '项目文件夹不存在' }
      }
    } catch (error) {
      return { ok: false, message: `无法访问项目文件夹：${errorMessage(error)}` }
    }

    const claudeDir = resolve(homedir(), '.claude')
    if (cwd === claudeDir || isPathInside(claudeDir, cwd)) {
      return { ok: false, message: '不能把 Claude 配置目录作为项目文件夹' }
    }

    let args: string[]
    try {
      args = buildClaudeTerminalArgs(options)
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }

    const launcher = resolveClaudeLauncher()
    if (!launcher.resolved) {
      return { ok: false, message: CLAUDE_CLI_HINT }
    }

    try {
      const ptyId = randomUUID()
      const launch = buildClaudeLaunch(launcher.command, args)
      const child = spawn(launch.file, launch.args, {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd,
        env: terminalEnv(),
        useConpty: true
      })

      this.sessions.set(ptyId, child)
      const sessionId = options.sessionId ?? options.newSessionId
      if (sessionId) this.sessionIds.set(ptyId, sessionId)
      if (sessionId) this.fileContexts.set(sessionId, { sessionId, cwd })

      child.onData((data) => {
        this.send(IPC.terminalData, { ptyId, data })
      })
      child.onExit(({ exitCode, signal }) => {
        this.sessions.delete(ptyId)
        this.sessionIds.delete(ptyId)
        const event: TerminalExitEvent = { ptyId, exitCode, signal }
        this.send(IPC.terminalExit, event)
      })

      return { ok: true, ptyId, cwd }
    } catch (error) {
      const detail = errorMessage(error)
      const hint =
        /code:\s*2|ENOENT|not found/i.test(detail) ? ` ${CLAUDE_CLI_HINT}` : ''
      return {
        ok: false,
        message: `启动 Claude 终端失败：${detail}（CLI: ${launcher.command}）${hint}`
      }
    }
  }

  write(ptyId: string, data: unknown): void {
    if (typeof data !== 'string') throw new Error('非法终端输入')
    if (data.length > 1024 * 1024) throw new Error('终端输入过大')
    const child = this.sessions.get(ptyId)
    if (!child) throw new Error('终端不存在或已结束')
    child.write(data)
  }

  resize(ptyId: string, cols: unknown, rows: unknown): void {
    const columns = Number(cols)
    const terminalRows = Number(rows)
    if (
      !Number.isInteger(columns) ||
      !Number.isInteger(terminalRows) ||
      columns < 20 ||
      columns > 1000 ||
      terminalRows < 5 ||
      terminalRows > 500
    ) {
      throw new Error('非法终端尺寸')
    }
    this.sessions.get(ptyId)?.resize(columns, terminalRows)
  }

  async stop(ptyId: string): Promise<void> {
    const pending = this.stopping.get(ptyId)
    if (pending) return pending
    const child = this.sessions.get(ptyId)
    if (!child) return
    if (process.platform === 'win32') {
      const operation = new Promise<void>((resolveStop, reject) => {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, timeout: 5000
        }, (error) => {
          if (error && this.sessions.has(ptyId)) {
            try { process.kill(child.pid, 0) } catch { resolveStop(); return }
            reject(new Error(`无法结束终端：${error.message}`))
          } else resolveStop()
        })
      }).then(() => {
        if (this.sessions.delete(ptyId)) this.send(IPC.terminalExit, { ptyId, exitCode: 0 })
        this.sessionIds.delete(ptyId)
      }).finally(() => this.stopping.delete(ptyId))
      this.stopping.set(ptyId, operation)
      return operation
    } else {
      child.kill()
      this.sessions.delete(ptyId)
      this.sessionIds.delete(ptyId)
    }
  }

  async stopSessions(sessionIds: string[]): Promise<void> {
    const ids = new Set(sessionIds)
    await Promise.all([...this.sessionIds].filter(([, id]) => ids.has(id))
      .map(([ptyId]) => this.stop(ptyId)))
  }

  dispose(): void {
    for (const ptyId of [...this.sessions.keys()]) {
      const child = this.sessions.get(ptyId)
      if (!child) continue
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true, timeout: 2000
        })
        else child.kill()
      } catch { /* process may already have exited */ }
    }
    this.sessions.clear()
    this.sessionIds.clear()
    this.fileContexts.clear()
  }
}
