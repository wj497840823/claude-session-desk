import { mkdir, rm, writeFile } from 'node:fs/promises'
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
    ...overrides
  })
  services.push(service)
  await service.initialize()
  return { dir, project, userData, service }
}

async function waitFor(check: () => boolean, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for scheduled task state')
}

describe('ScheduledTaskService pause and replay', () => {
  it('blocks a due run while paused and runs it after resume', async () => {
    const { project, service } = await fixture()
    const task = await service.create({
      name: '暂停任务',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'node -e "console.log(\'paused-run\')"',
      schedule: { kind: 'once', at: Date.now() + 1_200 }
    })

    await service.pause(task.id, Date.now() + 3_000, '测试暂停')
    expect(service.list().find((item) => item.id === task.id)?.pausedUntil).toBeGreaterThan(Date.now())
    await new Promise((resolve) => setTimeout(resolve, 1_800))
    expect(service.runs(task.id)).toHaveLength(0)

    const resumed = await service.resume(task.id)
    expect(resumed.skipped).toBe(0)
    expect(resumed.task.pausedUntil).toBeUndefined()
    await waitFor(() => service.runs(task.id).length === 1)
    expect(service.runs(task.id)[0].status).toBe('success')
  })

  it('records skipped triggers, reports them on resume, and replays once', async () => {
    const { project, service } = await fixture()
    const task = await service.create({
      name: '补跑任务',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'node -e "console.log(\'replay-ok\')"',
      schedule: { kind: 'interval', minutes: 60 }
    })

    await service.pause(task.id, Date.now() + 60_000)
    await service.noteSkippedTrigger(task.id, '文件已变更')
    await service.noteSkippedTrigger(task.id, 'Git 有新提交')
    expect(service.list().find((item) => item.id === task.id)?.skippedTriggerCount).toBe(2)

    const resumed = await service.resume(task.id)
    expect(resumed.skipped).toBe(2)
    expect(resumed.task.skippedTriggerCount).toBe(2)

    expect(await service.replay(task.id)).toEqual({ ok: true })
    await waitFor(() => service.runs(task.id).length === 1)
    expect(service.list().find((item) => item.id === task.id)?.skippedTriggerCount).toBe(0)
    expect(service.runs(task.id)[0].status).toBe('success')
  })

  it('persists skipped triggers across restart', async () => {
    const { project, userData, service } = await fixture()
    const task = await service.create({
      name: '跳过持久化',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'node -e "console.log(1)"',
      schedule: { kind: 'interval', minutes: 60 }
    })
    await service.noteSkippedTrigger(task.id, '文件已变更')
    service.dispose()

    const restored = new ScheduledTaskService({ userData, tickMs: 20 })
    services.push(restored)
    await restored.initialize()
    expect(restored.list().find((item) => item.id === task.id)?.skippedTriggerCount).toBe(1)
  })

  it('validates file trigger paths and keeps git triggers', async () => {
    const { dir, project, service } = await fixture()
    const watched = join(dir, 'watched.txt')
    await writeFile(watched, 'x')

    const fileTask = await service.create({
      name: '文件触发',
      enabled: false,
      projectPath: project,
      type: 'command',
      command: 'echo ok',
      schedule: { kind: 'interval', minutes: 60 },
      trigger: { kind: 'file', path: watched }
    })
    expect(fileTask.trigger).toEqual({ kind: 'file', path: watched })

    const gitTask = await service.create({
      name: 'Git 触发',
      enabled: false,
      projectPath: project,
      type: 'command',
      command: 'echo ok',
      schedule: { kind: 'interval', minutes: 60 },
      trigger: { kind: 'git' }
    })
    expect(gitTask.trigger).toEqual({ kind: 'git' })

    await expect(service.create({
      name: '坏触发器',
      enabled: false,
      projectPath: project,
      type: 'command',
      command: 'echo ok',
      schedule: { kind: 'interval', minutes: 60 },
      trigger: { kind: 'file', path: join(dir, 'missing.txt') }
    })).rejects.toThrow('触发器路径')
  })
})