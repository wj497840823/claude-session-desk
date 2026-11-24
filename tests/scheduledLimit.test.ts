import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduledTaskService } from '../src/main/scheduledTasks'
import { tempDir } from './helpers'

const dirs: string[] = []
const services: ScheduledTaskService[] = []
const previousCli = process.env.CLAUDE_CLI_PATH
const previousResets = process.env.FAKE_RESETS_AT

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  if (previousCli === undefined) delete process.env.CLAUDE_CLI_PATH
  else process.env.CLAUDE_CLI_PATH = previousCli
  if (previousResets === undefined) delete process.env.FAKE_RESETS_AT
  else process.env.FAKE_RESETS_AT = previousResets
})

async function waitFor(check: () => boolean, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for scheduled task state')
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
const marker = path.join(__dirname, 'limit-marker')
if (fs.existsSync(marker)) {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-session' }))
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    model: 'claude-sonnet-4',
    result: 'done',
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    }
  }))
  process.exit(0)
}
fs.writeFileSync(marker, '1')
const resetsAt = Math.ceil(Number(process.env.FAKE_RESETS_AT) / 1000)
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-session' }))
console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { resetsAt } }))
console.log(JSON.stringify({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  api_error: 'usage_limit_reached',
  result: "You've hit your 5-hour limit"
}))
process.exit(1)
`, 'utf8')
  await writeFile(
    join(bin, 'fake-claude.cmd'),
    '@echo off\r\nnode "%~dp0fake-claude.cjs" %*\r\n',
    'utf8'
  )
  process.env.CLAUDE_CLI_PATH = join(bin, 'fake-claude.cmd')

  const notify = vi.fn()
  const service = new ScheduledTaskService({
    userData,
    notify,
    tickMs: 20,
    retryBaseMs: 40,
    retryMaxMs: 80,
    retryGiveUpAt: 3
  })
  services.push(service)
  await service.initialize()
  return { project, service, notify }
}

describe('Claude usage limit', () => {
  it('queues the run until the reported reset time, then continues', async () => {
    const { project, service, notify } = await fixture()
    const resetsAt = Date.now() + 300
    process.env.FAKE_RESETS_AT = String(resetsAt)
    const task = await service.create({
      name: '额度任务',
      enabled: true,
      projectPath: project,
      type: 'claude',
      prompt: 'do the thing',
      permissionMode: 'plan',
      sessionMode: 'new',
      schedule: { kind: 'interval', minutes: 60 }
    })

    await service.runNow(task.id)
    await waitFor(() => {
      const current = service.list().find((item) => item.id === task.id)
      return current?.lastRun?.status === 'failed' && current.retry?.limit === true
    })

    const limited = service.list().find((item) => item.id === task.id)!
    expect(limited.retry?.reason).toContain('用量限制')
    expect(limited.retry?.at).toBeGreaterThanOrEqual(resetsAt)
    expect(limited.retry?.at).toBeLessThanOrEqual(resetsAt + 2_000)
    expect(notify.mock.calls.some(([title]) =>
      String(title).includes('Claude 用量已达上限')
    )).toBe(true)
    expect(notify.mock.calls.some(([title]) =>
      String(title).includes('定时任务失败')
    )).toBe(false)

    await waitFor(() => {
      const current = service.list().find((item) => item.id === task.id)
      return current?.lastRun?.status === 'success' && current.retry === undefined
    })

    const runs = service.runs(task.id)
    expect(runs.map((run) => run.status)).toEqual(['success', 'failed'])
    expect(runs[0].attempt).toBe(1)
    expect(notify.mock.calls.some(([title]) =>
      String(title).includes('Claude 用量限制已恢复')
    )).toBe(true)

    const usage = service.usageSummary()
    expect(usage.week.runs).toBe(1)
    expect(usage.week.inputTokens).toBe(10)
    expect(usage.week.outputTokens).toBe(20)
    expect(usage.week.missingUsageRuns).toBe(1)
    expect(usage.week.costUSD).not.toBeNull()
    expect(usage.tasks[0]).toMatchObject({ taskName: '额度任务' })
  })
})