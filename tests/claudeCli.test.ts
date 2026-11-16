import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildClaudeLaunch,
  resolveClaudeLauncher,
  windowsClaudeCandidates
} from '../src/main/claudeCli'

const dirs: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})

describe('Claude CLI resolution', () => {
  it('finds native and npm launchers on quoted PATH entries without starting a shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csm-cli-path '))
    dirs.push(dir)
    await writeFile(join(dir, 'claude.exe'), '')
    await writeFile(join(dir, 'claude.cmd'), '')
    expect(windowsClaudeCandidates(`;"${dir}";${join(dir, 'missing')};`)).toEqual([
      join(dir, 'claude.exe'), join(dir, 'claude.cmd')
    ])
  })
  it('honours a configured .cmd shim', async () => {
    if (process.platform !== 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'csm-cli-'))
    dirs.push(dir)
    const cli = join(dir, 'claude.cmd')
    await writeFile(cli, '@echo off\r\n', 'utf8')
    vi.stubEnv('CLAUDE_CLI_PATH', cli)
    expect(resolveClaudeLauncher()).toEqual({ command: cli, resolved: true })
  })

  it('wraps npm .cmd shims in cmd.exe for node-pty', () => {
    if (process.platform !== 'win32') return
    const result = buildClaudeLaunch(
      'C:\Program Files\nodejs\claude.cmd',
      ['--resume', 'abc']
    )
    expect(result.file.toLowerCase()).toContain('cmd.exe')
    expect(result.args).toEqual([
      '/c',
      'C:\Program Files\nodejs\claude.cmd',
      '--resume',
      'abc'
    ])
  })

  it('launches .exe directly', () => {
    if (process.platform !== 'win32') return
    const result = buildClaudeLaunch('C:\tools\claude.exe', [
      '--permission-mode',
      'plan'
    ])
    expect(result).toEqual({
      file: 'C:\tools\claude.exe',
      args: ['--permission-mode', 'plan']
    })
  })
})
