import type { SessionEvent, SessionUsage, TokenUsage } from './types'

interface ModelPrice {
  match: RegExp
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

// USD per million tokens. Cache reads are billed at 10% of input and cache
// writes at 125%; keep the table small and mark anything else as unpriced.
const PRICES: ModelPrice[] = [
  { match: /opus/i, input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: /sonnet/i, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: /haiku/i, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
]

function priceOf(model: string | undefined): ModelPrice | null {
  if (!model) return null
  return PRICES.find((price) => price.match.test(model)) ?? null
}

export function estimateCost(model: string | undefined, tokens: TokenUsage): number | null {
  const price = priceOf(model)
  if (!price) return null
  return (
    tokens.inputTokens * price.input +
    tokens.outputTokens * price.output +
    tokens.cacheReadTokens * price.cacheRead +
    tokens.cacheWriteTokens * price.cacheWrite
  ) / 1_000_000
}

export function contextLimitFor(model: string | undefined): number | null {
  if (!model) return null
  if (/\[1m\]|[-_ ]1m\b/i.test(model)) return 1_000_000
  if (/claude/i.test(model)) return 200_000
  return null
}

export function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 2).replace(/\.?0+$/, '')}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`
  return String(Math.round(value))
}

export function formatUsageCost(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null
  if (value > 0 && value < 0.01) return '<$0.01'
  return `$${value.toFixed(2)}`
}

export function summarizeUsage(events: SessionEvent[]): SessionUsage | null {
  const totals: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  }
  let latest: TokenUsage | null = null
  let model: string | undefined
  let seen = false

  for (const event of events) {
    if (event.kind !== 'assistant' || !event.usage) continue
    seen = true
    latest = event.usage
    if (event.model) model = event.model
    totals.inputTokens += event.usage.inputTokens
    totals.outputTokens += event.usage.outputTokens
    totals.cacheReadTokens += event.usage.cacheReadTokens
    totals.cacheWriteTokens += event.usage.cacheWriteTokens
  }

  if (!seen || !latest) return null
  const contextTokens =
    latest.inputTokens + latest.outputTokens + latest.cacheReadTokens + latest.cacheWriteTokens
  const contextLimit = contextLimitFor(model)
  return {
    ...totals,
    costUSD: estimateCost(model, totals),
    contextTokens,
    contextLimit,
    contextPercent: contextLimit ? (contextTokens / contextLimit) * 100 : null,
    model
  }
}