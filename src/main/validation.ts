import { isAbsolute, relative, resolve, sep } from 'node:path'

export const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ParsedSessionKey {
  projectKey: string
  sessionId: string
}

export function externalWebUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

export function parseSessionKey(key: unknown): ParsedSessionKey | null {
  if (typeof key !== 'string') return null
  const slash = key.lastIndexOf('/')
  if (slash <= 0) return null
  const projectKey = key.slice(0, slash)
  const sessionId = key.slice(slash + 1)
  if (!/^[A-Za-z0-9._-]+$/.test(projectKey)) return null
  if (!SESSION_ID_RE.test(sessionId)) return null
  return { projectKey, sessionId }
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return (
    Boolean(rel) &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  )
}
