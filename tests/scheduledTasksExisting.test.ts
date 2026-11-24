import { EventEmitter } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn()
}))
vi.mock('node:child_process', () => mocks)
vi.mock('../src/main/claudeCli', () => ({
  resolveClaudeLauncher: () => ({ command: 'claude-fixture', resolved: true }),
  CLAUDE_CLI_HINT: '',
  buildClaudeLaunch: (file: string, args: string[]) => ({ file, args })
}))

import { ScheduledTaskService, type ScheduledTaskServiceOptions } from '../src/main/scheduledTasks'

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const dirs: string[] = []
const services: ScheduledTaskService[] = []

afterEach(async () => {
  vi.clearAllMocks()
  for (const service of services.splice(0)) service.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

type FakeChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  pid: number
  killed: boolean
  kill: () => void
}

function fakeChild(exitCode = 0): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 4242
  child.killed = false
  child.kill = vi.fn()
  setTimeout(() => child.emit('close', exitCode), 100)
  return child
}

function failingSpawnChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 4243
  child.killed = false
  child.kill = vi.fn()
  setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 20)
  return child
}

function slowChild(closeAfter = 200): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 4244
  child.killed = false
  child.kill = vi.fn()
  setTimeout(() => child.emit('close', 0), closeAfter)
  return child
}

async function fixture(
  resolveSession?: ScheduledTaskServiceOptions['resolveSession'],
  isSessionActive?: ScheduledTaskServiceOptions['isSessionActive']
) {
  const dir = await tempDir()
  dirs.push(dir)
  const project = join(dir, 'project')
  await mkdir(project)
  const service = new ScheduledTaskService({
    userData: join(dir, 'config'),
    ...(resolveSession ? { resolveSession } : {}),
    ...(isSessionActive ? { isSessionActive } : {})
  })
  services.push(service)
  await service.initialize()
  return { project, service }
}

function input(project: string, overrides: Record<string, unknown> = {}) {
  return {
    name: '追加到已有会话',
    enabled: true,
    projectPath: project,
    type: 'claude' as const,
    prompt: '继续之前的任务',
    permissionMode: 'plan' as const,
    sessionMode: 'existing' as const,
    resumeSessionId: SESSION_ID,
    schedule: { kind: 'interval' as const, minutes: 60 },
    ...overrides
  }
}

async function waitFor(check: () => boolean, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for scheduled task')
}

describe('ScheduledTaskService existing-session mode', () => {
  it('does not recreate a task deleted while its edit validates the session', async () => {
    let releaseValidation!: () => void
    let validationStarted!: () => void
    const started = new Promise<void>((resolve) => { validationStarted = resolve })
    const waitForValidation = new Promise<void>((resolve) => { releaseValidation = resolve })
    let defer = false
    let projectPath = ''
    const { project, service } = await fixture(async () => {
      if (defer) {
        validationStarted()
        await waitForValidation
      }
      return { projectPath, source: 'transcript', cwdExists: true }
    })
    projectPath = project
    const task = await service.create(input(project))
    defer = true
    const edit = service.update(task.id, input(project, { name: '修改后的任务' }))
    await started
    await service.remove(task.id)
    releaseValidation()
    await expect(edit).rejects.toThrow('定时任务不存在')
    expect(service.list()).toEqual([])
  })

  it('requires a session id when appending to an existing session', async () => {
    const { project, service } = await fixture()
    await expect(service.create(input(project, { resumeSessionId: undefined })))
      .rejects.toThrow('已有会话')
  })

  it('rejects a malformed session id', async () => {
    const { project, service } = await fixture()
    await expect(service.create(input(project, { resumeSessionId: 'not-a-session' })))
      .rejects.toThrow('会话 ID')
  })

  it('rejects a selected session from another project', async () => {
    const { project, service } = await fixture(async () => ({
      projectPath: 'C:\\some-other-project',
      source: 'transcript',
      cwdExists: true
    }))
    await expect(service.create(input(project))).rejects.toThrow('不属于当前项目')
  })

  it('rejects a selected session that cannot be resumed', async () => {
    const { project, service } = await fixture(async () => null)
    await expect(service.create(input(project))).rejects.toThrow('无法恢复')
  })

  it('refuses to append while the target session is open in a terminal', async () => {
    const { project, service } = await fixture(undefined, () => true)
    const task = await service.create(input(project))
    expect(await service.runNow(task.id)).toEqual({
      ok: false,
      message: '该会话正在终端中打开，请关闭该对话标签后再运行定时任务'
    })
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(service.list().find((item) => item.id === task.id)?.lastRun).toBeUndefined()
  })

  it('tracks the generated session while a new-session task runs', async () => {
    mocks.spawn.mockImplementation(() => slowChild())
    const { project, service } = await fixture()
    const task = await service.create(input(project, {
      sessionMode: 'new',
      resumeSessionId: undefined
    }))

    expect(await service.runNow(task.id)).toEqual({ ok: true })
    await waitFor(() => mocks.spawn.mock.calls.length > 0)
    const args = mocks.spawn.mock.calls[0][1] as string[]
    const sessionId = args[args.indexOf('--session-id') + 1]
    expect(sessionId).toBeTruthy()
    expect(service.isSessionRunning(sessionId)).toBe(true)
    await waitFor(() => !service.list().find((item) => item.id === task.id)?.running)
    expect(service.isSessionRunning(sessionId)).toBe(false)
  })

  it('refuses to start a second task for the same session', async () => {
    mocks.spawn.mockImplementation(() => slowChild())
    const { project, service } = await fixture()
    const first = await service.create(input(project, { name: '任务 A' }))
    const second = await service.create(input(project, { name: '任务 B' }))

    expect(await service.runNow(first.id)).toEqual({ ok: true })
    await waitFor(() => mocks.spawn.mock.calls.length > 0)
    const secondResult = await service.runNow(second.id)
    expect(secondResult.ok).toBe(false)
    expect(secondResult.message).toContain('另一个定时任务')
    await waitFor(() => !service.list().find((item) => item.id === first.id)?.running)
  })

  it('reports the target session as running while the task is active', async () => {
    mocks.spawn.mockImplementation(() => fakeChild())
    const { project, service } = await fixture()
    const task = await service.create(input(project))
    expect(await service.runNow(task.id)).toEqual({ ok: true })
    expect(service.isSessionRunning(SESSION_ID)).toBe(true)
    await waitFor(() => !service.list().find((item) => item.id === task.id)?.running)
    expect(service.isSessionRunning(SESSION_ID)).toBe(false)
  })

  it('runs with --resume and appends to the chosen session', async () => {
    mocks.spawn.mockImplementation(() => fakeChild())
    const { project, service } = await fixture()
    const task = await service.create(input(project))
    expect(task.sessionMode).toBe('existing')
    expect(task.resumeSessionId).toBe(SESSION_ID)

    expect(await service.runNow(task.id)).toEqual({ ok: true })
    await waitFor(() => !service.list().find((item) => item.id === task.id)?.running)

    const args = mocks.spawn.mock.calls[0][1] as string[]
    expect(mocks.spawn.mock.calls[0][0]).toBe('claude-fixture')
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe(SESSION_ID)
    expect(args).not.toContain('--session-id')
    expect(args).toContain('-p')
    expect(args[args.indexOf('-p') + 1]).toContain('继续之前的任务')
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ cwd: project })

    const updated = service.list().find((item) => item.id === task.id)
    expect(updated?.lastRun?.status).toBe('success')
    expect(updated?.lastRun?.sessionId).toBe(SESSION_ID)
  })

  it('does not persist a dedicated session when the child fails to spawn', async () => {
    mocks.spawn.mockImplementation(() => failingSpawnChild())
    const { project, service } = await fixture()
    const task = await service.create(input(project, {
      sessionMode: 'resume',
      resumeSessionId: undefined
    }))
    expect(task.resumeSessionId).toBeUndefined()

    expect(await service.runNow(task.id)).toEqual({ ok: true })
    await waitFor(() => !service.list().find((item) => item.id === task.id)?.running)

    const updated = service.list().find((item) => item.id === task.id)
    expect(updated?.lastRun?.status).toBe('failed')
    expect(updated?.resumeSessionId).toBeUndefined()
  })

  it('does not persist a dedicated session when the first run exits with an error', async () => {
    mocks.spawn.mockImplementation(() => fakeChild(1))
    const { project, service } = await fixture()
    const task = await service.create(input(project, {
      sessionMode: 'resume',
      resumeSessionId: undefined
    }))
    expect(task.resumeSessionId).toBeUndefined()

    expect(await service.runNow(task.id)).toEqual({ ok: true })
    await waitFor(() => !service.list().find((item) => item.id === task.id)?.running)
    const failed = service.list().find((item) => item.id === task.id)
    expect(failed?.lastRun?.status).toBe('failed')
    expect(failed?.resumeSessionId).toBeUndefined()

    mocks.spawn.mockImplementation(() => fakeChild(0))
    expect(await service.runNow(task.id)).toEqual({ ok: true })
    await waitFor(() => service.list().find((item) => item.id === task.id)?.lastRun?.status === 'success')
    const retried = service.list().find((item) => item.id === task.id)
    const args = mocks.spawn.mock.calls[1][1] as string[]
    expect(args).toContain('--session-id')
    expect(retried?.resumeSessionId).toBe(args[args.indexOf('--session-id') + 1])
  })

  it('drops a dedicated session when the project path changes', async () => {
    const { project, service } = await fixture()
    const task = await service.create(input(project, {
      sessionMode: 'resume',
      resumeSessionId: SESSION_ID
    }))
    expect(task.resumeSessionId).toBe(SESSION_ID)

    const other = join(project, 'other')
    await mkdir(other)
    const updated = await service.update(task.id, input(other, {
      sessionMode: 'resume',
      resumeSessionId: undefined
    }))
    expect(updated.resumeSessionId).toBeUndefined()
  })

  it('decodes multi-byte output split across data chunks', async () => {
    mocks.spawn.mockImplementation(() => {
      const child = fakeChild()
      setTimeout(() => {
        const bytes = Buffer.from('你好')
        child.stdout.emit('data', bytes.subarray(0, 2))
        child.stdout.emit('data', bytes.subarray(2))
      }, 10)
      return child
    })
    const { project, service } = await fixture()
    const task = await service.create({
      name: 'UTF-8 分片',
      enabled: true,
      projectPath: project,
      type: 'command',
      command: 'echo ignored',
      schedule: { kind: 'interval', minutes: 60 }
    })

    expect(await service.runNow(task.id)).toEqual({ ok: true })
    await waitFor(() => !service.list().find((item) => item.id === task.id)?.running)
    const runs = service.runs(task.id)
    expect(runs).toHaveLength(1)
    const log = await service.readLog(task.id, runs[0].id)
    expect(log.content).toContain('你好')
  })

  it('clears the chosen session when switching to dedicated-session mode', async () => {
    const { project, service } = await fixture()
    const task = await service.create(input(project))
    const updated = await service.update(task.id, input(project, {
      sessionMode: 'resume',
      resumeSessionId: undefined
    }))
    expect(updated.sessionMode).toBe('resume')
    expect(updated.resumeSessionId).toBeUndefined()
  })
})
