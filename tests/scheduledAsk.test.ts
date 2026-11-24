import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduledTaskService } from '../src/main/scheduledTasks'
import { tempDir } from './helpers'

const dirs: string[] = []
const services: ScheduledTaskService[] = []
const previousCli = process.env.CLAUDE_CLI_PATH

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  if (previousCli === undefined) delete process.env.CLAUDE_CLI_PATH
  else process.env.CLAUDE_CLI_PATH = previousCli
})

async function waitFor(check: () => boolean, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for scheduled task state')
}

async function waitForSavedAsk(userData: string): Promise<void> {
  const file = join(userData, 'scheduled-tasks.json')
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    try {
      if ((await readFile(file, 'utf8')).includes('"pendingAsk"')) return
    } catch {
      // The atomic write may not exist yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for the pending ask to be saved')
}

async function fixture() {
  const dir = await tempDir()
  dirs.push(dir)
  const project = join(dir, 'project')
  const bin = join(dir, 'bin')
  const userData = join(dir, 'config')
  await mkdir(project)
  await mkdir(bin)
  await writeFile(join(bin, 'fake-claude.cjs'), `
const fs = require('node:fs')
const path = require('node:path')
const counter = path.join(__dirname, 'count')
const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1
fs.writeFileSync(counter, String(count))
fs.writeFileSync(path.join(__dirname, 'argv-' + count + '.json'), JSON.stringify(process.argv.slice(2)))
const text = count === 1
  ? '需要确认。\\n\`\`\`claudeview\\n{"ask":{"title":"选哪个","text":"请选择","options":["A","B"]}}\\n\`\`\`'
  : 'done'
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }))
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }))
`, 'utf8')
  await writeFile(
    join(bin, 'fake-claude.cmd'),
    '@echo off\r\nnode "%~dp0fake-claude.cjs" %*\r\n',
    'utf8'
  )
  process.env.CLAUDE_CLI_PATH = join(bin, 'fake-claude.cmd')

  const notify = vi.fn()
  const service = new ScheduledTaskService({ userData, notify, tickMs: 60_000 })
  services.push(service)
  await service.initialize()
  return { bin, project, userData, service, notify }
}

async function createTask(project: string, service: ScheduledTaskService, name = '提问任务') {
  return service.create({
    name,
    enabled: true,
    projectPath: project,
    type: 'claude',
    prompt: 'do it',
    permissionMode: 'plan',
    sessionMode: 'new',
    schedule: { kind: 'interval', minutes: 60 }
  })
}

describe('scheduled task ask and resume', () => {
  it('keeps a pending question on a compatible edit and clears it when converted to a command', async () => {
    const { project, service } = await fixture()
    const task = await createTask(project, service)
    await service.runNow(task.id)
    await waitFor(() => service.hasPendingAsk(task.id))
    const renamed = await service.update(task.id, { ...task, name: '新名称' })
    expect(renamed.pendingAsk?.title).toBe('选哪个')

    const command = await service.update(task.id, { ...renamed, type: 'command', command: 'echo ok' })
    expect(command.pendingAsk).toBeUndefined()
    expect(service.asks()).toEqual([])
  })

  it('stores the question, blocks new runs and resumes the same session after an answer', async () => {
    const { bin, project, service, notify } = await fixture()
    const task = await createTask(project, service)

    await service.runNow(task.id)
    await waitFor(() => Boolean(service.list().find((item) => item.id === task.id)?.pendingAsk))
    const pending = service.list().find((item) => item.id === task.id)!
    expect(pending.pendingAsk).toMatchObject({
      title: '选哪个',
      text: '请选择',
      options: ['A', 'B']
    })
    expect(pending.pendingAsk?.sessionId).toBeTruthy()
    expect(service.inbox()).toEqual([])
    expect(service.asks()).toHaveLength(1)
    expect(service.asks()[0]).toMatchObject({ taskId: task.id, kind: 'ask' })
    expect((await service.runNow(task.id)).ok).toBe(false)
    await waitFor(() => notify.mock.calls.length > 0)

    const firstArgs = JSON.parse(await readFile(join(bin, 'argv-1.json'), 'utf8')) as string[]
    const sessionId = firstArgs[firstArgs.indexOf('--session-id') + 1]
    expect(pending.pendingAsk?.sessionId).toBe(sessionId)

    expect(await service.answerAsk(task.id, { choice: 1 })).toEqual({ ok: true, message: '已提交回答，任务继续运行' })
    await waitFor(() => service.runs(task.id).length >= 2 && !service.hasPendingAsk(task.id))

    const secondArgs = JSON.parse(await readFile(join(bin, 'argv-2.json'), 'utf8')) as string[]
    expect(secondArgs).toContain('--resume')
    expect(secondArgs[secondArgs.indexOf('--resume') + 1]).toBe(sessionId)
    const prompt = secondArgs[secondArgs.indexOf('-p') + 1]
    expect(prompt).toContain('B')
    expect(service.runs(task.id)[0].status).toBe('success')
  })

  it('keeps a pending question when its session is open in a terminal', async () => {
    const { project, userData } = await fixture()
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const now = Date.now()
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'scheduled-tasks.json'), JSON.stringify({
      version: 1,
      tasks: [{
        id,
        name: '打开会话时回答',
        enabled: true,
        projectPath: project,
        type: 'claude',
        prompt: 'do it',
        permissionMode: 'plan',
        sessionMode: 'new',
        schedule: { kind: 'interval', minutes: 60 },
        createdAt: now,
        updatedAt: now,
        runs: [],
        pendingAsk: {
          runId: 'run-open-session',
          sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          title: '选哪个',
          text: '',
          options: ['A', 'B'],
          askedAt: now
        }
      }]
    }))
    const service = new ScheduledTaskService({
      userData,
      isSessionActive: () => true,
      tickMs: 60_000
    })
    services.push(service)
    await service.initialize()

    const result = await service.answerAsk(id, { choice: 0 })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('终端中打开')
    expect(service.hasPendingAsk(id)).toBe(true)
  })

  it('can ignore a pending question without starting another run', async () => {
    const { project, service } = await fixture()
    const task = await createTask(project, service, '忽略任务')
    await service.runNow(task.id)
    await waitFor(() => service.hasPendingAsk(task.id))
    expect(await service.ignoreAsk(task.id)).toEqual({ ok: true })
    expect(service.hasPendingAsk(task.id)).toBe(false)
    expect(service.runs(task.id)).toHaveLength(1)
    expect(service.asks()).toEqual([])
  })

  it('restores a pending question after restarting', async () => {
    const { project, userData, service } = await fixture()
    const task = await createTask(project, service, '持久化提问')
    await service.runNow(task.id)
    await waitFor(() => {
      const current = service.list().find((item) => item.id === task.id)
      return Boolean(current?.pendingAsk) && !current?.running
    })
    const saved = service.list().find((item) => item.id === task.id)?.pendingAsk
    await waitForSavedAsk(userData)
    service.dispose()

    const restored = new ScheduledTaskService({ userData, tickMs: 60_000 })
    services.push(restored)
    await restored.initialize()
    expect(restored.hasPendingAsk(task.id)).toBe(true)
    expect(restored.list().find((item) => item.id === task.id)?.pendingAsk).toEqual(saved)
  })
})
