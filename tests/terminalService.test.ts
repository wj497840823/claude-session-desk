import { rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { TerminalService } from '../src/main/terminal'
import { tempDir } from './helpers'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: mocks.spawn }))
vi.mock('node:child_process', () => ({ execFile: mocks.execFile, execFileSync: mocks.execFileSync }))
vi.mock('../src/main/claudeCli', () => ({
  resolveClaudeLauncher: () => ({ command: 'fixture.exe', resolved: true }), CLAUDE_CLI_HINT: '',
  buildClaudeLaunch: (file: string, args: string[]) => ({ file, args })
}))
const dirs: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})

it('opens more than eight PTYs and stops a matching group asynchronously', async () => {
  const cwd = await tempDir()
  dirs.push(cwd)
  mocks.spawn.mockImplementation(() => ({ pid: process.pid, onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn() }))
  const service = new TerminalService(() => null)
  const ids: string[] = []
  const sessionIds: string[] = []
  for (let i = 0; i < 12; i += 1) {
    const sessionId = `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`
    sessionIds.push(sessionId)
    const result = service.start({ cwd, sessionId, cols: 80, rows: 24, mode: 'follow' })
    expect(result.ok).toBe(true)
    ids.push(result.ptyId!)
  }
  expect(mocks.spawn).toHaveBeenCalledTimes(12)
  const callbacks: Array<() => void> = []
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => callbacks.push(() => callback(null)))
  const stopping = service.stopSessions(sessionIds.slice(0, 3))
  expect(mocks.execFile).toHaveBeenCalledTimes(3)
  expect(mocks.execFileSync).not.toHaveBeenCalledWith('taskkill', expect.anything(), expect.anything())
  const duplicate = service.stop(ids[0])
  expect(mocks.execFile).toHaveBeenCalledTimes(3)
  callbacks.forEach((callback) => callback())
  await Promise.all([stopping, duplicate])
  expect(() => service.write(ids[0], 'test')).toThrow('终端不存在')
  expect(() => service.write(ids[3], 'test')).not.toThrow()
  service.dispose()
})

it('switches from the PTY tracker to hook events', async () => {
  const cwd = await tempDir()
  dirs.push(cwd)
  let onData: ((data: string) => void) | null = null
  mocks.spawn.mockImplementation(() => ({
    pid: process.pid,
    onData: (callback: (data: string) => void) => { onData = callback },
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn()
  }))
  const events: Array<{ activity: string }> = []
  const handlers = new Map<string, (event: unknown) => void>()
  const service = new TerminalService(() => null, (event) => events.push(event))
  service.setHookRelay({
    urlFor: (ptyId) => `http://127.0.0.1:1/token/${ptyId}`,
    register: (ptyId, handler) => handlers.set(ptyId, handler),
    unregister: (ptyId) => handlers.delete(ptyId)
  })
  const sessionId = '22222222-2222-4222-8222-222222222222'
  const result = service.start({ cwd, sessionId, cols: 80, rows: 24, mode: 'follow' })
  expect(result.ok).toBe(true)
  expect(mocks.spawn.mock.calls[0][1]).toContain('--settings')
  const ptyId = result.ptyId!
  const hook = handlers.get(ptyId)!
  hook({ hook_event_name: 'UserPromptSubmit' })
  expect(events.map((event) => event.activity)).toEqual(['working'])
  // The PTY tracker is disabled once hook events are live.
  onData!('✻ Working… (esc to interrupt)')
  expect(events.map((event) => event.activity)).toEqual(['working'])
  hook({ hook_event_name: 'PermissionRequest' })
  hook({ hook_event_name: 'Stop' })
  expect(events.map((event) => event.activity)).toEqual(['working', 'approval', 'idle'])
  service.dispose()
  expect(handlers.has(ptyId)).toBe(false)
})

it('keeps the PTY activity tracker when a hook event is unrecognized', async () => {
  const cwd = await tempDir()
  dirs.push(cwd)
  let onData: ((data: string) => void) | null = null
  mocks.spawn.mockImplementation(() => ({
    pid: process.pid,
    onData: (callback: (data: string) => void) => { onData = callback },
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn()
  }))
  const events: string[] = []
  const handlers = new Map<string, (event: unknown) => void>()
  const service = new TerminalService(() => null, (event) => events.push(event.activity))
  service.setHookRelay({
    urlFor: (ptyId) => `http://127.0.0.1:1/token/${ptyId}`,
    register: (ptyId, handler) => handlers.set(ptyId, handler),
    unregister: (ptyId) => handlers.delete(ptyId)
  })
  const result = service.start({
    cwd,
    sessionId: '44444444-4444-4444-8444-444444444444',
    cols: 80,
    rows: 24,
    mode: 'follow'
  })
  handlers.get(result.ptyId!)!({ hook_event_name: 'SomeFutureEvent' })
  onData!('✻ Working… (esc to interrupt)')
  expect(events).toEqual(['working'])
  service.dispose()
})

it('does not treat Alt+key input as an interrupt', async () => {
  const cwd = await tempDir()
  dirs.push(cwd)
  mocks.spawn.mockImplementation(() => ({
    pid: process.pid, onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn()
  }))
  const events: string[] = []
  const handlers = new Map<string, (event: unknown) => void>()
  const service = new TerminalService(() => null, (event) => events.push(event.activity))
  service.setHookRelay({
    urlFor: (ptyId) => `http://127.0.0.1:1/token/${ptyId}`,
    register: (ptyId, handler) => handlers.set(ptyId, handler),
    unregister: (ptyId) => handlers.delete(ptyId)
  })
  const result = service.start({
    cwd,
    sessionId: '55555555-5555-4555-8555-555555555555',
    cols: 80,
    rows: 24,
    mode: 'follow'
  })
  handlers.get(result.ptyId!)!({ hook_event_name: 'UserPromptSubmit' })
  service.write(result.ptyId!, '\x1bb')
  expect(events).toEqual(['working'])
  service.dispose()
})

it('treats Esc as an answer to an approval prompt', async () => {
  const cwd = await tempDir()
  dirs.push(cwd)
  mocks.spawn.mockImplementation(() => ({
    pid: process.pid, onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn()
  }))
  const events: string[] = []
  const handlers = new Map<string, (event: unknown) => void>()
  const service = new TerminalService(() => null, (event) => events.push(event.activity))
  service.setHookRelay({
    urlFor: (ptyId) => `http://127.0.0.1:1/token/${ptyId}`,
    register: (ptyId, handler) => handlers.set(ptyId, handler),
    unregister: (ptyId) => handlers.delete(ptyId)
  })
  const result = service.start({
    cwd,
    sessionId: '66666666-6666-4666-8666-666666666666',
    cols: 80,
    rows: 24,
    mode: 'follow'
  })
  handlers.get(result.ptyId!)!({ hook_event_name: 'PermissionRequest' })
  service.write(result.ptyId!, '\x1b')
  expect(events).toEqual(['approval', 'working'])
  service.dispose()
})

it('refuses to resume a session that a scheduled task is using', async () => {
  const cwd = await tempDir()
  dirs.push(cwd)
  const sessionId = '77777777-7777-4777-8777-777777777777'
  const service = new TerminalService(() => null)
  service.setScheduledSessionGuard((id) => id === sessionId)

  const result = service.start({ cwd, sessionId, cols: 80, rows: 24, mode: 'follow' })
  expect(result).toEqual({
    ok: false,
    message: '该会话正在被定时任务使用，请等待运行结束后再打开'
  })
  expect(mocks.spawn).not.toHaveBeenCalled()
  service.dispose()
})

it('uses input as a fallback for approval answers and interrupts', async () => {
  const cwd = await tempDir()
  dirs.push(cwd)
  mocks.spawn.mockImplementation(() => ({
    pid: process.pid, onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn()
  }))
  const events: string[] = []
  const handlers = new Map<string, (event: unknown) => void>()
  const service = new TerminalService(() => null, (event) => events.push(event.activity))
  service.setHookRelay({
    urlFor: (ptyId) => `http://127.0.0.1:1/token/${ptyId}`,
    register: (ptyId, handler) => handlers.set(ptyId, handler),
    unregister: (ptyId) => handlers.delete(ptyId)
  })
  const sessionId = '33333333-3333-4333-8333-333333333333'
  const result = service.start({ cwd, sessionId, cols: 80, rows: 24, mode: 'follow' })
  const hook = handlers.get(result.ptyId!)!
  hook({ hook_event_name: 'PermissionRequest' })
  service.write(result.ptyId!, '1\r')
  expect(events).toEqual(['approval', 'working'])
  service.write(result.ptyId!, '\x1b')
  expect(events).toEqual(['approval', 'working', 'idle'])
  service.dispose()
})
