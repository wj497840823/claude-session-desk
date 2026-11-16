export interface HighlightPart {
  text: string
  match: boolean
}

export function highlightParts(text: string, query: string): HighlightPart[] {
  const trimmed = query.trim()
  if (!trimmed) return [{ text, match: false }]
  const terms = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  const lower = text.toLowerCase()

  let bestIndex = -1
  let bestTerm = ''
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase())
    if (index >= 0 && (bestIndex < 0 || index < bestIndex)) {
      bestIndex = index
      bestTerm = term
    }
  }
  if (bestIndex < 0) return [{ text, match: false }]

  const end = bestIndex + bestTerm.length
  const parts: HighlightPart[] = []
  if (bestIndex > 0) parts.push({ text: text.slice(0, bestIndex), match: false })
  parts.push({ text: text.slice(bestIndex, end), match: true })
  if (end < text.length) parts.push({ text: text.slice(end), match: false })
  return parts
}