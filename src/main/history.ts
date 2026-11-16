import { randomUUID } from 'node:crypto'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { HistoryPrompt, PastedContent } from '@shared/types'
import { parseJsonLine, readJsonlLines } from './jsonl'

interface RawHistoryRecord {
  display?: unknown
  pastedContents?: unknown
  timestamp?: unknown
  project?: unknown
  sessionId?: unknown
}

export interface HistorySession {
  sessionId: string
  projectPath: string
  prompts: HistoryPrompt[]
  title: string
  createdAt: number
  updatedAt: number
}

export interface HistoryParseResult {
  sessions: HistorySession[]
  skippedLines: number
}

function pastedContentsOf(value: unknown): PastedContent[] {
  if (!value) return []
  const items: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'object'
      ? Object.values(value as Record<string, unknown>)
      : []
  const result: PastedContent[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.content !== 'string' || !record.content) continue
    result.push({
      id: typeof record.id === 'number' ? record.id : result.length + 1,
      content: record.content
    })
  }
  return result
}

function titleOf(prompts: HistoryPrompt[]): string {
  const nonCommand = prompts.find((prompt) => !prompt.display.trim().startsWith('/'))
  const raw = (nonCommand ?? prompts[0])?.display ?? '历史会话'
  const firstLine = raw.trim().split(/\r?\n/)[0]?.trim() ?? ''
  return (firstLine || '历史会话').slice(0, 80)
}

export async function parseHistoryFile(
  filePath: string
): Promise<HistoryParseResult> {
  const groups = new Map<
    string,
    {
      projectPath: string
      prompts: HistoryPrompt[]
      first: number | null
      last: number | null
    }
  >()
  let skippedLines = 0

  for await (const line of readJsonlLines(filePath)) {
    if (!line.trim()) continue
    const record = parseJsonLine<RawHistoryRecord>(line)
    if (!record) {
      skippedLines += 1
      continue
    }
    const sessionId =
      typeof record.sessionId === 'string' ? record.sessionId : ''
    if (!sessionId) {
      skippedLines += 1
      continue
    }

    const projectPath = typeof record.project === 'string' ? record.project : ''
    const timestamp =
      typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
        ? record.timestamp
        : 0
    const display = typeof record.display === 'string' ? record.display : ''

    let group = groups.get(sessionId)
    if (!group) {
      group = { projectPath: '', prompts: [], first: null, last: null }
      groups.set(sessionId, group)
    }
    if (projectPath) group.projectPath = projectPath
    group.prompts.push({
      index: group.prompts.length,
      display: display || '（无文本提示）',
      timestamp,
      pastedContents: pastedContentsOf(record.pastedContents)
    })
    if (timestamp > 0) {
      group.first = group.first === null ? timestamp : Math.min(group.first, timestamp)
      group.last = group.last === null ? timestamp : Math.max(group.last, timestamp)
    }
  }

  const sessions: HistorySession[] = []
  for (const [sessionId, group] of groups) {
    sessions.push({
      sessionId,
      projectPath: group.projectPath,
      prompts: group.prompts,
      title: titleOf(group.prompts),
      createdAt: group.first ?? 0,
      updatedAt: group.last ?? 0
    })
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return { sessions, skippedLines }
}

export interface HistoryDeleteResult {
  deletedSessions: number
  deletedPrompts: number
  backupPath?: string
}

function backupName(filePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${filePath}.bak-${stamp}-${randomUUID()}`
}

const historyWrites = new Map<string, Promise<HistoryDeleteResult>>()

export function removeHistorySessions(
  filePath: string,
  sessionIds: Set<string>
): Promise<HistoryDeleteResult> {
  const key = resolve(filePath)
  const ids = new Set(sessionIds)
  const previous = historyWrites.get(key) ?? Promise.resolve()
  const pending = previous.catch(() => undefined).then(() => removeHistorySessionsNow(filePath, ids))
  historyWrites.set(key, pending)
  const cleanup = (): void => {
    if (historyWrites.get(key) === pending) historyWrites.delete(key)
  }
  void pending.then(cleanup, cleanup)
  return pending
}

async function removeHistorySessionsNow(
  filePath: string,
  sessionIds: Set<string>
): Promise<HistoryDeleteResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await stat(filePath)
    const raw = await readFile(filePath, 'utf8')
    const lines = raw.split('\n')
    const removedSessions = new Set<string>()
    let deletedPrompts = 0
    const kept: string[] = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        kept.push(line)
        continue
      }
      try {
        const record = JSON.parse(trimmed) as { sessionId?: unknown }
        if (
          typeof record.sessionId === 'string' &&
          sessionIds.has(record.sessionId)
        ) {
          removedSessions.add(record.sessionId)
          deletedPrompts += 1
          continue
        }
      } catch {
        // keep malformed lines unchanged
      }
      kept.push(line)
    }

    if (removedSessions.size === 0) {
      return { deletedSessions: 0, deletedPrompts: 0 }
    }

    const after = await stat(filePath)
    if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
      continue
    }

    const backupPath = backupName(filePath)
    const tempPath = `${filePath}.${randomUUID()}.tmp`
    try {
      // Back up exactly the snapshot used to prepare the deletion.
      await writeFile(backupPath, raw, { encoding: 'utf8', flag: 'wx' })
      await writeFile(tempPath, kept.join('\n'), 'utf8')
      const latest = await stat(filePath)
      if (latest.mtimeMs !== before.mtimeMs || latest.size !== before.size) continue
      await rename(tempPath, filePath)
    } finally {
      await unlink(tempPath).catch(() => undefined)
    }

    return {
      deletedSessions: removedSessions.size,
      deletedPrompts,
      backupPath
    }
  }

  throw new Error('history.jsonl 正在被其他程序修改，请稍后重试')
}
