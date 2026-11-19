import { describe, expect, it } from 'vitest'
import { buildHookSettings, hookEventToActivity } from '../src/main/hookActivity'

describe('hookEventToActivity', () => {
  it('maps hook events to terminal activity', () => {
    expect(hookEventToActivity({ hook_event_name: 'UserPromptSubmit' })).toBe('working')
    expect(hookEventToActivity({ hook_event_name: 'PermissionDenied' })).toBe('working')
    expect(hookEventToActivity({ hook_event_name: 'Stop' })).toBe('idle')
    expect(hookEventToActivity({ hook_event_name: 'StopFailure' })).toBe('idle')
    expect(hookEventToActivity({ hook_event_name: 'PermissionRequest' })).toBe('approval')
  })

  it('ignores unknown or malformed events', () => {
    expect(hookEventToActivity({ hook_event_name: 'SessionStart' })).toBeNull()
    expect(hookEventToActivity(null)).toBeNull()
    expect(hookEventToActivity({ hook_event_name: 42 })).toBeNull()
    expect(hookEventToActivity({})).toBeNull()
  })
})

describe('buildHookSettings', () => {
  it('builds http hooks for every subscribed event', () => {
    const settings = buildHookSettings('http://127.0.0.1:1234/token/pty') as {
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>
    }
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'PermissionDenied',
      'PermissionRequest',
      'Stop',
      'StopFailure',
      'UserPromptSubmit'
    ])
    for (const groups of Object.values(settings.hooks)) {
      expect(groups[0].hooks[0]).toMatchObject({
        type: 'http',
        url: 'http://127.0.0.1:1234/token/pty',
        timeout: 5,
        onFailure: 'continue'
      })
    }
  })
})