import { describe, expect, it } from 'vitest'
import type { SessionDetail } from '@shared/types'
import { buildMarkdown, safeExportFileName } from '../src/main/exportMarkdown'

const detail: SessionDetail = {
  key: 'E--demo/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  title: '修复登录',
  projectPath: 'E:/demo',
  createdAt: Date.parse('2026-11-13T10:00:00.000Z'),
  updatedAt: Date.parse('2026-11-13T10:05:00.000Z'),
  totalEvents: 3,
  skippedLines: 0,
  events: [
    { kind: 'user', uuid: 'u1', timestamp: 1, text: '帮我看看' },
    { kind: 'assistant', uuid: 'a1', timestamp: 2, text: '好的' },
    {
      kind: 'tools',
      uuid: 'a1',
      timestamp: 2,
      calls: [
        {
          id: 't1',
          name: 'Bash',
          inputSummary: 'Bash: npm test',
          input: '{\n  "command": "npm test"\n}',
          result: 'all pass',
          isError: false
        }
      ]
    }
  ]
}

describe('exportMarkdown', () => {
  it('sanitizes file names', () => {
    expect(
      safeExportFileName('a/b:c*?', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    ).toBe('a_b_c__-bbbbbbbb.md')
    expect(
      safeExportFileName('   ', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    ).toBe('会话-bbbbbbbb.md')
  })

  it('builds a readable markdown document', () => {
    const markdown = buildMarkdown(detail)
    expect(markdown).toContain('# 修复登录')
    expect(markdown).toContain('- 项目：`E:/demo`')
    expect(markdown).toContain('## 用户')
    expect(markdown).toContain('## 助手')
    expect(markdown).toContain('### 工具：Bash')
    expect(markdown).toContain('all pass')
    expect(markdown.endsWith('\n')).toBe(true)
  })
})