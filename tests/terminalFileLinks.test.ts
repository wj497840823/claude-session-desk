/// <reference lib="dom" />
import { expect, it, vi } from 'vitest'
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { registerTerminalFileLinks } from '../src/renderer/src/lib/terminalFileLinks'

function terminalFixture(values: string[], wrapped: boolean[] = []) {
  const lines = values.map((value, index) => {
    const cells: Array<{ getChars: () => string; getWidth: () => number }> = []
    for (const char of value) {
      const width = /[\u3400-\u9fff]/.test(char) ? 2 : 1
      cells.push({ getChars: () => char, getWidth: () => width })
      if (width === 2) cells.push({ getChars: () => '', getWidth: () => 0 })
    }
    while (cells.length < 40) cells.push({ getChars: () => '', getWidth: () => 1 })
    return { length: cells.length, isWrapped: wrapped[index] ?? false,
      getCell: (index: number) => cells[index], translateToString: () => value }
  })
  let provider: ILinkProvider
  const buffer = { length: lines.length, getLine: (index: number) => lines[index] }
  const terminal = { cols: 40, buffer: { active: buffer }, registerLinkProvider: (value: ILinkProvider) => {
    provider = value; return { dispose() {} }
  } } as unknown as Terminal
  const links = (row: number) => new Promise<ILink[]>((resolve) => provider.provideLinks(row, (value) => resolve(value ?? [])))
  return { terminal, links, lines }
}

it('only exposes verified links and activates the resolved full path', async () => {
  const fixture = terminalFixture(['结果 C:/项目/', '报告 文件.pdf'], [false, true])
  const activate = vi.fn()
  const check = vi.fn().mockResolvedValue({ ok: true, path: 'C:\\项目\\报告 文件.pdf' })
  registerTerminalFileLinks(fixture.terminal, activate, () => {}, check)
  const links = await fixture.links(2)
  expect(links).toHaveLength(1)
  expect(check).toHaveBeenCalledWith('C:/项目/报告 文件.pdf')
  expect(links[0].range.start).toEqual({ x: 6, y: 1 })
  const event = {} as MouseEvent
  links[0].activate(event, links[0].text)
  expect(activate).toHaveBeenCalledWith(event, 'C:\\项目\\报告 文件.pdf')
})

it('does not link missing files or stale terminal content', async () => {
  const fixture = terminalFixture(['storage.conf'])
  registerTerminalFileLinks(fixture.terminal, () => {}, () => {}, async () => ({ ok: false }))
  expect(await fixture.links(1)).toEqual([])
  let finish!: (value: { ok: boolean; path: string }) => void
  registerTerminalFileLinks(fixture.terminal, () => {}, () => {}, () => new Promise((resolve) => { finish = resolve }))
  const pending = fixture.links(1)
  fixture.lines[0].translateToString = () => 'changed while checking'
  finish({ ok: true, path: 'C:/storage.conf' })
  expect(await pending).toEqual([])
})
