import { existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ClaudeLauncher {
  command: string
  resolved: boolean
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function fromWhere(): string[] {
  if (process.platform !== 'win32') {
    try {
      const output = execFileSync('which', ['claude'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 2000
      })
      return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }

  return windowsClaudeCandidates(process.env.PATH ?? '')
}

export function windowsClaudeCandidates(pathValue: string): string[] {
  // Resolving PATH directly avoids four synchronous where.exe processes on
  // every terminal launch, including when the native CLI is already installed.
  const directories = pathValue.split(';').map((dir) => dir.trim().replace(/^"|"$/g, '')).filter(Boolean)
  return directories.flatMap((dir) =>
    ['claude.exe', 'claude.cmd', 'claude.bat', 'claude'].map((name) => join(dir, name))
  ).filter(isFile)
}

function priority(path: string): number {
  const lower = path.toLowerCase()
  if (lower.endsWith('.exe')) return 0
  if (lower.endsWith('.cmd')) return 1
  if (lower.endsWith('.bat')) return 2
  if (lower.endsWith('.ps1')) return 4
  return 3
}

export function resolveClaudeLauncher(): ClaudeLauncher {
  const configured = process.env.CLAUDE_CLI_PATH?.trim()
  if (configured && isFile(configured)) {
    const command =
      process.platform === 'win32'
        ? configured.replace(/\//g, '\\')
        : configured
    return { command, resolved: true }
  }

  const home = homedir()
  const isWindows = process.platform === 'win32'
  const names = isWindows
    ? ['claude.exe', 'claude.cmd', 'claude', 'claude.bat']
    : ['claude']
  const candidates = [
    ...names.map((name) => join(home, '.local', 'bin', name)),
    ...names.map((name) => join(home, '.claude', 'local', name)),
    ...(isWindows && process.env.APPDATA
      ? names.map((name) => join(process.env.APPDATA!, 'npm', name))
      : []),
    ...(isWindows && process.env.ProgramFiles
      ? names.map((name) => join(process.env.ProgramFiles!, 'nodejs', name))
      : []),
    ...(isWindows && process.env.LOCALAPPDATA
      ? names.map((name) =>
          join(process.env.LOCALAPPDATA!, 'Programs', 'claude', name)
        )
      : [])
  ]

  const seen = new Set<string>()
  const matches = [...candidates, ...fromWhere()]
    .filter((path) => {
      const key = path.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return isFile(path)
    })
    .sort((a, b) => priority(a) - priority(b))

  if (matches.length > 0) {
    return { command: matches[0], resolved: true }
  }

  return { command: 'claude', resolved: false }
}

export function resolveClaudeExecutable(): string {
  return resolveClaudeLauncher().command
}

/**
 * node-pty calls CreateProcess directly and cannot execute npm's .cmd shims.
 * Wrap those in cmd.exe; .exe launches are passed through unchanged.
 */
export function buildClaudeLaunch(
  command: string,
  args: string[]
): { file: string; args: string[] } {
  if (
    process.platform === 'win32' &&
    /\.(cmd|bat)$/i.test(command)
  ) {
    const comspec = process.env.ComSpec || 'cmd.exe'
    return {
      file: comspec,
      args: ['/c', command, ...args]
    }
  }
  return { file: command, args }
}

export const CLAUDE_CLI_HINT =
  '未找到 Windows 版 Claude Code CLI。请先在当前 Windows 用户下安装 Claude Code，' +
  '并确认在命令提示符执行 claude 能正常启动；' +
  '如果安装在非标准位置，请设置环境变量 CLAUDE_CLI_PATH 指向 claude.exe 或 claude.cmd。' +
  '如果 claude 只安装在 WSL 中，Windows 应用无法直接使用它。'
