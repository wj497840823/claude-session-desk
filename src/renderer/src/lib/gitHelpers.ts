import type { Snapshot } from '@shared/types'

export function activeProjectKeys(
  snapshot: Snapshot | null,
  archived: string[]
): string[] {
  if (!snapshot) return []
  const keys = new Set<string>()
  for (const session of snapshot.sessions) {
    if (session.source !== 'transcript') continue
    if (archived.includes(session.id) || archived.includes(session.key)) continue
    keys.add(session.projectKey)
  }
  return [...keys]
}

export function chunkProjectKeys(keys: string[], size = 50): string[][] {
  const unique = [...new Set(keys)].filter((key) => key.length > 0)
  const chunks: string[][] = []
  for (let index = 0; index < unique.length; index += size) {
    chunks.push(unique.slice(index, index + size))
  }
  return chunks
}

export function gitErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}