import { describe, expect, it } from 'vitest'
import { ClaudeStreamLog } from '../src/main/claudeStream'

function collect() {
  const lines: string[] = []
  const log = new ClaudeStreamLog((text) => lines.push(text))
  return { lines, log, text: () => lines.join('') }
}

const json = (value: unknown): string => `${JSON.stringify(value)}\n`

describe('ClaudeStreamLog', () => {
  it('turns assistant text and tool use into readable log lines', () => {
    const { log, text } = collect()
    log.push(json({
      type: 'system',
      subtype: 'init',
      session_id: 'session-a'
    }))
    log.push(json({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '先检查文件。' },
          { type: 'tool_use', name: 'Read' },
          { type: 'text', text: '然后运行测试。' }
        ]
      }
    }))
    const summary = log.finish()
    expect(text()).toContain('先检查文件。')
    expect(text()).toContain('[工具] Read')
    expect(text()).toContain('然后运行测试。')
    expect(summary.started).toBe(true)
    expect(summary.sessionId).toBe('session-a')
    expect(summary.limitedUntil).toBeUndefined()
  })

  it('does not repeat the final result text already streamed', () => {
    const { log, text } = collect()
    log.push(json({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '完成了。' }] }
    }))
    log.push(json({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '完成了。'
    }))
    log.finish()
    expect(text().match(/完成了。/g)).toHaveLength(1)
  })

  it('reports the usage limit and its reset time', () => {
    const { log } = collect()
    log.push(json({
      type: 'rate_limit_event',
      rate_limit_info: { resetsAt: 1_800_000_000 }
    }))
    log.push(json({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      api_error: 'usage_limit_reached',
      result: "You've hit your 5-hour limit"
    }))
    const summary = log.finish()
    expect(summary.limitedUntil).toBe(1_800_000_000_000)
    expect(summary.isError).toBe(true)
    expect(summary.usageLimit).toBe(true)
    expect(summary.started).toBe(true)
  })

  it('collects token usage and the model from the result', () => {
    const { log } = collect()
    log.push(json({
      type: 'assistant',
      message: { model: 'claude-sonnet-4', content: [] }
    }))
    log.push(json({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40
      }
    }))
    const summary = log.finish()
    expect(summary.model).toBe('claude-sonnet-4')
    expect(summary.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40
    })
  })

  it('passes through malformed lines and treats them as started', () => {
    const { log, text } = collect()
    log.push('not json at all\n')
    const summary = log.finish()
    expect(text()).toBe('not json at all\n')
    expect(summary.started).toBe(true)
  })

  it('flushes a trailing partial line on finish', () => {
    const { log, text } = collect()
    log.push('{"type":"assistant","message":{"content":[{"type":"text","text":"尾行"}')
    expect(text()).toBe('')
    log.push(']}}\n')
    expect(text()).toContain('尾行')
  })
})