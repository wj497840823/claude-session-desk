import type { TerminalActivity } from './terminalActivity'

// Claude Code skips HTTP hooks for SessionStart/Setup, so liveness is proven by
// the first real activity event instead.
const HOOK_EVENTS = [
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'PermissionRequest',
  'PermissionDenied'
] as const

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
      return 'idle'
    case 'PermissionRequest':
      return 'approval'
    default:
      return null
  }
}

export function buildHookSettings(ptyUrl: string): Record<string, unknown> {
  const group = (): Record<string, unknown> => ({
    hooks: [{ type: 'http', url: ptyUrl, timeout: 5, onFailure: 'continue' }]
  })
  return {
    hooks: Object.fromEntries(HOOK_EVENTS.map((name) => [name, [group()]]))
  }
}