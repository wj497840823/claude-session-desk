import { basename } from 'node:path'
import type {
  HistoryPrompt,
  SearchHit,
  SearchResponse,
  SessionSummary
} from '@shared/types'
import { parseJsonLine, readJsonlLines } from './jsonl'
import { humanTextOf, type RawRecord } from './parser'

export interface SearchOptions {
  query: string
  sessions: SessionSummary[]
  sessionFiles: Record<string, string>
  maxHits?: number
  isCancelled?: () => boolean
}

export interface HistorySearchOptions {
  query: string
  sessions: SessionSummary[]
  prompts: Record<string, HistoryPrompt[]>
  maxHits?: number
  isCancelled?: () => boolean
}

function searchableText(record: RawRecord): string | null {
  if (record.type === 'user') return humanTextOf(record)
  if (record.type !== 'assistant' || record.isSidechain) return null

  const content = record.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null

  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const value = block as Record<string, unknown>
    if (value.type === 'text' && typeof value.text === 'string') {
      parts.push(value.text)
    }
    if (value.type === 'tool_use') {
      if (typeof value.name === 'string') parts.push(value.name)
      try {
        parts.push(JSON.stringify(value.input))
      } catch {
        // ignore non-serializable tool input
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}

function cleanSnippetText(text: string): string {
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\\[nrt]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function makeSnippet(text: string, term: string): string {
  const normalized = cleanSnippetText(text)
  const index = normalized.toLowerCase().indexOf(term.toLowerCase())
  if (index < 0) return normalized.slice(0, 120)
  const start = Math.max(0, index - 60)
  const end = Math.min(normalized.length, index + term.length + 60)
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${
    end < normalized.length ? '…' : ''
  }`
}

export async function searchSessions(options: SearchOptions): Promise<SearchResponse> {
  const terms = options.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) {
    return { query: options.query, hits: [], truncated: false }
  }

  const maxHits = options.maxHits ?? 100
  const hits: SearchHit[] = []
  let truncated = false
  let cancelled = false

  for (const session of options.sessions) {
    if (session.source !== 'transcript') continue
    if (options.isCancelled?.()) {
      cancelled = true
      break
    }

    const title = session.title.toLowerCase()
    const baseHit = {
      sessionKey: session.key,
      title: session.title,
      projectName: session.projectPath
        ? basename(session.projectPath) || session.projectKey
        : session.projectKey,
      projectPath: session.projectPath,
      updatedAt: session.updatedAt,
      source: 'transcript' as const
    }

    if (terms.every((term) => title.includes(term))) {
      hits.push({ ...baseHit, snippet: session.title, matchUuid: '' })
      if (hits.length >= maxHits) {
        truncated = true
        break
      }
      continue
    }

    const filePath = options.sessionFiles[session.key]
    if (!filePath) continue

    const found = new Set(terms.flatMap((term, index) => title.includes(term) ? [index] : []))
    let snippet = ''
    let matchUuid = ''

    try {
      for await (const line of readJsonlLines(filePath)) {
        if (options.isCancelled?.()) {
          cancelled = true
          break
        }
        const record = parseJsonLine<RawRecord>(line)
        if (!record) continue
        const text = searchableText(record)
        if (!text) continue
        const lower = text.toLowerCase()

        terms.forEach((term, index) => {
          if (!found.has(index) && lower.includes(term)) {
            found.add(index)
            if (!snippet) {
              snippet = makeSnippet(text, term)
              matchUuid = typeof record.uuid === 'string' ? record.uuid : ''
            }
          }
        })

        if (found.size === terms.length) break
      }
    } catch {
      continue
    }

    if (cancelled) break
    if (found.size === terms.length) {
      hits.push({ ...baseHit, snippet, matchUuid })
      if (hits.length >= maxHits) {
        truncated = true
        break
      }
    }
  }

  return { query: options.query, hits, truncated, cancelled }
}

export async function searchHistory(
  options: HistorySearchOptions
): Promise<SearchResponse> {
  const terms = options.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) {
    return { query: options.query, hits: [], truncated: false }
  }

  const maxHits = options.maxHits ?? 100
  const hits: SearchHit[] = []
  let truncated = false
  let cancelled = false

  for (const session of options.sessions) {
    if (session.source !== 'history') continue
    if (options.isCancelled?.()) {
      cancelled = true
      break
    }

    const title = session.title.toLowerCase()
    const baseHit = {
      sessionKey: session.key,
      title: session.title,
      projectName: session.projectPath
        ? basename(session.projectPath) || session.projectKey
        : session.projectKey,
      projectPath: session.projectPath,
      updatedAt: session.updatedAt,
      source: 'history' as const
    }

    if (terms.every((term) => title.includes(term))) {
      hits.push({ ...baseHit, snippet: session.title, matchUuid: '' })
      if (hits.length >= maxHits) {
        truncated = true
        break
      }
      continue
    }

    const found = new Set(terms.flatMap((term, index) => title.includes(term) ? [index] : []))
    let snippet = ''
    let matchPromptIndex: number | undefined

    for (const prompt of options.prompts[session.key] ?? []) {
      if (options.isCancelled?.()) {
        cancelled = true
        break
      }
      const text = [prompt.display, ...prompt.pastedContents.map((item) => item.content)]
        .filter(Boolean)
        .join('\n')
      const lower = text.toLowerCase()
      terms.forEach((term, index) => {
        if (!found.has(index) && lower.includes(term)) {
          found.add(index)
          if (!snippet) {
            snippet = makeSnippet(text, term)
            matchPromptIndex = prompt.index
          }
        }
      })
      if (found.size === terms.length) break
    }

    if (cancelled) break
    if (found.size === terms.length) {
      hits.push({
        ...baseHit,
        snippet,
        matchUuid: '',
        matchPromptIndex
      })
      if (hits.length >= maxHits) {
        truncated = true
        break
      }
    }
  }

  return { query: options.query, hits, truncated, cancelled }
}
