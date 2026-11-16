import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseSessionMeta } from '../src/main/parser'
import { tempDir, writeJsonl } from './helpers'

const SID = '11111111-1111-4111-8111-111111111111'
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})

async function fixture(records: Array<unknown | string>) {
  const dir = await tempDir()
  dirs.push(dir)
  const filePath = join(dir, `${SID}.jsonl`)
  await writeJsonl(filePath, records)
  return { dir, filePath }
}

describe('parseSessionMeta', () => {
  it('extracts sessionId, cwd, ai-title, time range and message count', async () => {
    const { filePath } = await fixture([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-11-13T10:00:00.000Z',
        cwd: 'E:/demo',
        sessionId: SID,
        origin: { kind: 'human' },
        message: { role: 'user', content: '修复登录问题\n第二行' }
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-11-13T10:01:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '内部思考' },
            { type: 'text', text: '好的，我来看看。' }
          ]
        }
      },
      { type: 'ai-title', aiTitle: '修复登录接口', sessionId: SID },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-11-13T10:02:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]
        }
      },
      'this is not json'
    ])

    const meta = await parseSessionMeta(filePath)
    expect(meta.sessionId).toBe(SID)
    expect(meta.cwd).toBe('E:/demo')
    expect(meta.title).toBe('修复登录接口')
    expect(meta.titleSource).toBe('ai-title')
    expect(meta.messageCount).toBe(2)
    expect(meta.createdAt).toBe(Date.parse('2026-11-13T10:00:00.000Z'))
    expect(meta.updatedAt).toBe(Date.parse('2026-11-13T10:02:00.000Z'))
  })

  it('falls back to the first human prompt first line', async () => {
    const { filePath } = await fixture([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-11-13T10:00:00.000Z',
        origin: { kind: 'human' },
        message: { role: 'user', content: '第一行标题\n第二行内容' }
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-11-13T10:01:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] }
      }
    ])
    const meta = await parseSessionMeta(filePath)
    expect(meta.title).toBe('第一行标题')
    expect(meta.titleSource).toBe('first-prompt')
  })

  it('ignores task-notification and tool results when building the title', async () => {
    const { filePath } = await fixture([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-11-13T10:00:00.000Z',
        origin: { kind: 'task-notification' },
        message: { role: 'user', content: '后台任务完成' }
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-11-13T10:01:00.000Z',
        origin: { kind: 'human' },
        message: { role: 'user', content: '真正的标题' }
      }
    ])
    const meta = await parseSessionMeta(filePath)
    expect(meta.title).toBe('真正的标题')
  })

  it('falls back to the file name and 新会话 for empty files', async () => {
    const { filePath } = await fixture([''])
    const meta = await parseSessionMeta(filePath)
    expect(meta.sessionId).toBe(SID)
    expect(meta.title).toBe('新会话')
    expect(meta.titleSource).toBe('fallback')
    expect(meta.messageCount).toBe(0)
  })
})