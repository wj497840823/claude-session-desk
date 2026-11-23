import { useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Minus,
  Plus,
  RefreshCw,
  X
} from 'lucide-react'
import type {
  ActionResult,
  GitDiff,
  GitDiffGroup,
  GitFileEntry
} from '@shared/types'
import { useStore } from '../store'
import { gitErrorMessage, refreshGitProject } from '../lib/git'

interface DiffState {
  loading?: boolean
  diff?: GitDiff
  error?: string
}

const GROUPS: Array<{ key: GitDiffGroup; title: string }> = [
  { key: 'conflict', title: '冲突' },
  { key: 'staged', title: '已暂存' },
  { key: 'unstaged', title: '未暂存' },
  { key: 'untracked', title: '未跟踪' }
]

function letter(kind: GitFileEntry['indexKind'], group: GitDiffGroup): string {
  if (group === 'untracked') return '?'
  if (group === 'conflict') return 'U'
  switch (kind) {
    case 'modified':
      return 'M'
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    case 'typechange':
      return 'T'
    default:
      return '·'
  }
}

function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf('/')
  return index === -1
    ? { dir: '', name: path }
    : { dir: path.slice(0, index + 1), name: path.slice(index + 1) }
}

function diffLineClass(line: string): string {
  if (
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('similarity ') ||
    line.startsWith('rename ')
  ) {
    return 'meta'
  }
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return ''
}

function DiffView({ diff }: { diff: GitDiff }): React.JSX.Element {
  if (diff.binary) return <div className="git-diff-note">二进制文件，无法预览</div>
  if (!diff.diff.trim()) return <div className="git-diff-note">没有可显示的内容</div>
  return (
    <div className="git-diff-wrap">
      <pre className="git-diff">
        {diff.diff.split('\n').map((line, index) => (
          <div key={index} className={`git-diff-line ${diffLineClass(line)}`}>
            {line || ' '}
          </div>
        ))}
      </pre>
      {diff.truncated && <div className="git-diff-note">内容过大，已截断</div>}
    </div>
  )
}

export default function GitPanel(): React.JSX.Element | null {
  const projectKey = useStore((state) => state.gitPanelProject)
  const status = useStore((state) =>
    state.gitPanelProject
      ? state.gitStatuses[state.gitPanelProject]
      : undefined
  )
  const project = useStore((state) =>
    state.gitPanelProject
      ? state.snapshot?.projects.find(
          (item) => item.key === state.gitPanelProject
        ) ?? null
      : null
  )
  const closeGitPanel = useStore((state) => state.closeGitPanel)
  const showToast = useStore((state) => state.showToast)

  const panelRef = useRef<HTMLElement>(null)
  const [message, setMessage] = useState('')
  const [skipHooks, setSkipHooks] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})

  useEffect(() => {
    setMessage('')
    setSkipHooks(false)
    setError(null)
    setExpanded({})
    setDiffs({})
  }, [projectKey])

  useEffect(() => {
    if (!projectKey) return undefined
    void refreshGitProject(projectKey)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshGitProject(projectKey)
      }
    }, 5000)
    return () => window.clearInterval(timer)
  }, [projectKey])

  useEffect(() => {
    if (!projectKey) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeGitPanel()
    }
    document.addEventListener('keydown', onKeyDown)
    panelRef.current?.focus()
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [projectKey, closeGitPanel])

  if (!projectKey) return null

  const clearDiffState = (id: string): void => {
    if (id === 'stage-all' || id === 'unstage-all') {
      setDiffs({})
      setExpanded({})
      return
    }
    const path = id.slice(id.indexOf(':') + 1)
    setDiffs((value) => {
      const next: Record<string, DiffState> = {}
      for (const [key, item] of Object.entries(value)) {
        if (!key.endsWith(`:${path}`)) next[key] = item
      }
      return next
    })
    setExpanded((value) => {
      const next: Record<string, boolean> = {}
      for (const [key, item] of Object.entries(value)) {
        if (!key.endsWith(`:${path}`)) next[key] = item
      }
      return next
    })
  }

  const runAction = async (
    id: string,
    action: () => Promise<ActionResult>,
    success: string
  ): Promise<void> => {
    setBusy(id)
    setError(null)
    try {
      const result = await action()
      if (!result.ok) {
        setError(result.message ?? '操作失败')
        return
      }
      await refreshGitProject(projectKey, true)
      clearDiffState(id)
      if (success) showToast({ kind: 'success', message: success })
    } catch (caught) {
      setError(gitErrorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const toggleDiff = async (
    group: GitDiffGroup,
    entry: GitFileEntry
  ): Promise<void> => {
    const id = `${group}:${entry.path}`
    const open = !expanded[id]
    setExpanded((value) => ({ ...value, [id]: open }))
    if (!open || diffs[id]?.diff || diffs[id]?.loading) return
    setDiffs((value) => ({ ...value, [id]: { loading: true } }))
    try {
      const diff = await window.api.getGitDiff(projectKey, entry.path, group)
      setDiffs((value) => ({ ...value, [id]: { diff } }))
    } catch (caught) {
      setDiffs((value) => ({
        ...value,
        [id]: { error: gitErrorMessage(caught) }
      }))
    }
  }

  const fileAction = async (
    entry: GitFileEntry,
    action: 'open' | 'reveal'
  ): Promise<void> => {
    try {
      const result = await window.api.gitFileAction(
        projectKey,
        entry.path,
        action
      )
      if (!result.ok) {
        showToast({ kind: 'error', message: result.message ?? '操作失败' })
      }
    } catch (caught) {
      showToast({ kind: 'error', message: gitErrorMessage(caught) })
    }
  }

  const submit = async (): Promise<void> => {
    if (!canCommit) return
    setBusy('commit')
    setError(null)
    try {
      const result = await window.api.commitGit(projectKey, message, skipHooks)
      if (!result.ok) {
        setError(result.message ?? '提交失败')
        return
      }
      setMessage('')
      await refreshGitProject(projectKey, true)
      setDiffs({})
      setExpanded({})
      showToast({
        kind: 'success',
        message: result.commit ? `已提交 ${result.commit}` : '提交成功'
      })
    } catch (caught) {
      setError(gitErrorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const filesFor = (group: GitDiffGroup): GitFileEntry[] => {
    if (!status) return []
    if (group === 'conflict') return status.files.filter((file) => file.conflict)
    if (group === 'untracked') return status.files.filter((file) => file.untracked)
    if (group === 'staged') {
      return status.files.filter(
        (file) => !file.conflict && file.indexKind !== null
      )
    }
    return status.files.filter(
      (file) => !file.conflict && file.worktreeKind !== null
    )
  }

  const canCommit =
    Boolean(status?.isRepo) &&
    (status?.counts.staged ?? 0) > 0 &&
    (status?.counts.unmerged ?? 0) === 0 &&
    message.trim().length > 0 &&
    !busy

  const renderRows = (group: GitDiffGroup): React.JSX.Element => {
    const files = filesFor(group)
    if (files.length === 0) return <div className="git-group-empty">没有文件</div>
    return (
      <div className="git-file-list">
        {files.map((entry) => {
          const id = `${group}:${entry.path}`
          const open = Boolean(expanded[id])
          const diffState = diffs[id]
          const stats =
            group === 'staged'
              ? {
                  additions: entry.stagedAdditions,
                  deletions: entry.stagedDeletions
                }
              : group === 'unstaged'
                ? {
                    additions: entry.worktreeAdditions,
                    deletions: entry.worktreeDeletions
                  }
                : {}
          const deleted =
            entry.indexKind === 'deleted' || entry.worktreeKind === 'deleted'
          const path = splitPath(entry.path)
          return (
            <div className="git-file-row" key={id}>
              <button
                className="git-file-main"
                title="展开或收起 diff"
                onClick={() => void toggleDiff(group, entry)}
              >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className={`git-file-letter ${group}`}>
                  {letter(
                    group === 'staged' ? entry.indexKind : entry.worktreeKind,
                    group
                  )}
                </span>
                <span className="git-file-path">
                  <span className="git-file-dir">{path.dir}</span>
                  <span className="git-file-name">{path.name}</span>
                  {entry.origPath && (
                    <span className="git-file-orig"> ← {entry.origPath}</span>
                  )}
                </span>
                {entry.binary && <span className="git-file-binary">二进制</span>}
                {stats.additions !== undefined && (
                  <span className="git-file-stat add">+{stats.additions}</span>
                )}
                {stats.deletions !== undefined && (
                  <span className="git-file-stat del">-{stats.deletions}</span>
                )}
              </button>
              <div className="git-file-actions">
                {group === 'conflict' && (
                  <button
                    className="git-row-action"
                    title="标记已解决（暂存）"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void runAction(
                        `stage:${entry.path}`,
                        () => window.api.stageGitFile(projectKey, entry.path),
                        '已标记为已解决'
                      )
                    }
                  >
                    <Check size={13} />
                  </button>
                )}
                {(group === 'unstaged' || group === 'untracked') && (
                  <button
                    className="git-row-action"
                    title="暂存"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void runAction(
                        `stage:${entry.path}`,
                        () => window.api.stageGitFile(projectKey, entry.path),
                        '已暂存'
                      )
                    }
                  >
                    <Plus size={13} />
                  </button>
                )}
                {group === 'staged' && (
                  <button
                    className="git-row-action"
                    title="取消暂存"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void runAction(
                        `unstage:${entry.path}`,
                        () => window.api.unstageGitFile(projectKey, entry.path),
                        '已取消暂存'
                      )
                    }
                  >
                    <Minus size={13} />
                  </button>
                )}
                <button
                  className="git-row-action"
                  title={deleted ? '文件已删除' : '打开文件'}
                  disabled={Boolean(busy) || deleted}
                  onClick={() => void fileAction(entry, 'open')}
                >
                  <ExternalLink size={13} />
                </button>
                <button
                  className="git-row-action"
                  title="在资源管理器中显示"
                  disabled={Boolean(busy)}
                  onClick={() => void fileAction(entry, 'reveal')}
                >
                  <FolderOpen size={13} />
                </button>
              </div>
              {open && (
                <div className="git-diff-area">
                  {diffState?.loading && (
                    <div className="git-diff-note">正在读取 diff…</div>
                  )}
                  {diffState?.error && (
                    <div className="git-diff-note error">{diffState.error}</div>
                  )}
                  {diffState?.diff && <DiffView diff={diffState.diff} />}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  const fatal =
    status && (!status.isRepo || status.error)
      ? status.error?.message ?? '无法读取 Git 状态'
      : null

  return (
    <div
      className="git-panel-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeGitPanel()
      }}
    >
      <aside
        className="git-panel"
        ref={panelRef}
        tabIndex={-1}
        aria-label="Git 变更"
      >
        <header className="git-panel-header">
          <div className="git-panel-title">
            <GitBranch size={15} />
            <strong>{project?.name ?? projectKey}</strong>
            {status?.isRepo && (
              <span
                className="git-branch-chip"
                title={status.upstream ? `上游 ${status.upstream}` : '没有上游分支'}
              >
                {status.detached
                  ? `HEAD@${status.oid?.slice(0, 7) ?? '?'}`
                  : status.branch ?? '未知分支'}
              </span>
            )}
            {status?.isRepo && status.upstream && (
              <span className="git-ahead-behind">
                ↑{status.ahead} ↓{status.behind}
              </span>
            )}
          </div>
          <div className="git-panel-header-actions">
            <button
              className="icon-button"
              title="刷新"
              disabled={Boolean(busy)}
              onClick={() => void refreshGitProject(projectKey, true)}
            >
              <RefreshCw size={14} />
            </button>
            <button className="icon-button" title="关闭" onClick={closeGitPanel}>
              <X size={14} />
            </button>
          </div>
        </header>

        {!status && <div className="git-panel-state">正在读取 Git 状态…</div>}

        {fatal && (
          <div className="git-panel-state error">
            <p>{fatal}</p>
            <button
              className="btn"
              onClick={() => void refreshGitProject(projectKey, true)}
            >
              重试
            </button>
          </div>
        )}

        {status?.isRepo && !status.error && (
          <div className="git-panel-body">
            <p className="git-summary">
              {status.counts.files} 个文件变更 · 已暂存 {status.counts.staged} ·
              未暂存 {status.counts.unstaged} · 未跟踪 {status.counts.untracked}
              {status.counts.unmerged > 0
                ? ` · 冲突 ${status.counts.unmerged}`
                : ''}
            </p>

            {status.truncated && (
              <p className="git-panel-hint">文件过多，仅显示前一部分。</p>
            )}

            <div className="git-bulk-actions">
              <button
                className="btn"
                disabled={
                  Boolean(busy) ||
                  status.counts.unstaged + status.counts.untracked === 0
                }
                onClick={() =>
                  void runAction(
                    'stage-all',
                    () => window.api.stageAllGit(projectKey),
                    '已暂存全部可暂存文件'
                  )
                }
              >
                全部暂存
              </button>
              <button
                className="btn"
                disabled={Boolean(busy) || status.counts.staged === 0}
                onClick={() =>
                  void runAction(
                    'unstage-all',
                    () => window.api.unstageAllGit(projectKey),
                    '已取消全部暂存'
                  )
                }
              >
                全部取消暂存
              </button>
            </div>

            {status.counts.files === 0 ? (
              <div className="git-panel-state">工作区没有未提交的变更</div>
            ) : (
              GROUPS.map((group) => {
                const files = filesFor(group.key)
                if (files.length === 0) return null
                return (
                  <section className="git-group" key={group.key}>
                    <h3 className="git-group-title">
                      {group.title}
                      <span className="git-group-count">{files.length}</span>
                    </h3>
                    {renderRows(group.key)}
                  </section>
                )
              })
            )}

            <section className="git-commit">
              <label className="git-commit-label" htmlFor="git-commit-message">
                提交说明
              </label>
              <textarea
                id="git-commit-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="描述本次提交…"
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault()
                    void submit()
                  }
                }}
              />
              <label className="git-commit-hook">
                <input
                  type="checkbox"
                  checked={skipHooks}
                  onChange={(event) => setSkipHooks(event.target.checked)}
                />
                跳过 Git 钩子
              </label>
              {status.counts.unmerged > 0 && (
                <p className="git-panel-hint error">请先解决冲突后再提交。</p>
              )}
              {error && <pre className="git-commit-error">{error}</pre>}
              <div className="git-commit-actions">
                <span className="git-commit-hint">
                  {status.counts.staged} 个文件已暂存 · Ctrl/Cmd + Enter 提交
                </span>
                <button
                  className="btn primary"
                  disabled={!canCommit}
                  onClick={() => void submit()}
                >
                  {busy === 'commit' ? '提交中…' : '提交已暂存内容'}
                </button>
              </div>
            </section>
          </div>
        )}
      </aside>
    </div>
  )
}