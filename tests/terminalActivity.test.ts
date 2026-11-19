import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalActivityTracker,
  detectActivitySignal,
  stripAnsi
} from '../src/main/terminalActivity'

afterEach(() => {
  vi.useRealTimers()
})

describe('detectActivitySignal', () => {
  it('recognizes the native permission prompt through ANSI colouring', () => {
    const output = '\x1b[36mDo you want to proceed?\x1b[0m\r\n' +
      '❯ 1. Yes\r\n  2. Yes, and don’t ask again\r\n  3. No\r\n'
    expect(detectActivitySignal(stripAnsi(output))).toEqual({ approval: true, busy: false })
  })

  it('recognizes the interrupt hint as active work', () => {
    expect(detectActivitySignal('✻ Thinking… (esc to interrupt)')).toEqual({ approval: false, busy: true })
  })

  it('does not treat the finished status line as active work', () => {
    expect(detectActivitySignal('✻ Sautéed for 6s · done 21:30')).toEqual({ approval: false, busy: false })
  })

  it('does not mistake ordinary assistant prose for a prompt', () => {
    expect(detectActivitySignal('Do you want to proceed? I would suggest running the tests first.')).toEqual({
      approval: false,
      busy: false
    })
  })
})

describe('TerminalActivityTracker', () => {
  it('stays quiet during startup output until the user submits a turn', () => {
    vi.useFakeTimers()
    const changes: string[] = []
    const tracker = new TerminalActivityTracker({ onChange: (activity) => changes.push(activity) })
    tracker.push('Claude Code v2.1.318\r\n> Try "fix a bug"')
    vi.advanceTimersByTime(5000)
    expect(changes).toEqual([])
    tracker.dispose()
  })

  it('reports working after a submitted turn and idle when output settles', () => {
    vi.useFakeTimers()
    const changes: string[] = []
    const tracker = new TerminalActivityTracker({ onChange: (activity) => changes.push(activity), idleMs: 1000 })
    tracker.noteInput('hello')
    tracker.noteInput('\r')
    tracker.push('✻ Working… (esc to interrupt)')
    vi.advanceTimersByTime(999)
    expect(changes).toEqual(['working'])
    vi.advanceTimersByTime(1)
    expect(changes).toEqual(['working', 'idle'])
    tracker.dispose()
  })

  it('ignores empty enters, UI toggles and cursor keys', () => {
    vi.useFakeTimers()
    const changes: string[] = []
    const tracker = new TerminalActivityTracker({ onChange: (activity) => changes.push(activity), idleMs: 500 })
    tracker.noteInput('\r')
    tracker.noteInput('\x1b[A')
    tracker.push('✻ Thought for 6s · done 21:30')
    vi.advanceTimersByTime(5000)
    expect(changes).toEqual([])
    tracker.dispose()
  })

  it('does not report another completion from typing or redraws after idle', () => {
    vi.useFakeTimers()
    const changes: string[] = []
    const tracker = new TerminalActivityTracker({ onChange: (activity) => changes.push(activity), idleMs: 500 })
    tracker.noteInput('hello')
    tracker.noteInput('\r')
    tracker.push('✻ Working… (esc to interrupt)')
    vi.advanceTimersByTime(500)
    expect(changes).toEqual(['working', 'idle'])
    tracker.push('typing echo in the prompt')
    vi.advanceTimersByTime(5000)
    expect(changes).toEqual(['working', 'idle'])
    tracker.dispose()
  })

  it('re-arms when background work resumes after an idle period', () => {
    vi.useFakeTimers()
    const changes: string[] = []
    const tracker = new TerminalActivityTracker({ onChange: (activity) => changes.push(activity), idleMs: 500 })
    tracker.noteInput('hello')
    tracker.noteInput('\r')
    tracker.push('✻ Working… (esc to interrupt)')
    vi.advanceTimersByTime(500)
    tracker.push('✻ Thinking… (esc to interrupt)')
    expect(changes).toEqual(['working', 'idle', 'working'])
    vi.advanceTimersByTime(500)
    expect(changes).toEqual(['working', 'idle', 'working', 'idle'])
    tracker.dispose()
  })

  it('reports an approval prompt immediately and only once per prompt', () => {
    vi.useFakeTimers()
    const changes: string[] = []
    const tracker = new TerminalActivityTracker({ onChange: (activity) => changes.push(activity) })
    tracker.noteInput('hello')
    tracker.noteInput('\r')
    tracker.push('Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n')
    tracker.push('Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n')
    vi.advanceTimersByTime(5000)
    expect(changes).toEqual(['working', 'approval'])
    tracker.dispose()
  })

  it('returns to working after the user answers the prompt', () => {
    vi.useFakeTimers()
    const changes: string[] = []
    const tracker = new TerminalActivityTracker({ onChange: (activity) => changes.push(activity), idleMs: 500 })
    tracker.noteInput('hello')
    tracker.noteInput('\r')
    tracker.push('Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n')
    tracker.noteInput('1\r')
    tracker.push('✻ Working… (esc to interrupt)')
    expect(changes).toEqual(['working', 'approval', 'working'])
    vi.advanceTimersByTime(500)
    expect(changes).toEqual(['working', 'approval', 'working', 'idle'])
    tracker.dispose()
  })

  it('keeps text typed ahead across an idle period', () => {
    vi.useFakeTimers()
    const changes: string[] = []
    const tracker = new TerminalActivityTracker({ onChange: (activity) => changes.push(activity), idleMs: 500 })
    tracker.noteInput('hello')
    tracker.noteInput('\r')
    tracker.push('✻ Working… (esc to interrupt)')
    tracker.noteInput('queued prompt')
    vi.advanceTimersByTime(500)
    expect(changes).toEqual(['working', 'idle'])
    tracker.noteInput('\r')
    expect(changes).toEqual(['working', 'idle', 'working'])
    tracker.dispose()
  })

  it('releases an approval prompt when Esc denies it', () => {
    vi.useFakeTimers()
    const changes: string[] = []
    const tracker = new TerminalActivityTracker({ onChange: (activity) => changes.push(activity), idleMs: 500 })
    tracker.noteInput('hello')
    tracker.noteInput('\r')
    tracker.push('Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n')
    tracker.noteInput('\x1b')
    tracker.push('User rejected the request')
    vi.advanceTimersByTime(500)
    expect(changes).toEqual(['working', 'approval', 'working', 'idle'])
    tracker.dispose()
  })

  it('releases an approval prompt when the user aborts with Ctrl+C', () => {
    vi.useFakeTimers()
    const changes: string[] = []
    const tracker = new TerminalActivityTracker({ onChange: (activity) => changes.push(activity), idleMs: 500 })
    tracker.noteInput('hello')
    tracker.noteInput('\r')
    tracker.push('Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n')
    tracker.noteInput('\x03')
    expect(changes).toEqual(['working', 'approval', 'idle'])
    tracker.dispose()
  })

  it('cancels a pending idle report when disposed', () => {
    vi.useFakeTimers()
    const changes: string[] = []
    const tracker = new TerminalActivityTracker({ onChange: (activity) => changes.push(activity), idleMs: 500 })
    tracker.noteInput('hello')
    tracker.noteInput('\r')
    tracker.push('working')
    tracker.dispose()
    vi.advanceTimersByTime(5000)
    expect(changes).toEqual(['working'])
  })
})