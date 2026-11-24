import { describe, expect, it } from 'vitest'
import {
  APPROVAL_HOOK_TIMEOUT_SECONDS,
  buildHookSettings,
  hookEventToActivity,
  permissionHookOutput
} from '../src/main/hookActivity'

describe('hookEventToActivity', () => {
  it('maps hook events to terminal activity', () => {
    expect(hookEventToActivity({ hook_event_name: 'UserPromptSubmit' })).toBe('working')
    expect(hookEventToActivity({ hook_event_name: 'PermissionDenied' })).toBe('working')
    expect(hookEventToActivity({ hook_event_name: 'Stop' })).toBe('idle')
    expect(hookEventToActivity({ hook_event_name: 'StopFailure' })).toBe('idle')
    expect(hookEventToActivity({ hook_event_name: 'PermissionRequest' })).toBe('approval')
  })

  it('reports a background state while background work is pending', () => {
    expect(hookEventToActivity({
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'task-1', type: 'shell', status: 'running' }]
    })).toBe('background')
    expect(hookEventToActivity({
      hook_event_name: 'StopFailure',
      background_tasks: [{ id: 'task-2', type: 'monitor', status: 'running' }]
    })).toBe('background')
  })

  it('reports a background state for session crons', () => {
    expect(hookEventToActivity({
      hook_event_name: 'Stop',
      background_tasks: [],
      session_crons: [{ id: 'cron-1', schedule: '2026-11-23T10:00:00Z', recurring: false }]
    })).toBe('background')
  })

  it('reports idle only when Stop has no pending background work', () => {
    expect(hookEventToActivity({ hook_event_name: 'Stop' })).toBe('idle')
    expect(hookEventToActivity({
      hook_event_name: 'Stop',
      background_tasks: [],
      session_crons: []
    })).toBe('idle')
    expect(hookEventToActivity({
      hook_event_name: 'Stop',
      background_tasks: 'running',
      session_crons: null
    })).toBe('idle')
  })

  it('only applies background work to stop events', () => {
    expect(hookEventToActivity({
      hook_event_name: 'UserPromptSubmit',
      background_tasks: [{ id: 'task-1' }]
    })).toBe('working')
    expect(hookEventToActivity({
      hook_event_name: 'PermissionRequest',
      background_tasks: [{ id: 'task-1' }]
    })).toBe('approval')
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
    for (const [name, groups] of Object.entries(settings.hooks)) {
      expect(groups[0].hooks[0]).toMatchObject({
        type: 'http',
        url: 'http://127.0.0.1:1234/token/pty',
        timeout: name === 'PermissionRequest' ? APPROVAL_HOOK_TIMEOUT_SECONDS : 5,
        onFailure: 'continue'
      })
    }
  })
})

describe('permissionHookOutput', () => {
  it('returns the documented allow decision', () => {
    expect(permissionHookOutput('allow')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' }
      }
    })
  })

  it('returns a deny decision with a reason', () => {
    expect(permissionHookOutput('deny')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          message: '用户在 Claude Session Desk 中拒绝了此操作'
        }
      }
    })
  })

  it('returns an empty decision when nobody answered', () => {
    expect(permissionHookOutput(null)).toEqual({})
  })
})