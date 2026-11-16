import { appendFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeHistorySessions } from '../src/main/history'
import { tempDir, writeJsonl } from './helpers'

const hook = vi.hoisted(() => ({ afterTemp: null as null | (() => Promise<void>) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    await actual.writeFile(...args)
    if (String(args[0]).endsWith('.tmp') && hook.afterTemp) {
      const callback = hook.afterTemp
      hook.afterTemp = null
      await callback()
    }
  } }
})
const dirs: string[] = []
afterEach(async () => {
  hook.afterTemp = null
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})

it('retries when Claude writes while a replacement file is being prepared', async () => {
  const dir = await tempDir()
  dirs.push(dir)
  const file = join(dir, 'history.jsonl')
  await writeJsonl(file, [{ sessionId: 'remove-me', display: 'old' }])
  hook.afterTemp = () => appendFile(file, JSON.stringify({ sessionId: 'keep-me', display: 'new writer' }) + '\n')
  const result = await removeHistorySessions(file, new Set(['remove-me']))
  expect(result.deletedSessions).toBe(1)
  const content = await readFile(file, 'utf8')
  expect(content).not.toContain('remove-me')
  expect(content).toContain('keep-me')
})
