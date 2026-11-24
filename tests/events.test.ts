import { describe, expect, it } from 'vitest'
import {
  eventTypeMatches,
  isValidEventPattern,
  isValidEventType,
  sanitizeExternalEvent
} from '../src/main/events'

describe('eventTypeMatches', () => {
  it('matches exact types, prefixes and the global wildcard', () => {
    expect(eventTypeMatches('github.issues.opened', 'github.issues.opened')).toBe(true)
    expect(eventTypeMatches('github.*', 'github.issues.opened')).toBe(true)
    expect(eventTypeMatches('github.*', 'github')).toBe(true)
    expect(eventTypeMatches('github.*', 'githubx.issues')).toBe(false)
    expect(eventTypeMatches('*', 'anything')).toBe(true)
    expect(eventTypeMatches('github.issues.opened', 'github.issues.closed')).toBe(false)
  })
})

describe('isValidEventType', () => {
  it('accepts lowercase dotted types and rejects unsafe values', () => {
    expect(isValidEventType('github.issues.opened')).toBe(true)
    expect(isValidEventType('alert_p1')).toBe(true)
    expect(isValidEventType('GitHub.Issues')).toBe(false)
    expect(isValidEventType('../etc/passwd')).toBe(false)
    expect(isValidEventType('')).toBe(false)
  })

  it('accepts trigger patterns with a trailing wildcard', () => {
    expect(isValidEventPattern('github.issues.*')).toBe(true)
    expect(isValidEventPattern('github.*')).toBe(true)
    expect(isValidEventPattern('*')).toBe(true)
    expect(isValidEventPattern('GitHub.*')).toBe(false)
    expect(isValidEventPattern('*.*')).toBe(false)
  })
})

describe('sanitizeExternalEvent', () => {
  it('keeps only the allowed fields', () => {
    expect(sanitizeExternalEvent({
      type: 'github.issues.opened',
      subject: '#42',
      summary: '新 Issue',
      detail: '正文',
      link: 'https://github.com/org/repo/issues/42',
      cwd: 'C:\\Windows',
      agent: 'claude',
      access: 'full'
    })).toEqual({
      type: 'github.issues.opened',
      subject: '#42',
      summary: '新 Issue',
      detail: '正文',
      link: 'https://github.com/org/repo/issues/42'
    })
  })

  it('rejects unsafe types, subjects and links', () => {
    expect(sanitizeExternalEvent({ type: 'UPPER' })).toBeNull()
    expect(sanitizeExternalEvent({ type: 'ok', subject: 'bad subject!' })).toBeNull()
    expect(sanitizeExternalEvent({ type: 'ok', link: 'file:///C:/secret' })).toBeNull()
    expect(sanitizeExternalEvent({ type: 'ok', link: 'https://x.test/ok' })).not.toBeNull()
  })
})