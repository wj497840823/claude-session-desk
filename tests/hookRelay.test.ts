import { afterEach, describe, expect, it } from 'vitest'
import { HookRelayService } from '../src/main/hookRelay'

let relay: HookRelayService | null = null

afterEach(async () => {
  await relay?.stop()
  relay = null
})

describe('HookRelayService', () => {
  it('routes a valid POST to the registered pty handler', async () => {
    relay = new HookRelayService()
    expect(await relay.start()).toBe(true)
    expect(relay.running).toBe(true)
    const events: unknown[] = []
    relay.register('pty-1', (event) => events.push(event))
    const response = await fetch(relay.urlFor('pty-1')!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'Stop' })
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual([{ hook_event_name: 'Stop' }])
  })

  it('rejects unknown tokens, unknown ptys and non-POST methods', async () => {
    relay = new HookRelayService()
    await relay.start()
    relay.register('pty-1', () => undefined)
    const base = relay.urlFor('pty-1')!
    const unknownPty = base.replace('/pty-1', '/nope')
    expect((await fetch(unknownPty, { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(base, { method: 'GET' })).status).toBe(405)
    const wrongToken = base.replace(/\/[0-9a-f]{48}\//, '/bad/')
    expect((await fetch(wrongToken, { method: 'POST', body: '{}' })).status).toBe(404)
  })

  it('rejects oversized bodies', async () => {
    relay = new HookRelayService()
    await relay.start()
    relay.register('pty-1', () => undefined)
    const response = await fetch(relay.urlFor('pty-1')!, {
      method: 'POST',
      body: 'x'.repeat(70 * 1024)
    })
    expect(response.status).toBe(413)
  })

  it('handles repeated server errors after start', async () => {
    relay = new HookRelayService()
    await relay.start()
    const server = (relay as unknown as { server: import('node:net').Server }).server
    expect(() => server.emit('error', new Error('first'))).not.toThrow()
    expect(() => server.emit('error', new Error('second'))).not.toThrow()
  })

  it('stops serving on stop()', async () => {
    relay = new HookRelayService()
    await relay.start()
    const url = relay.urlFor('pty-1')!
    await relay.stop()
    expect(relay.running).toBe(false)
    await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow()
    relay = null
  })
})