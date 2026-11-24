import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ScheduledTaskService,
  nextRetrySession,
  retryDelayMs,
  shouldRetry,
  type ScheduledTaskServiceOptions
} from '../src/main/scheduledTasks'
import { tempDir } from './helpers'

const dirs: string[] = []
const services: ScheduledTaskService[] = []

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture(overrides: Partial<ScheduledTaskServiceOptions> = {}) {
  const dir = await tempDir()
  dirs.push(dir)
  const project = join(dir, 'project')
  const userData = join(dir, 'config')
  await mkdir(project)
  const notify = vi.fn()
  const service = new ScheduledTaskService({
    userData,
    notify,
    tickMs: 20,
    retryBaseMs: 40,
    retryMaxMs: 160,
    retryNotifyAt: 2,
    retryGiveUpAt: 3,
    ...overrides
  })
  services.push(service)
  await service.initialize()
  return { dir, project, userData, service, notify }
}

async function waitFor(check: () => boolean, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for scheduled task state')
}

const FAILING_COMMAND = 'node -e "process.exit(1)"'
const FAIL_ONCE_COMMAND =
  'node -e "const fs=require(\'fs\');const p=\'retry-marker.txt\';if(fs.existsSync(p)){process.exit(0)}fs.writeFileSync(p,\'1\');process.exit(1)"'

describe('retry helpers', () => {
  it('grows the delay exponentially and caps it', () => {
    expect(retryDelayMs(1, 300_000, 3_600_000)).toBe(300_000)
    expect(retryDelayMs(2, 300_000, 3_600_000)).toBe(600_000)
    expect(retryDelayMs(3, 300_000, 3_600_000)).toBe(1_200_000)
    expect(retryDelayMs(8, 300_000, 3_600_000)).toBe(3_600_000)
  })

  it('only retries enabled failed or timed-out runs below the limit', () => {
    expect(shouldRetry('failed', true, 1, 10)).toBe(true)
    expect(shouldRetry('timeout', true, 9, 10)).toBe(true)
    expect(shouldRetry('success', true, 1, 10)).toBe(false)
    expect(shouldRetry('cancelled', true, 1, 10)).toBe(false)
    expect(shouldRetry('failed', false, 1, 10)).toBe(false)
    expect(shouldRetry('failed', true, 10, 10)).toBe(false)
  })

  it('carries the session only after the run actually started', () => {
    expect(nextRetrySession({ sessionMode: 'new', usedSessionId: 'a', started: true })).toBe('a')
    expect(nextRetrySession({ sessionMode: 'new', usedSessionId: 'a', started: false })).toBeUndefined()
    expect(nextRetrySession({
      sessionMode: 'existing',
      fixedSessionId: 'f',
      usedSessionId: 'a',
      started: false
    })).toBe('f')
    expect(nextRetrySession({
      sessionMode: 'resume',
      fixedSessionId: 'f',
      usedSessionId: 'a',
      started: false
    })).toBe('f')
    expect(nextRetrySession({ sessionMode: 'resume', usedSessionId: 'a', started: true })).toBe('a')
  })
})

describe('ScheduledTaskService retries', () => {
  it('retries failures with backoff and stops after the attempt limit', async () => {
    const { project, service, notify } = await fixture()
    const task = await service.create({
      name: '失败重试',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: FAILING_COMMAND,
      schedule: { kind: 'interval', minutes: 60 }
    })

    expect(await service.runNow(task.id)).toEqual({ ok: true })
    await waitFor(() => {
      const current = service.list().find((item) => item.id === task.id)
      return current?.lastRun?.status === 'failed' && current.retry?.attempt === 2
    })
    const afterFirst = service.list().find((item) => item.id === task.id)!
    expect(afterFirst.lastRun?.attempt).toBe(1)
    expect(afterFirst.retry?.sessionId).toBeUndefined()
    expect(afterFirst.retry!.at).toBeGreaterThanOrEqual(afterFirst.lastRun!.endedAt + 40)
    expect(afterFirst.retry!.at).toBeLessThanOrEqual(afterFirst.lastRun!.endedAt + 160)
    expect(afterFirst.nextRun).toBe(afterFirst.retry!.at)

    await waitFor(() => (service.runs(task.id)[0]?.attempt ?? 0) >= 2)
    await waitFor(() => (service.runs(task.id)[0]?.attempt ?? 0) >= 3)
    await waitFor(() => service.list().find((item) => item.id === task.id)?.retry === undefined)

    const runs = service.runs(task.id)
    expect(runs.map((run) => run.attempt)).toEqual([3, 2, 1])
    expect(runs.every((run) => run.status === 'failed')).toBe(true)
    expect(notify).toHaveBeenCalled()
  })

  it('clears the retry and records success when a retry succeeds', async () => {
    const { project, service } = await fixture({ retryGiveUpAt: 5 })
    const task = await service.create({
      name: '重试成功',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: FAIL_ONCE_COMMAND,
      schedule: { kind: 'interval', minutes: 60 }
    })

    await service.runNow(task.id)
    await waitFor(() =>
      service.list().find((item) => item.id === task.id)?.lastRun?.status === 'success'
    )
    const updated = service.list().find((item) => item.id === task.id)!
    expect(updated.retry).toBeUndefined()
    expect(updated.lastRun?.attempt).toBe(2)
    const runs = service.runs(task.id)
    expect(runs.map((run) => run.attempt)).toEqual([2, 1])
  })

  it('restarts at attempt 1 when the user runs the task manually', async () => {
    const { project, service } = await fixture({ retryBaseMs: 60_000, retryMaxMs: 60_000 })
    const task = await service.create({
      name: '手动重跑',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: FAILING_COMMAND,
      schedule: { kind: 'interval', minutes: 60 }
    })

    await service.runNow(task.id)
    await waitFor(() => {
      const current = service.list().find((item) => item.id === task.id)
      return Boolean(current?.retry) && !current?.running
    })
    expect(await service.runNow(task.id)).toEqual({ ok: true })
    expect(service.list().find((item) => item.id === task.id)?.retry).toBeUndefined()

    await waitFor(() => !service.list().find((item) => item.id === task.id)?.running)
    expect(service.runs(task.id)[0].attempt).toBe(1)
  })

  it('restores a pending retry after restarting the service', async () => {
    const { project, userData, service } = await fixture({
      retryBaseMs: 60_000,
      retryMaxMs: 60_000
    })
    const task = await service.create({
      name: '重启恢复',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: FAILING_COMMAND,
      schedule: { kind: 'interval', minutes: 60 }
    })
    await service.runNow(task.id)
    await waitFor(() => {
      const current = service.list().find((item) => item.id === task.id)
      return Boolean(current?.retry) && !current?.running
    })
    const saved = service.list().find((item) => item.id === task.id)!.retry!
    service.dispose()

    const restored = new ScheduledTaskService({
      userData,
      tickMs: 20,
      retryBaseMs: 60_000,
      retryMaxMs: 60_000
    })
    services.push(restored)
    await restored.initialize()
    const loaded = restored.list().find((item) => item.id === task.id)!
    expect(loaded.retry).toEqual(saved)
    expect(loaded.nextRun).toBe(saved.at)
  })
})