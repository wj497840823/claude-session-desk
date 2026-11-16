import { expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS, type Snapshot } from '@shared/types'
import { nextTabAfterClosing, terminalContext } from '../src/renderer/src/lib/tabNavigation'

it('falls back to the nearest remaining tab and leaves an unaffected active tab alone', () => {
  const keys = ['a', 'b', 'c', 'd']
  expect(nextTabAfterClosing(keys, 'b', new Set(['b', 'c']))).toBe('d')
  expect(nextTabAfterClosing(keys, 'd', new Set(['d', 'c']))).toBe('b')
  expect(nextTabAfterClosing(keys, 'b', new Set(['a', 'c']))).toBe('b')
  expect(nextTabAfterClosing(keys, 'b', new Set(keys))).toBeNull()
})

it('anchors a new conversation by project path until its transcript is indexed', () => {
  const snapshot: Snapshot = {
    projects: [{ key: 'demo', name: 'demo', path: 'E:/Demo', sessionCount: 0, transcriptCount: 0, historyCount: 0, lastActivity: 0 }],
    sessions: [], dataRoot: '', dataRootExists: true, historyFileExists: false,
    transcriptCount: 0, historyOnlyCount: 0, scannedAt: 1, skippedFiles: 0, settings: DEFAULT_APP_SETTINGS
  }
  expect(terminalContext(snapshot, { cwd: 'e:\\demo\\', sessionId: 'new' })).toEqual({ projectKey: 'demo', sessionKey: null })
  expect(terminalContext(null, { cwd: 'E:/other' })).toEqual({ projectKey: null, sessionKey: null })
})
