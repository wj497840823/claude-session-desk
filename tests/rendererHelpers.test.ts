import { describe, expect, it } from 'vitest'
import { highlightParts } from '../src/renderer/src/lib/highlight'
import {
  initialStart,
  loadEarlier,
  PAGE_SIZE
} from '../src/renderer/src/lib/pagination'

describe('pagination', () => {
  it('shows the latest page by default', () => {
    expect(initialStart(400, [], null)).toBe(250)
  })

  it('moves the window back to a match and can load earlier pages', () => {
    const events = Array.from({ length: 400 }, (_, index) => ({ uuid: `u${index}` }))
    expect(initialStart(400, events, 'u10')).toBe(0)
    expect(initialStart(400, events, 'u300')).toBe(250)
    expect(loadEarlier(250)).toBe(100)
    expect(loadEarlier(10)).toBe(0)
    expect(PAGE_SIZE).toBe(150)
  })
})

describe('highlightParts', () => {
  it('marks the first match of any term', () => {
    expect(highlightParts('帮我看看登录接口', '登录')).toEqual([
      { text: '帮我看看', match: false },
      { text: '登录', match: true },
      { text: '接口', match: false }
    ])
    expect(highlightParts('abc', 'zzz')).toEqual([{ text: 'abc', match: false }])
    expect(highlightParts('abc', '')).toEqual([{ text: 'abc', match: false }])
  })
})