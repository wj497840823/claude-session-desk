import { describe, expect, it } from 'vitest'
import { filterPaletteItems } from '../src/renderer/src/lib/commandPalette'

const items = [
  { id: 'settings', label: '打开设置', keywords: 'preferences options' },
  { id: 'next', label: '下一个对话标签', keywords: 'tab next' },
  { id: 'new', label: '新建对话', keywords: 'new chat' },
  { id: 'scan', label: '重新扫描会话', keywords: 'refresh rescan' }
]

describe('filterPaletteItems', () => {
  it('returns the first items for an empty query', () => {
    expect(filterPaletteItems(items, '', 2).map((item) => item.id)).toEqual(['settings', 'next'])
  })

  it('matches labels and keywords case-insensitively', () => {
    expect(filterPaletteItems(items, '设置').map((item) => item.id)).toEqual(['settings'])
    expect(filterPaletteItems(items, 'TAB').map((item) => item.id)).toEqual(['next'])
  })

  it('ranks label prefixes first and respects the limit', () => {
    expect(filterPaletteItems(items, '新', 1).map((item) => item.id)).toEqual(['new'])
    expect(filterPaletteItems(items, 'e', 2)).toHaveLength(2)
  })
})