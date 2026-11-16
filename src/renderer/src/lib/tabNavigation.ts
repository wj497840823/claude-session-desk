import type { Snapshot } from '@shared/types'

export function terminalContext(snapshot: Snapshot | null, terminal: { cwd: string; sessionId?: string }): {
  sessionKey: string | null; projectKey: string | null
} {
  const session = snapshot?.sessions.find((item) => item.source === 'transcript' && item.id === terminal.sessionId)
  const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const project = snapshot?.projects.find((item) => normalize(item.path) === normalize(terminal.cwd))
  return { sessionKey: session?.key ?? null, projectKey: session?.projectKey ?? project?.key ?? null }
}

export function nextTabAfterClosing(keys: string[], active: string, closing: Set<string>): string | null {
  if (!closing.has(active)) return active
  const index = keys.indexOf(active)
  return keys.slice(index + 1).find((key) => !closing.has(key)) ??
    keys.slice(0, index).reverse().find((key) => !closing.has(key)) ?? null
}
