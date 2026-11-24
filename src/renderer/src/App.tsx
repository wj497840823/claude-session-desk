import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import PanelResizer from './components/PanelResizer'
import CommandPalette from './components/CommandPalette'
import ProjectRail from './components/ProjectRail'
import SearchResults from './components/SearchResults'
import SettingsDialog from './components/SettingsDialog'
import ScheduledTasksDialog from './components/ScheduledTasksDialog'
import ClaudeMdEditorDialog from './components/ClaudeMdEditorDialog'
import GitPanel from './components/GitPanel'
import AttentionInbox from './components/AttentionInbox'
import TemplateManagerDialog from './components/TemplateManagerDialog'
import TerminalStartDialog from './components/TerminalStartDialog'
import Toast from './components/Toast'
import TopBar from './components/TopBar'
import WorkspacePane from './components/WorkspacePane'
import { loadSnapshot, refreshSnapshot } from './lib/actions'
import { saveOpenTabs } from './lib/openTabs'
import { useStore } from './store'
import { fitPanelWidths } from './lib/panelLayout'
import { DEFAULT_RAIL_WIDTH } from './lib/preferences'

function clearViewedAttention(): void {
  const state = useStore.getState()
  const tab = state.terminals.find((item) => item.key === state.activeTab)
  if (tab?.sessionId) state.setAttention(tab.sessionId, null)
  if (state.activeTab === 'record' && state.selectedKey) {
    const session = state.snapshot?.sessions.find((item) => item.key === state.selectedKey)
    if (session) state.setAttention(session.id, null)
  }
}

export default function App(): React.JSX.Element {
  const snapshot = useStore((state) => state.snapshot)
  const loading = useStore((state) => state.loading)
  const query = useStore((state) => state.query)
  const selectedKey = useStore((state) => state.selectedKey)
  const view = useStore((state) => state.view)
  const setView = useStore((state) => state.setView)
  const theme = useStore((state) => state.snapshot?.settings.theme ?? 'system')
  const loadHistory = useStore(
    (state) => state.snapshot?.settings.loadHistory ?? false
  )
  const leftRailCollapsed = useStore((state) => state.leftRailCollapsed)
  const sessionListCollapsed = useStore(
    (state) => state.sessionListCollapsed
  )
  const leftRailWidth = useStore((state) => state.leftRailWidth)
  const sessionListWidth = useStore((state) => state.sessionListWidth)
  const setLeftRailWidth = useStore((state) => state.setLeftRailWidth)
  const setSessionListWidth = useStore((state) => state.setSessionListWidth)
  const terminals = useStore((state) => state.terminals)
  const activeTab = useStore((state) => state.activeTab)
  const sessionRefreshInterest = activeTab === 'record'
  const attention = useStore((state) => state.attention)
  const archived = useStore((state) => state.archived)
  const gitPanelProject = useStore((state) => state.gitPanelProject)
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const showSearchResults = Boolean(query.trim()) && !sessionListCollapsed
  const fitted = fitPanelWidths(viewportWidth, leftRailWidth, sessionListWidth,
    leftRailCollapsed, !showSearchResults)

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  useEffect(() => {
    if (theme === 'system') {
      delete document.documentElement.dataset.theme
    } else {
      document.documentElement.dataset.theme = theme
    }
  }, [theme])

  useEffect(() => {
    saveOpenTabs(terminals)
  }, [terminals])

  useEffect(() => {
    if (
      !loadHistory &&
      (view.type === 'history' || view.type === 'history-project')
    ) {
      setView({ type: 'all' })
    }
  }, [loadHistory, view.type, setView])

  useEffect(() => {
    void loadSnapshot()
    const unsubscribe = window.api.onDataChanged(() => {
      // The main process has already refreshed its index before notifying us.
      void loadSnapshot()
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    void window.api.setSessionRefreshInterest(sessionRefreshInterest).catch(() => undefined)
  }, [sessionRefreshInterest])

  useEffect(() => {
    const loadInbox = (): void => {
      void window.api.listInbox()
        .then((items) => useStore.getState().setInbox(items))
        .catch(() => undefined)
    }
    loadInbox()
    const offApprovals = window.api.onApprovalsChanged(loadInbox)
    const offSchedules = window.api.onSchedulesChanged(loadInbox)
    const offOpen = window.api.onApprovalsOpen(() => {
      useStore.getState().setApprovalPanelOpen(true)
      loadInbox()
    })
    return () => {
      offApprovals()
      offSchedules()
      offOpen()
    }
  }, [])

  useEffect(() => {
    const offActivity = window.api.onTerminalActivity((event) => {
      if (!event.sessionId) return
      const state = useStore.getState()
      state.setTerminalActivity(event.sessionId, event.activity)
      if (event.activity === 'working' || event.activity === 'background') {
        state.setAttention(event.sessionId, null)
      } else {
        const viewing = document.hasFocus() &&
          state.terminals.some((tab) => tab.key === state.activeTab && tab.sessionId === event.sessionId)
        if (!viewing) {
          state.setAttention(event.sessionId, event.activity === 'approval' ? 'approval' : 'completed')
        }
      }
    })
    const offFocus = window.api.onFocusSession((sessionId) => {
      const state = useStore.getState()
      const tab = [...state.terminals].reverse().find((item) => item.sessionId === sessionId)
      if (tab) state.setActiveTerminal(tab.key)
    })
    const offScreenshot = window.api.onScreenshotTrigger(() => {
      const state = useStore.getState()
      const active = state.terminals.find((item) => item.key === state.activeTab)
      const tab = active?.sessionId
        ? active
        : [...state.terminals].reverse().find((item) => item.sessionId)
      if (!tab?.sessionId) {
        state.showToast({ kind: 'error', message: '请先打开一个运行中的对话再截图' })
        return
      }
      const sessionId = tab.sessionId
      void window.api.captureScreenshot({ sessionId }).then((attachments) => {
        if (!attachments.length) return
        window.dispatchEvent(new CustomEvent('csm:attachments-added', {
          detail: { sessionId, attachments }
        }))
        state.showToast({ kind: 'success', message: '截图已插入当前对话' })
      }).catch((error: unknown) => {
        state.showToast({
          kind: 'error',
          message: `截图失败：${error instanceof Error ? error.message : String(error)}`
        })
      })
    })
    return () => {
      offActivity()
      offFocus()
      offScreenshot()
    }
  }, [])

  useEffect(() => {
    clearViewedAttention()
  }, [activeTab, selectedKey])

  useEffect(() => {
    window.addEventListener('focus', clearViewedAttention)
    return () => window.removeEventListener('focus', clearViewedAttention)
  }, [])

  useEffect(() => {
    const values = Object.values(attention)
    void window.api.updateAttention({
      total: values.length,
      completed: values.filter((kind) => kind === 'completed').length,
      approval: values.filter((kind) => kind === 'approval').length
    }).catch(() => undefined)
  }, [attention])

  useEffect(() => {
    if (
      gitPanelProject &&
      snapshot &&
      !snapshot.projects.some((project) => project.key === gitPanelProject)
    ) {
      useStore.getState().closeGitPanel()
    }
  }, [gitPanelProject, snapshot])

  useEffect(() => {
    if (
      snapshot &&
      selectedKey &&
      !snapshot.sessions.some((session) => session.key === selectedKey)
    ) {
      useStore.getState().selectSession(null)
    }
  }, [snapshot, selectedKey])

  const searchRequestId = useRef(0)

  useEffect(() => {
    const text = query.trim()
    const state = useStore.getState()
    if (!text) {
      state.setSearch(null)
      state.setSearching(false)
      return undefined
    }

    let cancelled = false
    const requestId = ++searchRequestId.current
    state.setSearching(true)

    const timer = setTimeout(() => {
      window.api
        .search(text, requestId)
        .then((result) => {
          if (!cancelled && requestId === searchRequestId.current) {
            state.setSearch(result)
          }
        })
        .catch((error: unknown) => {
          if (!cancelled && requestId === searchRequestId.current) {
            state.showToast({
              kind: 'error',
              message: `搜索失败：${
                error instanceof Error ? error.message : String(error)
              }`
            })
          }
        })
        .finally(() => {
          if (!cancelled && requestId === searchRequestId.current) state.setSearching(false)
        })
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, snapshot?.scannedAt])

  if (loading && !snapshot) {
    return <div className="boot">正在扫描 Claude 会话…</div>
  }

  if (!snapshot && !loading) {
    return (
      <div className="onboarding">
        <h1>暂时无法加载会话</h1>
        <p>请重试扫描；如果问题持续，请检查 Claude 数据目录的读取权限。</p>
        <button onClick={() => void refreshSnapshot()}>重新扫描</button>
        <Toast />
      </div>
    )
  }

  return (
    <div className="app-shell">
      <TopBar />
      <div
        className="app-body"
        style={
          {
            '--rail-width': `${fitted.rail}px`,
            '--session-width': `${fitted.list}px`
          } as CSSProperties
        }
      >
        {!leftRailCollapsed && (
          <>
            <ProjectRail />
            <PanelResizer
              value={fitted.rail}
              min={240}
              max={Math.max(
                240,
                Math.min(
                  480,
                  viewportWidth - fitted.list - 308
                )
              )}
              defaultValue={DEFAULT_RAIL_WIDTH}
              onChange={setLeftRailWidth}
            />
          </>
        )}
        {showSearchResults && (
          <>
            <SearchResults />
            <PanelResizer
              value={fitted.list}
              min={240}
              max={Math.max(
                240,
                Math.min(
                  640,
                  viewportWidth - fitted.rail - 308
                )
              )}
              defaultValue={340}
              onChange={setSessionListWidth}
            />
          </>
        )}
        <WorkspacePane />
      </div>
      <TerminalStartDialog />
      <SettingsDialog />
      <ClaudeMdEditorDialog />
      <TemplateManagerDialog />
      <ScheduledTasksDialog />
      <GitPanel />
      <AttentionInbox />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Toast />
    </div>
  )
}
