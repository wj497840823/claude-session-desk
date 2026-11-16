import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/types'
import { makeSnippet, searchHistory, searchSessions } from '../src/main/search'
import { tempDir, writeJsonl } from './helpers'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})

function session(key: string, title: string): SessionSummary {
  return {
    key,
    id: key.split('/')[1],
    projectKey: 'E--demo',
    projectPath: 'E:/demo',
    title,
    titleSource: 'ai-title',
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
    sizeBytes: 10,
    favorite: false,
    cwdExists: true,
    hasSidecar: false,
    source: 'transcript',
    promptCount: 0
  }
}

async function makeFile(records: Array<unknown>) {
  const dir = await tempDir()
  dirs.push(dir)
  const filePath = join(dir, 'session.jsonl')
  await writeJsonl(filePath, records)
  return filePath
}

describe('searchSessions', () => {
  it('combines terms from the title and the conversation body', async () => {
    const filePath = await makeFile([{
      type: 'user', uuid: 'body-match', message: { role: 'user', content: '未授权访问' }
    }])
    const result = await searchSessions({
      query: '登录 未授权', sessions: [session('E--demo/a', '登录接口')],
      sessionFiles: { 'E--demo/a': filePath }
    })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].matchUuid).toBe('body-match')
  })
  it('matches the title without reading the body', async () => {
    const response = await searchSessions({
      query: '登录',
      sessions: [session('E--demo/a', '修复登录接口')],
      sessionFiles: {}
    })
    expect(response.hits).toHaveLength(1)
    expect(response.hits[0].snippet).toBe('修复登录接口')
    expect(response.hits[0].matchUuid).toBe('')
  })

  it('requires all terms and records the first matching uuid', async () => {
    const filePath = await makeFile([
      {
        type: 'user',
        uuid: 'u1',
        origin: { kind: 'human' },
        message: { role: 'user', content: '帮我看看登录接口' }
      },
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '存在未授权访问风险' }]
        }
      }
    ])
    const response = await searchSessions({
      query: '登录 未授权',
      sessions: [session('E--demo/a', '其他标题')],
      sessionFiles: { 'E--demo/a': filePath }
    })
    expect(response.hits).toHaveLength(1)
    expect(response.hits[0].matchUuid).toBe('u1')
    expect(response.hits[0].snippet).toContain('登录')
  })

  it('matches tool names and inputs but not unrelated text', async () => {
    const filePath = await makeFile([
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Bash',
              input: { command: 'npm test' }
            }
          ]
        }
      }
    ])
    const response = await searchSessions({
      query: 'npm test',
      sessions: [session('E--demo/a', '构建')],
      sessionFiles: { 'E--demo/a': filePath }
    })
    expect(response.hits).toHaveLength(1)
    expect(response.hits[0].matchUuid).toBe('a1')

    const empty = await searchSessions({
      query: '完全不存在的词',
      sessions: [session('E--demo/a', '构建')],
      sessionFiles: { 'E--demo/a': filePath }
    })
    expect(empty.hits).toEqual([])
  })

  it('supports cancellation and truncation', async () => {
    const sessions = [session('E--demo/a', '登录 A'), session('E--demo/b', '登录 B')]
    const cancelled = await searchSessions({
      query: '登录',
      sessions,
      sessionFiles: {},
      isCancelled: () => true
    })
    expect(cancelled.cancelled).toBe(true)
    expect(cancelled.hits).toEqual([])

    const truncated = await searchSessions({
      query: '登录',
      sessions,
      sessionFiles: {},
      maxHits: 1
    })
    expect(truncated.hits).toHaveLength(1)
    expect(truncated.truncated).toBe(true)
  })
})

describe('makeSnippet', () => {
  it('strips HTML and control text so snippets stay readable', () => {
    const snippet = makeSnippet(
      '<div style="padding:8px">批量签署 defaultSealId 错误</div>\\n更多内容',
      'defaultSealId'
    )
    expect(snippet).toContain('批量签署 defaultSealId 错误')
    expect(snippet).not.toContain('<div')
    expect(snippet).not.toContain('padding')
  })
})

describe('searchHistory', () => {
  it('matches prompt text and pasted content, returning the prompt index', async () => {
    const historySession = {
      ...session('history/88888888-8888-4888-8888-888888888888', '登录历史'),
      source: 'history' as const,
      promptCount: 2
    }
    const response = await searchHistory({
      query: '密码泄露',
      sessions: [historySession],
      prompts: {
        [historySession.key]: [
          { index: 0, display: '/permissions', timestamp: 1, pastedContents: [] },
          {
            index: 1,
            display: '请检查登录',
            timestamp: 2,
            pastedContents: [{ id: 1, content: '密码泄露风险' }]
          }
        ]
      }
    })
    expect(response.hits).toHaveLength(1)
    expect(response.hits[0].source).toBe('history')
    expect(response.hits[0].matchPromptIndex).toBe(1)
    expect(response.hits[0].snippet).toContain('密码泄露')
  })
})
