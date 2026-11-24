import type { TerminalActivity } from './terminalActivity'
import type { ApprovalDecision } from './approvalBroker'

// Claude Code skips HTTP hooks for SessionStart/Setup, so liveness is proven by
// the first real activity event instead.
const HOOK_EVENTS = [
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'PermissionRequest',
  'PermissionDenied'
] as const

// PermissionRequest keeps the HTTP request open while the user decides. The
// relay always answers before this deadline with either a decision or `{}`.
export const APPROVAL_HOOK_TIMEOUT_SECONDS = 300

export function hookEventName(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null
  const name = (event as { hook_event_name?: unknown }).hook_event_name
  return typeof name === 'string' && name ? name : null
}

export function hookEventToActivity(event: unknown): TerminalActivity | null {
  switch (hookEventName(event)) {
    case 'UserPromptSubmit':
    case 'PermissionDenied':
      return 'working'
    case 'Stop':
    case 'StopFailure':
      return hasPendingBackgroundWork(event) ? 'background' : 'idle'
    case 'PermissionRequest':
      return 'approval'
    default:
      return null
  }
}

function hasPendingBackgroundWork(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false
  const value = event as {
    background_tasks?: unknown
    session_crons?: unknown
  }
  return (
    (Array.isArray(value.background_tasks) && value.background_tasks.length > 0) ||
    (Array.isArray(value.session_crons) && value.session_crons.length > 0)
  )
}

export function buildHookSettings(ptyUrl: string): Record<string, unknown> {
  const group = (timeout: number): Record<string, unknown> => ({
    hooks: [{ type: 'http', url: ptyUrl, timeout, onFailure: 'continue' }]
  })
  return {
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((name) => [
        name,
        [group(name === 'PermissionRequest' ? APPROVAL_HOOK_TIMEOUT_SECONDS : 5)]
      ])
    )
  }
}

/**
 * Builds the PermissionRequest hook response. `null` means nobody answered
 * (timeout, closed terminal, relay unavailable), so the hook returns an empty
 * object and Claude keeps its native permission flow.
 */
export function permissionHookOutput(
  decision: ApprovalDecision | null
): Record<string, unknown> {
  if (!decision) return {}
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: decision === 'allow'
        ? { behavior: 'allow' }
        : {
            behavior: 'deny',
            message: '用户在 Claude Session Desk 中拒绝了此操作'
          }
    }
  }
}