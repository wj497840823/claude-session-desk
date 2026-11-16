import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminalEnv } from '../src/main/terminal'

afterEach(() => vi.unstubAllEnvs())

describe('embedded terminal IME environment', () => {
  it('enables the native Claude cursor so IME follows the input caret', () => {
    vi.stubEnv('CLAUDE_CODE_NATIVE_CURSOR', undefined)
    expect(terminalEnv().CLAUDE_CODE_NATIVE_CURSOR).toBe('1')
  })

  it('overrides an inherited simulated-cursor setting without changing the parent', () => {
    vi.stubEnv('CLAUDE_CODE_NATIVE_CURSOR', '0')
    expect(terminalEnv().CLAUDE_CODE_NATIVE_CURSOR).toBe('1')
    expect(process.env.CLAUDE_CODE_NATIVE_CURSOR).toBe('0')
  })
})
