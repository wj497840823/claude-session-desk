import { describe, expect, it } from 'vitest'
import {
  buildClaudeTerminalArgs,
  normalizeTerminalOptions
} from '../src/main/terminalArgs'

const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('terminalArgs', () => {
  it('assigns new conversations a stable UUID without trying to resume them', () => {
    expect(buildClaudeTerminalArgs({ newSessionId: SID, mode: 'follow' })).toEqual(['--session-id', SID])
    expect(() => buildClaudeTerminalArgs({ newSessionId: SID, sessionId: SID, mode: 'follow' })).toThrow()
    expect(() => normalizeTerminalOptions({ cwd: 'E:/demo', newSessionId: [SID], cols: 80, rows: 24, mode: 'follow' })).toThrow()
  })
  it('builds resume and permission mode arguments', () => {
    expect(
      buildClaudeTerminalArgs({ sessionId: SID, mode: 'manual' })
    ).toEqual(['--resume', SID, '--permission-mode', 'manual'])
  })

  it('builds a new follow-settings session without flags', () => {
    expect(buildClaudeTerminalArgs({ sessionId: null, mode: 'follow' })).toEqual([])
  })

  it('rejects invalid session ids and permission modes', () => {
    expect(() =>
      buildClaudeTerminalArgs({ sessionId: 'bad', mode: 'manual' })
    ).toThrow()
    expect(() =>
      buildClaudeTerminalArgs({ sessionId: null, mode: 'bypass' as never })
    ).toThrow()
  })

  it('normalizes valid terminal options and rejects bad sizes', () => {
    expect(
      normalizeTerminalOptions({
        cwd: 'E:/demo',
        sessionId: SID,
        mode: 'plan',
        cols: 120,
        rows: 30
      })
    ).toEqual({ cwd: 'E:/demo', sessionId: SID, mode: 'plan', cols: 120, rows: 30 })

    expect(() =>
      normalizeTerminalOptions({
        cwd: 'E:/demo',
        mode: 'follow',
        cols: 10,
        rows: 30
      })
    ).toThrow()
  })
})
