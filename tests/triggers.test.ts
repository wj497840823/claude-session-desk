import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '@shared/types'
import { TriggerService, defaultReadGitHead, type TriggerServiceOptions } from '../src/main/triggers'
import { ScheduledTaskService } from '../src/main/scheduledTasks'
import { tempDir } from './helpers'

const dirs: string[] = []
const services: TriggerService[] = []
const scheduledServices: ScheduledTaskService[] = []

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  for (const service of scheduledServices.splice(0)) service.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function waitFor(check: () => boolean, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for trigger')
}

function task(id: string, projectPath: string, trigger: ScheduledTask['trigger']): ScheduledTask {
  return {
    id,
    name: id,
    enabled: true,
    projectPath,
    type: 'command',
    command: 'echo ok',
    schedule: { kind: 'interval', minutes: 60 },
    trigger,
    createdAt: 0,
    updatedAt: 0
  }
}

async function fixture(overrides: Partial<TriggerServiceOptions> = {}) {
  const dir = await tempDir()
  dirs.push(dir)
  const watched = join(dir, 'watched.txt')
  await writeFile(watched, 'start')
  const run = vi.fn(() => ({ ok: true }))
  const onSkipped = vi.fn()
  let tasks: ScheduledTask[] = [task('t1', dir, { kind: 'file', path: watched })]
  const service = new TriggerService({
    listTasks: () => tasks,
    run,
    isPaused: () => false,
    onSkipped,
    debounceMs: 40,
    cooldownMs: 0,
    gitPollMs: 30,
    ...overrides
  })
  services.push(service)
  service.start()
  return {
    dir,
    watched,
    run,
    onSkipped,
    service,
    setTasks: (next: ScheduledTask[]) => { tasks = next }
  }
}

describe('defaultReadGitHead', () => {
  it('ignores inherited Git repository overrides', async () => {
    try {
      execFileSync('git', ['--version'], { windowsHide: true })
    } catch {
      return
    }
    const repoA = await tempDir()
    const repoB = await tempDir()
    dirs.push(repoA, repoB)
    const git = (cwd: string, args: string[]): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
    for (const repo of [repoA, repoB]) {
      git(repo, ['init', '-q'])
      git(repo, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test',
        'commit', '--allow-empty', '-qm', repo === repoA ? 'a' : 'b'])
    }
    const headA = git(repoA, ['rev-parse', 'HEAD'])
    const previous = {
      dir: process.env.GIT_DIR,
      workTree: process.env.GIT_WORK_TREE,
      index: process.env.GIT_INDEX_FILE
    }
    process.env.GIT_DIR = join(repoB, '.git')
    process.env.GIT_WORK_TREE = repoB
    try {
      await expect(defaultReadGitHead(repoA)).resolves.toBe(headA)
    } finally {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      restore('GIT_DIR', previous.dir)
      restore('GIT_WORK_TREE', previous.workTree)
      restore('GIT_INDEX_FILE', previous.index)
    }
  })
})

describe('TriggerService file triggers', () => {
  it('discards pending file changes when a task starts watching a different path', async () => {
    const callbacks = new Map<string, () => void>()
    const watch = ((path: string, _options: unknown, callback: () => void) => {
      callbacks.set(path, callback)
      return Object.assign(new EventEmitter(), {
        close: () => { callbacks.delete(path) }
      })
    }) as unknown as TriggerServiceOptions['watch']
    const { dir, watched, run, service, setTasks } = await fixture({ watch })
    const replacement = join(dir, 'replacement.txt')
    vi.useFakeTimers()
    try {
      callbacks.get(watched)!()
      setTasks([task('t1', dir, { kind: 'file', path: replacement })])
      service.sync()
      await vi.advanceTimersByTimeAsync(100)
      expect(run).not.toHaveBeenCalled()
      callbacks.get(replacement)!()
      await vi.advanceTimersByTimeAsync(100)
      expect(run).toHaveBeenCalledExactlyOnceWith('t1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs the task once for a burst of file changes', async () => {
    const { watched, run } = await fixture()
    await new Promise((resolve) => setTimeout(resolve, 80))
    await writeFile(watched, 'one')
    await writeFile(watched, 'two')
    await writeFile(watched, 'three')
    await waitFor(() => run.mock.calls.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('t1')
  })

  it('does not run while paused and records the skipped trigger', async () => {
    const { watched, run, onSkipped } = await fixture({ isPaused: () => true })
    await new Promise((resolve) => setTimeout(resolve, 80))
    await writeFile(watched, 'paused')
    await waitFor(() => onSkipped.mock.calls.length === 1)
    expect(run).not.toHaveBeenCalled()
    expect(onSkipped.mock.calls[0][0]).toBe('t1')
    expect(String(onSkipped.mock.calls[0][1])).toContain('文件')
  })

  it('applies the per-task cooldown', async () => {
    const { watched, run } = await fixture({ cooldownMs: 250 })
    await new Promise((resolve) => setTimeout(resolve, 80))
    await writeFile(watched, 'first')
    await waitFor(() => run.mock.calls.length === 1)
    await writeFile(watched, 'second')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(run).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setTimeout(resolve, 250))
    await writeFile(watched, 'third')
    await waitFor(() => run.mock.calls.length === 2)
  })
})

describe('TriggerService integration', () => {
  it('runs a real scheduled task when the watched file changes', async () => {
    const dir = await tempDir()
    dirs.push(dir)
    const project = join(dir, 'project')
    const userData = join(dir, 'config')
    await mkdir(project)
    await mkdir(userData)
    const watched = join(dir, 'watched.txt')
    await writeFile(watched, 'start')

    const scheduled = new ScheduledTaskService({ userData, tickMs: 60_000 })
    scheduledServices.push(scheduled)
    await scheduled.initialize()
    const task = await scheduled.create({
      name: '触发集成',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'node -e "console.log(\'triggered\')"',
      schedule: { kind: 'interval', minutes: 60 },
      trigger: { kind: 'file', path: watched }
    })

    const trigger = new TriggerService({
      listTasks: () => scheduled.list(),
      run: (id) => scheduled.runNow(id),
      isPaused: (id) => scheduled.isPaused(id),
      onSkipped: (id, reason) => { void scheduled.noteSkippedTrigger(id, reason) },
      debounceMs: 30,
      cooldownMs: 0,
      gitPollMs: 60_000
    })
    services.push(trigger)
    trigger.start()
    await new Promise((resolve) => setTimeout(resolve, 80))
    await writeFile(watched, 'changed')

    await waitFor(() => scheduled.runs(task.id).length === 1)
    expect(scheduled.runs(task.id)[0].status).toBe('success')
  })
})

describe('TriggerService git triggers', () => {
  it('fires when the project HEAD changes', async () => {
    let head: string | null = 'commit-a'
    const run = vi.fn(() => ({ ok: true }))
    const service = new TriggerService({
      listTasks: () => [task('g1', 'E:\\repo', { kind: 'git' })],
      run,
      isPaused: () => false,
      onSkipped: vi.fn(),
      readGitHead: async () => head,
      gitPollMs: 25,
      cooldownMs: 0
    })
    services.push(service)
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(run).not.toHaveBeenCalled()

    head = 'commit-b'
    await waitFor(() => run.mock.calls.length === 1)
    expect(run).toHaveBeenCalledWith('g1')
  })
})
