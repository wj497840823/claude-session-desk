import type { TerminalPermissionMode } from '@shared/types'

export type OpenTabKind = 'resume' | 'new' | 'new-project' | 'fork'

export interface OpenTab {
  key: string
  cwd: string
  projectName: string
  sessionId?: string
  sessionTitle?: string
  forkFromSessionId?: string
  kind: OpenTabKind
  mode: TerminalPermissionMode
}

const STORAGE_KEY = 'csm.openTabs'
const MAX_TABS = 50
const KINDS = new Set<OpenTabKind>(['resume', 'new', 'new-project', 'fork'])
const MODES = new Set<TerminalPermissionMode>([
  'follow',
  'manual',
  'auto',
  'acceptEdits',
  'plan',
  'dontAsk'
])

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function optionalString(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' && value.length <= max ? value : null
}

export function parseOpenTabs(raw: string | null | undefined): OpenTab[] {
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []

  const result: OpenTab[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const key = boundedString(item.key, 200)
    const cwd = boundedString(item.cwd, 4096)
    const projectName = typeof item.projectName === 'string' && item.projectName.length <= 500
      ? item.projectName
      : null
    const kind = typeof item.kind === 'string' && KINDS.has(item.kind as OpenTabKind)
      ? item.kind as OpenTabKind
      : null
    const mode = typeof item.mode === 'string' && MODES.has(item.mode as TerminalPermissionMode)
      ? item.mode as TerminalPermissionMode
      : null
    const sessionId = optionalString(item.sessionId, 200)
    const sessionTitle = optionalString(item.sessionTitle, 500)
    const forkFromSessionId = optionalString(item.forkFromSessionId, 200)
    if (!key || !cwd || projectName === null || !kind || !mode || sessionId === null || sessionTitle === null || forkFromSessionId === null) continue
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      key,
      cwd,
      projectName,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionTitle !== undefined ? { sessionTitle } : {}),
      ...(forkFromSessionId ? { forkFromSessionId } : {}),
      kind,
      mode
    })
    if (result.length >= MAX_TABS) break
  }
  return result
}

export function serializeOpenTabs(tabs: readonly OpenTab[]): string {
  return JSON.stringify(tabs.slice(-MAX_TABS))
}

export function loadOpenTabs(): OpenTab[] {
  if (typeof window === 'undefined') return []
  try {
    return parseOpenTabs(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return []
  }
}

export function saveOpenTabs(tabs: readonly OpenTab[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeOpenTabs(tabs))
  } catch {
    // Losing tab restoration is not worth surfacing an error.
  }
}