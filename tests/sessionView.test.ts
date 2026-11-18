import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/types'
import { filterSessions, formatRelativeTime } from '../src/renderer/src/lib/sessionView'

function session(
  key: string,
  updatedAt: number,
  favorite = false,
  projectKey = 'E--demo'
): SessionSummary {
  return {
    key,
    id: key.split('/')[1],
    projectKey,
    projectPath: 'E:/demo',
    title: key,
    titleSource: 'ai-title',
    createdAt: 0,
    updatedAt,
    messageCount: 1,
    sizeBytes: 1,
    favorite,
    cwdExists: true,
    hasSidecar: false,
    source: 'transcript',
    promptCount: 0
  }
}

describe('filterSessions', () => {
  it('sorts recent sessions by time without pinning older favorites', () => {
    const rows = filterSessions(
      [session('a', 3), session('b', 2, true), session('c', 1)],
      { type: 'all' }
    )
    expect(rows.map((row) => row.key)).toEqual(['a', 'b', 'c'])
  })

  it('filters favorites and projects', () => {
    const rows = [
      session('a', 1, false, 'p1'),
      session('b', 2, true, 'p2'),
      session('c', 3, true, 'p1')
    ]
    expect(
      filterSessions(rows, { type: 'favorites' }).map((row) => row.key)
    ).toEqual(['c', 'b'])
    expect(
      filterSessions(rows, { type: 'project', projectKey: 'p1' }).map(
        (row) => row.key
      )
    ).toEqual(['c', 'a'])
  })

  it('hides archived sessions from normal views and lists them in the archive view', () => {
    const rows = [session('a', 2, true), session('b', 1)]
    const archived = new Set(['a'])
    expect(filterSessions(rows, { type: 'all' }, archived).map((row) => row.key)).toEqual(['b'])
    expect(filterSessions(rows, { type: 'archived' }, archived).map((row) => row.key)).toEqual(['a'])
    expect(filterSessions(rows, { type: 'favorites' }, archived)).toHaveLength(0)
  })

  it('filters history-only sessions', () => {
    const rows = [
      session('a', 1),
      { ...session('b', 2), source: 'history' as const, promptCount: 3 }
    ]
    expect(
      filterSessions(rows, { type: 'history' }).map((row) => row.key)
    ).toEqual(['b'])
  })

  it('keeps history out of active views and supports history project filters', () => {
    const rows = [
      session('a', 1, false, 'p1'),
      {
        ...session('h1', 2, true, 'p1'),
        source: 'history' as const,
        promptCount: 2
      },
      {
        ...session('h2', 3, false, 'p2'),
        source: 'history' as const,
        promptCount: 1
      }
    ]
    expect(
      filterSessions(rows, { type: 'all' }).map((row) => row.key)
    ).toEqual(['a'])
    expect(
      filterSessions(rows, { type: 'project', projectKey: 'p1' }).map(
        (row) => row.key
      )
    ).toEqual(['a'])
    expect(
      filterSessions(rows, { type: 'history-project', projectKey: 'p1' }).map(
        (row) => row.key
      )
    ).toEqual(['h1'])
    expect(
      filterSessions(rows, { type: 'history' }).map((row) => row.key)
    ).toEqual(['h2', 'h1'])
  })
})

describe('formatRelativeTime', () => {
  const now = new Date(2026, 10, 14, 12, 0, 0).getTime()

  it('formats recent, today, yesterday and older dates', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('刚刚')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(formatRelativeTime(new Date(2026, 10, 14, 9, 5).getTime(), now)).toBe(
      '今天 09:05'
    )
    expect(formatRelativeTime(new Date(2026, 10, 13, 18, 30).getTime(), now)).toBe(
      '昨天 18:30'
    )
    expect(formatRelativeTime(new Date(2026, 9, 2, 9, 0).getTime(), now)).toBe(
      '10月2日'
    )
    expect(formatRelativeTime(new Date(2025, 9, 2, 9, 0).getTime(), now)).toBe(
      '2025-10-02'
    )
  })
})
