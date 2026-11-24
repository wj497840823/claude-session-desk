import { execFile } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { ActionResult, ScheduledTask, ScheduledTaskTrigger } from '@shared/types'

export interface TriggerServiceOptions {
  listTasks: () => ScheduledTask[]
  run: (taskId: string) => ActionResult | Promise<ActionResult>
  isPaused: (taskId: string) => boolean
  onSkipped: (taskId: string, reason: string) => void
  readGitHead?: (projectPath: string) => Promise<string | null>
  notify?: (title: string, body: string) => void
  now?: () => number
  debounceMs?: number
  cooldownMs?: number
  gitPollMs?: number
  watch?: typeof watch
}

export function defaultReadGitHead(projectPath: string): Promise<string | null> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE'
  ]) {
    delete env[key]
  }
  return new Promise((resolveHead) => {
    execFile(
      'git',
      ['-C', projectPath, 'rev-parse', 'HEAD'],
      { windowsHide: true, timeout: 5_000, env },
      (error, stdout) => {
        resolveHead(error ? null : stdout.trim() || null)
      }
    )
  })
}

/**
 * Watches the file paths and Git repositories referenced by enabled tasks and
 * starts them when something changes. A per-task debounce coalesces bursts and
 * a cooldown stops a task that writes into its own watched folder from looping.
 */
export class TriggerService {
  private readonly debounceMs: number
  private readonly cooldownMs: number
  private readonly gitPollMs: number
  private readonly now: () => number
  private readonly readGitHead: (projectPath: string) => Promise<string | null>
  private readonly watchFn: typeof watch

  private watchers = new Map<string, FSWatcher>()
  private fileTasks = new Map<string, Set<string>>()
  private gitTasks = new Map<string, Set<string>>()
  private tasks = new Map<string, ScheduledTaskTrigger>()
  private debounce = new Map<string, { path: string; timer: ReturnType<typeof setTimeout> }>()
  private lastFired = new Map<string, number>()
  private gitHeads = new Map<string, string>()
  private gitTimer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private started = false

  constructor(private readonly options: TriggerServiceOptions) {
    this.debounceMs = options.debounceMs ?? 2_000
    this.cooldownMs = options.cooldownMs ?? 5 * 60_000
    this.gitPollMs = options.gitPollMs ?? 15_000
    this.now = options.now ?? Date.now
    this.readGitHead = options.readGitHead ?? defaultReadGitHead
    this.watchFn = options.watch ?? watch
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.sync()
  }

  sync(): void {
    const tasks = this.options.listTasks().filter((task) => task.enabled && task.trigger)
    const fileTasks = new Map<string, Set<string>>()
    const gitTasks = new Map<string, Set<string>>()
    const triggers = new Map<string, ScheduledTaskTrigger>()

    for (const task of tasks) {
      const trigger = task.trigger
      if (!trigger) continue
      triggers.set(task.id, trigger)
      if (trigger.kind === 'file') {
        const key = resolve(trigger.path)
        const ids = fileTasks.get(key) ?? new Set<string>()
        ids.add(task.id)
        fileTasks.set(key, ids)
      } else if (trigger.kind === 'git') {
        const key = resolve(task.projectPath)
        const ids = gitTasks.get(key) ?? new Set<string>()
        ids.add(task.id)
        gitTasks.set(key, ids)
      }
    }

    for (const [path, watcher] of [...this.watchers]) {
      if (fileTasks.has(path)) continue
      watcher.close()
      this.watchers.delete(path)
    }
    for (const path of fileTasks.keys()) {
      if (this.watchers.has(path)) continue
      try {
        const watcher = this.watchFn(
          path,
          { persistent: false },
          () => this.scheduleFileFire(path)
        )
        watcher.on('error', () => {
          watcher.close()
          this.watchers.delete(path)
        })
        this.watchers.set(path, watcher)
      } catch {
        // A removed or unreadable path is skipped until the next sync.
      }
    }

    this.fileTasks = fileTasks
    this.gitTasks = gitTasks
    this.tasks = triggers
    this.lastFired = new Map([...this.lastFired].filter(([id]) => triggers.has(id)))
    for (const [id, pending] of this.debounce) {
      if (fileTasks.get(pending.path)?.has(id)) continue
      clearTimeout(pending.timer)
      this.debounce.delete(id)
    }
    for (const path of [...this.gitHeads.keys()]) {
      if (!gitTasks.has(path)) this.gitHeads.delete(path)
    }
    this.syncGitTimer()
  }

  dispose(): void {
    for (const pending of this.debounce.values()) clearTimeout(pending.timer)
    this.debounce.clear()
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    if (this.gitTimer) clearInterval(this.gitTimer)
    this.gitTimer = null
    this.fileTasks.clear()
    this.gitTasks.clear()
    this.tasks.clear()
    this.gitHeads.clear()
    this.lastFired.clear()
    this.started = false
  }

  private syncGitTimer(): void {
    if (this.gitTasks.size === 0) {
      if (this.gitTimer) clearInterval(this.gitTimer)
      this.gitTimer = null
      return
    }
    if (this.gitTimer) return
    this.gitTimer = setInterval(() => void this.pollGit(), this.gitPollMs)
    this.gitTimer.unref?.()
    void this.pollGit()
  }

  private scheduleFileFire(path: string): void {
    const ids = this.fileTasks.get(path)
    if (!ids) return
    const reason = `文件变更：${basename(path)}`
    for (const taskId of ids) {
      const existing = this.debounce.get(taskId)
      if (existing) clearTimeout(existing.timer)
      const timer = setTimeout(() => {
        this.debounce.delete(taskId)
        this.fire(taskId, reason)
      }, this.debounceMs)
      timer.unref?.()
      this.debounce.set(taskId, { path, timer })
    }
  }

  private async pollGit(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      for (const projectPath of this.gitTasks.keys()) {
        const head = await this.readGitHead(projectPath).catch(() => null)
        const ids = this.gitTasks.get(projectPath)
        if (!head || !ids) continue
        const previous = this.gitHeads.get(projectPath)
        this.gitHeads.set(projectPath, head)
        if (previous === undefined || previous === head) continue
        for (const taskId of ids) this.fire(taskId, 'Git 有新提交')
      }
    } finally {
      this.polling = false
    }
  }

  private fire(taskId: string, reason: string): void {
    if (!this.tasks.has(taskId)) return
    const now = this.now()
    const previous = this.lastFired.get(taskId)
    if (previous !== undefined && now - previous < this.cooldownMs) return
    if (this.options.isPaused(taskId)) {
      this.options.onSkipped(taskId, reason)
      return
    }
    try {
      Promise.resolve(this.options.run(taskId))
        .then((result) => {
          if (result.ok) this.lastFired.set(taskId, now)
        })
        .catch(() => undefined)
    } catch {
      // A task that cannot start is retried on the next trigger.
    }
  }
}
