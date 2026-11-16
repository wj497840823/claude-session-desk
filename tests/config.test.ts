import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../src/main/config'
import type { SessionMeta } from '../src/main/parser'
import { tempDir } from './helpers'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})

async function store() {
  const dir = await tempDir()
  dirs.push(dir)
  return { dir, config: new ConfigStore(dir) }
}

const meta: SessionMeta = {
  sessionId: '33333333-3333-4333-8333-333333333333',
  cwd: 'E:/demo',
  title: '缓存标题',
  titleSource: 'ai-title',
  createdAt: 1,
  updatedAt: 2,
  messageCount: 3
}

describe('ConfigStore', () => {
  it('starts with no favorites', async () => {
    const { config } = await store()
    await expect(config.readFavorites()).resolves.toEqual([])
  })

  it('preserves concurrent favorite and settings updates', async () => {
    const { config } = await store()
    await Promise.all([
      config.setFavorite('a', true),
      config.setFavorite('b', true),
      config.updateSettings({ theme: 'dark' }),
      config.updateSettings({ terminalFontSize: 16 })
    ])
    expect(await config.readFavorites()).toEqual(['a', 'b'])
    expect(await config.readSettings()).toMatchObject({ theme: 'dark', terminalFontSize: 16 })
  })

  it('adds and removes favorites persistently', async () => {
    const { dir, config } = await store()
    await expect(config.setFavorite('session-a', true)).resolves.toEqual(['session-a'])
    await expect(config.setFavorite('session-b', true)).resolves.toEqual([
      'session-a',
      'session-b'
    ])
    expect(await config.readFavorites()).toEqual(['session-a', 'session-b'])
    await expect(config.setFavorite('session-a', false)).resolves.toEqual(['session-b'])

    const raw = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
    expect(raw).toEqual({ version: 1, favorites: ['session-b'] })
  })

  it('recovers from a corrupt config file', async () => {
    const { dir, config } = await store()
    await writeFile(join(dir, 'config.json'), '{bad json', 'utf8')
    await expect(config.readFavorites()).resolves.toEqual([])
  })

  it('removes several favorites in one write', async () => {
    const { config } = await store()
    await config.setFavorite('a', true)
    await config.setFavorite('b', true)
    await config.setFavorite('c', true)
    await expect(config.removeFavorites(['a', 'c', 'missing'])).resolves.toEqual(['b'])
    await expect(config.readFavorites()).resolves.toEqual(['b'])
  })

  it('defaults settings and persists updates without losing favorites', async () => {
    const { dir, config } = await store()
    await expect(config.readSettings()).resolves.toMatchObject({
      loadHistory: false,
      minimizeToTray: true,
      theme: 'system',
      defaultPermissionMode: 'follow',
      terminalFontSize: 13,
      sessionClickAction: 'continue'
    })

    await config.setFavorite('favorite-session', true)
    const updated = await config.updateSettings({
      loadHistory: true,
      theme: 'dark',
      terminalFontSize: 15,
      defaultPermissionMode: 'plan'
    })
    expect(updated).toMatchObject({
      loadHistory: true,
      theme: 'dark',
      terminalFontSize: 15,
      defaultPermissionMode: 'plan'
    })
    await expect(config.readFavorites()).resolves.toEqual(['favorite-session'])

    const raw = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
    expect(raw.favorites).toEqual(['favorite-session'])
    expect(raw.settings).toMatchObject({
      loadHistory: true,
      theme: 'dark',
      terminalFontSize: 15
    })

    await expect(config.setFavorite('second', true)).resolves.toEqual([
      'favorite-session',
      'second'
    ])
    await expect(config.readSettings()).resolves.toMatchObject({
      loadHistory: true,
      theme: 'dark'
    })
  })

  it('ignores invalid setting values', async () => {
    const { config } = await store()
    const settings = await config.updateSettings({
      loadHistory: 'yes' as never,
      theme: 'neon' as never,
      terminalFontSize: 99,
      defaultPermissionMode: 'unknown' as never,
      sessionClickAction: 'unknown' as never
    })
    expect(settings.loadHistory).toBe(false)
    expect(settings.theme).toBe('system')
    expect(settings.terminalFontSize).toBe(13)
    expect(settings.defaultPermissionMode).toBe('follow')
    expect(settings.sessionClickAction).toBe('continue')
  })

  it('round-trips the metadata cache and ignores corrupt cache data', async () => {
    const { dir, config } = await store()
    const cache = {
      version: 1 as const,
      sessions: {
        'E:/demo/session.jsonl': { mtimeMs: 10, size: 20, meta }
      }
    }
    await config.writeCache(cache)
    await expect(config.readCache()).resolves.toEqual(cache)

    await writeFile(join(dir, 'cache.json'), 'not json', 'utf8')
    await expect(config.readCache()).resolves.toEqual({ version: 1, sessions: {} })
  })
})
