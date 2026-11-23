import { describe, expect, it } from 'vitest'
import { BUILTIN_CLAUDE_MD_TEMPLATES } from '../src/main/claudeMdTemplates'

describe('built-in CLAUDE.md templates', () => {
  it('ships 3 global and 6 project templates', () => {
    expect(BUILTIN_CLAUDE_MD_TEMPLATES).toHaveLength(9)
    expect(BUILTIN_CLAUDE_MD_TEMPLATES.filter((template) => template.scope === 'global')).toHaveLength(3)
    expect(BUILTIN_CLAUDE_MD_TEMPLATES.filter((template) => template.scope === 'project')).toHaveLength(6)
  })

  it('has unique ids and non-empty LF-only content', () => {
    const ids = new Set(BUILTIN_CLAUDE_MD_TEMPLATES.map((template) => template.id))
    expect(ids.size).toBe(9)
    for (const template of BUILTIN_CLAUDE_MD_TEMPLATES) {
      expect(template.content.trim().length).toBeGreaterThan(0)
      expect(template.content).not.toContain('\r\n')
      expect(template.content).not.toContain('\r')
      expect(template.content.startsWith('# ')).toBe(true)
      expect(template.name.trim().length).toBeGreaterThan(0)
      expect(template.description.trim().length).toBeGreaterThan(0)
      expect(template.id.startsWith(`builtin:${template.scope}:`)).toBe(true)
    }
  })

  it('preserves the expected first headings', () => {
    const headings = Object.fromEntries(
      BUILTIN_CLAUDE_MD_TEMPLATES.map((template) => [template.id, template.content.split('\n')[0]])
    )
    expect(headings['builtin:global:01-minimal']).toBe('# Global Rules — Minimal')
    expect(headings['builtin:global:02-standard']).toBe('# Global Rules — Standard')
    expect(headings['builtin:global:03-strict']).toBe('# Global Rules — Strict Quality & Safety')
    expect(headings['builtin:project:01-minimal']).toBe('# Project Mode — Minimal')
    expect(headings['builtin:project:02-standard']).toBe('# Project Mode — Standard Development')
    expect(headings['builtin:project:03-strict']).toBe('# Project Mode — Strict / Critical Changes')
    expect(headings['builtin:project:04-code-review']).toBe('# Project Mode — Code Review (Read-only by Default)')
    expect(headings['builtin:project:05-testing-first']).toBe('# Project Mode — Testing First / Bug Fixing')
    expect(headings['builtin:project:06-autonomous-execution']).toBe('# Project Mode — Autonomous Execution')
  })
})