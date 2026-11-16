import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseSessionDetail } from '../src/main/parser'
import { tempDir, writeJsonl } from './helpers'

const SID = '22222222-2222-4222-8222-222222222222'
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
  return filePath
}

describe('parseSessionDetail', () => {
  it('retains structured file references before tool input is truncated', async () => {
    const filePath = await fixture([{
      type: 'assistant', uuid: 'file-tool', message: { role: 'assistant', content: [{
        type: 'tool_use', id: 'write-file', name: 'Write', input: { content: 'x'.repeat(10000), file_path: 'E:/项目/报告.txt' }
      }] }
    }])
    const parsed = await parseSessionDetail(filePath)
    const event = parsed.events[0]
    if (event.kind !== 'tools') throw new Error('expected tools')
    expect(event.calls[0].files).toEqual(['E:/项目/报告.txt'])
    expect(event.calls[0].input).not.toContain('报告.txt')
  })
  it('builds user, assistant and grouped tool events', async () => {
    const filePath = await fixture([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-11-13T10:00:00.000Z',
        origin: { kind: 'human' },
        message: { role: 'user', content: '帮我跑一下测试' }
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-11-13T10:01:00.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet',
          content: [
            { type: 'thinking', thinking: '先运行测试' },
            { type: 'text', text: '好的。' },
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'Bash',
              input: { command: 'npm test', description: '运行测试' }
            }
          ]
        }
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-11-13T10:02:00.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: 'Exit code 0\nall pass' }
          ]
        }
      }
    ])

    const result = await parseSessionDetail(filePath)
    expect(result.skippedLines).toBe(0)
    expect(result.events.map((event) => event.kind)).toEqual([
      'user',
      'assistant',
      'tools'
    ])
    const assistant = result.events[1]
    if (assistant.kind !== 'assistant') throw new Error('expected assistant')
    expect(assistant.text).toBe('好的。')
    expect(assistant.model).toBe('claude-sonnet')

    const tools = result.events[2]
    if (tools.kind !== 'tools') throw new Error('expected tools')
    expect(tools.calls).toHaveLength(1)
    expect(tools.calls[0].name).toBe('Bash')
    expect(tools.calls[0].inputSummary).toContain('npm test')
    expect(tools.calls[0].result).toContain('all pass')
    expect(tools.calls[0].isError).toBe(false)
  })

  it('ignores thinking-only messages, sidechains and orphan tool results', async () => {
    const filePath = await fixture([
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-11-13T10:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] }
      },
      {
        type: 'assistant',
        uuid: 'a2',
        isSidechain: true,
        timestamp: '2026-11-13T10:01:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '子代理' }] }
      },
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-11-13T10:02:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'missing', content: '孤立结果' }]
        }
      }
    ])
    const result = await parseSessionDetail(filePath)
    expect(result.events).toEqual([])
  })

  it('extracts persisted output paths and marks errors', async () => {
    const filePath = await fixture([
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-11-13T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'openssl x509' } }
          ]
        }
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-11-13T10:01:00.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              is_error: true,
              content:
                '<persisted-output>\nOutput too large.\nFull output saved to: C:\\tmp\\out.txt\n\nPreview: abc'
            }
          ]
        }
      }
    ])
    const result = await parseSessionDetail(filePath)
    const tools = result.events[0]
    if (tools.kind !== 'tools') throw new Error('expected tools')
    expect(tools.calls[0].isError).toBe(true)
    expect(tools.calls[0].persistedOutputPath).toBe('C:\\tmp\\out.txt')
  })

  it('truncates oversized tool results and counts bad lines', async () => {
    const huge = 'x'.repeat(13000)
    const filePath = await fixture([
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-11-13T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.txt' } }
          ]
        }
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-11-13T10:01:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: huge }]
        }
      },
      'not json at all'
    ])
    const result = await parseSessionDetail(filePath)
    expect(result.skippedLines).toBe(1)
    const tools = result.events[0]
    if (tools.kind !== 'tools') throw new Error('expected tools')
    expect(tools.calls[0].result).toContain('…（已截断）')
  })
})
