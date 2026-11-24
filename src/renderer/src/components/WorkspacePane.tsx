import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { FileText, MoreHorizontal, Plus, X } from 'lucide-react'
import type { TerminalActivity } from '@shared/types'
import { useStore, type TerminalSession, type TerminalStatus } from '../store'
import ConfirmDialog from './ConfirmDialog'
import { closeConversationTabs } from '../lib/actions'

const SessionDetail = lazy(() => import('./SessionDetail'))
const TerminalTab = lazy(() => import('./TerminalTab'))

function tabLabel(
  terminals: TerminalSession[],
  tab: TerminalSession,
  index: number
): string {
  const base = tab.sessionTitle?.trim() ||
    (tab.kind === 'resume' ? '恢复的对话' : tab.kind === 'fork' ? '副本对话' : '新对话')
  const earlier = terminals
    .slice(0, index)
    .filter(
      (item) => item.projectName === tab.projectName && item.kind === tab.kind
    ).length
  return earlier > 0 ? `${base} ${earlier + 1}` : base
}

function tabState(
  tab: TerminalSession,
  status: TerminalStatus | undefined,
  activity: TerminalActivity | undefined
): { text: string; short: string; kind: string } {
  if (status === 'starting') return { text: '启动中', short: 'S', kind: 'starting' }
  if (status === 'running') {
    if (activity === 'approval') return { text: '待确认', short: 'A', kind: 'approval' }
    if (activity === 'background') return { text: '后台任务中', short: 'B', kind: 'background' }
    if (activity === 'idle') return { text: '完成', short: 'D', kind: 'idle' }
    if (activity === 'working') return { text: '工作中', short: 'W', kind: 'working' }
    return { text: '运行中', short: 'R', kind: 'running' }
  }
  if (tab.dormant) return { text: '未启动', short: 'U', kind: 'stopped' }
  return { text: '已结束', short: 'E', kind: 'stopped' }
}

function projectNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export default function WorkspacePane(): React.JSX.Element {
  const terminals = useStore((state) => state.terminals)
  const activeTab = useStore((state) => state.activeTab)
  const recordTabVisible = useStore((state) => state.recordTabVisible)
  const selectedKey = useStore((state) => state.selectedKey)
  const snapshot = useStore((state) => state.snapshot)
  const terminalStatus = useStore((state) => state.terminalStatus)
  const terminalActivity = useStore((state) => state.terminalActivity)
  const attention = useStore((state) => state.attention)
  const setActiveTerminal = useStore((state) => state.setActiveTerminal)
  const closeRecordTab = useStore((state) => state.closeRecordTab)
  const openTerminalDialog = useStore((state) => state.openTerminalDialog)
  const showToast = useStore((state) => state.showToast)

  const [pendingClose, setPendingClose] = useState<string[] | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selectedTabs, setSelectedTabs] = useState<string[]>([])
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSelectedTabs((keys) => keys.filter((key) => terminals.some((tab) => tab.key === key)))
  }, [terminals])
  useEffect(() => {
    tabsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTab, terminals.length])
  useEffect(() => {
    if (!menu) return undefined
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenu(null)
    }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') setMenu(null) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key) }
  }, [menu])

  const selectedSummary = snapshot?.sessions.find(
    (session) => session.key === selectedKey
  )
  const activeTerminal = terminals.find((tab) => tab.key === activeTab)
  const effectiveTab =
    activeTab === 'record' && selectedKey && recordTabVisible
      ? 'record'
      : activeTerminal
        ? activeTab
        : selectedKey && recordTabVisible
          ? 'record'
          : terminals[terminals.length - 1]?.key ?? ''

  const finishClose = (keys: string[]): void => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    void closeConversationTabs(keys).finally(() => { closingRef.current = false; setClosing(false) })
  }
  const requestClose = (keys: string[]): void => {
    if (closingRef.current) return
    setMenu(null)
    if (keys.length === 0) return
    if (keys.some((key) => terminalStatus[key] === 'running' || terminalStatus[key] === 'starting')) setPendingClose(keys)
    else finishClose(keys)
  }
  const toggleTab = (key: string): void => {
    setSelectedTabs((keys) => keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key])
  }

  const startNew = async (): Promise<void> => {
    const state = useStore.getState()
    const focusedProject = snapshot?.projects.find((project) => project.key === state.focusedProjectKey)
    const context =
      (focusedProject?.path ? { cwd: focusedProject.path, projectName: focusedProject.name } : undefined) ??
      terminals.find((tab) => tab.key === effectiveTab) ??
      (selectedSummary?.projectPath
        ? {
            cwd: selectedSummary.projectPath,
            projectName: projectNameOf(selectedSummary.projectPath)
          }
        : terminals[terminals.length - 1])

    if (context) {
      openTerminalDialog({
        kind: 'new',
        cwd: context.cwd,
        projectName: context.projectName
      })
      return
    }

    const result = await window.api.pickFolder()
    if (!result.ok) {
      if (result.message !== '已取消') {
        showToast({
          kind: 'error',
          message: result.message ?? '无法选择项目文件夹'
        })
      }
      return
    }
    if (result.path) {
      openTerminalDialog({
        kind: 'new-project',
        cwd: result.path,
        projectName: projectNameOf(result.path)
      })
    }
  }

  return (
    <section className="workspace-pane">
      <div className="workspace-tabbar">
      <div className="terminal-tabs workspace-tabs" role="tablist" ref={tabsRef}>
        {selectedSummary && recordTabVisible && (
          <div
            role="tab"
            tabIndex={0}
            aria-selected={effectiveTab === 'record'}
            className={`terminal-tab workspace-record-tab ${
              effectiveTab === 'record' ? 'active' : ''
            }`}
            title={selectedSummary.title}
            onClick={() => setActiveTerminal('record')}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setActiveTerminal('record')
              }
            }}
          >
            <FileText size={13} />
            <span className="terminal-tab-label">会话记录</span>
            <button
              className="terminal-tab-close"
              title="关闭会话记录"
              onClick={(event) => {
                event.stopPropagation()
                closeRecordTab()
              }}
            >
              <X size={12} />
            </button>
          </div>
        )}

        {terminals.map((tab, index) => {
          const status = terminalStatus[tab.key]
          const activity = tab.sessionId && status === 'running'
            ? terminalActivity[tab.sessionId]
            : undefined
          const state = tabState(tab, status, activity)
          const label = tabLabel(terminals, tab, index)
          return (
          <div
            key={tab.key}
            data-tab-key={tab.key}
            role="tab"
            tabIndex={0}
            aria-selected={tab.key === effectiveTab}
            className={`terminal-tab ${
              tab.key === effectiveTab ? 'active' : ''
            } ${selectedTabs.includes(tab.key) ? 'selected' : ''} ${
              activity ?? ''
            } ${tab.sessionId && attention[tab.sessionId] ? 'pending' : ''}`}
            title={`${label}\n${tab.projectName} · ${tab.cwd}\n${state.text}`}
            onClick={(event) => {
              if (selecting || event.ctrlKey || event.metaKey) {
                setSelecting(true)
                toggleTab(tab.key)
              } else setActiveTerminal(tab.key)
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu({ key: tab.key, x: Math.min(event.clientX, window.innerWidth - 200), y: event.clientY })
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setActiveTerminal(tab.key)
              }
            }}
          >
            {selecting && <input type="checkbox" aria-label={`选择标签 ${label}`}
              checked={selectedTabs.includes(tab.key)} onClick={(event) => event.stopPropagation()}
              onChange={() => toggleTab(tab.key)} />}
            {tab.sessionId && attention[tab.sessionId] && (
              <span
                className={`terminal-tab-attention ${attention[tab.sessionId]}`}
                title={attention[tab.sessionId] === 'approval' ? '等待确认，待查看' : '已完成，待查看'}
              />
            )}
            <span className="terminal-tab-label">{label}</span>
            <span className="terminal-tab-project" title={tab.projectName}>{tab.projectName}</span>
            <span
              className={`terminal-tab-letter ${state.kind}`}
              title={state.text}
              aria-label={state.text}
            >
              {state.short}
            </span>
            <button
              className="terminal-tab-close"
              title="关闭对话"
              onClick={(event) => {
                event.stopPropagation()
                requestClose([tab.key])
              }}
            >
              <X size={12} />
            </button>
          </div>
          )
        })}

      </div>
      <div className="workspace-tab-actions">
        <button
          className="terminal-tab-add"
          title="新建对话"
          onClick={() => void startNew()}
        >
          <Plus size={14} />
        </button>
        <button className="terminal-tab-add" title="标签管理" disabled={closing || terminals.length === 0}
          aria-haspopup="menu" aria-expanded={Boolean(menu)} onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setMenu(menu ? null : { key: effectiveTab, x: Math.max(4, rect.right - 190), y: rect.bottom })
          }}><MoreHorizontal size={15} /></button>
      </div>
      </div>

      {menu && <div className="menu tab-context-menu" role="menu" ref={menuRef}
        style={{ left: menu.x, top: menu.y }}>
        <button role="menuitem" disabled={!terminals.some((tab) => tab.key === menu.key)}
          onClick={() => { setSelecting(true); toggleTab(menu.key); setMenu(null) }}>
          {selectedTabs.includes(menu.key) ? '取消选择当前标签' : '选择当前标签'}
        </button>
        <button role="menuitem" onClick={() => { setSelecting(true); setSelectedTabs(terminals.map((tab) => tab.key)); setMenu(null) }}>全选标签</button>
        <button role="menuitem" disabled={closing || selectedTabs.length === 0}
          onClick={() => requestClose(selectedTabs)}>{closing ? '关闭中…' : `关闭选中 ${selectedTabs.length} 个对话`}</button>
        <button role="menuitem" disabled={!selecting}
          onClick={() => { setSelecting(false); setSelectedTabs([]); setMenu(null) }}>取消多选</button>
        <button role="menuitem" disabled={!terminals.some((tab) => tab.key === menu.key)}
          onClick={() => requestClose([menu.key])}>关闭当前对话</button>
        <button role="menuitem" disabled={!terminals.some((tab) => tab.key === menu.key) || terminals.length < 2}
          onClick={() => requestClose(terminals.filter((tab) => tab.key !== menu.key).map((tab) => tab.key))}>关闭其他对话</button>
        <button role="menuitem" disabled={terminals.findIndex((tab) => tab.key === menu.key) < 0 || terminals.at(-1)?.key === menu.key}
          onClick={() => requestClose(terminals.slice(terminals.findIndex((tab) => tab.key === menu.key) + 1).map((tab) => tab.key))}>关闭右侧对话</button>
        <button role="menuitem" disabled={!terminals.some((tab) => terminalStatus[tab.key] === 'stopped')}
          onClick={() => requestClose(terminals.filter((tab) => terminalStatus[tab.key] === 'stopped').map((tab) => tab.key))}>关闭已结束对话</button>
        <button role="menuitem" className="danger" onClick={() => requestClose(terminals.map((tab) => tab.key))}>关闭全部对话</button>
      </div>}

        <div className="workspace-content">
          {selectedKey && recordTabVisible && (
            <div
              className="workspace-record"
              style={{ display: effectiveTab === 'record' ? 'flex' : 'none' }}
            >
              <Suspense fallback={<div className="detail-empty" role="status">正在加载会话记录…</div>}>
                <SessionDetail />
              </Suspense>
            </div>
          )}

          {terminals.length > 0 && (
            <div
              className="workspace-terminal-views"
              style={{ display: effectiveTab === 'record' ? 'none' : 'flex' }}
            >
              <Suspense fallback={<div className="detail-empty" role="status">正在加载对话终端…</div>}>
              {terminals.map((tab) => (
                <TerminalTab
                  key={tab.key}
                  session={tab}
                  active={tab.key === effectiveTab}
                />
              ))}
              </Suspense>
            </div>
          )}

          {effectiveTab === '' && (
            <div className="workspace-empty">
              <FileText size={28} />
              <strong>还没有打开的会话</strong>
              <p>从左侧选择一个会话查看记录，或直接新建对话。</p>
              <button className="btn primary" onClick={() => void startNew()}>
                <Plus size={14} />
                新建对话
              </button>
            </div>
          )}
        </div>

      {pendingClose && (
        <ConfirmDialog
          title="关闭对话"
          confirmLabel="结束并关闭"
          danger
          message={
            <p>
              将关闭 {pendingClose.length} 个对话标签，其中仍在运行的对话会结束。Claude
              已写入磁盘的会话记录不会丢失。
            </p>
          }
          onCancel={() => setPendingClose(null)}
          onConfirm={() => {
            const keys = pendingClose
            setPendingClose(null)
            finishClose(keys)
          }}
        />
      )}
    </section>
  )
}
