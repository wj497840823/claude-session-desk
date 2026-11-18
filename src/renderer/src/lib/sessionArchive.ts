const STORAGE_KEY = 'csm.archivedSessions'
const MAX_ARCHIVED = 1_000

export function parseArchived(raw: string | null | undefined): string[] {
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || entry.length > 300 || seen.has(entry)) continue
    seen.add(entry)
    result.push(entry)
    if (result.length >= MAX_ARCHIVED) break
  }
  return result
}

export function serializeArchived(ids: readonly string[]): string {
  return JSON.stringify([...new Set(ids)].slice(-MAX_ARCHIVED))
}

export function toggleArchived(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]
}

export function loadArchived(): string[] {
  if (typeof window === 'undefined') return []
  try {
    return parseArchived(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return []
  }
}

export function saveArchived(ids: readonly string[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeArchived(ids))
  } catch {
    // Archiving is a convenience; failing to persist should not break the UI.
  }
}