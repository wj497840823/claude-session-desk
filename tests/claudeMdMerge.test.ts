import { describe, expect, it } from 'vitest'
import { mergeClaudeMd, normalizeHeading } from '../src/shared/claudeMd'

const TEMPLATE = `# Global Rules — Standard

Intro.

## 1. Understand the task

Read the code.

## 2. Validate with evidence

Run tests.
`

describe('normalizeHeading', () => {
  it('removes numbering, extra whitespace and case differences', () => {
    expect(normalizeHeading('1. Understand the task')).toBe('understand the task')
    expect(normalizeHeading('1.1 Understand the task')).toBe('understand the task')
    expect(normalizeHeading('1.2.3 Validate')).toBe('validate')
    expect(normalizeHeading('1st Quarter')).toBe('1st quarter')
    expect(normalizeHeading('3D Printing')).toBe('3d printing')
    expect(normalizeHeading('2、Validate  with evidence')).toBe('validate with evidence')
    expect(normalizeHeading('  APPROACH  ')).toBe('approach')
  })
})

describe('mergeClaudeMd', () => {
  it('returns the whole template when the existing file is empty', () => {
    const result = mergeClaudeMd('', TEMPLATE)
    expect(result.content).toBe(TEMPLATE)
    expect(result.added).toEqual(['1. Understand the task', '2. Validate with evidence'])
    expect(result.skipped).toEqual([])
  })

  it('skips sections whose normalized headings already exist', () => {
    const existing = '# Project Rules\n\n## Understand the task\n\nOld text.\n'
    const incoming = '# Global Rules — Standard\n\nIntro.\n\n## 1. Understand the task\n\nNew text.\n\n## 2. Validate with evidence\n\nRun tests.\n'
    const result = mergeClaudeMd(existing, incoming)
    expect(result.skipped).toEqual(['1. Understand the task'])
    expect(result.added).toEqual(['2. Validate with evidence'])
    expect(result.content).not.toContain('New text.')
    expect(result.content).toContain('# Global Rules — Standard')
    expect(result.content).toContain('## 2. Validate with evidence')
  })

  it('does not repeat a group heading that already exists', () => {
    const existing = '# Global Rules — Standard\n\n## Understand the task\n\nOld.\n'
    const incoming = '# Global Rules — Standard\n\nIntro.\n\n## Understand the task\n\nNew.\n\n## Validate with evidence\n\nRun.\n'
    const result = mergeClaudeMd(existing, incoming)
    expect(result.content.match(/# Global Rules — Standard/g)).toHaveLength(1)
    expect(result.content).toContain('## Validate with evidence')
  })

  it('deduplicates hierarchical section numbering', () => {
    const existing = '# Rules\n\n## Understand the task\n\nOld.\n'
    const incoming = '# Rules\n\n## 1.1 Understand the task\n\nNew.\n\n## 1.2 Validate\n\nRun.\n'
    const result = mergeClaudeMd(existing, incoming)
    expect(result.skipped).toEqual(['1.1 Understand the task'])
    expect(result.added).toEqual(['1.2 Validate'])
    expect(result.content).not.toContain('New.')
    expect(result.content).toContain('## 1.2 Validate')
  })

  it('is idempotent for repeated merges of the same template', () => {
    const first = mergeClaudeMd('', TEMPLATE)
    const second = mergeClaudeMd(first.content, TEMPLATE)
    expect(second.added).toEqual([])
    expect(second.content).toBe(first.content)
  })

  it('normalizes CRLF input', () => {
    const result = mergeClaudeMd('', TEMPLATE.replace(/\n/g, '\r\n'))
    expect(result.content).not.toContain('\r')
    expect(result.content).toContain('## 1. Understand the task')
  })

  it('deduplicates an H1-only template by its title', () => {
    const existing = '# Only Title\n\nOld body.\n'
    const incoming = '# Only Title\n\nNew body.\n'
    const result = mergeClaudeMd(existing, incoming)
    expect(result.content).toBe('# Only Title\n\nOld body.\n')
    expect(result.skipped).toEqual(['Only Title'])
  })

  it('appends a template without second-level headings when its title is new', () => {
    const result = mergeClaudeMd('# Local\n\nBody.\n', '# New Rules\n\nExtra.\n')
    expect(result.content).toContain('# New Rules')
    expect(result.added).toEqual(['New Rules'])
  })

  it('returns unchanged content when every section already exists', () => {
    const existing = `# Global Rules — Standard

## Understand the task

Old.

## Validate with evidence

Old.
`
    const result = mergeClaudeMd(existing, TEMPLATE)
    expect(result.added).toEqual([])
    expect(result.content).toBe(existing)
  })

  it('does not treat headings inside fenced code blocks as sections', () => {
    const incoming = '# Rules\n\n```bash\n# Install dependencies\nnpm i\n```\n\n## Real\n\nBody.\n'
    const result = mergeClaudeMd('# Existing\n\nOld.\n', incoming)
    expect(result.content).toContain('# Install dependencies')
    expect(result.content).toContain('npm i')
    expect(result.content).toContain('```')
    expect(result.content).toContain('## Real')
    expect(result.skipped).toEqual([])
  })

  it('ignores heading-like lines in fenced blocks when deduplicating', () => {
    const existing = '# Existing\n\n```bash\n# Rules\nnpm i\n```\n'
    const result = mergeClaudeMd(existing, '# Rules\n\nIntro.\n')
    expect(result.added).toEqual(['Rules'])
    expect(result.content).toContain('# Rules')
  })

  it('is idempotent for templates without headings', () => {
    const incoming = 'Always be careful.\n- Rule one\n'
    const first = mergeClaudeMd('# Local\n\nBody.\n', incoming)
    const second = mergeClaudeMd(first.content, incoming)
    expect(second.added).toEqual([])
    expect(second.content).toBe(first.content)
  })

  it('preserves additional top-level headings instead of dropping them', () => {
    const incoming = '# First\n\nA\n\n# Second\n\nB\n\n## S\n\nC\n'
    const result = mergeClaudeMd('# Existing\n\nOld.\n', incoming)
    expect(result.content).toContain('# First')
    expect(result.content).toContain('A')
    expect(result.content).toContain('# Second')
    expect(result.content).toContain('B')
    expect(result.content).toContain('## S')
  })

  it('does not append duplicate sections from the same template twice', () => {
    const incoming = '# T\n\n## Same\n\nA\n\n## Same\n\nB\n'
    const result = mergeClaudeMd('# Existing\n\nOld.\n', incoming)
    expect(result.added).toEqual(['Same'])
    expect(result.content.match(/## Same/g)).toHaveLength(1)
  })

  it('reports an H1-only template when the existing file is empty', () => {
    const result = mergeClaudeMd('', '# Solo\n\nbody\n')
    expect(result.content).toBe('# Solo\n\nbody\n')
    expect(result.added).toEqual(['Solo'])
  })

  it('does not add a new group header when all of its sections already exist', () => {
    const existing = '# Old Header\n\n## A\n\nold a\n'
    const incoming = '# New Header\n\nintro\n\n## A\n\nnew a\n'
    const result = mergeClaudeMd(existing, incoming)
    expect(result.content).toBe(existing)
    expect(result.added).toEqual([])
    expect(result.skipped).toEqual(['A'])
  })
})