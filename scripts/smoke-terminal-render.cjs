const assert = require('node:assert/strict')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')

module.exports = async ({ win, dir, js, until, checks, showActivity }) => {
  if (process.platform !== 'win32') return

  const launcher = join(dir, 'render-fixture.cmd')
  await writeFile(launcher, '@echo off\r\nnode "%~dp0render-fixture.cjs"\r\n')
  await writeFile(join(dir, 'render-fixture.cjs'), String.raw`
const esc = '\x1b'
const write = (text) => process.stdout.write(text)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let nextFrame
async function draw() {
  write(esc + '[?1049h')
  for (let frame = 1; frame <= 4; frame++) {
    const ready = new Promise((resolve) => { nextFrame = resolve })
    write(esc + '[?2026h' + esc + '[2J' + esc + '[H')
    await pause(200)
    write('DRAW_FRAME_' + frame + esc + '[?2026l')
    if (frame < 4) await ready
  }
}
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let replies = ''
let started = false
const probeTimer = setTimeout(() => write('SYNC_PROBE_MISSING'), 1500)
process.stdin.on('data', (data) => {
  if (started) {
    if (data.includes('n')) nextFrame?.()
    return
  }
  replies += data
  if (!/\x1b\[\?2026;[12]\$y/.test(replies)) return
  started = true
  clearTimeout(probeTimer)
  void draw()
})
write(esc + '[?2026$p')
`)

  const previous = process.env.CLAUDE_CLI_PATH
  const previousThrottling = win.webContents.getBackgroundThrottling()
  win.webContents.setBackgroundThrottling(false)
  process.env.CLAUDE_CLI_PATH = launcher
  try {
    await js(`window.renderProbe = { startupHidden: false, blankAfterFirstFrame: false, frames: [] };
      window.stopRenderEvents = window.api.onTerminalData(({ ptyId }) => { window.renderProbe.ptyId = ptyId });
      window.renderObserver = new MutationObserver(() => {
        const terminal = document.querySelector('.terminal-tab-view.active .xterm');
        if (!terminal) return;
        const text = terminal.querySelector('.xterm-rows')?.textContent ?? '';
        if (getComputedStyle(terminal).opacity === '0') window.renderProbe.startupHidden = true;
        const frame = text.match(/DRAW_FRAME_\\d/)?.[0];
        if (frame && window.renderProbe.frames.at(-1) !== frame) window.renderProbe.frames.push(frame);
        if (!frame && window.renderProbe.frames.length) window.renderProbe.blankAfterFirstFrame = true;
      });
      window.renderObserver.observe(document.body, {
        attributes: true, attributeFilter: ['data-awaiting-output'], characterData: true, childList: true, subtree: true
      });`)
    await js("document.querySelector('.session-row').click()")
    await until(() => js("Boolean(document.querySelector('.detail-actions .primary'))"), 'render probe record')
    await js("document.querySelector('.detail-actions .primary').click()")
    await until(() => js("Boolean(document.querySelector('.terminal-start-dialog'))"), 'render probe start dialog')
    await js("document.querySelector('.terminal-start-dialog .primary').click()")
    const terminalText = () => js("document.querySelector('.terminal-tab-view.active .xterm-rows')?.textContent ?? ''")
    await until(async () => /DRAW_FRAME_1|SYNC_PROBE_MISSING/.test(await terminalText()), 'synchronized output probe')
    assert.match(await terminalText(), /DRAW_FRAME_1/, 'The Windows PTY must pass the sync-mode probe and its response')
    for (let frame = 2; frame <= 4; frame++) {
      await js("window.api.writeTerminal(window.renderProbe.ptyId, 'n')")
      await until(async () => (await terminalText()).includes(`DRAW_FRAME_${frame}`), `synchronized frame ${frame}`)
    }
    const result = await js('window.renderObserver.disconnect(); window.stopRenderEvents(); window.renderProbe')
    assert.equal(result.startupHidden, true, 'The terminal must stay hidden until its first output')
    assert.equal(await js("getComputedStyle(document.querySelector('.terminal-tab-view.active .xterm')).opacity"), '1')
    assert.deepEqual(result.frames, ['DRAW_FRAME_1', 'DRAW_FRAME_2', 'DRAW_FRAME_3', 'DRAW_FRAME_4'])
    assert.equal(result.blankAfterFirstFrame, false, 'A synchronized redraw must retain the previous frame until the new one is ready')
    await js("document.querySelector('.terminal-tab.active[data-tab-key] .terminal-tab-close').click()")
    await until(() => js("Boolean(document.querySelector('[aria-label=\"关闭对话\"] .danger'))"), 'render probe close confirmation')
    await js("document.querySelector('[aria-label=\"关闭对话\"] .danger').click()")
    await until(() => js("!document.querySelector('[data-tab-key]')"), 'render probe stopped')
    await showActivity()
    checks.push('Windows ConPTY and xterm complete the sync-mode handshake and paint four frames without a visible blank redraw')
  } finally {
    win.webContents.setBackgroundThrottling(previousThrottling)
    if (previous === undefined) delete process.env.CLAUDE_CLI_PATH
    else process.env.CLAUDE_CLI_PATH = previous
  }
}
