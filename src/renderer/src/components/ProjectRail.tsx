import {
  Archive,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Layers,
  MessageSquarePlus,
  Plus,
  Star,
  Terminal,
  Trash2
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProjectSummary, SessionSummary } from '@shared/types'
import {
  deleteProjectSessions,
  deleteSession,
  openProject,
  openProjectTerminal
} from '../lib/actions'
import { formatRelativeTime } from '../lib/sessionView'
import { useStore } from '../store'
import ConfirmDialog from './ConfirmDialog'
import SessionList from './SessionList'

interface ContextMenuState {
  x: number
  y: number
  project: ProjectSummary
}

type PendingDelete =
  | { kind: 'session'; session: SessionSummary }
  | { kind: 'project'; project: ProjectSummary }
  | null

export default function ProjectRail(): React.JSX.Element {
  const snapshot = useStore((state) => state.snapshot)
  const view = useStore((state) => state.view)
  const focusedProjectKey = useStore((state) => state.focusedProjectKey)
  const selectedKey = useStore((state) => state.selectedKey)
  const expandedProjectKeys = useStore((state) => state.expandedProjectKeys)
  const toggleProject = useStore((state) => state.toggleProject)
  const sessionListCollapsed = useStore((state) => state.sessionListCollapsed)
  const setView = useStore((state) => state.setView)
  const toggleView = useStore((state) => state.toggleView)
  const openTerminalDialog = useStore((state) => state.openTerminalDialog)
  const showToast = useStore((state) => state.showToast)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [deleteSessionsOpen, setDeleteSessionsOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const activeProjectRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // The selected session scrolls itself into view; scrolling its header afterward
    // would move a long project's active session back out of the viewport.
    if (!selectedKey || sessionListCollapsed || !focusedProjectKey || !expandedProjectKeys.includes(focusedProjectKey)) {
      activeProjectRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [focusedProjectKey, selectedKey, sessionListCollapsed, expandedProjectKeys, snapshot?.projects.length])

  const activeCount = snapshot?.transcriptCount ?? 0
  const favoriteCount =
    snapshot?.sessions.filter((session) => session.favorite).length ?? 0
  const historyCount = snapshot?.historyOnlyCount ?? 0
  const historyEnabled = snapshot?.settings.loadHistory ?? false
  const activeProjects =
    snapshot?.projects.filter((project) => project.transcriptCount > 0) ?? []
  const historyProjects =
    snapshot?.projects.filter((project) => project.historyCount > 0) ?? []

  const sessionsForProject = (projectKey: string): SessionSummary[] =>
    (snapshot?.sessions ?? []).filter(
      (session) =>
        session.projectKey === projectKey && session.source === 'transcript'
    )

  const contextSessions = contextMenu
    ? sessionsForProject(contextMenu.project.key)
    : []
  const pendingProjectCount =
    pendingDelete?.kind === 'project'
      ? sessionsForProject(pendingDelete.project.key).length
      : 0

  useEffect(() => {
    if (view.type === 'history' || view.type === 'history-project') {
      setHistoryOpen(true)
    }
  }, [view.type, view.type === 'history-project' ? view.projectKey : null])

  useEffect(() => {
    if (!contextMenu) return undefined
    const close = (): void => {
      setContextMenu(null)
      setDeleteSessionsOpen(false)
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      ) {
        return
      }
      close()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', close)
    }
  }, [contextMenu])

  const handleNewProject = async (): Promise<void> => {
    try {
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
      if (!result.path) return
      const parts = result.path.split(/[\\/]/).filter(Boolean)
      openTerminalDialog({
        kind: 'new-project',
        cwd: result.path,
        projectName: parts[parts.length - 1] ?? result.path
      })
    } catch (error) {
      showToast({
        kind: 'error',
        message: `选择文件夹失败：${
          error instanceof Error ? error.message : String(error)
        }`
      })
    }
  }

  const openContextMenu = (
    event: React.MouseEvent<HTMLDivElement>,
    project: ProjectSummary
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      project
    })
    setDeleteSessionsOpen(false)
  }

  const closeContextMenu = (): void => {
    setContextMenu(null)
    setDeleteSessionsOpen(false)
  }

  const handleOpenProjectTerminal = (project: ProjectSummary): void => {
    closeContextMenu()
    void openProjectTerminal(project.key)
  }

  const handleOpenProjectFolder = (project: ProjectSummary): void => {
    closeContextMenu()
    void openProject(project.key)
  }

  const queueDeleteSession = (session: SessionSummary): void => {
    closeContextMenu()
    setPendingDelete({ kind: 'session', session })
  }

  const queueDeleteProject = (project: ProjectSummary): void => {
    closeContextMenu()
    setPendingDelete({ kind: 'project', project })
  }

  return (
    <>
      <aside className="rail" aria-label="项目与会话" onScroll={() => closeContextMenu()}>
        <nav className="rail-nav">
          <button
            className={`rail-item ${view.type === 'all' ? 'active' : ''}`}
            aria-expanded={view.type === 'all' && !sessionListCollapsed}
            onClick={() => toggleView({ type: 'all' })}
          >
            {view.type === 'all' && !sessionListCollapsed ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Layers size={15} />
            <span>活动会话</span>
            <span className="rail-count">{activeCount}</span>
          </button>
          {!sessionListCollapsed && view.type === 'all' && (
            <SessionList embedded />
          )}
          <button
            className={`rail-item ${view.type === 'favorites' ? 'active' : ''}`}
            aria-expanded={view.type === 'favorites' && !sessionListCollapsed}
            onClick={() => toggleView({ type: 'favorites' })}
          >
            {view.type === 'favorites' && !sessionListCollapsed ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Star size={15} />
            <span>收藏</span>
            <span className="rail-count">{favoriteCount}</span>
          </button>
          {!sessionListCollapsed && view.type === 'favorites' && (
            <SessionList embedded />
          )}
        </nav>

        <div className="rail-heading-row">
          <div className="rail-heading">项目</div>
          <button
            className="rail-add-project"
            title="选择文件夹并新建项目"
            onClick={() => void handleNewProject()}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="rail-projects">
          {activeProjects.map((project) => {
            const expanded = view.type === 'project' && !sessionListCollapsed && expandedProjectKeys.includes(project.key)
            return (
            <div className="rail-project-group" key={project.key}>
            <div
              data-project-key={project.key}
              ref={focusedProjectKey === project.key ? activeProjectRef : undefined}
              className={`rail-project ${
                focusedProjectKey === project.key
                  ? 'active'
                  : ''
              }`}
              title={`${project.path || project.key}\n活动对话 ${project.transcriptCount}${
                project.historyCount > 0
                  ? ` · 历史记录 ${project.historyCount}`
                  : ''
              }`}
              onContextMenu={(event) => openContextMenu(event, project)}
            >
              <button
                className="rail-project-main"
                aria-expanded={expanded}
                onClick={() => toggleProject(project.key)}
              >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                <span className="rail-project-name">{project.name}</span>
                {project.historyCount > 0 && (
                  <span
                    className="rail-history-hint"
                    title={`另有 ${project.historyCount} 条历史记录`}
                  >
                    +{project.historyCount}
                  </span>
                )}
                <span className="rail-count">{project.transcriptCount}</span>
              </button>
              {project.path && (
                <button
                  className="rail-project-open rail-project-chat"
                  title="在应用内新建对话"
                  onClick={() =>
                    openTerminalDialog({
                      kind: 'new',
                      cwd: project.path,
                      projectName: project.name
                    })
                  }
                >
                  <MessageSquarePlus size={13} />
                </button>
              )}
            </div>
            {expanded && (
              <div className="rail-project-sessions">
                <SessionList embedded listView={{ type: 'project', projectKey: project.key }} />
              </div>
            )}
            </div>
          )})}
          {activeProjects.length === 0 && (
            <div className="rail-empty">没有活动项目</div>
          )}
        </div>


        {historyEnabled && (
          <>
            <button
              className="rail-section-toggle"
              onClick={() => setHistoryOpen((open) => !open)}
              title="展开或收起历史记录"
            >
              {historyOpen ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )}
              <Archive size={14} />
              <span>历史记录</span>
              <span className="rail-count">{historyCount}</span>
            </button>

            {historyOpen && (
              <div className="rail-history">
                <button
                  className={`rail-item ${
                    view.type === 'history' ? 'active' : ''
                  }`}
                  onClick={() => setView({ type: 'history' })}
                >
                  <Archive size={14} />
                  <span>全部历史记录</span>
                  <span className="rail-count">{historyCount}</span>
                </button>
                {historyProjects.map((project) => (
                  <div
                    key={project.key}
                    className={`rail-project history ${
                      view.type === 'history-project' &&
                      view.projectKey === project.key
                        ? 'active'
                        : ''
                    }`}
                    title={`${project.path || project.key}\n历史记录 ${project.historyCount}`}
                  >
                    <button
                      className="rail-project-main"
                      onClick={() =>
                        setView({
                          type: 'history-project',
                          projectKey: project.key
                        })
                      }
                    >
                      <Archive size={13} />
                      <span className="rail-project-name">{project.name}</span>
                      <span className="rail-count">{project.historyCount}</span>
                    </button>
                    <button
                      className="rail-project-open"
                      title="在资源管理器中打开"
                      onClick={() => void openProject(project.key)}
                    >
                      <FolderOpen size={13} />
                    </button>
                  </div>
                ))}
                {historyProjects.length === 0 && (
                  <div className="rail-empty">没有历史记录</div>
                )}
              </div>
            )}
          </>
        )}
        {historyEnabled && historyOpen && !sessionListCollapsed && (view.type === 'history' || view.type === 'history-project') && (
          <SessionList embedded />
        )}
      </aside>

      {contextMenu &&
        createPortal(
          <div
            ref={menuRef}
            className="context-menu"
            role="menu"
            style={{
              left: Math.min(contextMenu.x, window.innerWidth - 280),
              top: Math.min(contextMenu.y, window.innerHeight - 300)
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              role="menuitem"
              onClick={() => handleOpenProjectTerminal(contextMenu.project)}
            >
              <Terminal size={14} />
              在终端中打开
            </button>
            <button
              role="menuitem"
              onClick={() => handleOpenProjectFolder(contextMenu.project)}
            >
              <FolderOpen size={14} />
              在文件夹中打开
            </button>
            <div className="context-separator" />
            <button
              role="menuitem"
              disabled={contextSessions.length === 0}
              onClick={() => setDeleteSessionsOpen((open) => !open)}
            >
              <Trash2 size={14} />
              删除会话
              <span className="context-chevron">
                {deleteSessionsOpen ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
              </span>
            </button>
            {deleteSessionsOpen && contextSessions.length > 0 && (
              <div className="context-submenu">
                {contextSessions.map((session) => (
                  <button
                    key={session.key}
                    role="menuitem"
                    onClick={() => queueDeleteSession(session)}
                  >
                    <span className="context-session-title">
                      {session.title}
                    </span>
                    <small>{formatRelativeTime(session.updatedAt)}</small>
                  </button>
                ))}
              </div>
            )}
            <button
              role="menuitem"
              className="danger"
              disabled={contextSessions.length === 0}
              onClick={() => queueDeleteProject(contextMenu.project)}
            >
              <Trash2 size={14} />
              删除整个项目的会话
            </button>
          </div>,
          document.body
        )}

      {pendingDelete && (
        <ConfirmDialog
          title={
            pendingDelete.kind === 'session'
              ? '删除会话'
              : '删除整个项目的会话'
          }
          confirmLabel="删除"
          danger
          message={
            pendingDelete.kind === 'session' ? (
              <p>
                将删除「{pendingDelete.session.title}」及其附属数据，并移入系统回收站；相关终端会先关闭。
              </p>
            ) : (
              <p>
                将删除该项目下 {pendingProjectCount}{' '}
                个完整会话并移入系统回收站；项目文件夹和历史记录保留，相关终端会先关闭。
              </p>
            )
          }
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const target = pendingDelete
            setPendingDelete(null)
            if (target.kind === 'session') {
              void deleteSession(target.session.key)
            } else {
              void deleteProjectSessions(target.project.key)
            }
          }}
        />
      )}
    </>
  )
}
