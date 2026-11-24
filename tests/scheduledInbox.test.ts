import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduledTaskService, type ScheduledTaskServiceOptions } from '../src/main/scheduledTasks'
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
  const service = new ScheduledTaskService({
    userData,
    notify: vi.fn(),
    tickMs: 20,
    retryBaseMs: 40,
    retryMaxMs: 80,
    retryGiveUpAt: 3,
    ...overrides
  })
  services.push(service)
  await service.initialize()
  return { project, userData, service }
}

async function waitFor(check: () => boolean, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for scheduled task state')
}

async function runToCompletion(service: ScheduledTaskService, id: string): Promise<void> {
  await service.runNow(id)
  await waitFor(() => !service.list().find((task) => task.id === id)?.running)
}

describe('ScheduledTaskService inbox', () => {
  it('shows the latest successful run and hides a run that is waiting to retry', async () => {
    const { project, service } = await fixture({ retryBaseMs: 60_000, retryMaxMs: 60_000 })
    const task = await service.create({
      name: '失败待重试',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'node -e "process.exit(1)"',
      schedule: { kind: 'interval', minutes: 60 }
    })

    await runToCompletion(service, task.id)
    expect(service.list().find((item) => item.id === task.id)?.retry).toBeDefined()
    expect(service.inbox()).toEqual([])

    const success = await service.create({
      name: '成功任务',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'node -e "console.log(\'inbox-ok\')"',
      schedule: { kind: 'interval', minutes: 60 }
    })
    await runToCompletion(service, success.id)
    const items = service.inbox()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'task',
      taskId: success.id,
      taskName: '成功任务',
      status: 'success',
      projectPath: project
    })
    expect(items[0].outputTail).toContain('inbox-ok')
  })

  it('shows a final failure after retries are exhausted', async () => {
    const { project, service } = await fixture({ retryBaseMs: 20, retryMaxMs: 20, retryGiveUpAt: 2 })
    const task = await service.create({
      name: '重试耗尽',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'node -e "process.exit(1)"',
      schedule: { kind: 'interval', minutes: 60 }
    })

    await runToCompletion(service, task.id)
    await waitFor(() => {
      const current = service.list().find((item) => item.id === task.id)
      return current?.retry === undefined && current?.lastRun?.attempt === 2
    })

    const items = service.inbox()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      taskId: task.id,
      runId: task.id ? service.runs(task.id)[0].id : '',
      status: 'failed',
      attempt: 2
    })
  })

  it('dismisses an item and keeps it dismissed after restart', async () => {
    const { project, userData, service } = await fixture()
    const task = await service.create({
      name: '已读任务',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'node -e "console.log(1)"',
      schedule: { kind: 'interval', minutes: 60 }
    })
    await runToCompletion(service, task.id)
    const [item] = service.inbox()
    expect(item).toBeDefined()

    expect(await service.dismissInbox(item.id)).toBe(true)
    expect(service.inbox()).toEqual([])
    expect(await service.dismissInbox(item.id)).toBe(false)

    const restored = new ScheduledTaskService({ userData, tickMs: 20, retryBaseMs: 20 })
    services.push(restored)
    await restored.initialize()
    expect(restored.inbox()).toEqual([])
  })
})