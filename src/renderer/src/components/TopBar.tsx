import {
  List,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Settings
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import { refreshSnapshot } from '../lib/actions'
import { useStore } from '../store'

export default function TopBar(): React.JSX.Element {
  const query = useStore((state) => state.query)
  const setQuery = useStore((state) => state.setQuery)
  const refreshing = useStore((state) => state.refreshing)
  const historyOnly = useStore(
    (state) => state.snapshot?.historyOnlyCount ?? 0
  )
  const transcriptCount = useStore(
    (state) => state.snapshot
      ? state.snapshot.sessions.filter((session) =>
          session.source === 'transcript' &&
          !state.archived.includes(session.id) &&
          !state.archived.includes(session.key)
        ).length
      : 0
  )
  const setSettingsOpen = useStore((state) => state.setSettingsOpen)
  const leftRailCollapsed = useStore((state) => state.leftRailCollapsed)
  const toggleLeftRail = useStore((state) => state.toggleLeftRail)
  const sessionListCollapsed = useStore(
    (state) => state.sessionListCollapsed
  )
  const toggleSessionList = useStore((state) => state.toggleSessionList)
  const terminals = useStore((state) => state.terminals)
  const attention = useStore((state) => state.attention)
  const setActiveTerminal = useStore((state) => state.setActiveTerminal)
  const clearAllAttention = useStore((state) => state.clearAllAttention)
  const attentionCount = Object.keys(attention).length
  const pendingTab = terminals.find(
    (tab) => tab.sessionId && attention[tab.sessionId]
  )
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (useStore.getState().terminalFocused) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
      if (event.key === 'Escape' && document.activeElement === inputRef.current) {
        setQuery('')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setQuery])

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">C</span>
        <span>Claude Session Desk</span>
        <span className="brand-sub">会话工作台</span>
      </div>
      <button
        className="icon-button"
        title={leftRailCollapsed ? '展开项目与会话' : '收起项目与会话'}
        onClick={toggleLeftRail}
      >
        {leftRailCollapsed ? (
          <PanelLeftOpen size={16} />
        ) : (
          <PanelLeftClose size={16} />
        )}
      </button>
      <button
        className="icon-button"
        title={
          sessionListCollapsed || leftRailCollapsed ? '展开会话列表' : '收起会话列表'
        }
        onClick={toggleSessionList}
      >
        <List size={16} />
      </button>
      <div className="search-box">
        <Search size={15} aria-hidden />
        <input
          ref={inputRef}
          value={query}
          aria-label="搜索全部会话"
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索全部会话…（Ctrl+K）"
          spellCheck={false}
        />
        {query && (
          <button className="search-clear" onClick={() => setQuery('')} title="清空">
            ×
          </button>
        )}
      </div>
      <div className="topbar-meta">
        {attentionCount > 0 && (
          <div className="attention-chip" role="status">
            <button
              className="attention-jump"
              disabled={!pendingTab}
              onClick={() => pendingTab && setActiveTerminal(pendingTab.key)}
              title="跳到待查看对话"
            >
              待查看 {attentionCount}
            </button>
            <button
              className="attention-clear"
              onClick={clearAllAttention}
              title="全部标为已读"
              aria-label="全部标为已读"
            >
              ×
            </button>
          </div>
        )}
        <span title={`活动对话 ${transcriptCount} 个，历史记录 ${historyOnly} 个`}>
          {transcriptCount} 个活动会话
          {historyOnly > 0 ? ` · ${historyOnly} 条历史` : ''}
        </span>
        <button
          className="icon-button"
          onClick={() => setSettingsOpen(true)}
          title="设置"
        >
          <Settings size={16} />
        </button>
        <button
          className="icon-button"
          onClick={() => void refreshSnapshot()}
          disabled={refreshing}
          title="刷新"
        >
          <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
        </button>
      </div>
    </header>
  )
}
