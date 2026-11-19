import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduledTaskService } from '../src/main/scheduledTasks'
import { tempDir } from './helpers'

const dirs: string[] = []
const services: ScheduledTaskService[] = []

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await tempDir()
  dirs.push(dir)
  const project = join(dir, 'project')
  const userData = join(dir, 'config')
  await mkdir(project)
  const notify = vi.fn()
  const service = new ScheduledTaskService({ userData, notify })
  services.push(service)
  await service.initialize()
  return { dir, project, userData, service, notify }
}

async function waitFor(check: () => Promise<boolean> | boolean, timeout = 15_000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for scheduled task')
}

describe('ScheduledTaskService', () => {
  it('creates, runs and logs a command task', async () => {
    const { project, service, notify } = await fixture()
    const task = await service.create({
      name: '命令测试',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'node -e "console.log(\'scheduled-ok\')"',
      schedule: { kind: 'interval', minutes: 60 }
    })
    expect(task.nextRun).toBeGreaterThan(Date.now())
    expect(await service.runNow(task.id)).toEqual({ ok: true })
    await waitFor(() => !service.list().find((item) => item.id === task.id)?.running)
    const updated = service.list().find((item) => item.id === task.id)
    expect(updated?.lastRun?.status).toBe('success')
    const runs = service.runs(task.id)
    expect(runs).toHaveLength(1)
    const log = await service.readLog(task.id, runs[0].id)
    expect(log.content).toContain('scheduled-ok')
    expect(notify).toHaveBeenCalled()
  })

  it('persists tasks and validates project paths and schedules', async () => {
    const { project, userData, service } = await fixture()
    await service.create({
      name: '持久化',
      enabled: false,
      projectPath: project,
      type: 'command',
      command: 'echo ok',
      schedule: { kind: 'daily', time: '09:00' }
    })
    const restored = new ScheduledTaskService({ userData })
    services.push(restored)
    await restored.initialize()
    expect(restored.list().map((item) => item.name)).toEqual(['持久化'])

    await expect(service.create({
      name: '',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'echo ok',
      schedule: { kind: 'daily', time: '09:00' }
    })).rejects.toThrow('任务名称')
    await expect(service.create({
      name: 'bad path',
      enabled: true,
      projectPath: join(project, 'missing'),
      type: 'command',
      command: 'echo ok',
      schedule: { kind: 'daily', time: '09:00' }
    })).rejects.toThrow('项目目录')
    await expect(service.create({
      name: 'bad schedule',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'echo ok',
      schedule: { kind: 'daily', time: '25:00' } as never
    })).rejects.toThrow('调度')
  })

  it('cancels a running task and records it as cancelled', async () => {
    const { project, service } = await fixture()
    const task = await service.create({
      name: '取消测试',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'node -e "setTimeout(() => {}, 60000)"',
      schedule: { kind: 'interval', minutes: 60 }
    })
    expect(await service.runNow(task.id)).toEqual({ ok: true })
    await waitFor(() => service.list().find((item) => item.id === task.id)?.running === true)
    expect(service.cancel(task.id)).toEqual({ ok: true })
    await waitFor(() => !service.list().find((item) => item.id === task.id)?.running)
    expect(service.list().find((item) => item.id === task.id)?.lastRun?.status).toBe('cancelled')
  })

  it('does not advertise a next run for a disabled task', async () => {
    const { project, service } = await fixture()
    const task = await service.create({
      name: '禁用任务',
      enabled: false,
      projectPath: project,
      type: 'command',
      command: 'echo ok',
      schedule: { kind: 'daily', time: '09:00' }
    })
    expect(task.nextRun).toBeUndefined()
    expect(service.list().find((item) => item.id === task.id)?.nextRun).toBeUndefined()
  })

  it('recovers when the log directory cannot be created', async () => {
    const { project, userData, service } = await fixture()
    const blocker = join(userData, 'scheduled-task-logs')
    await mkdir(userData, { recursive: true })
    await writeFile(blocker, 'not a directory')
    const task = await service.create({
      name: '日志失败',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'echo ok',
      schedule: { kind: 'interval', minutes: 60 }
    })

    expect(await service.runNow(task.id)).toEqual({ ok: true })
    await waitFor(() => !service.list().find((item) => item.id === task.id)?.running)
    expect(service.list().find((item) => item.id === task.id)?.lastRun?.status).toBe('failed')

    await rm(blocker)
    expect(await service.runNow(task.id)).toEqual({ ok: true })
    await waitFor(() => service.list().find((item) => item.id === task.id)?.lastRun?.status === 'success')
  })

  it('does not shift an interval schedule when run manually', async () => {
    const dir = await tempDir()
    dirs.push(dir)
    const project = join(dir, 'project')
    const userData = join(dir, 'config')
    await mkdir(project)
    await mkdir(userData, { recursive: true })
    const id = '77777777-7777-4777-8777-777777777777'
    const now = Date.now()
    const nextRun = now + 10 * 60_000
    const lastStarted = now - 50 * 60_000
    await writeFile(join(userData, 'scheduled-tasks.json'), JSON.stringify({
      version: 1,
      tasks: [{
        id,
        name: '间隔任务',
        enabled: true,
        projectPath: project,
        type: 'command',
        command: 'node -e "process.exit(0)"',
        schedule: { kind: 'interval', minutes: 60 },
        createdAt: lastStarted,
        updatedAt: lastStarted,
        nextRun,
        lastRun: {
          id: 'old-run',
          startedAt: lastStarted,
          endedAt: lastStarted + 1000,
          status: 'success',
          logPath: join(userData, 'old-run.log'),
          outputTail: ''
        },
        runs: []
      }]
    }))
    const service = new ScheduledTaskService({ userData })
    services.push(service)
    await service.initialize()
    expect(service.list().find((item) => item.id === id)?.nextRun).toBe(nextRun)

    expect(await service.runNow(id)).toEqual({ ok: true })
    await waitFor(() => !service.list().find((item) => item.id === id)?.running)
    expect(service.list().find((item) => item.id === id)?.nextRun).toBe(nextRun)
  })

  it('refuses to enable a one-off task whose time has passed', async () => {
    const dir = await tempDir()
    dirs.push(dir)
    const project = join(dir, 'project')
    const userData = join(dir, 'config')
    await mkdir(project)
    await mkdir(userData, { recursive: true })
    const id = '99999999-9999-4999-8999-999999999999'
    const at = Date.now() - 60_000
    await writeFile(join(userData, 'scheduled-tasks.json'), JSON.stringify({
      version: 1,
      tasks: [{
        id,
        name: '过期一次性任务',
        enabled: false,
        projectPath: project,
        type: 'command',
        command: 'echo ok',
        schedule: { kind: 'once', at },
        createdAt: at,
        updatedAt: at,
        runs: []
      }]
    }))
    const service = new ScheduledTaskService({ userData })
    services.push(service)
    await service.initialize()

    await expect(service.setEnabled(id, true)).rejects.toThrow('执行时间已过')
    expect(service.list().find((item) => item.id === id)?.enabled).toBe(false)
  })

  it('keeps the future schedule when a one-off task is run manually', async () => {
    const { project, service } = await fixture()
    const at = Date.now() + 3_600_000
    const task = await service.create({
      name: '手动一次性任务',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'node -e "process.exit(0)"',
      schedule: { kind: 'once', at }
    })
    expect(task.nextRun).toBe(at)

    expect(await service.runNow(task.id)).toEqual({ ok: true })
    await waitFor(() => !service.list().find((item) => item.id === task.id)?.running)

    const updated = service.list().find((item) => item.id === task.id)
    expect(updated?.enabled).toBe(true)
    expect(updated?.nextRun).toBe(at)
    expect(updated?.lastRun?.status).toBe('success')
  })

  it('allows renaming an expired one-off task but rejects re-enabling it', async () => {
    const dir = await tempDir()
    dirs.push(dir)
    const project = join(dir, 'project')
    const userData = join(dir, 'config')
    await mkdir(project)
    await mkdir(userData, { recursive: true })
    const id = '88888888-8888-4888-8888-888888888888'
    const at = Date.now() - 60_000
    await writeFile(join(userData, 'scheduled-tasks.json'), JSON.stringify({
      version: 1,
      tasks: [{
        id,
        name: '过期一次性任务',
        enabled: false,
        projectPath: project,
        type: 'command',
        command: 'echo ok',
        schedule: { kind: 'once', at },
        createdAt: at,
        updatedAt: at,
        runs: []
      }]
    }))
    const service = new ScheduledTaskService({ userData })
    services.push(service)
    await service.initialize()

    const input = {
      name: '重命名后的任务',
      enabled: false,
      projectPath: project,
      type: 'command' as const,
      command: 'echo ok',
      schedule: { kind: 'once' as const, at }
    }
    const updated = await service.update(id, input)
    expect(updated.name).toBe('重命名后的任务')
    expect(updated.enabled).toBe(false)

    await expect(service.update(id, { ...input, enabled: true }))
      .rejects.toThrow('执行时间已过')
  })

  it('keeps only the newest run log files', async () => {
    const { project, userData, service } = await fixture()
    const task = await service.create({
      name: '日志轮转',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'node -e "process.exit(0)"',
      schedule: { kind: 'interval', minutes: 60 }
    })
    for (let index = 0; index < 21; index += 1) {
      expect(await service.runNow(task.id)).toEqual({ ok: true })
      await waitFor(() => !service.list().find((item) => item.id === task.id)?.running)
    }
    expect(service.runs(task.id)).toHaveLength(20)
    const logs = await readdir(join(userData, 'scheduled-task-logs', task.id))
    expect(logs.filter((name) => name.endsWith('.log'))).toHaveLength(20)
  })

  it('advances a due periodic schedule after a manual run instead of running twice', async () => {
    const dir = await tempDir()
    dirs.push(dir)
    const project = join(dir, 'project')
    const userData = join(dir, 'config')
    await mkdir(project)
    await mkdir(userData, { recursive: true })
    const id = '77777777-7777-4777-8777-777777777777'
    const due = Date.now() - 60_000
    await writeFile(join(userData, 'scheduled-tasks.json'), JSON.stringify({
      version: 1,
      tasks: [{
        id,
        name: '到期的间隔任务',
        enabled: true,
        projectPath: project,
        type: 'command',
        command: 'node -e "process.exit(0)"',
        schedule: { kind: 'interval', minutes: 1 },
        createdAt: due,
        updatedAt: due,
        nextRun: due,
        runs: []
      }]
    }))
    const service = new ScheduledTaskService({ userData })
    services.push(service)
    await service.initialize()

    expect(await service.runNow(id)).toEqual({ ok: true })
    await waitFor(() => !service.list().find((item) => item.id === id)?.running)
    expect(service.list().find((item) => item.id === id)?.nextRun).toBeGreaterThan(Date.now())
  })

  it('deletes a running task by stopping it first', async () => {
    const { project, service } = await fixture()
    const task = await service.create({
      name: '删除运行中任务',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'node -e "setTimeout(() => {}, 60000)"',
      schedule: { kind: 'interval', minutes: 60 }
    })
    expect(await service.runNow(task.id)).toEqual({ ok: true })
    await waitFor(() => service.list().find((item) => item.id === task.id)?.running === true)
    await service.remove(task.id)
    expect(service.list()).toHaveLength(0)
    expect(service.runs(task.id)).toEqual([])
  })
})