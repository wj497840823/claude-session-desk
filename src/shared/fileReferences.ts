export interface FileReference {
  reference: string
  start: number
  end: number
}

export function parseFileReference(value: string): { path: string; line?: number; column?: number } | null {
  let path = value.trim().replace(/^[`"']|[`"']$/g, '')
  if (!path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) return null
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path)
      if (url.hostname && url.hostname !== 'localhost') return null
      path = decodeURIComponent(url.pathname) + (/^#L\d+(?:C\d+)?$/.test(url.hash) ? url.hash : '')
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
    } catch { return null }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path) && !/\.[\w]+:\d+(?:-\d+)?(?::\d+)?$/.test(path)) return null
  if (/[\x00-\x1f\x7f]/.test(path)) return null
  const location = /(?::(\d+)(?:-\d+)?(?::(\d+))?|#L(\d+)(?:C(\d+))?)$/.exec(path)
  if (location) {
    path = path.slice(0, location.index)
    return { path, line: Number(location[1] ?? location[3]),
      ...(location[2] || location[4] ? { column: Number(location[2] ?? location[4]) } : {}) }
  }
  return { path }
}

const FILE_EXTENSION = /\.(?:pdf|docx?|xlsx?|pptx?|csv|tsv|txt|md|log|json|ya?ml|toml|ini|conf|properties|gradle|xml|html?|css|scss|less|js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|java|kt|go|rs|c|cpp|h|cs|sql|png|jpe?g|gif|webp|bmp|svg|zip|7z|tar|gz|exe|cmd|bat|ps1|sh)(?::\d+(?:-\d+)?(?::\d+)?|#L\d+(?:C\d+)?)?$/i

export function findFileReferences(text: string): FileReference[] {
  const result: FileReference[] = []
  const urls = [...text.matchAll(/https?:\/\/[^\s<>"`]+/gi)].map((match) => [match.index!, match.index! + match[0].length])
  const add = (reference: string, start: number, end: number): void => {
    if (urls.some(([left, right]) => start < right && end > left)) return
    if (result.some((item) => start < item.end && end > item.start)) return
    const parsed = parseFileReference(reference)
    if (parsed && (FILE_EXTENSION.test(reference) || /[\\/]/.test(parsed.path))) result.push({ reference, start, end })
  }
  // Quoted paths retain spaces; unquoted paths stop at punctuation or whitespace.
  for (const match of text.matchAll(/([`"'])([^\r\n`"']+)\1/g)) {
    if (FILE_EXTENSION.test(match[2])) add(match[2], match.index! + 1, match.index! + match[0].length - 1)
  }
  // An absolute prefix provides a boundary even when Windows paths contain spaces.
  for (const match of text.matchAll(/(?:file:\/\/\/|[A-Za-z]:[\\/])[^\r\n<>"'`|，。；]+?\.[A-Za-z][A-Za-z\d]{0,11}(?::\d+(?:-\d+)?(?::\d+)?|#L\d+(?:C\d+)?)?(?=$|[\s),;!\]}，。；])/gu)) {
    if (FILE_EXTENSION.test(match[0])) add(match[0], match.index!, match.index! + match[0].length)
  }
  for (const match of text.matchAll(/(?:file:\/\/\/|[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/?[\p{L}\p{N}_@.-]+[\\/])[^\s<>"'`|，。；]+|[\p{L}\p{N}_@.+-]+\.[A-Za-z][A-Za-z\d]{0,11}(?::\d+(?:-\d+)?(?::\d+)?|#L\d+(?:C\d+)?)?/gu)) {
    const before = text.slice(Math.max(0, match.index! - 12), match.index!)
    if (/(?:https?:\/\/|@|[\p{L}\p{N}])/u.test(before.slice(-1)) || /https?:\/$/i.test(before)) continue
    const value = match[0].replace(/[),;!\]}。，；]+$/g, '')
    if (FILE_EXTENSION.test(value)) add(value, match.index!, match.index! + value.length)
  }
  return result.sort((a, b) => a.start - b.start)
}

export function attachmentText(paths: string[]): string {
  if (paths.some((path) => !path || /[\x00-\x1f\x7f]/.test(path))) throw new Error('附件路径含无效字符')
  return paths.map((path) => JSON.stringify(path.replace(/\\/g, '/'))).join(' ') + ' '
}
