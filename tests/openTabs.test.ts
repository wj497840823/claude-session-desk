import { describe, expect, it } from 'vitest'
import { parseOpenTabs, serializeOpenTabs, type OpenTab } from '../src/renderer/src/lib/openTabs'

const tab = (key: string, overrides: Record<string, unknown> = {}): OpenTab => ({
  key,
  cwd: 'E:/项目 空格',
  projectName: '项目',
  sessionId: '11111111-1111-4111-8111-111111111111',
  sessionTitle: '继续 上次',
  kind: 'resume',
  mode: 'follow',
  ...overrides
} as OpenTab)

describe('open tab persistence', () => {
  it('round-trips valid tabs with Chinese paths and titles', () => {
    const raw = serializeOpenTabs([tab('resume-1'), tab('new-1', { kind: 'new', sessionTitle: undefined })])
    expect(parseOpenTabs(raw)).toEqual([
      {
        key: 'resume-1',
        cwd: 'E:/项目 空格',
        projectName: '项目',
        sessionId: '11111111-1111-4111-8111-111111111111',
        sessionTitle: '继续 上次',
        kind: 'resume',
        mode: 'follow'
      },
      {
        key: 'new-1',
        cwd: 'E:/项目 空格',
        projectName: '项目',
        sessionId: '11111111-1111-4111-8111-111111111111',
        kind: 'new',
        mode: 'follow'
      }
    ])
  })

  it('drops malformed entries, duplicates and unsupported modes', () => {
    const raw = JSON.stringify([
      tab('ok'),
      tab('ok'),
      tab('bad-mode', { mode: 'root' }),
      tab('bad-kind', { kind: 'other' }),
      { key: 'missing-cwd', projectName: 'x', kind: 'resume', mode: 'follow' },
      null,
      'text'
    ])
    expect(parseOpenTabs(raw).map((item) => item.key)).toEqual(['ok'])
  })

  it('caps the restored list and tolerates corrupt storage', () => {
    const many = Array.from({ length: 60 }, (_, index) => tab(`tab-${index}`))
    expect(parseOpenTabs(serializeOpenTabs(many))).toHaveLength(50)
    expect(parseOpenTabs('{broken')).toEqual([])
    expect(parseOpenTabs(null)).toEqual([])
  })

  it('restores a forked tab with its source id', () => {
    const forked = tab('fork-1', {
      kind: 'fork',
      forkFromSessionId: '22222222-2222-4222-8222-222222222222'
    })
    expect(parseOpenTabs(serializeOpenTabs([forked]))).toEqual([forked])
  })
})