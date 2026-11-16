import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeHistorySessions } from '../src/main/history'
import { tempDir, writeJsonl } from './helpers'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})

async function fixture() {
  const dir = await tempDir()
  dirs.push(dir)
  const filePath = join(dir, 'history.jsonl')
  await writeJsonl(filePath, [
    {
      display: 'A 第一条',
      pastedContents: {},
      timestamp: 1000,
      project: 'E:/demo',
      sessionId: 'session-a'
    },
    {
      display: 'A 第二条',
      pastedContents: {},
      timestamp: 2000,
      project: 'E:/demo',
      sessionId: 'session-a'
    },
    {
      display: 'B',
      pastedContents: {},
      timestamp: 3000,
      project: 'E:/demo',
      sessionId: 'session-b'
    },
    {
      display: 'C',
      pastedContents: {},
      timestamp: 4000,
      project: 'E:/demo',
      sessionId: 'session-c'
    },
    'malformed line'
  ])
  return { dir, filePath }
}

describe('removeHistorySessions', () => {
  it('preserves both changes when deletes overlap', async () => {
    const { filePath } = await fixture()
    await Promise.all([
      removeHistorySessions(filePath, new Set(['session-a'])),
      removeHistorySessions(filePath, new Set(['session-b']))
    ])
    const content = await readFile(filePath, 'utf8')
    expect(content).not.toContain('session-a')
    expect(content).not.toContain('session-b')
    expect(content).toContain('session-c')
  })
  it('removes all prompts for selected sessions, preserves other lines and creates a backup', async () => {
    const { dir, filePath } = await fixture()
    const original = await readFile(filePath, 'utf8')

    const result = await removeHistorySessions(filePath, new Set(['session-a']))
    expect(result.deletedSessions).toBe(1)
    expect(result.deletedPrompts).toBe(2)
    expect(result.backupPath).toBeTruthy()

    const content = await readFile(filePath, 'utf8')
    expect(content).not.toContain('session-a')
    expect(content).toContain('session-b')
    expect(content).toContain('session-c')
    expect(content).toContain('malformed line')
    expect(await readFile(result.backupPath!, 'utf8')).toBe(original)

    const backups = (await readdir(dir)).filter((name) =>
      name.startsWith('history.jsonl.bak-')
    )
    expect(backups).toHaveLength(1)
  })

  it('removes multiple sessions in one pass', async () => {
    const { filePath } = await fixture()
    const result = await removeHistorySessions(
      filePath,
      new Set(['session-b', 'session-c'])
    )
    expect(result.deletedSessions).toBe(2)
    expect(result.deletedPrompts).toBe(2)
    const content = await readFile(filePath, 'utf8')
    expect(content).toContain('session-a')
    expect(content).not.toContain('session-b')
    expect(content).not.toContain('session-c')
  })

  it('does nothing and creates no backup when the selected sessions are absent', async () => {
    const { dir, filePath } = await fixture()
    const result = await removeHistorySessions(filePath, new Set(['missing']))
    expect(result.deletedSessions).toBe(0)
    expect(result.deletedPrompts).toBe(0)
    expect(result.backupPath).toBeUndefined()
    const backups = (await readdir(dir)).filter((name) =>
      name.startsWith('history.jsonl.bak-')
    )
    expect(backups).toHaveLength(0)
  })
})
