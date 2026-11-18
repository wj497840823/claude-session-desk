import type { SessionSummary } from '@shared/types'

export type View =
  | { type: 'all' }
  | { type: 'favorites' }
  | { type: 'archived' }
  | { type: 'history' }
  | { type: 'history-project'; projectKey: string }
  | { type: 'project'; projectKey: string }

export function filterSessions(
  sessions: SessionSummary[],
  view: View,
  archivedIds: ReadonlySet<string> = new Set()
): SessionSummary[] {
  const archived = (session: SessionSummary): boolean => archivedIds.has(session.id) || archivedIds.has(session.key)
  const base =
    view.type === 'archived'
      ? sessions.filter((session) => session.source === 'transcript' && archived(session))
      : view.type === 'favorites'
        ? sessions.filter((session) => session.favorite && !archived(session))
        : view.type === 'history'
          ? sessions.filter((session) => session.source === 'history')
          : view.type === 'history-project'
            ? sessions.filter(
                (session) =>
                  session.source === 'history' &&
                  session.projectKey === view.projectKey
              )
            : view.type === 'project'
              ? sessions.filter(
                  (session) =>
                    session.source === 'transcript' &&
                    session.projectKey === view.projectKey &&
                    !archived(session)
                )
              : sessions.filter((session) => session.source === 'transcript' && !archived(session))
  return [...base].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key)
  )
}

export function isProjectExpanded(
  view: View,
  sessionListCollapsed: boolean,
  expandedProjectKeys: readonly string[],
  projectKey: string
): boolean {
  return view.type === 'project' &&
    view.projectKey === projectKey &&
    !sessionListCollapsed &&
    expandedProjectKeys.includes(projectKey)
}

function sameDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diff = now - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`

  const date = new Date(timestamp)
  const current = new Date(now)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`

  if (sameDate(date, current)) return `今天 ${clock}`

  const yesterday = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate() - 1
  )
  if (sameDate(date, yesterday)) return `昨天 ${clock}`

  if (date.getFullYear() === current.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
