import type { ExternalEvent } from '@shared/types'

const EVENT_TYPE_RE = /^[a-z][a-z0-9_.-]{0,63}$/
const SUBJECT_RE = /^[A-Za-z0-9#._:/@-]{0,200}$/

export function isValidEventType(type: string): boolean {
  return EVENT_TYPE_RE.test(type)
}

/** Trigger patterns additionally allow `prefix.*` and the global `*`. */
export function isValidEventPattern(pattern: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) return isValidEventType(pattern.slice(0, -2))
  return isValidEventType(pattern)
}

/** Exact match, `prefix.*`, or the global `*`. */
export function eventTypeMatches(pattern: string, type: string): boolean {
  if (pattern === '*') return true
  if (pattern === type) return true
  if (!pattern.endsWith('.*')) return false
  const prefix = pattern.slice(0, -2)
  return type === prefix || type.startsWith(`${prefix}.`)
}

function safeLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 2_000) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Blocks external input from choosing execution scope (`cwd`, agent, access)
 * and keeps event text in a separate file rather than the prompt.
 */
export function sanitizeExternalEvent(value: unknown): ExternalEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type.trim() : ''
  if (!isValidEventType(type)) return null
  const subject = record.subject === undefined
    ? undefined
    : typeof record.subject === 'string' && SUBJECT_RE.test(record.subject)
      ? record.subject
      : null
  if (subject === null) return null
  const link = record.link === undefined ? undefined : safeLink(record.link)
  if (record.link !== undefined && link === undefined) return null
  return {
    type,
    ...(subject ? { subject } : {}),
    ...(typeof record.summary === 'string'
      ? { summary: record.summary.slice(0, 4_000) }
      : {}),
    ...(typeof record.detail === 'string'
      ? { detail: record.detail.slice(0, 20_000) }
      : {}),
    ...(link ? { link } : {})
  }
}