import { describe, expect, it } from 'vitest'
import { deletePaths } from '../src/main/deletePlan'

describe('deletePaths', () => {
  it('includes the sidecar directory only when it exists', () => {
    expect(deletePaths('C:/p/s.jsonl', 'C:/p/s', false)).toEqual(['C:/p/s.jsonl'])
    expect(deletePaths('C:/p/s.jsonl', 'C:/p/s', true)).toEqual([
      'C:/p/s.jsonl',
      'C:/p/s'
    ])
  })
})