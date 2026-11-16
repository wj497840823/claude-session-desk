import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  const input = createReadStream(filePath, { encoding: 'utf8' })
  const reader = createInterface({
    input,
    crlfDelay: Infinity
  })
  try {
    for await (const line of reader) yield line
  } finally {
    reader.close()
    input.destroy()
  }
}

export function parseJsonLine<T = unknown>(line: string): T | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const value = JSON.parse(trimmed)
    return value && typeof value === 'object' ? (value as T) : null
  } catch {
    return null
  }
}
