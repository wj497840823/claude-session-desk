import { Folder, Star, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionSummary } from '@shared/types'
import {
  deleteHistorySessions,
  deleteTranscriptSessions,
  openSessionConversation,
  toggleFavorite
} from '../lib/actions'
import { filterSessions, formatRelativeTime } from '../lib/sessionView'
import type { View } from '../lib/sessionView'
import { useStore } from '../store'
import ConfirmDialog from './ConfirmDialog'

const PROJECT_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#0891b2',
  '#059669',
  '#d97706',
  '#dc2626',
  '#db2777',
  '#4f46e5'
]

function projectColor(key: string): string {
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0
  }
  return PROJECT_COLORS[hash % PROJECT_COLORS.length]
}

function projectNameOf(
  projectPath: string,
  projectKey: string,
  projects: Array<{ key: string; name: string }>
): string {
  const project = projects.find((item) => item.key === projectKey)
  if (project?.name) return project.name
  const parts = projectPath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? projectKey
}

interface SessionListProps {
  embedded?: boolean
  listView?: View
}

export default function SessionList({ embedded = false, listView }: SessionListProps): React.JSX.Element {
  const snapshot = useStore((state) => state.snapshot)
  const currentView = useStore((state) => state.view)
  const view = listView ?? currentView
  const selectedKey = useStore((state) => state.selectedKey)
  const selectSession = useStore((state) => state.selectSession)
  const setView = useStore((state) => state.setView)
  const openTerminalDialog = useStore((state) => state.openTerminalDialog)
  const sessionClickAction = useStore(
    (state) => state.snapshot?.settings.sessionClickAction ?? 'continue'
  )
  const selectedHistory = useStore((state) => state.selectedHistory)
  const toggleHistorySelection = useStore(
    (state) => state.toggleHistorySelection
  )
  const setHistorySelection = useStore((state) => state.setHistorySelection)
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [visibleCount, setVisibleCount] = useState(20)
  const [contextMenu, setContextMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)
  const activeRowRef = useRef<HTMLDivElement>(null)

  const sessions = snapshot ? filterSessions(snapshot.sessions, view) : []
  const shownCount = embedded
    ? Math.max(visibleCount, sessions.findIndex((session) => session.key === selectedKey) + 1)
    : sessions.length
  const projects = snapshot?.projects ?? []
  const projectMap = new Map(projects.map((item) => [item.key, item]))
  const showProjectBadge =
    view.type === 'all' ||
    view.type === 'favorites' ||
    view.type === 'history'
  const isHistoryView =
    view.type === 'history' || view.type === 'history-project'
  const selectable = sessions.filter((s) => s.source === 'history')
  const selection = selectedHistory
  const visibleKeys = new Set(selectable.map((session) => session.key))
  const selectedVisible = selection.filter((key) => visibleKeys.has(key))
  const setSelection = setHistorySelection
  const clearSelection = (): void => setSelection([])
  const allSelected =
    selectable.length > 0 && selectedVisible.length === selectable.length
  const someSelected = selectedVisible.length > 0 && !allSelected
  const selectedPrompts = sessions
    .filter((session) => selectedHistory.includes(session.key))
    .reduce((sum, session) => sum + session.promptCount, 0)

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected
    }
  }, [someSelected])
  useEffect(() => {
    const row = activeRowRef.current
    if (!row) return
    const rail = row.closest<HTMLElement>('.rail')
    if (!rail) { row.scrollIntoView({ block: 'nearest' }); return }
    const reveal = (): void => {
      if (!row.isConnected) return
      const item = row.getBoundingClientRect()
      const box = rail.getBoundingClientRect()
      if (item.bottom > box.bottom - 8) rail.scrollTop += item.bottom - box.bottom + 8
      else if (item.top < box.top + 8) rail.scrollTop -= box.top + 8 - item.top
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(rail)
    const frame = requestAnimationFrame(reveal)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [selectedKey, view.type, 'projectKey' in view ? view.projectKey : null])
  useEffect(() => { setContextMenu(null) }, [currentView, selectedKey])
  useEffect(() => { setVisibleCount(20) }, [view.type, 'projectKey' in view ? view.projectKey : null])
  useEffect(() => {
    if (!contextMenu) return undefined
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setContextMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setContextMenu(null) }
    const onBlur = (): void => setContextMenu(null)
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    window.addEventListener('scroll', onBlur, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('scroll', onBlur, true)
    }
  }, [contextMenu])
  const project =
    view.type === 'project' || view.type === 'history-project'
      ? snapshot?.projects.find((item) => item.key === view.projectKey)
      : undefined
  const title =
    view.type === 'favorites'
      ? '收藏'
      : view.type === 'history'
        ? '历史记录'
        : view.type === 'history-project'
          ? `${project?.name ?? '项目'} · 历史记录`
          : view.type === 'project'
            ? project?.name ?? '项目'
            : '活动会话'
  const historyLinkCount =
    view.type === 'project' ? project?.historyCount ?? 0 : 0

  const handleSelect = (session: SessionSummary): void => {
    if (
      sessionClickAction === 'continue' &&
      session.source === 'transcript' &&
      openSessionConversation(session)
    ) {
      return
    }
    selectSession(session.key)
  }

  return (
    <section className={embedded ? 'embedded-sessions' : 'session-column'} aria-label={view.type === 'project' ? `${title} · 会话` : title}>
      {!(embedded && (view.type === 'all' || view.type === 'favorites')) && (
      <div className={embedded ? 'embedded-session-head' : 'column-head'}>
        {!embedded && <span>{title}</span>}
        {embedded && isHistoryView && <span>{title}</span>}
        <span className="column-head-meta">
          {view.type === 'project' && project?.path && (
            <button
              className="text-button"
              onClick={() =>
                openTerminalDialog({
                  kind: 'new',
                  cwd: project.path,
                  projectName: project.name
                })
              }
            >
              新建对话
            </button>
          )}
          {historyLinkCount > 0 && view.type === 'project' && (
            <button
              className="text-button"
              onClick={() =>
                setView({ type: 'history-project', projectKey: view.projectKey })
              }
            >
              历史 {historyLinkCount}
            </button>
          )}
          <span className="muted">{sessions.length}</span>
        </span>
      </div>
      )}
      {isHistoryView && (
        <div className="history-toolbar">
          <label className="select-all-label">
            <input
              ref={selectAllRef}
              type="checkbox"
              aria-label="全选当前列表"
              disabled={deleting}
              checked={allSelected}
              onChange={() => {
                if (allSelected) clearSelection()
                else setSelection(selectable.map((session) => session.key))
              }}
            />
            <span>全选</span>
          </label>
          <span className="history-selected-count">
            {selectedVisible.length} 已选
          </span>
          {selectedVisible.length > 0 && (
            <button className="text-button" disabled={deleting} onClick={clearSelection}>
              取消选择
            </button>
          )}
          <button
            className="text-button danger"
            disabled={deleting || selectedVisible.length === 0}
            onClick={() => setPendingDelete([...selectedVisible])}
          >
            {deleting ? '删除中…' : '删除选中'}
          </button>
        </div>
      )}
      <div className="session-list" onScroll={() => setContextMenu(null)}>
        {sessions.slice(0, shownCount).map((session) => {
          const projectName = projectNameOf(
            session.projectPath,
            session.projectKey,
            projects
          )
          return (
          <div
            key={session.key}
            ref={selectedKey === session.key ? activeRowRef : undefined}
            data-session-key={session.key}
            className={`session-row ${selectedKey === session.key ? 'active' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => handleSelect(session)}
            onContextMenu={(event) => {
              if (session.source !== 'transcript') return
              event.preventDefault()
              setContextMenu({ key: session.key,
                x: Math.max(4, Math.min(event.clientX, window.innerWidth - 194)),
                y: Math.max(4, Math.min(event.clientY, window.innerHeight - 90)) })
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                handleSelect(session)
              }
            }}
            title={
              session.source === 'history'
                ? '完整对话已被 Claude 保留策略清理，仅保留提示记录'
                : `${session.title}\n${new Date(session.updatedAt).toLocaleString()}`
            }
          >
            {isHistoryView && (
              <input
                type="checkbox"
                className="session-check"
                checked={selection.includes(session.key)}
                disabled={deleting}
                onClick={(event) => event.stopPropagation()}
                onChange={() => toggleHistorySelection(session.key)}
                aria-label="选择历史会话"
              />
            )}
            <div className="session-main">
              <div className="session-title">{session.title}</div>
              <div className="session-meta">
                {session.source === 'history' && (
                  <span className="source-badge history">已清理</span>
                )}
                {showProjectBadge && (
                  <>
                    <button
                      className="session-project"
                      title={
                        projectMap.get(session.projectKey)?.path ||
                        session.projectPath ||
                        projectName
                      }
                      onClick={(event) => {
                        event.stopPropagation()
                        setView(
                          session.source === 'history'
                            ? {
                                type: 'history-project',
                                projectKey: session.projectKey
                              }
                            : {
                                type: 'project',
                                projectKey: session.projectKey
                              }
                        )
                      }}
                    >
                      <span
                        className="project-dot"
                        style={{
                          background: projectColor(session.projectKey)
                        }}
                      />
                      <Folder size={11} />
                      <span className="session-project-name">{projectName}</span>
                    </button>
                    <span>·</span>
                  </>
                )}
                <span>{formatRelativeTime(session.updatedAt)}</span>
                <span>·</span>
                <span>
                  {session.source === 'history'
                    ? `${session.promptCount} 条提示`
                    : `${session.messageCount} 条消息`}
                </span>
              </div>
            </div>
            <button
              className={`star-button ${session.favorite ? 'on' : ''}`}
              title={session.favorite ? '取消收藏' : '收藏'}
              onClick={(event) => {
                event.stopPropagation()
                void toggleFavorite(session.key, !session.favorite)
              }}
            >
              <Star size={14} fill={session.favorite ? 'currentColor' : 'none'} />
            </button>
          </div>
          )
        })}
        {sessions.length === 0 && (
          <div className="list-empty">
            {view.type === 'favorites'
              ? '还没有收藏的会话'
              : view.type === 'history' || view.type === 'history-project'
                ? '没有历史记录'
                : '没有活动会话'}
          </div>
        )}
        {shownCount < sessions.length && (
          <button className="more-sessions text-button" onClick={() => setVisibleCount(shownCount + 20)}>
            显示更早会话（{sessions.length - shownCount}）
          </button>
        )}
      </div>
      {contextMenu && createPortal(
        <div className="menu session-context-menu" role="menu" ref={menuRef}
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, width: 190, zIndex: 45 }}>
          <button role="menuitem" onClick={() => { selectSession(contextMenu.key); setContextMenu(null) }}>查看会话记录</button>
          <button role="menuitem" className="danger" disabled={deleting} onClick={() => {
            setPendingDelete([contextMenu.key]); setContextMenu(null)
          }}><Trash2 size={14} />删除会话</button>
        </div>, document.body
      )}
      {pendingDelete && (
        <ConfirmDialog
          title={isHistoryView ? '删除历史记录' : '删除活动会话'}
          confirmLabel={isHistoryView ? '永久删除' : '移入回收站'}
          danger
          message={
            isHistoryView ? <p>
              将从 <code>~/.claude/history.jsonl</code> 中永久删除{' '}
              {pendingDelete.length} 个历史会话的 {selectedPrompts} 条提示记录。
              操作前会自动备份该文件，删除后无法通过应用恢复。
            </p> : <p>
              将删除该完整会话及其附属数据，并移入系统回收站。
              对应的运行中对话会先结束并关闭标签。项目文件夹和历史提示记录保留。
            </p>
          }
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const keys = pendingDelete
            setPendingDelete(null)
            setDeleting(true)
            void (isHistoryView ? deleteHistorySessions(keys) : deleteTranscriptSessions(keys))
              .finally(() => setDeleting(false))
          }}
        />
      )}
    </section>
  )
}
