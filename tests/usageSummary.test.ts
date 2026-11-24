import { describe, expect, it } from 'vitest'
import type { ScheduledTaskRun } from '@shared/types'
import {
  emptyUsageTotals,
  mergeUsageTotals,
  summarizeRunUsage
} from '../src/main/scheduledTasks'

function run(overrides: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun {
  return {
    id: 'run-1',
    startedAt: 1_000,
    endedAt: 2_000,
    status: 'success',
    logPath: 'log',
    outputTail: '',
    ...overrides
  }
}

describe('summarizeRunUsage', () => {
  it('sums tokens and prices runs with a known model', () => {
    const totals = summarizeRunUsage([
      run({
        model: 'claude-sonnet-4',
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        }
      })
    ], 0)
    expect(totals.runs).toBe(1)
    expect(totals.inputTokens).toBe(1_000_000)
    expect(totals.outputTokens).toBe(1_000_000)
    expect(totals.costUSD).toBeCloseTo(18)
    expect(totals.unpricedRuns).toBe(0)
  })

  it('counts completed runs without usage and unpriced models', () => {
    const totals = summarizeRunUsage([
      run({ id: 'a' }),
      run({
        id: 'b',
        status: 'failed',
        model: 'unknown-model',
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        }
      }),
      run({ id: 'c', status: 'cancelled' })
    ], 0)
    expect(totals.runs).toBe(1)
    expect(totals.missingUsageRuns).toBe(1)
    expect(totals.unpricedRuns).toBe(1)
    expect(totals.costUSD).toBeNull()
  })

  it('ignores runs older than the cutoff', () => {
    const totals = summarizeRunUsage([
      run({ startedAt: 100 }),
      run({ id: 'new', startedAt: 5_000, usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4
      } })
    ], 1_000)
    expect(totals.runs).toBe(1)
    expect(totals.inputTokens).toBe(1)
    expect(totals.cacheWriteTokens).toBe(4)
  })
})

describe('mergeUsageTotals', () => {
  it('adds counters and keeps a null cost only when both sides are unpriced', () => {
    const left = { ...emptyUsageTotals(), runs: 1, inputTokens: 10, costUSD: 1.5 }
    const right = { ...emptyUsageTotals(), runs: 2, inputTokens: 5, costUSD: null }
    const merged = mergeUsageTotals(left, right)
    expect(merged.runs).toBe(3)
    expect(merged.inputTokens).toBe(15)
    expect(merged.costUSD).toBe(1.5)

    expect(mergeUsageTotals(emptyUsageTotals(), emptyUsageTotals()).costUSD).toBeNull()
  })
})