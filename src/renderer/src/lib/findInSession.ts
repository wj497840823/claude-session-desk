import type { SessionEvent } from '@shared/types'

export interface FindMatch {
  uuid: string
  kind: 'user' | 'assistant' | 'tools'
  preview: string
}

function previewOf(text: string, index: number, length: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  const start = Math.max(0, index - 28)
  const end = Math.min(collapsed.length, index + length + 48)
  return `${start > 0 ? '…' : ''}${collapsed.slice(start, end)}${end < collapsed.length ? '…' : ''}`
}

export function findSessionMatches(events: SessionEvent[], query: string, limit = 200): FindMatch[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []
  const matches: FindMatch[] = []
  const seen = new Set<string>()

  const push = (uuid: string, kind: FindMatch['kind'], text: string): void => {
    if (seen.has(uuid) || matches.length >= limit) return
    const index = text.toLowerCase().indexOf(normalized)
    if (index < 0) return
    seen.add(uuid)
    matches.push({ uuid, kind, preview: previewOf(text, index, normalized.length) })
  }

  for (const event of events) {
    if (event.kind === 'tools') {
      for (const call of event.calls) {
        push(event.uuid, 'tools', `${call.name} ${call.inputSummary} ${call.input} ${call.result ?? ''}`)
      }
    } else {
      push(event.uuid, event.kind, event.text)
    }
  }
  return matches
}