import type {
  TerminalPermissionMode,
  TerminalStartOptions
} from '@shared/types'
import { SESSION_ID_RE } from './validation'

export const TERMINAL_MODES: TerminalPermissionMode[] = [
  'follow',
  'manual',
  'auto',
  'acceptEdits',
  'plan',
  'dontAsk'
]

export function isTerminalPermissionMode(
  value: unknown
): value is TerminalPermissionMode {
  return (
    typeof value === 'string' &&
    (TERMINAL_MODES as string[]).includes(value)
  )
}

export interface TerminalArgInjection {
  settingsJson?: string
}

export function buildClaudeTerminalArgs(
  options: Pick<TerminalStartOptions, 'sessionId' | 'newSessionId' | 'forkFromSessionId' | 'mode'>,
  injection: TerminalArgInjection = {}
): string[] {
  if (!isTerminalPermissionMode(options.mode)) {
    throw new Error('非法权限模式')
  }
  if (options.sessionId && !SESSION_ID_RE.test(options.sessionId)) {
    throw new Error('非法会话 ID')
  }
  if (options.newSessionId && (!SESSION_ID_RE.test(options.newSessionId) || options.sessionId)) {
    throw new Error('非法新会话 ID')
  }
  if (options.forkFromSessionId) {
    if (!SESSION_ID_RE.test(options.forkFromSessionId)) throw new Error('非法分叉来源会话 ID')
    if (!options.newSessionId) throw new Error('分叉会话缺少新会话 ID')
  }

  const args: string[] = []
  if (options.forkFromSessionId) {
    // Claude Code relaunches forks with this exact combination: the new id is
    // preallocated so the app can track the fork before Claude writes it.
    args.push('--session-id', options.newSessionId!, '--fork-session', '--resume', options.forkFromSessionId)
  } else if (options.sessionId) args.push('--resume', options.sessionId)
  else if (options.newSessionId) args.push('--session-id', options.newSessionId)
  if (options.mode !== 'follow') {
    args.push('--permission-mode', options.mode)
  }
  if (injection.settingsJson) args.push('--settings', injection.settingsJson)
  return args
}

export function normalizeTerminalOptions(value: unknown): TerminalStartOptions {
  if (!value || typeof value !== 'object') throw new Error('非法终端参数')
  const options = value as Record<string, unknown>
  if (typeof options.cwd !== 'string' || !options.cwd) {
    throw new Error('非法项目路径')
  }
  if (
    !Number.isInteger(options.cols) ||
    !Number.isInteger(options.rows) ||
    (options.cols as number) < 20 ||
    (options.cols as number) > 1000 ||
    (options.rows as number) < 5 ||
    (options.rows as number) > 500
  ) {
    throw new Error('非法终端尺寸')
  }
  if (!isTerminalPermissionMode(options.mode)) {
    throw new Error('非法权限模式')
  }
  if (
    options.sessionId !== undefined &&
    options.sessionId !== null &&
    typeof options.sessionId !== 'string'
  ) {
    throw new Error('非法会话 ID')
  }

  if (options.newSessionId !== undefined &&
    (typeof options.newSessionId !== 'string' || !SESSION_ID_RE.test(options.newSessionId) || options.sessionId)) {
    throw new Error('非法新会话 ID')
  }

  if (options.title !== undefined && (typeof options.title !== 'string' || options.title.length > 200)) {
    throw new Error('非法对话标题')
  }

  if (options.forkFromSessionId !== undefined) {
    if (typeof options.forkFromSessionId !== 'string' || !SESSION_ID_RE.test(options.forkFromSessionId)) {
      throw new Error('非法分叉来源会话 ID')
    }
    if (options.newSessionId === undefined) throw new Error('分叉会话缺少新会话 ID')
  }

  return {
    cwd: options.cwd,
    sessionId: (options.sessionId as string | null | undefined) ?? null,
    ...(options.newSessionId !== undefined ? { newSessionId: options.newSessionId as string } : {}),
    ...(options.forkFromSessionId !== undefined ? { forkFromSessionId: options.forkFromSessionId as string } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    mode: options.mode,
    cols: options.cols as number,
    rows: options.rows as number
  }
}
