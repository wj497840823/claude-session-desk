import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import PanelResizer from './components/PanelResizer'
import ProjectRail from './components/ProjectRail'
import SearchResults from './components/SearchResults'
import SettingsDialog from './components/SettingsDialog'
import TerminalStartDialog from './components/TerminalStartDialog'
import Toast from './components/Toast'
import TopBar from './components/TopBar'
import WorkspacePane from './components/WorkspacePane'
import { loadSnapshot, refreshSnapshot } from './lib/actions'
import { useStore } from './store'
import { fitPanelWidths } from './lib/panelLayout'

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
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth)
  const showSearchResults = Boolean(query.trim()) && !sessionListCollapsed
  const fitted = fitPanelWidths(viewportWidth, leftRailWidth, sessionListWidth,
    leftRailCollapsed, !showSearchResults)

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (theme === 'system') {
      delete document.documentElement.dataset.theme
    } else {
      document.documentElement.dataset.theme = theme
    }
  }, [theme])

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
      {snapshot && !snapshot.dataRootExists && (
        <div className="notice">
          尚未找到会话目录：{snapshot.dataRoot}。你可以选择项目文件夹新建对话。
        </div>
      )}
      {snapshot && snapshot.skippedFiles > 0 && (
        <div className="notice">
          有 {snapshot.skippedFiles} 个会话文件无法读取，已跳过。
        </div>
      )}
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
              defaultValue={320}
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
      <Toast />
    </div>
  )
}
