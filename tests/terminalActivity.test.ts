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
    tracker.noteInput('\r')
    tracker.push('✻ Working… (esc to interrupt)')
    vi.advanceTimersByTime(999)
    expect(changes).toEqual(['working'])
    vi.advanceTimersByTime(1)
    expect(changes).toEqual(['working', 'idle'])
    tracker.dispose()
  })

  it('reports an approval prompt immediately and only once per prompt', () => {
    vi.useFakeTimers()
    const changes: string[] = []
    const tracker = new TerminalActivityTracker({ onChange: (activity) => changes.push(activity) })
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
    tracker.noteInput('\r')
    tracker.push('Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n')
    tracker.noteInput('1\r')
    tracker.push('✻ Working… (esc to interrupt)')
    expect(changes).toEqual(['working', 'approval', 'working'])
    vi.advanceTimersByTime(500)
    expect(changes).toEqual(['working', 'approval', 'working', 'idle'])
    tracker.dispose()
  })

  it('cancels a pending idle report when disposed', () => {
    vi.useFakeTimers()
    const changes: string[] = []
    const tracker = new TerminalActivityTracker({ onChange: (activity) => changes.push(activity), idleMs: 500 })
    tracker.noteInput('\r')
    tracker.push('working')
    tracker.dispose()
    vi.advanceTimersByTime(5000)
    expect(changes).toEqual(['working'])
  })
})