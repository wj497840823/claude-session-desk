import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { spawn, type IPty } from 'node-pty'
import type { BrowserWindow } from 'electron'
import type {
  TerminalActivityEvent,
  TerminalExitEvent,
  TerminalStartOptions,
  TerminalStartResult
} from '@shared/types'
import { IPC } from '@shared/ipc'
import { TerminalActivityTracker, stripAnsi } from './terminalActivity'
import type { TerminalActivity } from './terminalActivity'
import { buildHookSettings, hookEventToActivity, permissionHookOutput } from './hookActivity'
import type { HookRelayLike } from './hookRelay'
import { approvalInputFromHook, type ApprovalBroker } from './approvalBroker'
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
  delete env.CLAUDECODE
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
  // Hook relay traffic goes to loopback; never let a configured proxy carry it.
  const existingNoProxy = env.NO_PROXY ?? env.no_proxy ?? ''
  const noProxy = [...new Set(
    [...existingNoProxy.split(',').map((item) => item.trim()), '127.0.0.1', 'localhost']
      .filter(Boolean)
  )].join(',')
  env.NO_PROXY = noProxy
  env.no_proxy = noProxy
  return env
}

export class TerminalService {
  private readonly sessions = new Map<string, IPty>()
  private readonly sessionIds = new Map<string, string>()
  private readonly activities = new Map<string, TerminalActivityTracker>()
  private readonly hookPhases = new Map<string, TerminalActivity>()
  private readonly titles = new Map<string, string>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly fileContexts = new Map<string, FileScope>()
  private hookRelay: HookRelayLike | null = null
  private approvalBroker: ApprovalBroker | null = null
  private scheduledSessionGuard: ((sessionId: string) => boolean) | null = null

  getFileContext(sessionId: string): FileScope | undefined {
    return this.fileContexts.get(sessionId)
  }

  setHookRelay(relay: HookRelayLike | null): void {
    this.hookRelay = relay
  }

  setApprovalBroker(broker: ApprovalBroker | null): void {
    this.approvalBroker = broker
  }

  setScheduledSessionGuard(guard: ((sessionId: string) => boolean) | null): void {
    this.scheduledSessionGuard = guard
  }

  hasSession(sessionId: string): boolean {
    for (const value of this.sessionIds.values()) {
      if (value === sessionId) return true
    }
    return false
  }

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly onActivity?: (event: TerminalActivityEvent & { title: string }) => void
  ) {}

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

    if (options.sessionId && this.scheduledSessionGuard?.(options.sessionId)) {
      return { ok: false, message: '该会话正在被定时任务使用，请等待运行结束后再打开' }
    }

    const ptyId = randomUUID()
    const sessionId = options.sessionId ?? options.newSessionId
    const hookUrl = this.hookRelay?.urlFor(ptyId) ?? null

    let args: string[]
    try {
      args = buildClaudeTerminalArgs(
        options,
        hookUrl ? { settingsJson: JSON.stringify(buildHookSettings(hookUrl)) } : undefined
      )
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }

    const launcher = resolveClaudeLauncher()
    if (!launcher.resolved) {
      return { ok: false, message: CLAUDE_CLI_HINT }
    }

    try {
      if (hookUrl && sessionId) {
        this.hookRelay?.register(ptyId, (event) => this.handleHookEvent(ptyId, sessionId, event))
      }
      const launch = buildClaudeLaunch(launcher.command, args)
      const child = spawn(launch.file, launch.args, {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd,
        env: terminalEnv(),
        useConpty: true,
        // The system ConPTY can consume the synchronized-output probe and
        // forward a frame's end marker before its buffered screen writes.
        useConptyDll: process.platform === 'win32'
      })

      this.sessions.set(ptyId, child)
      if (sessionId) this.sessionIds.set(ptyId, sessionId)
      if (sessionId) this.fileContexts.set(sessionId, { sessionId, cwd })
      if (options.title) this.titles.set(ptyId, options.title)
      if (sessionId) {
        this.activities.set(ptyId, new TerminalActivityTracker({
          onChange: (activity) => {
            const event: TerminalActivityEvent = { ptyId, sessionId, activity }
            this.send(IPC.terminalActivity, event)
            this.onActivity?.({ ...event, title: this.titles.get(ptyId) ?? 'Claude 对话' })
          }
        }))
      }

      child.onData((data) => {
        this.activities.get(ptyId)?.push(data)
        this.send(IPC.terminalData, { ptyId, data })
      })
      child.onExit(({ exitCode, signal }) => {
        this.releasePty(ptyId)
        this.titles.delete(ptyId)
        this.sessions.delete(ptyId)
        this.sessionIds.delete(ptyId)
        const event: TerminalExitEvent = { ptyId, exitCode, signal }
        this.send(IPC.terminalExit, event)
      })

      return { ok: true, ptyId, cwd }
    } catch (error) {
      this.releasePty(ptyId)
      const detail = errorMessage(error)
      const hint =
        /code:\s*2|ENOENT|not found/i.test(detail) ? ` ${CLAUDE_CLI_HINT}` : ''
      return {
        ok: false,
        message: `启动 Claude 终端失败：${detail}（CLI: ${launcher.command}）${hint}`
      }
    }
  }

  private releasePty(ptyId: string): void {
    this.hookRelay?.unregister(ptyId)
    this.approvalBroker?.cancelForPty(ptyId)
    this.hookPhases.delete(ptyId)
    this.activities.get(ptyId)?.dispose()
    this.activities.delete(ptyId)
  }

  private applyActivity(ptyId: string, sessionId: string, activity: TerminalActivity): void {
    if (this.hookPhases.get(ptyId) === activity) return
    this.hookPhases.set(ptyId, activity)
    const event: TerminalActivityEvent = { ptyId, sessionId, activity }
    this.send(IPC.terminalActivity, event)
    this.onActivity?.({ ...event, title: this.titles.get(ptyId) ?? 'Claude 对话' })
  }

  private async handleHookEvent(
    ptyId: string,
    sessionId: string,
    event: unknown
  ): Promise<unknown> {
    const activity = hookEventToActivity(event)
    // Only a recognized hook event proves hooks are live. An unknown or
    // malformed payload must not disable the PTY-based fallback.
    if (!activity) return undefined
    const tracker = this.activities.get(ptyId)
    if (tracker) {
      tracker.dispose()
      this.activities.delete(ptyId)
    }
    this.applyActivity(ptyId, sessionId, activity)

    if (activity !== 'approval' || !this.approvalBroker) return undefined
    const input = approvalInputFromHook(
      event,
      ptyId,
      sessionId,
      this.titles.get(ptyId) ?? 'Claude 对话'
    )
    if (!input) return undefined
    const decision = await this.approvalBroker.request(input)
    // While waiting, the terminal stays in "approval"; once a decision is made
    // Claude resumes work (an allow continues the tool call, a deny continues
    // the turn).
    if (decision) this.applyActivity(ptyId, sessionId, 'working')
    return permissionHookOutput(decision)
  }

  private noteHookInput(ptyId: string, data: string): void {
    const phase = this.hookPhases.get(ptyId)
    const sessionId = this.sessionIds.get(ptyId)
    if (!phase || !sessionId) return
    const clean = stripAnsi(data)
    // A bare Esc arrives as a single byte; an Esc followed by a character is
    // an Alt/Meta shortcut and must not be mistaken for an interrupt.
    const escape = clean === '\x1b'
    if (phase === 'approval' && (/[\r\n]/.test(clean) || escape)) {
      this.applyActivity(ptyId, sessionId, 'working')
    } else if (phase === 'working' && (escape || clean.includes('\x03'))) {
      this.applyActivity(ptyId, sessionId, 'idle')
    }
  }

  write(ptyId: string, data: unknown): void {
    if (typeof data !== 'string') throw new Error('非法终端输入')
    if (data.length > 1024 * 1024) throw new Error('终端输入过大')
    const child = this.sessions.get(ptyId)
    if (!child) throw new Error('终端不存在或已结束')
    const tracker = this.activities.get(ptyId)
    if (tracker) tracker.noteInput(data)
    else this.noteHookInput(ptyId, data)
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
    const child = this.sessions.get(ptyId)
    if (child && (child.cols !== columns || child.rows !== terminalRows)) child.resize(columns, terminalRows)
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
        this.releasePty(ptyId)
        this.titles.delete(ptyId)
      }).finally(() => this.stopping.delete(ptyId))
      this.stopping.set(ptyId, operation)
      return operation
    } else {
      child.kill()
      this.sessions.delete(ptyId)
      this.sessionIds.delete(ptyId)
      this.releasePty(ptyId)
      this.titles.delete(ptyId)
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
      if (child) {
        try {
          if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore', windowsHide: true, timeout: 2000
          })
          else child.kill()
        } catch { /* process may already have exited */ }
      }
      this.releasePty(ptyId)
    }
    this.sessions.clear()
    this.sessionIds.clear()
    this.fileContexts.clear()
    this.activities.clear()
    this.hookPhases.clear()
    this.titles.clear()
  }
}
