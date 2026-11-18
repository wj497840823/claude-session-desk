import { describe, expect, it } from 'vitest'
import { isProjectExpanded } from '../src/renderer/src/lib/sessionView'

describe('isProjectExpanded', () => {
  it('expands only the project currently opened in the rail', () => {
    expect(isProjectExpanded({ type: 'project', projectKey: 'p1' }, false, ['p1', 'p2'], 'p1')).toBe(true)
    expect(isProjectExpanded({ type: 'project', projectKey: 'p1' }, false, ['p1', 'p2'], 'p2')).toBe(false)
  })

  it('keeps a project collapsed when its expansion state was cleared', () => {
    expect(isProjectExpanded({ type: 'project', projectKey: 'p1' }, false, ['p2'], 'p1')).toBe(false)
  })

  it('does not expand projects from other views or when the session list is collapsed', () => {
    expect(isProjectExpanded({ type: 'all' }, false, ['p1'], 'p1')).toBe(false)
    expect(isProjectExpanded({ type: 'archived' }, false, ['p1'], 'p1')).toBe(false)
    expect(isProjectExpanded({ type: 'project', projectKey: 'p1' }, true, ['p1'], 'p1')).toBe(false)
  })
})