import { describe, expect, it } from 'vitest'
import type { Snapshot } from '@shared/types'
import { activeProjectKeys, chunkProjectKeys, gitErrorMessage } from '../src/renderer/src/lib/gitHelpers'

function snapshotWithSessions(
  sessions: Array<{ key: string; projectKey: string; source: string; id: string }>
): Snapshot {
  return {
    projects: [],
    sessions: sessions.map((session) => ({
      ...session,
      projectPath: '',
      title: '',
      titleSource: 'fallback',
      createdAt: 0,
      updatedAt: 0,
      messageCount: 0,
      sizeBytes: 0,
      favorite: false,
      cwdExists: true,
      hasSidecar: false,
      promptCount: 0
    })),
    scannedAt: 0,
    skippedFiles: 0,
    dataRoot: '',
    dataRootExists: true,
    historyFileExists: false,
    transcriptCount: 0,
    historyOnlyCount: 0,
    settings: {
      loadHistory: false,
      minimizeToTray: true,
      desktopNotifications: true,
      terminalCopyOnSelect: true,
      terminalRightClickPaste: true,
      theme: 'system',
      defaultPermissionMode: 'follow',
      terminalFontSize: 13,
      sessionClickAction: 'continue'
    }
  } as unknown as Snapshot
}

describe('activeProjectKeys', () => {
  it('deduplicates transcript projects and excludes archived sessions', () => {
    const snapshot = snapshotWithSessions([
      { key: 'k1', projectKey: 'p1', source: 'transcript', id: 'id1' },
      { key: 'k2', projectKey: 'p1', source: 'transcript', id: 'id2' },
      { key: 'k3', projectKey: 'p2', source: 'transcript', id: 'id3' },
      { key: 'k4', projectKey: 'p3', source: 'history', id: 'id4' }
    ])
    expect(activeProjectKeys(snapshot, ['id2'])).toEqual(['p1', 'p2'])
    expect(activeProjectKeys(null, [])).toEqual([])
  })
})

describe('chunkProjectKeys', () => {
  it('keeps every batch within the IPC limit', () => {
    const keys = Array.from({ length: 120 }, (_, index) => `p${index}`)
    expect(chunkProjectKeys(keys).map((chunk) => chunk.length)).toEqual([50, 50, 20])
  })

  it('deduplicates keys and handles empty input', () => {
    expect(chunkProjectKeys(['a', 'a', 'b'])).toEqual([['a', 'b']])
    expect(chunkProjectKeys([])).toEqual([])
  })
})

describe('gitErrorMessage', () => {
  it('stringifies unknown errors', () => {
    expect(gitErrorMessage(new Error('boom'))).toBe('boom')
    expect(gitErrorMessage('bad')).toBe('bad')
  })
})