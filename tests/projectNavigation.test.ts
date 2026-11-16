/// <reference lib="dom" />
import { beforeEach, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS, type Snapshot } from '@shared/types'
import { useStore } from '../src/renderer/src/store'

const snapshot: Snapshot = {
  settings: DEFAULT_APP_SETTINGS, scannedAt: 1, skippedFiles: 0,
  dataRoot: '', dataRootExists: true, historyFileExists: false,
  transcriptCount: 2, historyOnlyCount: 0,
  projects: ['p1', 'p2'].map((key) => ({
    key, name: key, path: `E:/${key}`, sessionCount: 1,
    transcriptCount: 1, historyCount: 0, lastActivity: 1
  })),
  sessions: ['p1', 'p2'].map((key) => ({
    key: `${key}/s`, id: key, projectKey: key, projectPath: `E:/${key}`,
    title: key, titleSource: 'fallback', createdAt: 0, updatedAt: 1,
    messageCount: 1, sizeBytes: 1, favorite: false, cwdExists: true,
    hasSidecar: false, source: 'transcript', promptCount: 0
  }))
}

beforeEach(() => {
  useStore.setState(useStore.getInitialState())
  useStore.getState().setSnapshot(snapshot)
})

it('expands and collapses a project without clearing its selected record', () => {
  const store = useStore.getState()
  store.selectSession('p1/s')
  store.toggleProject('p1')
  expect(useStore.getState()).toMatchObject({
    view: { type: 'project', projectKey: 'p1' }, selectedKey: 'p1/s',
    expandedProjectKeys: ['p1'], recordTabVisible: true, activeTab: 'record'
  })
  store.toggleProject('p1')
  expect(useStore.getState().expandedProjectKeys).toEqual([])
  expect(useStore.getState().selectedKey).toBe('p1/s')
  expect(useStore.getState().recordTabVisible).toBe(true)
  store.toggleProject('p1')
  expect(useStore.getState().expandedProjectKeys).toEqual(['p1'])
  store.setView({ type: 'project', projectKey: 'p1' })
  expect(useStore.getState().activeTab).toBe('record')
})

it('clears a search on project navigation and clears only out-of-scope selection', () => {
  const store = useStore.getState()
  store.selectSession('p1/s')
  store.setQuery('query')
  store.setView({ type: 'project', projectKey: 'p2' })
  expect(useStore.getState()).toMatchObject({
    selectedKey: null, focusedProjectKey: 'p2', query: '', search: null,
    recordTabVisible: false, expandedProjectKeys: ['p2']
  })
})

it('switching tabs reopens a collapsed project and restores its session anchor', () => {
  const store = useStore.getState()
  for (const key of ['p1', 'p2']) store.startTerminal({
    key, cwd: `E:/${key}`, sessionId: key, projectName: key, kind: 'resume', mode: 'follow'
  })
  store.setView({ type: 'project', projectKey: 'p1' })
  store.toggleProject('p1')
  store.toggleSessionList()
  store.setActiveTerminal('p1')
  expect(useStore.getState()).toMatchObject({
    view: { type: 'project', projectKey: 'p1' }, selectedKey: 'p1/s',
    focusedProjectKey: 'p1', sessionListCollapsed: false
  })
  expect(useStore.getState().expandedProjectKeys).toContain('p1')
})

it('the session toggle restores navigation when the whole sidebar was hidden', () => {
  const store = useStore.getState()
  store.toggleLeftRail()
  store.toggleSessionList()
  expect(useStore.getState()).toMatchObject({ leftRailCollapsed: false, sessionListCollapsed: false })
})

it('activity and favorites toggle closed without dropping the selected record', () => {
  const store = useStore.getState()
  store.setView({ type: 'all' })
  store.selectSession('p1/s')
  store.toggleView({ type: 'all' })
  expect(useStore.getState()).toMatchObject({ sessionListCollapsed: true, selectedKey: 'p1/s', activeTab: 'record' })
  store.toggleView({ type: 'all' })
  expect(useStore.getState().sessionListCollapsed).toBe(false)
  store.toggleView({ type: 'favorites' })
  expect(useStore.getState()).toMatchObject({ view: { type: 'favorites' }, sessionListCollapsed: false })
  store.toggleView({ type: 'favorites' })
  expect(useStore.getState().sessionListCollapsed).toBe(true)
  store.setQuery('search')
  store.toggleView({ type: 'favorites' })
  expect(useStore.getState()).toMatchObject({ query: '', sessionListCollapsed: false })
})
