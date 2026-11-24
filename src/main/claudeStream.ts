import type { TokenUsage } from '@shared/types'

export interface ClaudeStreamSummary {
  started: boolean
  isError: boolean
  usageLimit?: boolean
  limitedUntil?: number
  result?: string
  sessionId?: string
  model?: string
  usage?: TokenUsage
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function finiteTimestamp(seconds: unknown): number | undefined {
  const value = Number(seconds)
  return Number.isFinite(value) && value > 0 ? value * 1000 : undefined
}

/**
 * Converts Claude Code's `--output-format stream-json --verbose` output into
 * readable log lines while collecting the structured facts the scheduler needs:
 * whether the turn started, which session it used, and whether it hit a usage
 * limit together with the reset time.
 *
 * Lines that are not JSON are passed through unchanged, so older CLI versions
 * and plain-text errors remain visible.
 */
export class ClaudeStreamLog {
  private buffer = ''
  private started = false
  private isError = false
  private usageLimit = false
  private limitedUntil: number | undefined
  private result: string | undefined
  private sessionId: string | undefined
  private model: string | undefined
  private usage: TokenUsage | undefined
  private lastText = ''

  constructor(private readonly append: (text: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) this.handleLine(line)
  }

  finish(): ClaudeStreamSummary {
    if (this.buffer) {
      this.handleLine(this.buffer)
      this.buffer = ''
    }
    return {
      started: this.started,
      isError: this.isError,
      ...(this.usageLimit ? { usageLimit: true } : {}),
      ...(this.limitedUntil !== undefined ? { limitedUntil: this.limitedUntil } : {}),
      ...(this.result !== undefined ? { result: this.result } : {}),
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(this.usage !== undefined ? { usage: this.usage } : {})
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Plain text output still proves the CLI produced something.
      this.started = true
      this.append(`${line}\n`)
      return
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    for (const message of messages) this.handleMessage(message)
  }

  private handleMessage(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const message = value as Record<string, unknown>
    const type = message.type

    if (type === 'system') {
      if (message.subtype === 'init') this.started = true
      if (typeof message.session_id === 'string') this.sessionId = message.session_id
      return
    }

    if (type === 'rate_limit_event') {
      const info = message.rate_limit_info
      if (info && typeof info === 'object') {
        const until = finiteTimestamp((info as Record<string, unknown>).resetsAt)
        if (until !== undefined) {
          this.limitedUntil = until
          this.append(
            `[额度] 已达到用量上限，预计 ${new Date(until).toLocaleString('zh-CN')} 恢复\n`
          )
        }
      }
      return
    }

    if (type === 'assistant') {
      this.started = true
      const payload = message.message
      if (!payload || typeof payload !== 'object') return
      if (typeof (payload as Record<string, unknown>).model === 'string') {
        this.model = (payload as Record<string, unknown>).model as string
      }
      const content = (payload as Record<string, unknown>).content
      if (!Array.isArray(content)) return
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const item = block as Record<string, unknown>
        if (item.type === 'text') {
          const text = textOf(item.text)
          if (text) {
            this.lastText = text
            this.append(`${text}\n`)
          }
        } else if (item.type === 'tool_use') {
          this.append(`[工具] ${textOf(item.name) || '未知工具'}\n`)
        }
      }
      return
    }

    if (type === 'result') {
      this.started = true
      if (typeof message.session_id === 'string') this.sessionId = message.session_id
      if (typeof message.model === 'string') this.model = message.model
      const usage = message.usage
      if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
        const record = usage as Record<string, unknown>
        const count = (value: unknown): number => {
          const number = Number(value)
          return Number.isFinite(number) && number > 0 ? number : 0
        }
        this.usage = {
          inputTokens: count(record.input_tokens),
          outputTokens: count(record.output_tokens),
          cacheReadTokens: count(record.cache_read_input_tokens),
          cacheWriteTokens: count(record.cache_creation_input_tokens)
        }
      }
      if (!this.model && message.modelUsage && typeof message.modelUsage === 'object') {
        const models = Object.keys(message.modelUsage as Record<string, unknown>)
        if (models[0]) this.model = models[0]
      }
      this.result = textOf(message.result) || this.result
      if (message.api_error === 'usage_limit_reached') {
        this.isError = true
        this.usageLimit = true
      }
      if (message.is_error === true || (message.subtype !== undefined && message.subtype !== 'success')) {
        this.isError = true
      }
      if (this.result && this.result !== this.lastText.trim()) {
        this.append(`${this.result}\n`)
        this.lastText = this.result
      }
    }
  }
}