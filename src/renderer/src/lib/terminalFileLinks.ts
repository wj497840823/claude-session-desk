import type { Terminal, ILink, IDisposable } from '@xterm/xterm'
import { findFileReferences } from '@shared/fileReferences'
import type { ActionResult } from '@shared/types'

export function registerTerminalFileLinks(
  terminal: Terminal,
  activate: (event: MouseEvent, text: string) => void,
  hover: (text: string | null) => void,
  check: (reference: string) => Promise<ActionResult>
): IDisposable {
  let disposed = false
  const registration = terminal.registerLinkProvider({
    provideLinks(y, callback) {
      const buffer = terminal.buffer.active
      let first = y - 1
      let last = y - 1
      while (first > Math.max(0, y - 9) && buffer.getLine(first)?.isWrapped) first -= 1
      while (last < Math.min(buffer.length - 1, y + 7) && buffer.getLine(last + 1)?.isWrapped) last += 1
      // A truncated logical line can turn the tail of a path into a different file.
      if (buffer.getLine(first)?.isWrapped || buffer.getLine(last + 1)?.isWrapped) { callback([]); return }
      const signature = buffer.getLine(y - 1)?.translateToString(false)
      let text = ''
      const positions: Array<{ x: number; y: number; width: number }> = []
      for (let row = first; row <= last; row += 1) {
        const line = buffer.getLine(row)
        if (!line) continue
        let end = Math.min(line.length, terminal.cols)
        while (end > 0 && !line.getCell(end - 1)?.getChars()) end -= 1
        for (let x = 0; x < end; x += 1) {
          const cell = line.getCell(x)
          if (!cell || cell.getWidth() === 0) continue
          const chars = cell.getChars() || ' '
          text += chars
          for (let i = 0; i < chars.length; i += 1) positions.push({ x: x + 1, y: row + 1, width: cell.getWidth() })
        }
      }
      const candidates = findFileReferences(text)
      void Promise.all(candidates.map(async (item): Promise<ILink | null> => {
        const start = positions[item.start]
        const end = positions[item.end - 1]
        if (!start || !end || y < start.y || y > end.y) return null
        const result = await check(item.reference)
        if (!result.ok || !result.path) return null
        const path = result.path
        return {
          text: item.reference,
          range: { start: { x: start.x, y: start.y }, end: { x: end.x + end.width - 1, y: end.y } },
          activate: (event) => activate(event, path),
          hover: () => hover(path), leave: () => hover(null)
        }
      })).then((links) => {
        if (disposed) return
        if (terminal.buffer.active !== buffer || buffer.getLine(y - 1)?.translateToString(false) !== signature) { callback([]); return }
        callback(links.filter((link): link is ILink => Boolean(link)))
      }).catch(() => { if (!disposed) callback([]) })
    }
  })
  return { dispose() { disposed = true; registration.dispose() } }
}
