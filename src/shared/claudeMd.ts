import type { ClaudeMdMergeResult } from './types'

interface ParsedBlock {
  level: 1 | 2
  title: string
  key: string
  text: string
}

interface ParsedTemplate {
  plain: boolean
  blocks: ParsedBlock[]
}

interface ScannedHeading {
  index: number
  level: 1 | 2
  title: string
  key: string
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/
const FENCE_RE = /^\s*(`{3,}|~{3,})/
const NUMBER_PREFIX_RE = /^(?:\d+(?:\.\d+)*(?:[.)、]\s*|\s+)|[一二三四五六七八九十百]+[、.)]\s*)/

export function normalizeHeading(text: string): string {
  return text
    .trim()
    .replace(NUMBER_PREFIX_RE, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

function scanHeadings(content: string): ScannedHeading[] {
  const headings: ScannedHeading[] = []
  const lines = content.split('\n')
  let fence: { char: string; length: number } | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      const char = marker[0]
      if (!fence) {
        fence = { char, length: marker.length }
      } else if (char === fence.char && marker.length >= fence.length) {
        fence = null
      }
      continue
    }
    if (fence) continue

    const match = HEADING_RE.exec(line)
    if (!match || match[1].length > 2) continue
    headings.push({
      index,
      level: match[1].length === 1 ? 1 : 2,
      title: match[2].trim(),
      key: normalizeHeading(match[2])
    })
  }
  return headings
}

function plainTitle(line: string): string {
  const heading = HEADING_RE.exec(line)
  const text = (heading ? heading[2] : line).trim()
  if (!text) return '整份文档'
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

function parseTemplate(content: string): ParsedTemplate {
  const lines = content.split('\n')
  const headings = scanHeadings(content)

  if (headings.length === 0) {
    const first = lines.find((line) => line.trim()) ?? ''
    return {
      plain: true,
      blocks: [{
        level: 2,
        title: plainTitle(first),
        key: normalizeHeading(first),
        text: content.trim()
      }]
    }
  }

  const blocks: ParsedBlock[] = []
  const preamble = lines.slice(0, headings[0].index).join('\n').trim()

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    const end = headings[index + 1]?.index ?? lines.length
    let text = lines.slice(heading.index, end).join('\n').trim()
    if (index === 0 && preamble) text = `${preamble}\n\n${text}`
    blocks.push({
      level: heading.level,
      title: heading.title,
      key: heading.key,
      text
    })
  }

  return { plain: false, blocks }
}

function existingHeadingKeys(content: string): Set<string> {
  return new Set(
    scanHeadings(content).map((heading) => `${heading.level}:${heading.key}`)
  )
}

export function mergeClaudeMd(existing: string, incoming: string): ClaudeMdMergeResult {
  const current = normalizeNewlines(existing).trim()
  const template = normalizeNewlines(incoming).trim()

  if (!template) {
    return { content: current ? `${current}\n` : '', added: [], skipped: [] }
  }

  if (!current) {
    const parsed = parseTemplate(template)
    const hasSections = parsed.blocks.some((block) => block.level === 2)
    const headerIndex = hasSections
      ? parsed.blocks.findIndex((block) => block.level === 1)
      : -1
    return {
      content: `${template}\n`,
      added: parsed.blocks
        .filter((_, index) => parsed.plain || index !== headerIndex)
        .map((block) => block.title),
      skipped: []
    }
  }

  const parsed = parseTemplate(template)

  if (parsed.plain) {
    const label = parsed.blocks[0].title
    if (current.includes(template)) {
      return { content: `${current}\n`, added: [], skipped: [label] }
    }
    return {
      content: `${current}\n\n${template}\n`,
      added: [label],
      skipped: []
    }
  }

  const existingKeys = existingHeadingKeys(current)
  const keys = new Set(existingKeys)
  const hasSections = parsed.blocks.some((block) => block.level === 2)
  const headerIndex = hasSections
    ? parsed.blocks.findIndex((block) => block.level === 1)
    : -1
  const added: string[] = []
  const skipped: string[] = []
  const appended: Array<{ text: string; isHeader: boolean }> = []

  parsed.blocks.forEach((block, index) => {
    const isHeader = index === headerIndex
    const key = `${block.level}:${block.key}`
    if (keys.has(key)) {
      if (!isHeader && existingKeys.has(key)) skipped.push(block.title)
      return
    }
    keys.add(key)
    if (!isHeader) added.push(block.title)
    appended.push({ text: block.text, isHeader })
  })

  if (!appended.some((block) => !block.isHeader)) {
    return { content: `${current}\n`, added, skipped }
  }

  return {
    content: `${current}\n\n${appended.map((block) => block.text).join('\n\n')}\n`,
    added,
    skipped
  }
}