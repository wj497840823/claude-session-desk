import { describe, expect, it } from 'vitest'
import { buildResumeCommand, buildResumeSpawnArgs } from '../src/main/resumeCommand'

const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('resumeCommand', () => {
  it('builds a cd + claude --resume command', () => {
    expect(buildResumeCommand('E:\\My Projects\\demo', SID)).toBe(
      `cd /d "E:\\My Projects\\demo" && claude --resume ${SID}`
    )
  })

  it('rejects non-uuid session ids and paths with quotes', () => {
    expect(() => buildResumeCommand('E:/demo', 'not-a-uuid')).toThrow()
    expect(() => buildResumeCommand('E:/bad"path', SID)).toThrow()
    expect(() => buildResumeCommand('', SID)).toThrow()
  })

  it('builds spawn args that open a new cmd window in the project cwd', () => {
    const result = buildResumeSpawnArgs(SID)
    expect(result.args).toEqual([
      '/c',
      'start',
      '',
      'cmd.exe',
      '/k',
      `claude --resume ${SID}`
    ])
    expect(result.file.toLowerCase()).toContain('cmd')
    expect(() => buildResumeSpawnArgs('not-a-uuid')).toThrow()
  })

  it('quotes an executable path that contains spaces', () => {
    const executable = 'C:\\Program Files\\Claude\\claude.exe'
    expect(buildResumeCommand('E:/demo', SID, executable)).toContain(
      `"${executable}" --resume ${SID}`
    )
    expect(buildResumeSpawnArgs(SID, executable).args[5]).toBe(
      `"${executable}" --resume ${SID}`
    )
  })
})