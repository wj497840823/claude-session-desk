import {
  Download,
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  Star,
  Terminal,
  Trash2
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { HistoryDetail, SessionDetail as SessionDetailType } from '@shared/types'
import {
  deleteHistorySessions,
  deleteSession,
  exportSession,
  openProject,
  resumeSession,
  toggleFavorite
} from '../lib/actions'
import { useStore } from '../store'
import CommandDialog from './CommandDialog'
import ConfirmDialog from './ConfirmDialog'
import HistoryPromptList from './HistoryPromptList'
import MessageStream from './MessageStream'

function formatDate(timestamp: number): string {
  if (!timestamp) return '时间未知'
  return new Date(timestamp).toLocaleString('zh-CN')
}

function projectNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export default function SessionDetail(): React.JSX.Element {
  const selectedKey = useStore((state) => state.selectedKey)
  const matchUuid = useStore((state) => state.matchUuid)
  const matchPromptIndex = useStore((state) => state.matchPromptIndex)
  const snapshot = useStore((state) => state.snapshot)
  const detail = useStore((state) => state.detail)
  const historyDetail = useStore((state) => state.historyDetail)
  const detailLoading = useStore((state) => state.detailLoading)
  const setDetail = useStore((state) => state.setDetail)
  const setHistoryDetail = useStore((state) => state.setHistoryDetail)
  const setDetailLoading = useStore((state) => state.setDetailLoading)
  const showToast = useStore((state) => state.showToast)
  const openTerminalDialog = useStore((state) => state.openTerminalDialog)

  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmHistoryDelete, setConfirmHistoryDelete] = useState(false)
  const [commandDialog, setCommandDialog] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return undefined

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (
        target instanceof Node &&
        menuRef.current &&
        !menuRef.current.contains(target)
      ) {
        setMenuOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    const onWindowBlur = (): void => setMenuOpen(false)

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [menuOpen])

  const summary = snapshot?.sessions.find((session) => session.key === selectedKey)
  const isHistory = Boolean(selectedKey?.startsWith('history/'))
  const revision = isHistory
    ? `${summary?.updatedAt}:${summary?.promptCount}`
    : `${summary?.updatedAt}:${summary?.sizeBytes}`

  useEffect(() => {
    setMenuOpen(false)
    setConfirmDelete(false)
    setConfirmHistoryDelete(false)
    setCommandDialog(null)
    if (useStore.getState().detail?.key !== selectedKey) setDetail(null)
    if (useStore.getState().historyDetail?.key !== selectedKey) setHistoryDetail(null)

    if (!selectedKey) {
      setDetailLoading(false)
      return undefined
    }

    let cancelled = false
    setDetailLoading(true)
    const request = selectedKey.startsWith('history/')
      ? window.api.getHistoryDetail(selectedKey)
      : window.api.getSessionDetail(selectedKey)

    request
      .then((value) => {
        if (cancelled) return
        if (selectedKey.startsWith('history/')) {
          setHistoryDetail(value as HistoryDetail)
        } else {
          setDetail(value as SessionDetailType)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          showToast({
            kind: 'error',
            message: `读取会话失败：${
              error instanceof Error ? error.message : String(error)
            }`
          })
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedKey, revision, setDetail, setHistoryDetail, setDetailLoading, showToast])

  if (!selectedKey) {
    return (
      <section className="detail-pane">
        <div className="detail-empty">选择一个会话查看内容</div>
      </section>
    )
  }

  const title = historyDetail?.title ?? detail?.title ?? summary?.title ?? '加载中…'
  const projectPath =
    historyDetail?.projectPath ?? detail?.projectPath ?? summary?.projectPath ?? ''
  const favorite = summary?.favorite ?? false
  const promptCount = historyDetail?.prompts.length ?? summary?.promptCount ?? 0

  return (
    <section className="detail-pane">
      <header className="detail-header">
        <div className="detail-title-row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="detail-title">{title}</div>
            <div className="detail-sub">
              {isHistory && <span className="source-badge history">对话已清理</span>}
              {projectPath && (
                <span title={projectPath} style={{ overflowWrap: 'anywhere' }}>
                  {projectPath}
                </span>
              )}
              {isHistory ? (
                <>
                  <span>·</span>
                  <span>{promptCount} 条提示</span>
                  <span>·</span>
                  <span>
                    {formatDate(
                      historyDetail?.updatedAt ?? summary?.updatedAt ?? 0
                    )}
                  </span>
                </>
              ) : (
                detail && (
                  <>
                    <span>·</span>
                    <span>{formatDate(detail.createdAt)}</span>
                    <span>·</span>
                    <span>{detail.totalEvents} 个事件</span>
                    {detail.skippedLines > 0 && (
                      <span>· {detail.skippedLines} 行无法解析</span>
                    )}
                  </>
                )
              )}
            </div>
          </div>
          <button
            className={`star-button ${favorite ? 'on' : ''}`}
            title={favorite ? '取消收藏' : '收藏'}
            onClick={() => void toggleFavorite(selectedKey, !favorite)}
          >
            <Star size={17} fill={favorite ? 'currentColor' : 'none'} />
          </button>
        </div>

        <div className="detail-actions">
          {!isHistory && (
            <>
              <button
                className="btn primary"
                disabled={!summary || !summary.cwdExists}
                onClick={() => {
                  if (!summary?.projectPath) return
                  openTerminalDialog({
                    kind: 'resume',
                    cwd: summary.projectPath,
                    projectName: projectNameOf(summary.projectPath),
                    sessionId: summary.id,
                    sessionTitle: title
                  })
                }}
              >
                <MessageSquare size={14} />
                在应用内对话
              </button>
              <button
                className="btn"
                disabled={!summary}
                onClick={() => {
                  void resumeSession(selectedKey).then((result) => {
                    if (!result.ok && result.command) setCommandDialog(result.command)
                  })
                }}
              >
                <Terminal size={14} />
                在终端恢复
              </button>
              <button
                className="btn"
                disabled={!detail}
                onClick={() => void exportSession(selectedKey)}
              >
                <Download size={14} />
                导出 Markdown
              </button>
            </>
          )}
          {isHistory && (
            <>
              <button
                className="btn"
                disabled={!summary}
                onClick={() => {
                  if (summary) void openProject(summary.projectKey)
                }}
              >
                <FolderOpen size={14} />
                打开项目文件夹
              </button>
              <button
                className="btn danger"
                disabled={!historyDetail}
                onClick={() => setConfirmHistoryDelete(true)}
              >
                <Trash2 size={14} />
                删除历史记录
              </button>
            </>
          )}
          <div className="menu-wrap" ref={menuRef}>
            <button
              className="btn ghost"
              title="更多"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={16} />
            </button>
            {menuOpen && (
              <div className="menu" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    if (summary) void openProject(summary.projectKey)
                  }}
                >
                  <FolderOpen size={14} />
                  打开项目文件夹
                </button>
                {!isHistory && (
                  <button
                    role="menuitem"
                    className="danger"
                    onClick={() => {
                      setMenuOpen(false)
                      setConfirmDelete(true)
                    }}
                  >
                    <Trash2 size={14} />
                    删除会话
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {detailLoading && !detail && !historyDetail ? (
        <div className="detail-empty">
          {isHistory ? '正在读取历史记录…' : '正在解析会话…'}
        </div>
      ) : isHistory && historyDetail ? (
        <HistoryPromptList
          prompts={historyDetail.prompts}
          matchPromptIndex={matchPromptIndex}
        />
      ) : !isHistory && detail ? (
        <MessageStream key={`${detail.key}:${matchUuid ?? ''}`} detail={detail} matchUuid={matchUuid} />
      ) : (
        <div className="detail-empty">
          {isHistory ? '无法读取历史记录' : '无法读取此会话'}
        </div>
      )}

      {!isHistory && confirmDelete && (
        <ConfirmDialog
          title="删除会话"
          confirmLabel="移入回收站"
          danger
          message={
            <p>
              将删除「{title}」及其附属数据（子代理记录、工具结果），并移入系统回收站。
              如果该会话正在 Claude 中运行，可能影响当前进程。
            </p>
          }
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false)
            void deleteSession(selectedKey)
          }}
        />
      )}

      {isHistory && confirmHistoryDelete && (
        <ConfirmDialog
          title="删除历史记录"
          confirmLabel="永久删除"
          danger
          message={
            <p>
              将从 <code>~/.claude/history.jsonl</code> 中永久删除该会话的{' '}
              {promptCount} 条提示记录。操作前会自动备份该文件，删除后无法通过应用恢复。
            </p>
          }
          onCancel={() => setConfirmHistoryDelete(false)}
          onConfirm={() => {
            setConfirmHistoryDelete(false)
            void deleteHistorySessions([selectedKey])
          }}
        />
      )}

      {!isHistory && commandDialog && (
        <CommandDialog
          title="无法自动打开终端"
          command={commandDialog}
          onClose={() => setCommandDialog(null)}
        />
      )}
    </section>
  )
}
