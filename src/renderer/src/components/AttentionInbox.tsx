import { useState } from 'react'
import {
  ArrowUpRight,
  Check,
  RotateCcw,
  ShieldAlert,
  X
} from 'lucide-react'
import type {
  ApprovalDecision,
  ApprovalInboxItem,
  AskInboxItem,
  ScheduledTaskInboxItem
} from '@shared/types'
import { loadSnapshot } from '../lib/actions'
import { useDialog } from '../lib/useDialog'
import { useStore } from '../store'

function openInboxSession(sessionId: string): boolean {
  const state = useStore.getState()
  const tab = [...state.terminals].reverse().find((entry) => entry.sessionId === sessionId)
  if (tab) {
    state.setActiveTerminal(tab.key)
  } else {
    const session = state.snapshot?.sessions.find((entry) => entry.id === sessionId)
    if (!session) return false
    state.selectSession(session.key)
  }
  state.setApprovalPanelOpen(false)
  return true
}

async function viewInboxSession(sessionId: string): Promise<void> {
  if (openInboxSession(sessionId)) return
  if (!(await loadSnapshot(true))) return
  const state = useStore.getState()
  if (state.approvalPanelOpen && !openInboxSession(sessionId)) {
    state.showToast({ kind: 'error', message: '会话记录暂不可用，请稍后重试' })
  }
}

function prettyInput(input: string): string {
  if (!input) return ''
  try {
    return JSON.stringify(JSON.parse(input), null, 2)
  } catch {
    return input
  }
}

function remainingMinutes(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000))
}

function projectName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN')
}

function taskStatusLabel(item: ScheduledTaskInboxItem): string {
  if (item.status === 'success') return item.attempt && item.attempt > 1 ? '重试后成功' : '成功'
  if (item.status === 'timeout') return '超时'
  return item.attempt && item.attempt > 1 ? `失败（第 ${item.attempt} 次）` : '失败'
}

function ApprovalCard({ item }: { item: ApprovalInboxItem }): React.JSX.Element {
  const showToast = useStore((state) => state.showToast)
  const [busy, setBusy] = useState(false)

  const decide = async (decision: ApprovalDecision): Promise<void> => {
    setBusy(true)
    try {
      const changed = await window.api.resolveApproval(item.id, decision)
      if (!changed) {
        showToast({ kind: 'error', message: '该确认已失效，请在终端中处理' })
      }
    } catch (error) {
      showToast({
        kind: 'error',
        message: `提交确认失败：${error instanceof Error ? error.message : String(error)}`
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="approval-card">
      <header className="approval-card-head">
        <div className="approval-card-title">
          <strong>{item.title}</strong>
          <span className="approval-tool">{item.toolName}</span>
        </div>
        <span className="approval-timeout" title="超时后会退回终端询问">
          {remainingMinutes(item.expiresAt)} 分钟后退回终端
        </span>
      </header>
      {item.cwd && (
        <div className="approval-cwd" title={item.cwd}>{item.cwd}</div>
      )}
      {item.toolInput && (
        <pre className="approval-input">{prettyInput(item.toolInput)}</pre>
      )}
      <footer className="approval-actions">
        <button className="btn primary" disabled={busy} onClick={() => void decide('allow')}>
          <Check size={14} />
          允许
        </button>
        <button className="btn danger" disabled={busy} onClick={() => void decide('deny')}>
          <X size={14} />
          拒绝
        </button>
        {item.sessionId && <ViewSessionButton sessionId={item.sessionId} />}
      </footer>
    </article>
  )
}

function AskCard({ item }: { item: AskInboxItem }): React.JSX.Element {
  const showToast = useStore((state) => state.showToast)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (answer: { choice?: number; text?: string }): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.answerScheduledAsk(item.taskId, answer)
      if (!result.ok) {
        showToast({ kind: 'error', message: result.message ?? '提交回答失败' })
      }
    } catch (error) {
      showToast({
        kind: 'error',
        message: `提交回答失败：${error instanceof Error ? error.message : String(error)}`
      })
    } finally {
      setBusy(false)
    }
  }

  const ignore = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.ignoreScheduledAsk(item.taskId)
      if (!result.ok) {
        showToast({ kind: 'error', message: result.message ?? '忽略失败' })
      }
    } catch (error) {
      showToast({
        kind: 'error',
        message: `忽略失败：${error instanceof Error ? error.message : String(error)}`
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="approval-card inbox-ask">
      <header className="approval-card-head">
        <div className="approval-card-title">
          <strong>{item.taskName}</strong>
          <span className="approval-tool">等待回答</span>
        </div>
        <span className="approval-timeout">{formatTime(item.askedAt)}</span>
      </header>
      <div className="inbox-ask-question">
        <strong>{item.title}</strong>
        {item.text && <p>{item.text}</p>}
      </div>
      {item.options.length > 0 && (
        <div className="approval-actions inbox-ask-options">
          {item.options.map((option, index) => (
            <button
              className="btn"
              key={`${option}-${index}`}
              disabled={busy}
              onClick={() => void submit({ choice: index })}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <div className="inbox-ask-input">
        <input
          value={text}
          maxLength={4000}
          placeholder="或者输入回答…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' &&
              !(event.nativeEvent as KeyboardEvent).isComposing &&
              text.trim()) {
              void submit({ text: text.trim() })
            }
          }}
        />
        <button
          className="btn primary"
          disabled={busy || !text.trim()}
          onClick={() => void submit({ text: text.trim() })}
        >
          <Check size={14} />
          提交
        </button>
      </div>
      <footer className="approval-actions">
        <button className="btn" disabled={busy} onClick={() => void ignore()}>
          忽略本次提问
        </button>
        {item.sessionId && <ViewSessionButton sessionId={item.sessionId} />}
      </footer>
    </article>
  )
}

function TaskCard({ item }: { item: ScheduledTaskInboxItem }): React.JSX.Element {
  const showToast = useStore((state) => state.showToast)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(item.status !== 'success')

  const dismiss = async (): Promise<void> => {
    setBusy(true)
    try {
      const changed = await window.api.dismissInboxItem(item.id)
      if (!changed) showToast({ kind: 'error', message: '该事项已被处理' })
    } catch (error) {
      showToast({
        kind: 'error',
        message: `标记已读失败：${error instanceof Error ? error.message : String(error)}`
      })
    } finally {
      setBusy(false)
    }
  }

  const retry = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.runScheduledTask(item.taskId)
      if (!result.ok) {
        showToast({ kind: 'error', message: result.message ?? '任务未能启动' })
        return
      }
      await window.api.dismissInboxItem(item.id).catch(() => false)
      showToast({ kind: 'success', message: `已重新运行：${item.taskName}` })
    } catch (error) {
      showToast({
        kind: 'error',
        message: `重新运行失败：${error instanceof Error ? error.message : String(error)}`
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className={`approval-card inbox-task ${item.status}`}>
      <header className="approval-card-head">
        <div className="approval-card-title">
          <strong>{item.taskName}</strong>
          <span className={`scheduled-status ${item.status}`}>{taskStatusLabel(item)}</span>
        </div>
        <span className="approval-timeout">{formatTime(item.endedAt)}</span>
      </header>
      <div className="approval-cwd" title={item.projectPath}>
        {projectName(item.projectPath)} · {item.projectPath}
      </div>
      <details
        className="inbox-log"
        open={expanded}
        onToggle={(event) => setExpanded((event.target as HTMLDetailsElement).open)}
      >
        <summary>输出摘要</summary>
        <pre>{item.outputTail || '暂无输出'}</pre>
      </details>
      <footer className="approval-actions">
        <button className="btn" disabled={busy} onClick={() => void dismiss()}>
          <Check size={14} />
          标为已读
        </button>
        {(item.status === 'failed' || item.status === 'timeout') && (
          <button className="btn" disabled={busy} onClick={() => void retry()}>
            <RotateCcw size={14} />
            立即重试
          </button>
        )}
        {item.sessionId && <ViewSessionButton sessionId={item.sessionId} />}
      </footer>
    </article>
  )
}

function ViewSessionButton({ sessionId }: { sessionId: string }): React.JSX.Element {
  return (
    <button className="btn approval-focus" onClick={() => void viewInboxSession(sessionId)}>
      <ArrowUpRight size={14} />
      查看会话
    </button>
  )
}

export default function AttentionInbox(): React.JSX.Element | null {
  const items = useStore((state) => state.inbox)
  const open = useStore((state) => state.approvalPanelOpen)
  const setOpen = useStore((state) => state.setApprovalPanelOpen)
  const panelRef = useDialog(open, () => setOpen(false))

  if (!open) return null

  const approvals = items.filter((item): item is ApprovalInboxItem => item.kind === 'approval')
  const asks = items.filter((item): item is AskInboxItem => item.kind === 'ask')
  const tasks = items.filter((item): item is ScheduledTaskInboxItem => item.kind === 'task')

  return (
    <div
      className="git-panel-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }}
    >
      <div ref={panelRef} className="git-panel approval-panel" role="dialog" aria-modal="true" aria-label="待处理事项" tabIndex={-1}>
        <header className="git-panel-header">
          <div className="git-panel-title">
            <ShieldAlert size={15} />
            <strong>待处理</strong>
            <span className="git-branch-chip">{items.length} 项</span>
          </div>
          <div className="git-panel-header-actions">
            <button className="icon-button" title="关闭" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>
        </header>

        {items.length === 0 ? (
          <div className="git-panel-state">没有待处理事项</div>
        ) : (
          <div className="git-panel-body approval-list">
            {approvals.length > 0 && (
              <section className="inbox-section">
                <h3>等待确认</h3>
                {approvals.map((item) => <ApprovalCard key={item.id} item={item} />)}
              </section>
            )}
            {asks.length > 0 && (
              <section className="inbox-section">
                <h3>等待回答</h3>
                {asks.map((item) => <AskCard key={item.id} item={item} />)}
              </section>
            )}
            {tasks.length > 0 && (
              <section className="inbox-section">
                <h3>任务结果</h3>
                {tasks.map((item) => <TaskCard key={item.id} item={item} />)}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
