import { describe, expect, it } from 'vitest'
import {
  parseArchived,
  serializeArchived,
  toggleArchived
} from '../src/renderer/src/lib/sessionArchive'

describe('session archive persistence', () => {
  it('round-trips a bounded list of session ids', () => {
    const ids = ['a/b', '项目/会话', 'demo/1']
    expect(parseArchived(serializeArchived(ids))).toEqual(ids)
  })

  it('drops malformed entries and duplicates', () => {
    expect(parseArchived(JSON.stringify(['a', 'a', 2, null, 'b']))).toEqual(['a', 'b'])
    expect(parseArchived('{bad')).toEqual([])
    expect(parseArchived(null)).toEqual([])
  })

  it('toggles an id without losing the others', () => {
    expect(toggleArchived(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleArchived(['a', 'b'], 'b')).toEqual(['a'])
  })
})