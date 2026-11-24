export interface ParsedClaudeAsk {
  title: string
  text: string
  options: string[]
}

const BLOCK = /```claudeview\s*([\s\S]*?)```/g

function sanitize(value: unknown): ParsedClaudeAsk | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const title = typeof record.title === 'string'
    ? record.title.trim().slice(0, 200)
    : ''
  const text = typeof record.text === 'string'
    ? record.text.trim().slice(0, 4_000)
    : ''
  const rawOptions = Array.isArray(record.options) ? record.options : []
  const options = rawOptions
    .filter((option): option is string => typeof option === 'string')
    .map((option) => option.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 5)
  if (!title && !text && options.length === 0) return null
  return { title: title || '需要你回答', text, options }
}

/**
 * Reads the final `claudeview` fenced block from a scheduled task's result.
 * Only the last block counts, so an echoed example cannot override the real
 * question.
 */
export function parseClaudeViewAsk(text: string | undefined): ParsedClaudeAsk | null {
  if (!text) return null
  let match: RegExpExecArray | null
  let last: string | null = null
  BLOCK.lastIndex = 0
  while ((match = BLOCK.exec(text)) !== null) last = match[1]
  if (last === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(last.trim())
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const ask = (parsed as Record<string, unknown>).ask
  return sanitize(Array.isArray(ask) ? ask[0] : ask)
}