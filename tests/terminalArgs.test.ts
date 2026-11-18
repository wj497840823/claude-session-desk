import { describe, expect, it } from 'vitest'
import {
  buildClaudeTerminalArgs,
  normalizeTerminalOptions
} from '../src/main/terminalArgs'

const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FORK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

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

  it('builds a forked session with a preallocated new id', () => {
    expect(buildClaudeTerminalArgs({
      newSessionId: FORK_ID,
      forkFromSessionId: SID,
      mode: 'manual'
    })).toEqual([
      '--session-id', FORK_ID,
      '--fork-session',
      '--resume', SID,
      '--permission-mode', 'manual'
    ])
    expect(() => buildClaudeTerminalArgs({
      forkFromSessionId: SID,
      mode: 'follow'
    })).toThrow()
    expect(() => buildClaudeTerminalArgs({
      newSessionId: FORK_ID,
      forkFromSessionId: 'bad',
      mode: 'follow'
    })).toThrow()
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

  it('carries a bounded conversation title for notifications', () => {
    expect(normalizeTerminalOptions({
      cwd: 'E:/demo', sessionId: SID, title: '修复登录', mode: 'follow', cols: 80, rows: 24
    })).toMatchObject({ title: '修复登录' })
    expect(() => normalizeTerminalOptions({
      cwd: 'E:/demo', title: 'x'.repeat(201), mode: 'follow', cols: 80, rows: 24
    })).toThrow('对话标题')
  })

  it('normalizes a fork request with both the source and new session ids', () => {
    expect(normalizeTerminalOptions({
      cwd: 'E:/demo',
      newSessionId: FORK_ID,
      forkFromSessionId: SID,
      mode: 'plan',
      cols: 80,
      rows: 24
    })).toMatchObject({ newSessionId: FORK_ID, forkFromSessionId: SID })
    expect(() => normalizeTerminalOptions({
      cwd: 'E:/demo',
      newSessionId: FORK_ID,
      forkFromSessionId: 'bad',
      mode: 'plan',
      cols: 80,
      rows: 24
    })).toThrow()
  })
})
