import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { readJsonlLines } from '../src/main/jsonl'
import { tempDir, writeJsonl } from './helpers'

const dirs: string[] = []
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})

it('rejects missing files so a disappearing session can be skipped', async () => {
  const dir = await tempDir()
  dirs.push(dir)
  await expect((async () => {
    for await (const _line of readJsonlLines(join(dir, 'missing.jsonl'))) { /* consume */ }
  })()).rejects.toThrow()
})

it('closes the input stream when search stops at an early match', async () => {
  const dir = await tempDir()
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  await writeJsonl(file, Array.from({ length: 10000 }, () => ({ text: 'match' })))
  const open = vi.spyOn(fs, 'createReadStream')
  for await (const line of readJsonlLines(file)) {
    expect(line).toContain('match')
    break
  }
  expect(open.mock.results[0].value.destroyed).toBe(true)
  expect((await readFile(file, 'utf8')).length).toBeGreaterThan(0)
})
