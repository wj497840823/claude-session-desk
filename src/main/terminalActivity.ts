export type TerminalActivity = 'working' | 'idle' | 'approval'

export interface ActivitySignal {
  approval: boolean
  busy: boolean
}

const ANSI_PATTERN =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][\s\S]*?\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>]/g

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

const APPROVAL_PROMPT =
  /(?:Do you want to (?:proceed|allow|make this edit|run|use)\?|Do you want to (?:proceed|allow|make this edit|run|use)|Would you like to (?:proceed|allow)|Allow (?:this|Claude to)[\s\S]{0,80}\?)[\s\S]{0,600}?(?:❯\s*)?1\.\s*Yes[\s\S]{0,400}?2\.\s*(?:Yes|No)/i

const BUSY_HINT = /esc to interrupt|Press (?:Ctrl\+C|Esc) to (?:interrupt|cancel)|✻\s*\S+/i

export function detectActivitySignal(text: string): ActivitySignal {
  return {
    approval: APPROVAL_PROMPT.test(text),
    busy: !APPROVAL_PROMPT.test(text) && BUSY_HINT.test(text)
  }
}

export interface TerminalActivityTrackerOptions {
  onChange: (activity: TerminalActivity) => void
  idleMs?: number
}

export class TerminalActivityTracker {
  private readonly onChange: (activity: TerminalActivity) => void
  private readonly idleMs: number
  private buffer = ''
  private phase: TerminalActivity | null = null
  private armed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(options: TerminalActivityTrackerOptions) {
    this.onChange = options.onChange
    this.idleMs = options.idleMs ?? 1800
  }

  noteInput(data: string): void {
    if (this.disposed || !/[\r\n]/.test(data)) return
    this.armed = true
    // A submitted answer or message supersedes any prompt still visible in
    // the scrollback, so stale approval text must not be re-detected.
    this.buffer = ''
    this.clearTimer()
    this.emit('working')
  }

  push(data: string): void {
    if (this.disposed) return
    this.buffer = (this.buffer + stripAnsi(data)).slice(-4096)
    const signal = detectActivitySignal(this.buffer)
    if (signal.approval) {
      this.clearTimer()
      this.emit('approval')
      return
    }
    if (!this.armed) return
    this.emit('working')
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.disposed && this.phase !== 'approval') this.emit('idle')
    }, this.idleMs)
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  private emit(activity: TerminalActivity): void {
    if (this.phase === activity) return
    this.phase = activity
    this.onChange(activity)
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}