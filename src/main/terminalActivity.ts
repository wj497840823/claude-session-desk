export type TerminalActivity = 'working' | 'idle' | 'approval' | 'background'

export interface ActivitySignal {
  approval: boolean
  busy: boolean
}

const ANSI_PATTERN =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][\s\S]*?\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]|\x1bO[0-9A-Za-z]|\x1b[()][0-9A-Za-z]|\x1b[=>]/g

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

const APPROVAL_PROMPT =
  /(?:Do you want to (?:proceed|allow|make this edit|run|use)\?|Do you want to (?:proceed|allow|make this edit|run|use)|Would you like to (?:proceed|allow)|Allow (?:this|Claude to)[\s\S]{0,80}\?)[\s\S]{0,600}?(?:❯\s*)?1\.\s*Yes[\s\S]{0,400}?2\.\s*(?:Yes|No)/i

const BUSY_HINT = /esc to interrupt|Press (?:Ctrl\+C|Esc) to (?:interrupt|cancel)/i

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
  private pendingInput = ''
  private phase: TerminalActivity | null = null
  private armed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(options: TerminalActivityTrackerOptions) {
    this.onChange = options.onChange
    this.idleMs = options.idleMs ?? 2500
  }

  noteInput(data: string): void {
    if (this.disposed) return
    const clean = stripAnsi(data)
    // Esc denies an approval prompt and Ctrl+C aborts it. Clear the stale
    // prompt text so output after the decision cannot re-detect approval.
    const escape = clean === '\x1b'
    const interrupt = clean.includes('\x03')
    if (this.phase === 'approval' && (escape || interrupt)) {
      this.buffer = ''
      this.pendingInput = ''
      this.clearTimer()
      if (escape) {
        this.armed = true
        this.emit('working')
      } else {
        this.armed = false
        this.emit('idle')
      }
      return
    }
    const submitIndex = clean.search(/[\r\n]/)
    const typed = submitIndex >= 0 ? clean.slice(0, submitIndex) : clean
    this.pendingInput = this.updatePendingInput(this.pendingInput + typed)
    if (submitIndex < 0) return

    const submitted = this.pendingInput.trim().length > 0
    this.pendingInput = ''
    // A submitted answer or message supersedes any prompt still visible in
    // the scrollback, so stale approval text must not be re-detected.
    this.buffer = ''
    if (!submitted) return
    this.armed = true
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
    if (signal.busy && !this.armed) {
      this.armed = true
      this.emit('working')
    }
    if (!this.armed) return
    this.emit('working')
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.disposed || this.phase === 'approval') return
      this.armed = false
      this.buffer = ''
      // Keep pendingInput: text typed ahead while Claude was working is still
      // sitting in the prompt line, and a later Enter submits it.
      this.emit('idle')
    }, this.idleMs)
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  private updatePendingInput(value: string): string {
    let text = ''
    for (const char of value) {
      if (char === '\x7f' || char === '\b') {
        text = text.slice(0, -1)
      } else if (char === '\x15' || char === '\x03') {
        text = ''
      } else if (char >= ' ') {
        text += char
      }
    }
    return text.slice(-500)
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