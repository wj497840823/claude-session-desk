import { EventEmitter } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { tempDir } from './helpers'

const mocks = vi.hoisted(() => ({ createWriteStream: vi.fn() }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createWriteStream: mocks.createWriteStream }
})

import { ScheduledTaskService } from '../src/main/scheduledTasks'

const dirs: string[] = []
const services: ScheduledTaskService[] = []

afterEach(async () => {
  vi.clearAllMocks()
  for (const service of services.splice(0)) service.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function waitFor(check: () => boolean, timeout = 15_000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for scheduled task')
}

class FailingStream extends EventEmitter {
  writableEnded = false
  destroyed = false
  readonly chunks: string[] = []

  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }

  end(): void {
    this.writableEnded = true
    // A failed write surfaces as an 'error' event and the stream never emits
    // 'finish'; the run must still complete.
    setTimeout(() => {
      this.destroyed = true
      this.emit('error', new Error('ENOSPC: no space left on device'))
    }, 10)
  }
}

it('finishes a run even when the log stream fails', async () => {
  mocks.createWriteStream.mockImplementation(() => new FailingStream())
  const dir = await tempDir()
  dirs.push(dir)
  const project = join(dir, 'project')
  await mkdir(project)
  const service = new ScheduledTaskService({ userData: join(dir, 'config') })
  services.push(service)
  await service.initialize()

  const task = await service.create({
    name: '日志写入失败',
    enabled: true,
    projectPath: project,
    type: 'command',
    command: 'node -e "process.exit(0)"',
    schedule: { kind: 'interval', minutes: 60 }
  })

  expect(await service.runNow(task.id)).toEqual({ ok: true })
  await waitFor(() => !service.list().find((item) => item.id === task.id)?.running)
  expect(service.list().find((item) => item.id === task.id)?.lastRun?.status).toBe('success')
})