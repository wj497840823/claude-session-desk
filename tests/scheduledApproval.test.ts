import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalBroker } from '../src/main/approvalBroker'
import { ScheduledTaskService } from '../src/main/scheduledTasks'
import type { HookRelayHandler, HookRelayLike } from '../src/main/hookRelay'
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

describe('scheduled task approval hooks', () => {
  it('injects hook settings and returns the user decision', async () => {
    const dir = await tempDir()
    dirs.push(dir)
    const project = join(dir, 'project')
    const bin = join(dir, 'bin')
    const userData = join(dir, 'config')
    await mkdir(project)
    await mkdir(bin)
    const argvPath = join(bin, 'argv.json')
    await writeFile(join(bin, 'fake-claude.cjs'), `
const fs = require('node:fs')
const path = require('node:path')
fs.writeFileSync(path.join(__dirname, 'argv.json'), JSON.stringify(process.argv.slice(2)))
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }))
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }))
`, 'utf8')
    await writeFile(
      join(bin, 'fake-claude.cmd'),
      '@echo off\r\nnode "%~dp0fake-claude.cjs" %*\r\n',
      'utf8'
    )
    process.env.CLAUDE_CLI_PATH = join(bin, 'fake-claude.cmd')

    let handler: HookRelayHandler | null = null
    const relay: HookRelayLike = {
      urlFor: (id) => `http://127.0.0.1:9/${id}`,
      register: (_id, next) => { handler = next },
      unregister: () => undefined
    }
    const broker = new ApprovalBroker()
    const service = new ScheduledTaskService({
      userData,
      hookRelay: relay,
      approvalBroker: broker,
      tickMs: 60_000
    })
    services.push(service)
    await service.initialize()
    const task = await service.create({
      name: '定时审批',
      enabled: true,
      projectPath: project,
      type: 'claude',
      prompt: 'do it',
      permissionMode: 'plan',
      sessionMode: 'new',
      schedule: { kind: 'interval', minutes: 60 }
    })

    await service.runNow(task.id)
    await waitFor(() => service.list().find((item) => item.id === task.id)?.lastRun?.status === 'success')

    const argv = JSON.parse(await readFile(argvPath, 'utf8')) as string[]
    const settingsIndex = argv.indexOf('--settings')
    expect(settingsIndex).toBeGreaterThanOrEqual(0)
    const settings = JSON.parse(argv[settingsIndex + 1]) as {
      hooks: { PermissionRequest: Array<{ hooks: Array<{ url: string }> }> }
    }
    expect(settings.hooks.PermissionRequest[0].hooks[0].url).toMatch(/^http:\/\/127\.0\.0\.1:9\//)

    expect(handler).not.toBeNull()
    const pending = handler!({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    })
    await waitFor(() => broker.list().length === 1)
    const [request] = broker.list()
    expect(request.title).toBe('定时审批')
    expect(request.toolName).toBe('Bash')
    expect(broker.resolve(request.id, 'allow')).toBe(true)
    await expect(pending).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' }
      }
    })
  })
})