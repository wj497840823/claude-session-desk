import { describe, expect, it } from 'vitest'
import { parseClaudeViewAsk } from '../src/main/ask'

function fence(value: unknown): string {
  return `\n\n\`\`\`claudeview\n${JSON.stringify(value)}\n\`\`\``
}

describe('parseClaudeViewAsk', () => {
  it('parses the last claudeview ask block', () => {
    const text = `完成了一部分。${fence({
      ask: {
        title: '怎么继续？',
        text: '两种方式都可以。',
        options: ['继续', '停止']
      }
    })}`
    expect(parseClaudeViewAsk(text)).toEqual({
      title: '怎么继续？',
      text: '两种方式都可以。',
      options: ['继续', '停止']
    })
  })

  it('uses the last block when several are present', () => {
    const text = fence({ ask: { title: '旧的', options: ['A'] } }) +
      fence({ ask: { title: '新的', options: ['B'] } })
    expect(parseClaudeViewAsk(text)?.title).toBe('新的')
  })

  it('accepts an array and sanitizes options', () => {
    const text = fence({
      ask: [{
        title: '  标题  ',
        options: [' A ', '', 'B', 'C', 'D', 'E', 'F']
      }]
    })
    const ask = parseClaudeViewAsk(text)
    expect(ask?.title).toBe('标题')
    expect(ask?.options).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('rejects missing, malformed and empty blocks', () => {
    expect(parseClaudeViewAsk(undefined)).toBeNull()
    expect(parseClaudeViewAsk('普通回复')).toBeNull()
    expect(parseClaudeViewAsk('```claudeview\nnot json\n```')).toBeNull()
    expect(parseClaudeViewAsk('```claudeview\n{"ask":{}}\n```')).toBeNull()
    expect(parseClaudeViewAsk('```claudeview\n[]\n```')).toBeNull()
  })
})