import { useEffect, useState } from 'react'
import {
  Clock,
  FileText,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
  X
} from 'lucide-react'
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRun,
  ScheduleSpec,
  TerminalPermissionMode
} from '@shared/types'
import { WEEKDAY_LABELS, describeSchedule } from '@shared/schedule'
import { useStore } from '../store'
import { useDialog } from '../lib/useDialog'
import ConfirmDialog from './ConfirmDialog'

const PERMISSION_OPTIONS: Array<{ value: TerminalPermissionMode; label: string }> = [
  { value: 'plan', label: 'plan — 只读/计划（推荐）' },
  { value: 'manual', label: 'manual — 逐次询问' },
  { value: 'auto', label: 'auto — 自动判断' },
  { value: 'acceptEdits', label: 'acceptEdits — 自动接受编辑' },
  { value: 'dontAsk', label: 'dontAsk — 不询问' },
  { value: 'follow', label: '跟随 Claude 设置' }
]

type Mode = 'list' | 'edit' | 'logs'

interface FormState {
  name: string
  projectPath: string
  type: 'claude' | 'command'
  prompt: string
  command: string
  permissionMode: TerminalPermissionMode
  model: string
  maxBudgetUsd: string
  sessionMode: 'new' | 'resume' | 'existing'
  resumeSessionId: string
  enabled: boolean
  scheduleKind: 'once' | 'daily' | 'weekly' | 'interval'
  onceAt: string
  time: string
  weekdays: number[]
  intervalMinutes: string
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function toLocalInput(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function projectName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  return normalize(left) === normalize(right)
}

function defaultForm(): FormState {
  return {
    name: '',
    projectPath: useStore.getState().snapshot?.projects[0]?.path ?? '',
    type: 'claude',
    prompt: '',
    command: '',
    permissionMode: 'plan',
    model: '',
    maxBudgetUsd: '',
    sessionMode: 'new',
    resumeSessionId: '',
    enabled: true,
    scheduleKind: 'daily',
    onceAt: toLocalInput(Date.now() + 60 * 60_000),
    time: '09:00',
    weekdays: [1],
    intervalMinutes: '60'
  }
}

function formFromTask(task: ScheduledTask): FormState {
  return {
    name: task.name,
    projectPath: task.projectPath,
    type: task.type,
    prompt: task.prompt ?? '',
    command: task.command ?? '',
    permissionMode: task.permissionMode ?? 'plan',
    model: task.model ?? '',
    maxBudgetUsd: task.maxBudgetUsd === undefined ? '' : String(task.maxBudgetUsd),
    sessionMode: task.sessionMode ?? 'new',
    resumeSessionId: task.resumeSessionId ?? '',
    enabled: task.enabled,
    scheduleKind: task.schedule.kind,
    onceAt: task.schedule.kind === 'once' ? toLocalInput(task.schedule.at) : toLocalInput(Date.now() + 60 * 60_000),
    time: task.schedule.kind === 'daily' || task.schedule.kind === 'weekly' ? task.schedule.time : '09:00',
    weekdays: task.schedule.kind === 'weekly' ? task.schedule.weekdays : [1],
    intervalMinutes: task.schedule.kind === 'interval' ? String(task.schedule.minutes) : '60'
  }
}

function scheduleFromForm(form: FormState): ScheduleSpec {
  if (form.scheduleKind === 'once') {
    const at = new Date(form.onceAt).getTime()
    if (!Number.isFinite(at)) throw new Error('请选择有效的执行时间')
    return { kind: 'once', at }
  }
  if (form.scheduleKind === 'daily') return { kind: 'daily', time: form.time }
  if (form.scheduleKind === 'weekly') return { kind: 'weekly', weekdays: form.weekdays, time: form.time }
  const minutes = Number(form.intervalMinutes)
  if (!Number.isFinite(minutes)) throw new Error('请输入有效的间隔分钟数')
  return { kind: 'interval', minutes }
}

function formatTime(timestamp: number | undefined): string {
  return timestamp ? new Date(timestamp).toLocaleString('zh-CN') : '—'
}

function statusLabel(run: ScheduledTaskRun | undefined): string {
  if (!run) return '尚未运行'
  if (run.status === 'success') return '成功'
  if (run.status === 'timeout') return '超时'
  if (run.status === 'cancelled') return '已取消'
  return '失败'
}

export default function ScheduledTasksDialog(): React.JSX.Element | null {
  const open = useStore((state) => state.scheduledTasksOpen)
  const setOpen = useStore((state) => state.setScheduledTasksOpen)
  const showToast = useStore((state) => state.showToast)
  const snapshot = useStore((state) => state.snapshot)
  const terminals = useStore((state) => state.terminals)
  const dialogRef = useDialog(open, () => setOpen(false))
  const [mode, setMode] = useState<Mode>('list')
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState<FormState>(defaultForm)
  const [editing, setEditing] = useState<ScheduledTask | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<ScheduledTask | null>(null)
  const [logsTask, setLogsTask] = useState<ScheduledTask | null>(null)
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([])
  const [logContent, setLogContent] = useState('')
  const [logLoading, setLogLoading] = useState(false)

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      setTasks(await window.api.listScheduledTasks())
    } catch (cause) {
      showToast({ kind: 'error', message: `读取定时任务失败：${String(cause)}` })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return undefined
    void load()
    setMode('list')
    setError('')
    const off = window.api.onSchedulesChanged(() => { void load() })
    return off
  }, [open])

  const projects = snapshot?.projects ?? []
  const selectedProject = projects.find((project) => samePath(project.path, form.projectPath))
  const projectSessions = (snapshot?.sessions ?? [])
    .filter((session) => session.source === 'transcript' && session.cwdExists &&
      (selectedProject
        ? session.projectKey === selectedProject.key
        : samePath(session.projectPath, form.projectPath)))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 200)
  const sessionTitle = (id: string | undefined): string | undefined =>
    id ? snapshot?.sessions.find((session) => session.id === id)?.title : undefined
  const sessionModeShort = (task: ScheduledTask): string => {
    if (task.sessionMode === 'existing') {
      const title = sessionTitle(task.resumeSessionId)
      return title ? `→ ${title.length > 14 ? `${title.slice(0, 14)}…` : title}` : '→ 已有会话'
    }
    return task.sessionMode === 'resume' ? '→ 专用会话' : '→ 新建会话'
  }

  if (!open) return null

  const startCreate = (): void => {
    setEditing(null)
    setForm(defaultForm())
    setError('')
    setMode('edit')
  }

  const startEdit = (task: ScheduledTask): void => {
    setEditing(task)
    setForm(formFromTask(task))
    setError('')
    setMode('edit')
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const schedule = scheduleFromForm(form)
      const input: ScheduledTaskInput = {
        name: form.name.trim(),
        enabled: form.enabled,
        projectPath: form.projectPath.trim(),
        type: form.type,
        schedule,
        ...(form.type === 'claude'
          ? {
              prompt: form.prompt,
              permissionMode: form.permissionMode,
              model: form.model.trim() || undefined,
              maxBudgetUsd: form.maxBudgetUsd.trim() ? Number(form.maxBudgetUsd) : undefined,
              sessionMode: form.sessionMode,
              resumeSessionId: form.sessionMode === 'existing' ? form.resumeSessionId : undefined
            }
          : { command: form.command })
      }
      if (editing) await window.api.updateScheduledTask(editing.id, input)
      else await window.api.createScheduledTask(input)
      setMode('list')
      await load()
      showToast({ kind: 'success', message: editing ? '定时任务已更新' : '定时任务已创建' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (task: ScheduledTask, enabled: boolean): Promise<void> => {
    try {
      await window.api.setScheduledTaskEnabled(task.id, enabled)
      await load()
    } catch (cause) {
      showToast({ kind: 'error', message: String(cause) })
    }
  }

  const runNow = async (task: ScheduledTask): Promise<void> => {
    try {
      const result = await window.api.runScheduledTask(task.id)
      if (!result.ok) showToast({ kind: 'error', message: result.message ?? '任务未能启动' })
      else showToast({ kind: 'success', message: `已开始运行：${task.name}` })
      await load()
    } catch (cause) {
      showToast({ kind: 'error', message: String(cause) })
    }
  }

  const cancelRun = async (task: ScheduledTask): Promise<void> => {
    try {
      const result = await window.api.cancelScheduledTask(task.id)
      if (!result.ok) showToast({ kind: 'error', message: result.message ?? '无法停止任务' })
      else showToast({ kind: 'success', message: `正在停止：${task.name}` })
      await load()
    } catch (cause) {
      showToast({ kind: 'error', message: String(cause) })
    }
  }

  const openLogs = async (task: ScheduledTask): Promise<void> => {
    setLogsTask(task)
    setMode('logs')
    setRuns([])
    setLogContent('')
    setLogLoading(true)
    try {
      const items = await window.api.listScheduledTaskRuns(task.id)
      setRuns(items)
      if (items[0]) {
        const log = await window.api.readScheduledTaskLog(task.id, items[0].id)
        setLogContent(log.content)
      }
    } catch (cause) {
      setLogContent(`读取日志失败：${String(cause)}`)
    } finally {
      setLogLoading(false)
    }
  }

  const showRun = async (task: ScheduledTask, run: ScheduledTaskRun): Promise<void> => {
    setLogLoading(true)
    try {
      const log = await window.api.readScheduledTaskLog(task.id, run.id)
      setLogContent(log.content)
    } catch (cause) {
      setLogContent(`读取日志失败：${String(cause)}`)
    } finally {
      setLogLoading(false)
    }
  }

  const remove = async (task: ScheduledTask): Promise<void> => {
    try {
      await window.api.deleteScheduledTask(task.id)
      setConfirmDelete(null)
      await load()
      showToast({ kind: 'success', message: '定时任务已删除' })
    } catch (cause) {
      showToast({ kind: 'error', message: String(cause) })
    }
  }

  return (
    <>
      <div className="overlay" onMouseDown={() => setOpen(false)}>
        <div
          className="dialog scheduled-dialog"
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="定时任务"
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="scheduled-head">
            <div>
              <h2>{mode === 'list' ? '定时任务' : mode === 'edit' ? (editing ? '编辑定时任务' : '新建定时任务') : '运行日志'}</h2>
              <p className="scheduled-sub">
                {mode === 'list'
                  ? '应用在托盘或后台运行时执行'
                  : mode === 'edit'
                    ? 'Claude 任务默认使用只读/计划模式'
                    : logsTask?.name ?? ''}
              </p>
            </div>
            <button className="icon-button" title="关闭" onClick={() => setOpen(false)}><X size={16} /></button>
          </div>

          {mode === 'list' && (
            <>
              <div className="scheduled-toolbar">
                <button className="btn primary" onClick={startCreate}><Plus size={14} />新建任务</button>
                <span className="muted">{loading ? '读取中…' : `${tasks.length} 个任务`}</span>
              </div>
              <div className="scheduled-list">
                {!loading && tasks.length === 0 && (
                  <div className="list-empty">还没有定时任务</div>
                )}
                {tasks.map((task) => (
                  <div className={`scheduled-row ${task.running ? 'running' : ''}`} key={task.id}>
                    <label className="scheduled-toggle" title="勾选后按计划自动运行；取消勾选后仍可点击播放按钮手动运行一次">
                      <input
                        type="checkbox"
                        aria-label={`${task.enabled ? '停用' : '启用'}定时运行：${task.name}`}
                        checked={task.enabled}
                        disabled={task.running}
                        onChange={(event) => void toggle(task, event.target.checked)}
                      />
                      <span>{task.enabled ? '定时启用' : '定时停用'}</span>
                    </label>
                    <div className="scheduled-main">
                      <div className="scheduled-name">
                        <span>{task.name}</span>
                        <span className={`scheduled-type ${task.type}`}>{task.type === 'claude' ? 'Claude' : '命令'}</span>
                        {task.type === 'claude' && (
                          <span
                            className="muted"
                            title={task.sessionMode === 'existing'
                              ? sessionTitle(task.resumeSessionId) ?? task.resumeSessionId
                              : undefined}
                          >
                            {sessionModeShort(task)}
                          </span>
                        )}
                        {task.running && <span className="scheduled-running">运行中…</span>}
                      </div>
                      <div className="scheduled-meta">
                        <Clock size={12} />
                        <span>{describeSchedule(task.schedule)}</span>
                        <span>·</span>
                        <span>{projectName(task.projectPath)}</span>
                        <span>·</span>
                        <span>下次：{formatTime(task.nextRun)}</span>
                      </div>
                      <div className="scheduled-meta">
                        <span className={`scheduled-status ${task.lastRun?.status ?? 'idle'}`}>
                          上次：{statusLabel(task.lastRun)}
                        </span>
                        {task.lastRun?.endedAt && (
                          <span>· {formatTime(task.lastRun.endedAt)}</span>
                        )}
                      </div>
                    </div>
                    <div className="scheduled-actions">
                      {task.running ? (
                        <button className="icon-button danger" title="停止运行" aria-label="停止运行" onClick={() => void cancelRun(task)}>
                          <Square size={13} />
                        </button>
                      ) : (
                        <button className="icon-button" title="立即运行一次（不影响定时）" aria-label="立即运行一次" onClick={() => void runNow(task)}>
                          <Play size={14} />
                        </button>
                      )}
                      <button className="icon-button" title="编辑" disabled={task.running} onClick={() => startEdit(task)}><Pencil size={14} /></button>
                      <button className="icon-button" title="运行日志" onClick={() => void openLogs(task)}><FileText size={14} /></button>
                      <button className="icon-button danger" title={task.running ? '删除（会先停止当前运行）' : '删除'} onClick={() => setConfirmDelete(task)}><Trash2 size={14} /></button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {mode === 'edit' && (
            <div className="scheduled-form">
              {error && <div className="scheduled-error">{error}</div>}
              <label className="settings-field">
                <span>任务名称</span>
                <input value={form.name} maxLength={100} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：每日代码风险检查" />
              </label>
              <label className="settings-field">
                <span>项目目录</span>
                {form.type === 'claude' && form.sessionMode === 'existing' ? (
                  <select
                    value={form.projectPath}
                    onChange={(event) => setForm({
                      ...form,
                      projectPath: event.target.value,
                      resumeSessionId: ''
                    })}
                  >
                    <option value="">选择项目…</option>
                    {projects.map((project) => (
                      <option key={project.key} value={project.path}>
                        {project.name} — {project.path}
                      </option>
                    ))}
                    {form.projectPath && !projects.some((project) => samePath(project.path, form.projectPath)) && (
                      <option value={form.projectPath}>{form.projectPath}</option>
                    )}
                  </select>
                ) : (
                  <div className="scheduled-path-row">
                    <input value={form.projectPath} onChange={(event) => setForm({ ...form, projectPath: event.target.value })} placeholder="项目文件夹路径" />
                    <button className="btn" onClick={() => void window.api.pickFolder().then((result) => {
                      if (result.ok && result.path) setForm((current) => ({ ...current, projectPath: result.path! }))
                    })}>选择文件夹</button>
                  </div>
                )}
              </label>
              <label className="settings-field">
                <span>任务类型</span>
                <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as 'claude' | 'command' })}>
                  <option value="claude">Claude 提示词</option>
                  <option value="command">命令 / 脚本</option>
                </select>
              </label>

              {form.type === 'claude' ? (
                <>
                  <label className="settings-field">
                    <span>提示词</span>
                    <textarea value={form.prompt} maxLength={10000} rows={4} placeholder="例如：检查最近提交的代码，列出潜在风险" onChange={(event) => setForm({ ...form, prompt: event.target.value })} />
                  </label>
                  <div className="scheduled-form-grid">
                    <label className="settings-field">
                      <span>权限模式</span>
                      <select value={form.permissionMode} onChange={(event) => setForm({ ...form, permissionMode: event.target.value as TerminalPermissionMode })}>
                        {PERMISSION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className="settings-field">
                      <span>会话</span>
                      <select
                        value={form.sessionMode}
                        onChange={(event) => {
                          const sessionMode = event.target.value as FormState['sessionMode']
                          setForm({
                            ...form,
                            sessionMode,
                            resumeSessionId: sessionMode === 'existing' ? form.resumeSessionId : ''
                          })
                        }}
                      >
                        <option value="new">每次新建会话</option>
                        <option value="resume">复用专用会话</option>
                        <option value="existing">选择已有会话</option>
                      </select>
                    </label>
                    <label className="settings-field">
                      <span>模型（可选）</span>
                      <input value={form.model} maxLength={200} onChange={(event) => setForm({ ...form, model: event.target.value })} placeholder="默认模型" />
                    </label>
                    <label className="settings-field">
                      <span>预算上限 USD（可选）</span>
                      <input value={form.maxBudgetUsd} inputMode="decimal" onChange={(event) => setForm({ ...form, maxBudgetUsd: event.target.value })} placeholder="例如 1.5" />
                    </label>
                  </div>
                  {form.sessionMode === 'existing' && (
                    <label className="settings-field">
                      <span>追加到会话</span>
                      <select
                        value={form.resumeSessionId}
                        onChange={(event) => {
                          const session = snapshot?.sessions.find((item) => item.id === event.target.value)
                          setForm({
                            ...form,
                            resumeSessionId: event.target.value,
                            ...(session ? { projectPath: session.projectPath } : {})
                          })
                        }}
                      >
                        <option value="">选择会话…</option>
                        {projectSessions.map((session) => (
                          <option key={session.id} value={session.id}>
                            {session.title || session.id.slice(0, 8)} · {formatTime(session.updatedAt)}
                          </option>
                        ))}
                        {form.resumeSessionId && !projectSessions.some((session) => session.id === form.resumeSessionId) && (
                          <option value={form.resumeSessionId}>
                            {sessionTitle(form.resumeSessionId) ?? form.resumeSessionId}（不在当前项目列表）
                          </option>
                        )}
                      </select>
                    </label>
                  )}
                  <p className="dialog-hint">
                    {form.sessionMode === 'new'
                      ? '每次运行都会在项目中生成一个全新会话。'
                      : form.sessionMode === 'resume'
                        ? '首次运行会创建一个专用会话，之后追加到该会话；它会出现在项目会话列表中。'
                        : '每次运行都会把提示词追加到所选会话，并更新原会话记录。'}
                    定时任务以非交互模式运行，默认只读/计划模式；需要写文件时请显式选择对应权限，并确认风险。
                  </p>
                  {form.sessionMode === 'existing' && terminals.some((tab) => tab.sessionId === form.resumeSessionId) && (
                    <p className="dialog-hint">
                      注意：该会话已在终端中打开。为避免同一会话被两个 Claude 进程同时写入，定时任务会拒绝运行；请先关闭该对话标签。
                    </p>
                  )}
                </>
              ) : (
                <>
                  <label className="settings-field">
                    <span>命令</span>
                    <textarea value={form.command} maxLength={4000} rows={3} placeholder="例如：npm test" onChange={(event) => setForm({ ...form, command: event.target.value })} />
                  </label>
                  <p className="dialog-hint">命令将以当前用户权限在项目目录中执行。</p>
                </>
              )}

              <div className="scheduled-form-grid">
                <label className="settings-field">
                  <span>调度方式</span>
                  <select value={form.scheduleKind} onChange={(event) => setForm({ ...form, scheduleKind: event.target.value as FormState['scheduleKind'] })}>
                    <option value="once">仅一次</option>
                    <option value="daily">每天</option>
                    <option value="weekly">每周</option>
                    <option value="interval">间隔</option>
                  </select>
                </label>
                {form.scheduleKind === 'once' && (
                  <label className="settings-field">
                    <span>执行时间</span>
                    <input type="datetime-local" value={form.onceAt} onChange={(event) => setForm({ ...form, onceAt: event.target.value })} />
                  </label>
                )}
                {form.scheduleKind === 'daily' && (
                  <label className="settings-field">
                    <span>时间</span>
                    <input type="time" value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} />
                  </label>
                )}
                {form.scheduleKind === 'interval' && (
                  <label className="settings-field">
                    <span>间隔分钟</span>
                    <input value={form.intervalMinutes} inputMode="numeric" onChange={(event) => setForm({ ...form, intervalMinutes: event.target.value })} />
                  </label>
                )}
              </div>

              {form.scheduleKind === 'weekly' && (
                <div className="scheduled-weekdays">
                  {WEEKDAY_LABELS.map((label, day) => (
                    <label key={label}>
                      <input
                        type="checkbox"
                        checked={form.weekdays.includes(day)}
                        onChange={(event) => setForm((current) => ({
                          ...current,
                          weekdays: event.target.checked
                            ? [...new Set([...current.weekdays, day])].sort()
                            : current.weekdays.filter((item) => item !== day)
                        }))}
                      />
                      周{label}
                    </label>
                  ))}
                  <input type="time" value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} />
                </div>
              )}

              <label className="settings-check">
                <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
                <span><strong>启用任务</strong><small>保存后按调度自动运行。</small></span>
              </label>

              <div className="dialog-actions">
                <button className="btn" onClick={() => { setMode('list'); setError('') }}>取消</button>
                <button className="btn primary" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
              </div>
            </div>
          )}

          {mode === 'logs' && (
            <div className="scheduled-logs">
              <div className="scheduled-log-list">
                {runs.length === 0 && <div className="list-empty">还没有运行记录</div>}
                {runs.map((run) => (
                  <button key={run.id} className="scheduled-log-run" onClick={() => logsTask && void showRun(logsTask, run)}>
                    <span className={`scheduled-status ${run.status}`}>{statusLabel(run)}</span>
                    <span>{formatTime(run.startedAt)}</span>
                    <span>{Math.round((run.endedAt - run.startedAt) / 1000)}s</span>
                  </button>
                ))}
              </div>
              <pre className="scheduled-log-content">{logLoading ? '读取中…' : logContent || '暂无日志'}</pre>
              <div className="dialog-actions">
                <button className="btn" onClick={() => setMode('list')}>返回</button>
              </div>
            </div>
          )}
        </div>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title="删除定时任务"
          confirmLabel="删除"
          danger
          message={<p>将删除「{confirmDelete.name}」及其运行日志，不会删除 Claude 会话或项目文件。{confirmDelete.running ? ' 当前正在运行的任务会先被停止。' : ''}</p>}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void remove(confirmDelete)}
        />
      )}
    </>
  )
}