import { execFile, spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, stat, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ActionResult,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskLog,
  ScheduledTaskRun,
  ScheduleSpec,
  SessionSource
} from '@shared/types'
import { computeNextRun, isValidSchedule } from '@shared/schedule'
import { buildClaudeLaunch, CLAUDE_CLI_HINT, resolveClaudeLauncher } from './claudeCli'
import { terminalEnv } from './terminal'
import { isTerminalPermissionMode } from './terminalArgs'
import { SESSION_ID_RE } from './validation'

const FILE_VERSION = 1
const TICK_MS = 30_000
const GRACE_MS = 5 * 60_000
const MAX_RUNS = 20
const MAX_LOG_BYTES = 4 * 1024 * 1024
const MAX_TAIL = 8_000
const TASK_TIMEOUT_MS = 30 * 60_000
const KILL_GRACE_MS = 5_000
const END_STREAM_TIMEOUT_MS = 5_000

interface StoredTask extends ScheduledTask {
  runs: ScheduledTaskRun[]
}

interface RunningTask {
  child: ReturnType<typeof spawn>
  startedAt: number
  done: Promise<void>
}

export interface ScheduledTaskSession {
  projectPath: string
  source: SessionSource
  cwdExists: boolean
}

export interface ScheduledTaskServiceOptions {
  userData: string
  notify?: (title: string, body: string) => void
  onChange?: () => void
  resolveSession?: (sessionId: string) => Promise<ScheduledTaskSession | null>
  isSessionActive?: (sessionId: string) => boolean
}

function endStream(stream: ReturnType<typeof createWriteStream> | null): Promise<void> {
  if (!stream) return Promise.resolve()
  return new Promise((resolve) => {
    if (stream.destroyed || stream.writableEnded) {
      resolve()
      return
    }
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(finish, END_STREAM_TIMEOUT_MS)
    timer.unref?.()
    stream.once('finish', finish)
    stream.once('error', finish)
    stream.once('close', finish)
    stream.end(finish)
  })
}

function sameProjectPath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    timer.unref?.()
    promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temp = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
    await rename(temp, filePath)
  } finally {
    await unlink(temp).catch(() => undefined)
  }
}

export class ScheduledTaskService {
  private readonly filePath: string
  private readonly logRoot: string
  private readonly notify: (title: string, body: string) => void
  private readonly onChange: () => void
  private readonly resolveSession?: (sessionId: string) => Promise<ScheduledTaskSession | null>
  private readonly isSessionActive?: (sessionId: string) => boolean
  private tasks = new Map<string, StoredTask>()
  private running = new Map<string, RunningTask>()
  private starting = new Set<string>()
  private cancelled = new Set<string>()
  private runDone = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(options: ScheduledTaskServiceOptions) {
    this.filePath = join(options.userData, 'scheduled-tasks.json')
    this.logRoot = join(options.userData, 'scheduled-task-logs')
    this.notify = options.notify ?? (() => undefined)
    this.onChange = options.onChange ?? (() => undefined)
    this.resolveSession = options.resolveSession
    this.isSessionActive = options.isSessionActive
  }

  async initialize(): Promise<void> {
    await this.load()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    this.emitChange()
  }

  private busy(id: string): boolean {
    return this.running.has(id) || this.starting.has(id)
  }

  list(): ScheduledTask[] {
    const now = Date.now()
    return [...this.tasks.values()]
      .map((task) => {
        const { runs: _runs, ...rest } = task
        if (task.enabled && task.nextRun === undefined) {
          rest.nextRun = computeNextRun(task.schedule, now, task.lastRun?.startedAt)
        }
        return { ...rest, running: this.busy(task.id) }
      })
      .sort((left, right) => (left.nextRun ?? Number.MAX_SAFE_INTEGER) - (right.nextRun ?? Number.MAX_SAFE_INTEGER))
  }

  async create(input: ScheduledTaskInput): Promise<ScheduledTask> {
    const normalized = await this.normalizeInput(input)
    const now = Date.now()
    const task: StoredTask = {
      ...normalized,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      nextRun: normalized.enabled ? computeNextRun(normalized.schedule, now) : undefined,
      runs: []
    }
    this.tasks.set(task.id, task)
    await this.save()
    this.emitChange()
    return this.publicTask(task)
  }

  async update(id: string, input: ScheduledTaskInput): Promise<ScheduledTask> {
    if (this.busy(id)) throw new Error('任务正在运行，请等待结束后再修改')
    const current = this.tasks.get(id)
    if (!current) throw new Error('定时任务不存在')
    const normalized = await this.normalizeInput(input, current)
    const now = Date.now()
    const next = computeNextRun(normalized.schedule, now, current.lastRun?.startedAt)
    const task: StoredTask = {
      ...current,
      ...normalized,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: now,
      resumeSessionId: this.nextResumeSessionId(current, normalized),
      nextRun: normalized.enabled ? next : undefined,
      runs: current.runs
    }
    this.tasks.set(id, task)
    await this.save()
    this.emitChange()
    return this.publicTask(task)
  }

  async remove(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) throw new Error('定时任务不存在')
    const done = this.runDone.get(id)
    if (done) {
      // Deleting a running (or starting) task stops it first, then removes it
      // once the process has actually released its log file.
      this.cancelled.add(id)
      const running = this.running.get(id)
      if (running) this.kill(running.child)
      if (!(await settlesWithin(done, 10_000))) {
        throw new Error('无法停止正在运行的任务，请稍后重试')
      }
    }
    if (!this.tasks.delete(id)) throw new Error('定时任务不存在')
    await rm(join(this.logRoot, id), { recursive: true, force: true }).catch(() => undefined)
    await this.save()
    this.emitChange()
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduledTask> {
    const task = this.tasks.get(id)
    if (!task) throw new Error('定时任务不存在')
    if (this.busy(id)) throw new Error('任务正在运行，请等待结束后再操作')
    // Re-enabling an expired one-off task would either fire a duplicate run
    // (inside the grace window) or silently turn itself off again.
    if (enabled && task.schedule.kind === 'once' && task.schedule.at <= Date.now()) {
      throw new Error('一次性任务的执行时间已过，请编辑执行时间后再启用')
    }
    task.enabled = enabled
    task.updatedAt = Date.now()
    task.nextRun = enabled
      ? computeNextRun(task.schedule, Date.now(), task.lastRun?.startedAt)
      : undefined
    await this.save()
    this.emitChange()
    return this.publicTask(task)
  }

  async runNow(id: string): Promise<ActionResult> {
    const task = this.tasks.get(id)
    if (!task) return { ok: false, message: '定时任务不存在' }
    if (this.busy(id)) return { ok: false, message: '任务正在运行' }
    const sessionId = task.resumeSessionId
    if (sessionId && (task.sessionMode === 'existing' || task.sessionMode === 'resume') &&
      this.isSessionActive?.(sessionId)) {
      return { ok: false, message: '该会话正在终端中打开，请关闭该对话标签后再运行定时任务' }
    }
    void this.startRun(task, true).catch(() => undefined)
    return { ok: true }
  }

  cancel(id: string): ActionResult {
    const task = this.tasks.get(id)
    if (!task) return { ok: false, message: '定时任务不存在' }
    const running = this.running.get(id)
    if (!running) {
      if (this.starting.has(id)) {
        // The child has not spawned yet; cancel it as soon as it does.
        this.cancelled.add(id)
        return { ok: true }
      }
      return { ok: false, message: '任务未在运行' }
    }
    this.cancelled.add(id)
    this.kill(running.child)
    this.emitChange()
    return { ok: true }
  }

  runs(id: string): ScheduledTaskRun[] {
    return this.tasks.get(id)?.runs ?? []
  }

  async readLog(id: string, runId: string): Promise<ScheduledTaskLog> {
    const task = this.tasks.get(id)
    const run = task?.runs.find((item) => item.id === runId)
    if (!run) throw new Error('运行记录不存在')
    const content = await readFile(run.logPath, 'utf8').catch(() => '')
    return { run, content: content.slice(-1_000_000) }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const [id, running] of this.running) {
      this.cancelled.add(id)
      this.kill(running.child)
    }
    // Tasks still starting have no child yet; marking them cancelled makes
    // the spawn callback terminate the child as soon as it exists.
    for (const id of this.starting) this.cancelled.add(id)
    this.running.clear()
    this.starting.clear()
  }

  private publicTask(task: StoredTask): ScheduledTask {
    const { runs: _runs, ...rest } = task
    return { ...rest, running: this.busy(task.id) }
  }

  private emitChange(): void {
    this.onChange()
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as {
        version?: number
        tasks?: StoredTask[]
      }
      if (raw.version !== FILE_VERSION || !Array.isArray(raw.tasks)) return
      const now = Date.now()
      for (const item of raw.tasks) {
        if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') continue
        if (!isValidSchedule(item.schedule)) continue
        const { runs, ...task } = item
        const stored: StoredTask = {
          ...task,
          runs: Array.isArray(runs) ? runs.slice(0, MAX_RUNS) : [],
          nextRun: task.enabled ? task.nextRun : undefined
        }
        if (stored.enabled && stored.nextRun === undefined) {
          stored.nextRun = computeNextRun(stored.schedule, now, stored.lastRun?.startedAt)
        }
        this.tasks.set(stored.id, stored)
      }
    } catch {
      // A missing or corrupt file starts with no tasks.
    }
  }

  private async save(): Promise<void> {
    const payload = {
      version: FILE_VERSION,
      tasks: [...this.tasks.values()]
    }
    const operation = this.saveQueue.then(() => writeJsonAtomic(this.filePath, payload))
    this.saveQueue = operation.catch(() => undefined)
    await operation
  }

  private async normalizeInput(
    input: ScheduledTaskInput,
    current?: StoredTask
  ): Promise<ScheduledTaskInput> {
    if (!input || typeof input !== 'object') throw new Error('非法定时任务参数')
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.length > 100) throw new Error('任务名称必须为 1–100 个字符')
    const projectPath = typeof input.projectPath === 'string' ? input.projectPath.trim() : ''
    if (!projectPath) throw new Error('请选择项目目录')
    const info = await stat(projectPath).catch(() => null)
    if (!info?.isDirectory()) throw new Error('项目目录不存在或不是文件夹')
    if (input.type !== 'claude' && input.type !== 'command') throw new Error('非法任务类型')
    if (!isValidSchedule(input.schedule)) throw new Error('非法调度设置')
    if (input.schedule.kind === 'once' && input.schedule.at <= Date.now() + 1_000) {
      const unchanged = current?.schedule.kind === 'once' &&
        current.schedule.at === input.schedule.at
      if (!unchanged) throw new Error('一次性任务的执行时间必须在未来')
      if (input.enabled !== false && current && !current.enabled) {
        throw new Error('一次性任务的执行时间已过，请编辑执行时间后再启用')
      }
    }

    const schedule: ScheduleSpec = input.schedule.kind === 'weekly'
      ? { ...input.schedule, weekdays: [...new Set(input.schedule.weekdays)].sort() }
      : input.schedule

    if (input.type === 'command') {
      const command = typeof input.command === 'string' ? input.command.trim() : ''
      if (!command || command.length > 4000 || /[\x00]/.test(command)) throw new Error('请输入有效命令')
      return {
        name,
        enabled: input.enabled !== false,
        projectPath,
        type: 'command',
        command,
        schedule,
        sessionMode: undefined,
        prompt: undefined,
        permissionMode: undefined,
        model: undefined,
        maxBudgetUsd: undefined,
        resumeSessionId: undefined
      }
    }

    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (!prompt || prompt.length > 10_000 || /[\x00]/.test(prompt)) throw new Error('请输入有效提示词')
    const permissionMode = input.permissionMode ?? 'plan'
    if (!isTerminalPermissionMode(permissionMode)) throw new Error('非法权限模式')
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    if (model.length > 200) throw new Error('模型名称过长')
    const maxBudgetUsd = input.maxBudgetUsd
    if (maxBudgetUsd !== undefined &&
      (typeof maxBudgetUsd !== 'number' || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd < 0 || maxBudgetUsd > 1000)) {
      throw new Error('预算必须是 0–1000 之间的数字')
    }
    const sessionMode = input.sessionMode === 'resume' || input.sessionMode === 'existing'
      ? input.sessionMode
      : 'new'
    const resumeSessionId = typeof input.resumeSessionId === 'string'
      ? input.resumeSessionId.trim() || undefined
      : undefined
    if (resumeSessionId && !SESSION_ID_RE.test(resumeSessionId)) throw new Error('非法会话 ID')
    if (sessionMode === 'existing' && !resumeSessionId) throw new Error('请选择要追加的已有会话')
    if (sessionMode === 'existing' && resumeSessionId && this.resolveSession) {
      const session = await this.resolveSession(resumeSessionId)
      if (!session || session.source !== 'transcript' || !session.cwdExists) {
        throw new Error('所选会话不存在或无法恢复')
      }
      if (!sameProjectPath(session.projectPath, projectPath)) {
        throw new Error('所选会话不属于当前项目')
      }
    }
    return {
      name,
      enabled: input.enabled !== false,
      projectPath,
      type: 'claude',
      prompt,
      permissionMode: permissionMode as ScheduledTaskInput['permissionMode'],
      model: model || undefined,
      maxBudgetUsd,
      sessionMode,
      command: undefined,
      resumeSessionId: sessionMode === 'new' ? undefined : resumeSessionId,
      schedule
    }
  }

  private nextResumeSessionId(current: StoredTask, normalized: ScheduledTaskInput): string | undefined {
    if (normalized.sessionMode === 'existing') return normalized.resumeSessionId
    if (normalized.sessionMode === 'resume') {
      // The dedicated session lives in the task's project; after a project
      // change the old session id can no longer be resumed.
      if (current.sessionMode !== 'resume') return undefined
      if (!sameProjectPath(current.projectPath, normalized.projectPath)) return undefined
      return current.resumeSessionId
    }
    return undefined
  }

  isSessionRunning(sessionId: string): boolean {
    for (const [id, task] of this.tasks) {
      if (!this.busy(id)) continue
      if ((task.sessionMode === 'existing' || task.sessionMode === 'resume') &&
        task.resumeSessionId === sessionId) {
        return true
      }
    }
    return false
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    let changed = false
    for (const task of this.tasks.values()) {
      if (!task.enabled || this.busy(task.id)) continue
      if (task.nextRun === undefined) {
        task.nextRun = computeNextRun(task.schedule, now, task.lastRun?.startedAt)
        changed = true
        continue
      }
      if (task.nextRun > now) continue
      if (now - task.nextRun > GRACE_MS) {
        // The app was not running at the scheduled moment. Skip this
        // occurrence instead of firing a burst of missed runs.
        if (task.schedule.kind === 'once') {
          task.enabled = false
          task.nextRun = undefined
        } else {
          task.nextRun = computeNextRun(task.schedule, now, task.lastRun?.startedAt)
        }
        changed = true
        continue
      }
      // startRun finalizes its own state; this catch only guards against an
      // unexpected rejection escaping the finalizer.
      void this.startRun(task).catch(() => undefined)
    }
    if (changed) await this.save()
  }

  private async startRun(task: StoredTask, manual = false): Promise<void> {
    if (this.busy(task.id)) return
    this.starting.add(task.id)
    let resolveDone: () => void = () => undefined
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    this.runDone.set(task.id, done)
    const runId = randomUUID()
    const startedAt = Date.now()
    const logDirectory = join(this.logRoot, task.id)
    const logPath = join(logDirectory, `${runId}.log`)
    let stream: ReturnType<typeof createWriteStream> | null = null
    let bytes = 0
    let tail = ''
    let logFailed = false
    let failure: string | undefined
    const append = (chunk: string): void => {
      tail = (tail + chunk).slice(-MAX_TAIL)
      if (!stream || logFailed || bytes >= MAX_LOG_BYTES) return
      const text = chunk.slice(0, MAX_LOG_BYTES - bytes)
      bytes += Buffer.byteLength(text)
      try {
        stream.write(text)
      } catch {
        logFailed = true
      }
    }
    let run: ScheduledTaskRun | null = null

    try {
      await mkdir(logDirectory, { recursive: true })
      stream = createWriteStream(logPath, { flags: 'w' })
      // A broken log must neither crash the main process nor keep the task
      // stuck in the starting state.
      stream.on('error', () => { logFailed = true })
      append(`[${new Date(startedAt).toLocaleString('zh-CN')}] ${task.name}\n`)

      const result = await this.execute(task, append, (runningChild) => {
        this.running.set(task.id, { child: runningChild, startedAt, done })
        if (this.cancelled.has(task.id)) this.kill(runningChild)
        this.emitChange()
      })
      const endedAt = Date.now()
      const cancelled = this.cancelled.has(task.id)
      // Bind a dedicated session only after a successful first run. A failed
      // or cancelled run must not leave the task resuming an id that has no
      // transcript to resume.
      if (
        task.sessionMode === 'resume' &&
        !task.resumeSessionId &&
        result.sessionId &&
        !cancelled &&
        !result.timedOut &&
        result.exitCode === 0
      ) {
        task.resumeSessionId = result.sessionId
      }
      if (cancelled) append('\n[已取消]\n')
      run = {
        id: runId,
        startedAt,
        endedAt,
        status: cancelled
          ? 'cancelled'
          : result.timedOut ? 'timeout' : result.exitCode === 0 ? 'success' : 'failed',
        exitCode: result.exitCode ?? undefined,
        logPath,
        outputTail: tail,
        ...(result.sessionId ? { sessionId: result.sessionId } : {})
      }
      await endStream(stream)
    } catch (error) {
      failure = errorMessage(error)
      append(`\n[错误] ${failure}\n`)
      await endStream(stream)
      run = {
        id: runId,
        startedAt,
        endedAt: Date.now(),
        status: this.cancelled.has(task.id) ? 'cancelled' : 'failed',
        logPath,
        outputTail: tail
      }
    } finally {
      this.starting.delete(task.id)
      this.cancelled.delete(task.id)
    }

    if (run) {
      try {
        await this.finishRun(task, run, manual)
      } catch {
        // Persisting the run record is best-effort; the task must not remain busy.
      }
    }
    // Keep the task "running" until its record and dropped logs are persisted:
    // callers such as remove() rely on the completion signal meaning cleanup
    // has finished, not merely that the child process exited.
    this.running.delete(task.id)
    this.runDone.delete(task.id)
    // A cancel request that raced with the post-exit bookkeeping has nothing
    // left to stop; drop the flag so it cannot kill the next run.
    this.cancelled.delete(task.id)
    resolveDone()
    this.emitChange()
    if (!run) return
    try {
      if (run.status === 'cancelled') {
        this.notify(`定时任务已取消：${task.name}`, '运行已手动停止')
      } else {
        const seconds = Math.round((run.endedAt - startedAt) / 1000)
        this.notify(
          run.status === 'success' ? `定时任务完成：${task.name}` : `定时任务失败：${task.name}`,
          run.status === 'success'
            ? `用时 ${seconds} 秒`
            : failure ?? `退出码 ${run.exitCode ?? '未知'}，用时 ${seconds} 秒`
        )
      }
    } catch {
      // Notification failures must not affect task state.
    }
  }

  private advancePast(schedule: ScheduleSpec, nextRun: number, after: number): number {
    if (schedule.kind === 'interval') {
      const interval = schedule.minutes * 60_000
      let next = nextRun
      while (next <= after) next += interval
      return next
    }
    if (schedule.kind === 'once') return schedule.at
    return computeNextRun(schedule, after)
  }

  private async finishRun(task: StoredTask, run: ScheduledTaskRun, manual: boolean): Promise<void> {
    const previousRuns = task.runs
    task.runs = [run, ...previousRuns].slice(0, MAX_RUNS)
    task.lastRun = run
    task.updatedAt = run.endedAt
    if (task.schedule.kind === 'once') {
      // A manual run before the scheduled moment must not cancel it. A manual
      // run at/after the moment consumes the one occurrence as before.
      if (!manual || task.schedule.at <= task.lastRun.endedAt) {
        task.enabled = false
        task.nextRun = undefined
      } else {
        task.nextRun = task.enabled ? task.schedule.at : undefined
      }
    } else if (manual) {
      // "立即运行" must not move the periodic schedule. If the pending
      // occurrence became due during the manual run, advance past it so the
      // scheduler does not fire a duplicate immediately afterwards.
      if (!task.enabled) {
        task.nextRun = undefined
      } else if (task.nextRun === undefined) {
        task.nextRun = computeNextRun(task.schedule, run.endedAt, run.startedAt)
      } else if (task.nextRun <= run.endedAt) {
        task.nextRun = this.advancePast(task.schedule, task.nextRun, run.endedAt)
      }
    } else {
      task.nextRun = task.enabled
        ? computeNextRun(task.schedule, Date.now(), run.startedAt)
        : undefined
    }
    await this.save()
    const kept = new Set(task.runs.map((item) => item.id))
    for (const dropped of previousRuns) {
      if (kept.has(dropped.id) || !dropped.logPath) continue
      await rm(dropped.logPath, { force: true }).catch(() => undefined)
    }
  }

  private async execute(
    task: StoredTask,
    append: (chunk: string) => void,
    onChild: (child: ReturnType<typeof spawn>) => void
  ): Promise<{ exitCode: number | null; timedOut: boolean; sessionId?: string }> {
    if (task.type === 'command') {
      const command = task.command ?? ''
      return this.spawnAndCapture(command, [], task.projectPath, append, onChild, true)
    }

    const prompt = task.prompt ?? ''
    const launcher = resolveClaudeLauncher()
    if (!launcher.resolved) throw new Error(CLAUDE_CLI_HINT)
    let sessionId = task.resumeSessionId
    if (sessionId && this.isSessionActive?.(sessionId) &&
      (task.sessionMode === 'existing' || task.sessionMode === 'resume')) {
      throw new Error('该会话正在终端中打开，请关闭该对话标签后再运行定时任务')
    }
    const args: string[] = []
    if (task.sessionMode === 'existing') {
      if (!sessionId) throw new Error('任务未选择要追加的已有会话')
      args.push('--resume', sessionId)
    } else if (task.sessionMode === 'resume' && sessionId) {
      args.push('--resume', sessionId)
    } else {
      sessionId = randomUUID()
      args.push('--session-id', sessionId)
    }
    args.push('-p', prompt)
    const mode = task.permissionMode ?? 'plan'
    if (mode !== 'follow') args.push('--permission-mode', mode)
    if (task.model) args.push('--model', task.model)
    if (task.maxBudgetUsd !== undefined) {
      args.push('--max-budget-usd', String(task.maxBudgetUsd))
    }
    const launch = buildClaudeLaunch(launcher.command, args)
    const result = await this.spawnAndCapture(launch.file, launch.args, task.projectPath, append, onChild, false)
    return { ...result, sessionId }
  }

  private spawnAndCapture(
    file: string,
    args: string[],
    cwd: string,
    append: (chunk: string) => void,
    onChild: (child: ReturnType<typeof spawn>) => void,
    shell: boolean
  ): Promise<{ exitCode: number | null; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        cwd,
        env: terminalEnv(),
        windowsHide: true,
        shell,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      onChild(child)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        this.kill(child)
      }, TASK_TIMEOUT_MS)
      const stdoutDecoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')
      let settled = false
      child.stdout?.on('data', (chunk: Buffer) => append(stdoutDecoder.write(chunk)))
      child.stderr?.on('data', (chunk: Buffer) => append(stderrDecoder.write(chunk)))
      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (exitCode) => {
        if (settled) return
        settled = true
        const stdoutRest = stdoutDecoder.end()
        if (stdoutRest) append(stdoutRest)
        const stderrRest = stderrDecoder.end()
        if (stderrRest) append(stderrRest)
        clearTimeout(timer)
        resolve({ exitCode, timedOut })
      })
    })
  }

  private kill(child: ReturnType<typeof spawn>): void {
    if (!child.pid) return
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined)
      return
    }
    try {
      child.kill('SIGTERM')
    } catch {
      return
    }
    // A child that ignores SIGTERM must not keep the task busy forever.
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // The process is already gone.
      }
    }, KILL_GRACE_MS)
    timer.unref?.()
    child.once('close', () => clearTimeout(timer))
  }
}