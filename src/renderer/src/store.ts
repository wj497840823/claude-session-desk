import { create } from 'zustand'
import type {
  HistoryDetail,
  SearchResponse,
  SessionDetail,
  Snapshot,
  TerminalPermissionMode
} from '@shared/types'
import type { View } from './lib/sessionView'
import { filterSessions } from './lib/sessionView'
import { parseStoredBoolean } from './lib/preferences'
import { nextTabAfterClosing, terminalContext } from './lib/tabNavigation'

function storedBool(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback
  const value = window.localStorage.getItem(key)
  return parseStoredBoolean(value, fallback)
}

function storedWidth(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === 'undefined') return fallback
  const raw = window.localStorage.getItem(key)
  if (raw === null) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function remember(key: string, value: string | number | boolean): void {
  if (typeof window !== 'undefined') window.localStorage.setItem(key, String(value))
}

function storedProjects(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem('csm.expandedProjects') ?? '[]')
    return Array.isArray(value) ? [...new Set(value.filter((key): key is string => typeof key === 'string'))] : []
  } catch { return [] }
}

function expandedProjects(keys: string[], projectKey: string | null): string[] {
  if (!projectKey || keys.includes(projectKey)) return keys
  const expanded = [...keys, projectKey]
  remember('csm.expandedProjects', JSON.stringify(expanded))
  return expanded
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

function rememberLater(key: string, value: number): void {
  const existing = saveTimers.get(key)
  if (existing) clearTimeout(existing)
  saveTimers.set(
    key,
    setTimeout(() => {
      saveTimers.delete(key)
      remember(key, value)
    }, 250)
  )
}

export interface ToastMessage {
  kind: 'success' | 'error'
  message: string
}

export interface TerminalDialogRequest {
  kind: 'resume' | 'new' | 'new-project'
  cwd: string
  projectName: string
  sessionId?: string
  sessionTitle?: string
}

export interface TerminalSession {
  key: string
  cwd: string
  projectName: string
  sessionId?: string
  sessionTitle?: string
  kind: TerminalDialogRequest['kind']
  mode: TerminalPermissionMode
}

export type TerminalStatus = 'starting' | 'running' | 'stopped'

interface AppState {
  snapshot: Snapshot | null
  loading: boolean
  refreshing: boolean
  view: View
  selectedKey: string | null
  matchUuid: string | null
  matchPromptIndex: number | null
  selectedHistory: string[]
  focusedProjectKey: string | null
  expandedProjectKeys: string[]
  followActiveTerminal: boolean
  query: string
  search: SearchResponse | null
  searching: boolean
  detail: SessionDetail | null
  historyDetail: HistoryDetail | null
  detailLoading: boolean
  toast: ToastMessage | null
  terminalDialog: TerminalDialogRequest | null
  terminals: TerminalSession[]
  activeTab: string
  recordTabVisible: boolean
  terminalStatus: Record<string, TerminalStatus>
  terminalFocused: boolean
  leftRailCollapsed: boolean
  sessionListCollapsed: boolean
  leftRailWidth: number
  sessionListWidth: number
  settingsOpen: boolean
  setSnapshot: (snapshot: Snapshot) => void
  setLoading: (loading: boolean) => void
  setRefreshing: (refreshing: boolean) => void
  setView: (view: View) => void
  toggleView: (view: View) => void
  toggleProject: (projectKey: string) => void
  selectSession: (
    key: string | null,
    matchUuid?: string | null,
    matchPromptIndex?: number | null,
    showRecord?: boolean
  ) => void
  closeRecordTab: () => void
  toggleHistorySelection: (key: string) => void
  setHistorySelection: (keys: string[]) => void
  clearHistorySelection: () => void
  setQuery: (query: string) => void
  setSearch: (search: SearchResponse | null) => void
  setSearching: (searching: boolean) => void
  setDetail: (detail: SessionDetail | null) => void
  setHistoryDetail: (detail: HistoryDetail | null) => void
  setDetailLoading: (loading: boolean) => void
  showToast: (toast: ToastMessage) => void
  clearToast: () => void
  openTerminalDialog: (request: TerminalDialogRequest) => void
  closeTerminalDialog: () => void
  startTerminal: (session: TerminalSession) => void
  closeTerminal: (key: string) => void
  closeTerminals: (keys: string[]) => void
  setActiveTerminal: (key: string) => void
  setTerminalStatus: (key: string, status: TerminalStatus) => void
  setTerminalFocused: (focused: boolean) => void
  toggleLeftRail: () => void
  toggleSessionList: () => void
  setLeftRailWidth: (width: number) => void
  setSessionListWidth: (width: number) => void
  setSettingsOpen: (open: boolean) => void
}

function terminalNavigation(state: AppState, terminal: TerminalSession, changeView = true): Partial<AppState> {
  const context = terminalContext(state.snapshot, terminal)
  const same = state.selectedKey === context.sessionKey
  const visible = state.view.type === 'all' ||
    (state.view.type === 'project' && state.view.projectKey === context.projectKey) ||
    (state.view.type === 'favorites' && state.snapshot?.sessions.some((s) => s.key === context.sessionKey && s.favorite))
  return {
    selectedKey: context.sessionKey, focusedProjectKey: context.projectKey,
    expandedProjectKeys: expandedProjects(state.expandedProjectKeys, context.projectKey),
    sessionListCollapsed: false,
    followActiveTerminal: true,
    detail: same ? state.detail : null, historyDetail: same ? state.historyDetail : null,
    matchUuid: null, matchPromptIndex: null, selectedHistory: [],
    query: '', search: null, searching: false,
    recordTabVisible: Boolean(context.sessionKey) && state.recordTabVisible,
    ...((changeView || !visible) ? {
      view: context.projectKey ? { type: 'project' as const, projectKey: context.projectKey } : { type: 'all' as const }
    } : {})
  }
}

function viewNavigation(state: AppState, view: View): Partial<AppState> {
  const selected = state.snapshot?.sessions.find((session) => session.key === state.selectedKey)
  const keepSelection = Boolean(selected && filterSessions([selected], view).length)
  const projectKey = 'projectKey' in view ? view.projectKey : null
  return {
    view,
    selectedKey: keepSelection ? state.selectedKey : null,
    detail: keepSelection ? state.detail : null,
    historyDetail: keepSelection ? state.historyDetail : null,
    matchUuid: null, matchPromptIndex: null, selectedHistory: [],
    focusedProjectKey: projectKey ?? (keepSelection ? selected?.projectKey ?? null : null),
    expandedProjectKeys: expandedProjects(state.expandedProjectKeys, projectKey),
    followActiveTerminal: false,
    recordTabVisible: keepSelection && state.recordTabVisible,
    query: '', search: null, searching: false,
    sessionListCollapsed: false,
    activeTab: state.activeTab === 'record' && !keepSelection
      ? state.terminals.at(-1)?.key ?? '' : state.activeTab
  }
}

export const useStore = create<AppState>()((set) => ({
  snapshot: null,
  loading: true,
  refreshing: false,
  view: { type: 'all' },
  selectedKey: null,
  matchUuid: null,
  matchPromptIndex: null,
  selectedHistory: [],
  focusedProjectKey: null,
  expandedProjectKeys: storedProjects(),
  followActiveTerminal: false,
  query: '',
  search: null,
  searching: false,
  detail: null,
  historyDetail: null,
  detailLoading: false,
  toast: null,
  terminalDialog: null,
  terminals: [],
  activeTab: '',
  recordTabVisible: false,
  terminalStatus: {},
  terminalFocused: false,
  leftRailCollapsed: storedBool('csm.leftRailCollapsed', false),
  // Startup always enters the activity view collapsed, including after an upgrade.
  sessionListCollapsed: true,
  leftRailWidth: storedWidth('csm.navigationWidth', 320, 240, 480),
  sessionListWidth: storedWidth('csm.sessionListWidth', 340, 240, 640),
  settingsOpen: false,
  setSnapshot: (snapshot) =>
    set((state) => {
      const active = state.terminals.find((tab) => tab.key === state.activeTab)
      const context = active ? terminalContext(snapshot, active) : null
      const navigation = active && context && state.followActiveTerminal &&
        (context.sessionKey !== state.selectedKey || context.projectKey !== state.focusedProjectKey)
        ? terminalNavigation({ ...state, snapshot }, active, false) : {}
      return {
        ...navigation,
        snapshot,
        query: state.query, search: state.search, searching: state.searching,
        selectedHistory: state.selectedHistory.filter((key) =>
          snapshot.sessions.some(
            (session) => session.key === key && session.source === 'history'
          )
        )
      }
    }),
  setLoading: (loading) => set({ loading }),
  setRefreshing: (refreshing) => set({ refreshing }),
  setView: (view) =>
    set((state) => viewNavigation(state, view)),
  toggleView: (view) =>
    set((state) => {
      const same = state.view.type === view.type &&
        (!('projectKey' in view) || ('projectKey' in state.view && state.view.projectKey === view.projectKey))
      if (!same || state.query.trim()) return viewNavigation(state, view)
      const sessionListCollapsed = !state.sessionListCollapsed
      remember('csm.sessionListCollapsed', sessionListCollapsed)
      return { sessionListCollapsed, followActiveTerminal: false }
    }),
  toggleProject: (projectKey) =>
    set((state) => {
      const same = state.view.type === 'project' && state.view.projectKey === projectKey
      const navigation = !same ? viewNavigation(state, { type: 'project', projectKey }) : {}
      const expandedProjectKeys = state.view.type === 'project' && !state.sessionListCollapsed && state.expandedProjectKeys.includes(projectKey)
        ? state.expandedProjectKeys.filter((key) => key !== projectKey)
        : [...new Set([...state.expandedProjectKeys, projectKey])]
      remember('csm.expandedProjects', JSON.stringify(expandedProjectKeys))
      return { ...navigation,
        expandedProjectKeys, sessionListCollapsed: false }
    }),
  selectSession: (
    selectedKey,
    matchUuid = null,
    matchPromptIndex = null,
    showRecord = true
  ) =>
    set((state) => {
      const same = state.selectedKey === selectedKey
      return {
        selectedKey,
        focusedProjectKey: state.snapshot?.sessions.find((item) => item.key === selectedKey)?.projectKey ?? null,
        followActiveTerminal: false,
        matchUuid,
        matchPromptIndex,
        detail: same ? state.detail : null,
        historyDetail: same ? state.historyDetail : null,
        recordTabVisible: Boolean(selectedKey) && showRecord,
        activeTab: selectedKey
          ? showRecord
            ? 'record'
            : state.activeTab
          : state.terminals[state.terminals.length - 1]?.key ?? ''
      }
    }),
  closeRecordTab: () =>
    set((state) => {
      const activeTab = state.activeTab === 'record' ? state.terminals.at(-1)?.key ?? '' : state.activeTab
      const terminal = state.terminals.find((tab) => tab.key === activeTab)
      return { ...(terminal ? terminalNavigation(state, terminal) : {}), recordTabVisible: false, activeTab }
    }),
  toggleHistorySelection: (key) =>
    set((state) => ({
      selectedHistory: state.selectedHistory.includes(key)
        ? state.selectedHistory.filter((item) => item !== key)
        : [...state.selectedHistory, key]
    })),
  setHistorySelection: (keys) =>
    set({ selectedHistory: [...new Set(keys)] }),
  clearHistorySelection: () => set({ selectedHistory: [] }),
  setQuery: (query) =>
    set((state) => ({
      query,
      search: null,
      ...(query.trim() ? { sessionListCollapsed: false } : {})
    })),
  setSearch: (search) => set({ search }),
  setSearching: (searching) => set({ searching }),
  setDetail: (detail) => set({ detail }),
  setHistoryDetail: (historyDetail) => set({ historyDetail }),
  setDetailLoading: (detailLoading) => set({ detailLoading }),
  showToast: (toast) => set({ toast }),
  clearToast: () => set({ toast: null }),
  openTerminalDialog: (terminalDialog) => set({ terminalDialog }),
  closeTerminalDialog: () => set({ terminalDialog: null }),
  startTerminal: (terminal) =>
    set((state) => {
      terminal = { ...terminal, sessionId: terminal.sessionId ?? crypto.randomUUID() }
      const exists = state.terminals.some((item) => item.key === terminal.key)
      return {
        ...terminalNavigation(state, terminal, false),
        terminals: exists
          ? state.terminals.map((item) =>
              item.key === terminal.key ? terminal : item
            )
          : [...state.terminals, terminal],
        activeTab: terminal.key,
        terminalDialog: null,
        terminalStatus: { ...state.terminalStatus, [terminal.key]: 'starting' },
        terminalFocused: false
      }
    }),
  closeTerminal: (key) => useStore.getState().closeTerminals([key]),
  closeTerminals: (keys) =>
    set((state) => {
      const closing = new Set(keys)
      const terminals = state.terminals.filter((item) => !closing.has(item.key))
      const terminalStatus = { ...state.terminalStatus }
      for (const key of keys) delete terminalStatus[key]
      const activeTab = nextTabAfterClosing(state.terminals.map((tab) => tab.key), state.activeTab, closing) ??
        (state.recordTabVisible && state.selectedKey ? 'record' : '')
      const active = terminals.find((tab) => tab.key === activeTab)
      return {
        ...(active && activeTab !== state.activeTab ? terminalNavigation(state, active) : {}),
        terminals,
        activeTab,
        terminalStatus,
        terminalFocused: false
      }
    }),
  setActiveTerminal: (activeTab) =>
    set((state) => {
      const terminal = state.terminals.find((tab) => tab.key === activeTab)
      return { ...(terminal ? terminalNavigation(state, terminal) : { followActiveTerminal: false }),
        activeTab, terminalFocused: false }
    }),
  setTerminalStatus: (key, status) =>
    set((state) => ({
      terminalStatus: { ...state.terminalStatus, [key]: status }
    })),
  setTerminalFocused: (terminalFocused) => set({ terminalFocused }),
  toggleLeftRail: () =>
    set((state) => {
      const leftRailCollapsed = !state.leftRailCollapsed
      remember('csm.leftRailCollapsed', leftRailCollapsed)
      return { leftRailCollapsed }
    }),
  toggleSessionList: () =>
    set((state) => {
      const sessionListCollapsed = state.leftRailCollapsed ? false : !state.sessionListCollapsed
      remember('csm.sessionListCollapsed', sessionListCollapsed)
      remember('csm.leftRailCollapsed', false)
      return { sessionListCollapsed, leftRailCollapsed: false }
    }),
  setLeftRailWidth: (width) => {
    const leftRailWidth = Math.min(480, Math.max(240, width))
    rememberLater('csm.navigationWidth', leftRailWidth)
    set({ leftRailWidth })
  },
  setSessionListWidth: (width) => {
    const sessionListWidth = Math.min(640, Math.max(240, width))
    rememberLater('csm.sessionListWidth', sessionListWidth)
    set({ sessionListWidth })
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen })
}))
