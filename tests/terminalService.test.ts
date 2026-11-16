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
