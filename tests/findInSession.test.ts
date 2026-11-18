import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../src/shared/types'
import { findSessionMatches } from '../src/renderer/src/lib/findInSession'

const events: SessionEvent[] = [
  { kind: 'user', uuid: 'u1', timestamp: 1, text: '帮我修复登录跳转' },
  { kind: 'assistant', uuid: 'a1', timestamp: 2, text: '已经修复 LoginRedirect 的问题' },
  {
    kind: 'tools', uuid: 't1', timestamp: 3,
    calls: [{ id: 'c1', name: 'Bash', inputSummary: '运行测试', input: 'npm test -- login', result: 'all login tests pass' }]
  }
]

describe('findSessionMatches', () => {
  it('finds text in user, assistant and tool content', () => {
    expect(findSessionMatches(events, 'login').map((match) => match.uuid)).toEqual(['a1', 't1'])
    expect(findSessionMatches(events, '登录').map((match) => match.uuid)).toEqual(['u1'])
  })

  it('deduplicates events and ignores empty queries', () => {
    expect(findSessionMatches(events, 'login')).toHaveLength(2)
    expect(findSessionMatches(events, '   ')).toEqual([])
  })

  it('returns a readable preview around the match', () => {
    const [match] = findSessionMatches(events, 'LoginRedirect')
    expect(match.preview).toContain('LoginRedirect')
    expect(match.kind).toBe('assistant')
  })
})