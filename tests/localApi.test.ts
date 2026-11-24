import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScheduledTask, UsageSummary, UsageTotals } from '@shared/types'
import {
  LocalApiService,
  loadOrCreateApiToken,
  type LocalApiHandlers
} from '../src/main/localApi'

const TOKEN = 'test-token-123'

const totals: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  runs: 0,
  missingUsageRuns: 0,
  unpricedRuns: 0,
  costUSD: null
}
const usage: UsageSummary = {
  today: totals,
  week: totals,
  tasks: [],
  generatedAt: 0
}

function task(id: string): ScheduledTask {
  return {
    id,
    name: id,
    enabled: true,
    projectPath: 'E:\\repo',
    type: 'command',
    command: 'echo ok',
    schedule: { kind: 'interval', minutes: 60 },
    createdAt: 0,
    updatedAt: 0
  }
}

let service: LocalApiService | null = null

afterEach(async () => {
  await service?.stop()
  service = null
})

async function start() {
  const calls: string[] = []
  const handlers: LocalApiHandlers = {
    status: () => ({ ready: true }),
    listTasks: () => [task('t1')],
    listInbox: () => [],
    runTask: async (id) => { calls.push(`run:${id}`); return { ok: true } },
    pauseTask: async (id, until) => {
      calls.push(`pause:${id}:${until}`)
      return task(id)
    },
    resumeTask: async (id) => ({ task: task(id), skipped: 0 }),
    replayTask: async (id) => { calls.push(`replay:${id}`); return { ok: true } },
    answerApproval: (id, decision) => {
      calls.push(`approval:${id}:${decision}`)
      return id === 'a1'
    },
    answerAsk: async (id, answer) => {
      calls.push(`ask:${id}:${JSON.stringify(answer)}`)
      return { ok: true }
    },
    ignoreAsk: async (id) => ({ ok: true }),
    emitEvent: async (event) => {
      calls.push(`event:${event.type}`)
      return { matched: ['t1'], skipped: [] }
    },
    usage: () => usage
  }
  service = new LocalApiService({ token: TOKEN, handlers })
  expect(await service.start()).toBe(true)
  const url = service.info.url
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  return { calls, url: url! }
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
}

describe('LocalApiService', () => {
  it('requires the bearer token', async () => {
    const { url } = await start()
    expect((await fetch(`${url}/v1/status`)).status).toBe(401)
    expect((await fetch(`${url}/v1/status`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    const response = await fetch(`${url}/v1/status`, { headers: auth() })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ready: true })
  })

  it('serves status, tasks, inbox and usage', async () => {
    const { url } = await start()
    expect(await (await fetch(`${url}/v1/tasks`, { headers: auth() })).json()).toEqual([task('t1')])
    expect(await (await fetch(`${url}/v1/inbox`, { headers: auth() })).json()).toEqual([])
    expect(await (await fetch(`${url}/v1/usage`, { headers: auth() })).json()).toEqual(usage)
  })

  it('runs, pauses, resumes and replays tasks', async () => {
    const { calls, url } = await start()
    expect((await fetch(`${url}/v1/tasks/t1/run`, { method: 'POST', headers: auth(), body: '{}' })).status).toBe(200)
    expect(calls).toContain('run:t1')

    const before = Date.now()
    const paused = await fetch(`${url}/v1/tasks/t1/pause`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ minutes: 5, reason: 'test' })
    })
    expect(paused.status).toBe(200)
    const pauseCall = calls.find((call) => call.startsWith('pause:t1:'))
    const until = Number(pauseCall?.split(':')[2])
    expect(until).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1_000)

    expect((await fetch(`${url}/v1/tasks/t1/resume`, { method: 'POST', headers: auth(), body: '{}' })).status).toBe(200)
    expect((await fetch(`${url}/v1/tasks/t1/replay`, { method: 'POST', headers: auth(), body: '{}' })).status).toBe(200)
    expect(calls).toContain('replay:t1')
  })

  it('answers approvals and asks', async () => {
    const { calls, url } = await start()
    expect((await fetch(`${url}/v1/approvals/a1`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ decision: 'allow' })
    })).status).toBe(200)
    expect(calls).toContain('approval:a1:allow')
    expect((await fetch(`${url}/v1/approvals/a2`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ decision: 'deny' })
    })).status).toBe(404)
    expect((await fetch(`${url}/v1/approvals/a1`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ decision: 'maybe' })
    })).status).toBe(400)

    expect((await fetch(`${url}/v1/asks/t1`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ choice: 1 })
    })).status).toBe(200)
    expect(calls.some((call) => call.startsWith('ask:t1:'))).toBe(true)
  })

  it('accepts sanitized external events and rejects unsafe ones', async () => {
    const { calls, url } = await start()
    const response = await fetch(`${url}/v1/events`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        type: 'github.issues.opened',
        subject: '#1',
        summary: 'text',
        cwd: 'C:\\Windows',
        agent: 'claude'
      })
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, matched: ['t1'], skipped: [] })
    expect(calls).toContain('event:github.issues.opened')

    const unsafe = await fetch(`${url}/v1/events`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ type: 'UPPER' })
    })
    expect(unsafe.status).toBe(400)
  })

  it('rejects oversized bodies and unknown routes', async () => {
    const { url } = await start()
    const oversized = await fetch(`${url}/v1/events`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ type: 'ok', summary: 'x'.repeat(70 * 1024) })
    })
    expect(oversized.status).toBe(413)
    expect((await fetch(`${url}/v1/nope`, { headers: auth() })).status).toBe(404)
    expect((await fetch(`${url}/v1/status`, { method: 'DELETE', headers: auth() })).status).toBe(405)
  })
})

describe('loadOrCreateApiToken', () => {
  it('creates a stable 64-character token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csm-api-'))
    try {
      const first = await loadOrCreateApiToken(dir)
      expect(first).toMatch(/^[0-9a-f]{64}$/)
      expect(await loadOrCreateApiToken(dir)).toBe(first)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})