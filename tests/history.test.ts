import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseHistoryFile } from '../src/main/history'
import { tempDir, writeJsonl } from './helpers'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})

async function fixture(records: Array<unknown | string>) {
  const dir = await tempDir()
  dirs.push(dir)
  const filePath = join(dir, 'history.jsonl')
  await writeJsonl(filePath, records)
  return filePath
}

describe('parseHistoryFile', () => {
  it('groups prompts by session, skips slash commands for the title and keeps pasted text', async () => {
    const filePath = await fixture([
      {
        display: '/permissions',
        pastedContents: {},
        timestamp: 1000,
        project: 'E:/demo',
        sessionId: 'session-a'
      },
      {
        display: '帮我修复登录问题',
        pastedContents: {
          '1': { id: 1, type: 'text', content: 'pasted code' }
        },
        timestamp: 2000,
        project: 'E:/demo',
        sessionId: 'session-a'
      },
      {
        display: '第二段提示',
        pastedContents: {},
        timestamp: 3000,
        project: 'E:/demo',
        sessionId: 'session-a'
      }
    ])

    const result = await parseHistoryFile(filePath)
    expect(result.skippedLines).toBe(0)
    expect(result.sessions).toHaveLength(1)
    const session = result.sessions[0]
    expect(session.sessionId).toBe('session-a')
    expect(session.projectPath).toBe('E:/demo')
    expect(session.title).toBe('帮我修复登录问题')
    expect(session.createdAt).toBe(1000)
    expect(session.updatedAt).toBe(3000)
    expect(session.prompts).toHaveLength(3)
    expect(session.prompts[1].pastedContents).toEqual([
      { id: 1, content: 'pasted code' }
    ])
  })

  it('falls back to the first prompt when every prompt is a slash command', async () => {
    const filePath = await fixture([
      {
        display: '/permissions',
        pastedContents: {},
        timestamp: 1000,
        project: 'E:/demo',
        sessionId: 'session-b'
      }
    ])
    const result = await parseHistoryFile(filePath)
    expect(result.sessions[0].title).toBe('/permissions')
  })

  it('counts malformed lines and ignores records without a session id', async () => {
    const filePath = await fixture([
      {
        display: '有效提示',
        pastedContents: {},
        timestamp: 1000,
        project: 'E:/demo',
        sessionId: 'session-c'
      },
      'not json',
      { display: '没有会话 ID', pastedContents: {}, timestamp: 2000, project: 'E:/demo' }
    ])
    const result = await parseHistoryFile(filePath)
    expect(result.sessions).toHaveLength(1)
    expect(result.skippedLines).toBe(2)
  })
})