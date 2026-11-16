import type { Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { SessionEvent, TitleSource, ToolCall } from '@shared/types'
import { parseJsonLine, readJsonlLines } from './jsonl'

export interface RawRecord {
  type?: string
  uuid?: string
  timestamp?: string
  sessionId?: string
  cwd?: string
  isSidechain?: boolean
  origin?: { kind?: string }
  message?: { role?: string; content?: unknown; model?: string }
  aiTitle?: string
}

export interface SessionMeta {
  sessionId: string
  cwd: string | null
  title: string
  titleSource: TitleSource
  createdAt: number
  updatedAt: number
  messageCount: number
}

function timestampOf(record: RawRecord): number | null {
  if (!record.timestamp) return null
  const parsed = Date.parse(record.timestamp)
  return Number.isFinite(parsed) ? parsed : null
}

function contentBlocks(record: RawRecord): Array<Record<string, unknown>> {
  const content = record.message?.content
  if (!Array.isArray(content)) return []
  return content.filter(
    (block): block is Record<string, unknown> =>
      Boolean(block) && typeof block === 'object'
  )
}

function isHumanUser(record: RawRecord): boolean {
  if (record.type !== 'user' || record.isSidechain) return false
  if (record.origin?.kind === 'task-notification') return false
  return true
}

export function humanTextOf(record: RawRecord): string | null {
  if (!isHumanUser(record)) return null
  const content = record.message?.content
  if (typeof content === 'string') {
    return content.startsWith('<persisted-output>') ? null : content
  }
  const blocks = contentBlocks(record)
  if (blocks.length === 0) return null
  if (blocks.some((block) => block.type === 'tool_result')) return null
  const texts = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
  return texts.length > 0 ? texts.join('\n') : null
}

export function assistantTextOf(record: RawRecord): string | null {
  if (record.type !== 'assistant' || record.isSidechain) return null
  const texts = contentBlocks(record)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
  return texts.length > 0 ? texts.join('\n\n') : null
}

export async function parseSessionMeta(
  filePath: string,
  knownStat?: Pick<Stats, 'birthtimeMs' | 'mtimeMs'>
): Promise<SessionMeta> {
  let firstCwd: string | null = null
  let sessionId: string | null = null
  let aiTitle: string | null = null
  let firstPrompt: string | null = null
  let createdAt: number | null = null
  let updatedAt: number | null = null
  let messageCount = 0

  for await (const line of readJsonlLines(filePath)) {
    const record = parseJsonLine<RawRecord>(line)
    if (!record) continue
    if (!firstCwd && typeof record.cwd === 'string' && record.cwd) {
      firstCwd = record.cwd
    }
    if (!sessionId && typeof record.sessionId === 'string' && record.sessionId) {
      sessionId = record.sessionId
    }
    const timestamp = timestampOf(record)
    if (timestamp !== null) {
      if (createdAt === null || timestamp < createdAt) createdAt = timestamp
      if (updatedAt === null || timestamp > updatedAt) updatedAt = timestamp
    }
    if (
      record.type === 'ai-title' &&
      typeof record.aiTitle === 'string' &&
      record.aiTitle.trim()
    ) {
      aiTitle = record.aiTitle.trim()
    }
    const humanText = humanTextOf(record)
    if (humanText) {
      messageCount += 1
      if (!firstPrompt) {
        const firstLine = humanText.trim().split(/\r?\n/)[0]?.trim()
        if (firstLine) firstPrompt = firstLine
      }
    } else if (assistantTextOf(record)) {
      messageCount += 1
    }
  }

  const fileStat = knownStat ?? await stat(filePath)
  const fallbackId = basename(filePath, '.jsonl')
  const rawTitle = aiTitle ?? firstPrompt
  const titleSource: TitleSource = aiTitle
    ? 'ai-title'
    : firstPrompt
      ? 'first-prompt'
      : 'fallback'

  return {
    sessionId: sessionId ?? fallbackId,
    cwd: firstCwd,
    title: (rawTitle ?? '新会话').slice(0, 80),
    titleSource,
    createdAt: createdAt ?? (fileStat.birthtimeMs || fileStat.mtimeMs),
    updatedAt: updatedAt ?? fileStat.mtimeMs,
    messageCount
  }
}

const MAX_TOOL_INPUT = 8 * 1024
const MAX_TOOL_RESULT = 12 * 1024

export interface ParsedDetail {
  events: SessionEvent[]
  skippedLines: number
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（已截断）`
}

export function summarizeTool(name: string, input: unknown): string {
  const object =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const keys = ['command', 'file_path', 'path', 'pattern', 'description', 'url']
  let raw: string | null = null
  for (const key of keys) {
    if (typeof object[key] === 'string') {
      raw = object[key] as string
      break
    }
  }
  const text = raw
    ? raw.replace(/\s+/g, ' ').trim()
    : JSON.stringify(object).slice(0, 80)
  return `${name}: ${text.slice(0, 100)}`
}

export function extractPersistedPath(text: string): string | undefined {
  const match = /Full output saved to:\s*(.+?)(?:\r?\n|$)/.exec(text)
  return match?.[1]?.trim() || undefined
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'text' &&
        typeof (block as Record<string, unknown>).text === 'string'
      ) {
        return (block as Record<string, unknown>).text as string
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function stringifyInput(input: unknown): string {
  try {
    return truncateText(JSON.stringify(input, null, 2) ?? '', MAX_TOOL_INPUT)
  } catch {
    return ''
  }
}

export async function parseSessionDetail(filePath: string): Promise<ParsedDetail> {
  const events: SessionEvent[] = []
  const callsById = new Map<string, ToolCall>()
  let skippedLines = 0

  for await (const line of readJsonlLines(filePath)) {
    if (!line.trim()) continue
    const record = parseJsonLine<RawRecord>(line)
    if (!record) {
      skippedLines += 1
      continue
    }
    if (record.isSidechain) continue

    const timestamp = timestampOf(record) ?? 0
    const uuid =
      typeof record.uuid === 'string' ? record.uuid : `${timestamp}-${events.length}`

    if (record.type === 'user') {
      const results = contentBlocks(record).filter(
        (block) => block.type === 'tool_result'
      )
      if (results.length > 0) {
        for (const block of results) {
          const toolUseId =
            typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
          const call = callsById.get(toolUseId)
          if (!call) continue
          const text = toolResultText(block.content)
          call.result = truncateText(text, MAX_TOOL_RESULT)
          call.isError = block.is_error === true
          call.persistedOutputPath = extractPersistedPath(text)
        }
        continue
      }
      const text = humanTextOf(record)
      if (text && text.trim()) {
        events.push({ kind: 'user', uuid, timestamp, text })
      }
      continue
    }

    if (record.type === 'assistant') {
      const blocks = contentBlocks(record)
      const text = blocks
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('\n\n')
      if (text.trim()) {
        events.push({
          kind: 'assistant',
          uuid,
          timestamp,
          text,
          model: record.message?.model
        })
      }
      const calls: ToolCall[] = []
      for (const block of blocks) {
        if (
          block.type !== 'tool_use' ||
          typeof block.id !== 'string' ||
          typeof block.name !== 'string'
        ) {
          continue
        }
        const call: ToolCall = {
          id: block.id,
          name: block.name,
          inputSummary: summarizeTool(block.name, block.input),
          input: stringifyInput(block.input)
        }
        if (block.input && typeof block.input === 'object') {
          const input = block.input as Record<string, unknown>
          const files = [input.file_path, input.path, input.notebook_path]
            .filter((path): path is string => typeof path === 'string' && Boolean(path))
          if (files.length) call.files = [...new Set(files)]
        }
        calls.push(call)
        callsById.set(call.id, call)
      }
      if (calls.length > 0) {
        events.push({ kind: 'tools', uuid, timestamp, calls })
      }
    }
  }

  return { events, skippedLines }
}
