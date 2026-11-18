import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../src/shared/types'
import {
  estimateCost,
  formatCompactTokens,
  formatUsageCost,
  summarizeUsage
} from '../src/shared/usage'

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite
})

const assistant = (
  uuid: string,
  model: string,
  tokens: ReturnType<typeof usage>
): SessionEvent => ({ kind: 'assistant', uuid, timestamp: 1, text: 'ok', model, usage: tokens })

describe('summarizeUsage', () => {
  it('returns null when no assistant usage was recorded', () => {
    expect(summarizeUsage([{ kind: 'user', uuid: 'u', timestamp: 1, text: 'hi' }])).toBeNull()
  })

  it('sums every token type across assistant turns', () => {
    const summary = summarizeUsage([
      assistant('a1', 'claude-sonnet-4-5', usage(100, 20, 1000, 200)),
      assistant('a2', 'claude-sonnet-4-5', usage(50, 10, 500, 100))
    ])
    expect(summary).toMatchObject({
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 1500,
      cacheWriteTokens: 300
    })
  })

  it('estimates API-equivalent cost for a known model', () => {
    const summary = summarizeUsage([assistant('a1', 'claude-sonnet-4-5', usage(1_000_000, 1_000_000))])
    expect(summary?.costUSD).toBeCloseTo(18, 5)
  })

  it('leaves cost unknown for an unpriced model', () => {
    const summary = summarizeUsage([assistant('a1', 'local-model', usage(10, 10))])
    expect(summary?.costUSD).toBeNull()
  })

  it('uses the latest turn for context usage and the model window', () => {
    const summary = summarizeUsage([
      assistant('a1', 'claude-sonnet-4-5', usage(100, 10)),
      assistant('a2', 'claude-sonnet-4-5', usage(50_000, 1_000, 20_000, 5_000))
    ])
    expect(summary?.contextTokens).toBe(76_000)
    expect(summary?.contextLimit).toBe(200_000)
    expect(summary?.contextPercent).toBeCloseTo(38, 5)
  })

  it('honours a 1M context model', () => {
    const summary = summarizeUsage([assistant('a1', 'claude-sonnet-4-5[1m]', usage(120_000, 1_000))])
    expect(summary?.contextLimit).toBe(1_000_000)
    expect(summary?.contextPercent).toBeCloseTo(12.1, 5)
  })

  it('does not guess a context window for an unknown model', () => {
    const summary = summarizeUsage([assistant('a1', 'other', usage(10, 10))])
    expect(summary?.contextLimit).toBeNull()
    expect(summary?.contextPercent).toBeNull()
  })
})

describe('estimateCost', () => {
  it('prices cache reads and writes relative to input for Claude models', () => {
    const cost = estimateCost('claude-opus-4-5', usage(0, 0, 1_000_000, 1_000_000))
    expect(cost).toBeCloseTo(1.5 + 18.75, 5)
  })
})

describe('usage formatting', () => {
  it('formats compact token counts', () => {
    expect(formatCompactTokens(0)).toBe('0')
    expect(formatCompactTokens(999)).toBe('999')
    expect(formatCompactTokens(12_345)).toBe('12.3k')
    expect(formatCompactTokens(1_250_000)).toBe('1.25M')
  })

  it('formats estimated cost and hides unknown prices', () => {
    expect(formatUsageCost(null)).toBeNull()
    expect(formatUsageCost(0.126)).toBe('$0.13')
    expect(formatUsageCost(0.004)).toBe('<$0.01')
  })
})