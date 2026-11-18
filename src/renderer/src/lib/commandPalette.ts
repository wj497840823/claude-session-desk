export interface PaletteItem {
  id: string
  label: string
  keywords?: string
}

export function filterPaletteItems<T extends PaletteItem>(
  items: readonly T[],
  query: string,
  limit = 8
): T[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return items.slice(0, limit)
  const scored: Array<{ item: T; score: number }> = []
  for (const item of items) {
    const label = item.label.toLowerCase()
    const haystack = `${item.label} ${item.keywords ?? ''}`.toLowerCase()
    if (!haystack.includes(normalized)) continue
    scored.push({ item, score: label.startsWith(normalized) ? 0 : label.includes(normalized) ? 1 : 2 })
  }
  scored.sort((left, right) => left.score - right.score || left.item.label.localeCompare(right.item.label))
  return scored.slice(0, limit).map((entry) => entry.item)
}