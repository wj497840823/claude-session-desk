// Isolated integration checks against the compiled Electron app.
// Run after npm run build: node_modules/electron/dist/electron.exe scripts/smoke.cjs
const { app, BrowserWindow, ipcMain, Notification } = require('electron')
const { mkdtemp, mkdir, writeFile, appendFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const assert = require('node:assert/strict')

const checks = []
const rendererErrors = []
const timeout = setTimeout(() => { console.error('Smoke test timed out'); app.exit(1) }, 45000)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, label, ms = 7000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await delay(40)
  }
  throw new Error(`Timed out: ${label}`)
}

// Do not show or focus any desktop window during the test.
BrowserWindow.prototype.show = function () {}
BrowserWindow.prototype.focus = function () {}
// Smoke runs must not raise OS-level toasts on the developer's desktop.
Notification.prototype.show = function () {}
const overlayCalls = []
BrowserWindow.prototype.setOverlayIcon = function (_image, description) {
  overlayCalls.push(description)
}
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (details) => {
    if (details?.level === 'error') rendererErrors.push(details.message)
  })
})

;(async () => {
  const dir = process.env.CSM_SMOKE_DIR || await mkdtemp(join(tmpdir(), 'csm-smoke-'))
  const projectDir = join(dir, 'projects', 'demo')
  const configDir = join(dir, 'config')
  const sessionId = '11111111-1111-4111-8111-111111111111'
  try {
    await mkdir(configDir)
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      version: 1,
      favorites: [],
      settings: {
        minimizeToTray: false,
        sessionClickAction: 'record',
        // The scheduled-task check runs a real task; keep the smoke run from
        // raising OS-level toasts on the developer's desktop.
        desktopNotifications: false
      }
    }))
    process.env.CLAUDE_SESSION_MANAGER_ROOT = join(dir, 'projects')
    process.env.CLAUDE_SESSION_MANAGER_USER_DATA = configDir
    require('../out/main/index.js')
    await app.whenReady()
    await until(() => BrowserWindow.getAllWindows().length === 1, 'window creation')
    const win = BrowserWindow.getAllWindows()[0]
    assert.equal(win.listenerCount('minimize'), 0, 'Minimizing must use native taskbar behavior instead of a hide-to-tray handler')
    checks.push('Minimizing uses normal taskbar behavior instead of hiding the window to the tray')
    const js = (source) => win.webContents.executeJavaScript(source, true)
    const showActivity = () => js(`(() => { const button = document.querySelector('.rail-nav button');
      if (button.getAttribute('aria-expanded') !== 'true') button.click(); })()`)
    const checkTabLayout = async (label) => {
      const sizes = await js(`(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect();
        return { bar: box('.workspace-tabbar').width, strip: box('.workspace-tabs').width,
          actions: box('.workspace-tab-actions').width,
          label: box('[data-tab-key] .terminal-tab-label').width,
          close: box('[data-tab-key] .terminal-tab-close').width,
          viewport: innerWidth, page: document.documentElement.scrollWidth };
      })()`)
      assert(sizes.strip >= sizes.bar - sizes.actions - 2, `${label}: tab strip fails to fill available width ${JSON.stringify(sizes)}`)
      assert(sizes.label >= 100, `${label}: tab title is squeezed ${JSON.stringify(sizes)}`)
      assert(sizes.close >= 24, `${label}: close button is too small`)
      assert(sizes.page <= sizes.viewport, `${label}: page overflows horizontally`)
    }
    await until(() => js(`Boolean(document.querySelector('.workspace-empty'))`), 'initial render')
    assert(await js(`Boolean(document.querySelector('.workspace-empty button'))`))
    assert(await js(`document.querySelector('.notice').textContent.includes('尚未找到')`))
    const resources = await js(`performance.getEntriesByType('resource').map(item => item.name)`)
    assert(!resources.some((name) => /(?:TerminalTab|SessionDetail)-.*\.js/.test(name)))
    checks.push('Missing data root still permits new conversations; terminal/Markdown chunks are deferred')
    assert.equal(await js(`document.querySelector('.rail-nav button').getAttribute('aria-expanded')`), 'false')
    checks.push('Activity sessions start collapsed')
    assert.equal(Math.round(await js(`document.querySelector('.rail').getBoundingClientRect().width`)), 296, 'Default rail width is compact')

    await js(`document.querySelector('button[title="设置"]').focus(); document.querySelector('button[title="设置"]').click()`)
    await until(() => js(`Boolean(document.querySelector('[role="dialog"]'))`), 'settings dialog')
    assert(await js(`document.querySelector('[role="dialog"]').contains(document.activeElement)`))
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await until(() => js(`!document.querySelector('[role="dialog"]')`), 'Escape dismissal')
    assert(await js(`document.activeElement.title === '设置'`))
    checks.push('Dialogs focus their contents, support Escape, and restore focus')

    await mkdir(projectDir, { recursive: true })
    const record = (uuid, text, timestamp) => ({
      type: 'user', uuid, sessionId, cwd: dir, timestamp,
      message: { role: 'user', content: text }
    })
    const file = join(projectDir, `${sessionId}.jsonl`)
    await writeFile(file, JSON.stringify(record('first', 'fixture first message', '2026-11-16T00:00:00Z')) + '\n')
    // Hidden windows intentionally defer watcher scans. Manual refresh exercises the same index path.
    await js(`window.api.refresh()`)
    win.webContents.send('data:changed')
    await showActivity()
    await until(() => js(`document.querySelectorAll('.session-row').length === 1`), 'session appears')
    assert(await js(`(() => { const activity = document.querySelector('.rail-nav button');
      const list = activity.nextElementSibling;
      return list.matches('.embedded-sessions') && !list.querySelector('.embedded-session-head') && list.nextElementSibling.textContent.includes('收藏'); })()`), 'Activity list must be immediately below its toggle without a recent heading')
    checks.push('Expanded activity sessions appear directly below Activity without a redundant heading')
    await js(`document.querySelector('.session-row').click()`)
    await until(() => js(`Boolean(document.querySelector('[data-uuid="first"]'))`), 'lazy detail render')
    checks.push('Transcript indexing and lazy record rendering work')

    const clickProject = async (key) => {
      await js(`document.querySelector('[data-project-key="${key}"] .rail-project-main').click()`)
      await delay(40)
    }
    await clickProject('demo')
    assert(await js(`document.querySelector('[data-project-key="demo"] .rail-project-main').getAttribute('aria-expanded') === 'true'`))
    assert(await js(`Boolean(document.querySelector('.rail-project-sessions .session-row.active')) && !document.querySelector('.app-body > .session-column')`))
    await clickProject('demo')
    assert(await js(`!document.querySelector('.rail-project-sessions') && Boolean(document.querySelector('[data-uuid="first"]'))`))
    await clickProject('demo')
    assert(await js(`Boolean(document.querySelector('.rail-project-sessions .session-row.active')) && Boolean(document.querySelector('[data-uuid="first"]'))`))
    assert(await js(`JSON.parse(localStorage.getItem('csm.expandedProjects')).includes('demo')`))
    await showActivity()
    await js(`document.querySelector('.rail-nav button').click()`)
    assert(await js(`!document.querySelector('.session-row') && Boolean(document.querySelector('[data-uuid="first"]'))`), 'Collapsing activity must preserve the open record')
    await js(`document.querySelector('.rail-nav button').click()`)
    await until(() => js(`document.querySelectorAll('.session-row').length === 1`), 'activity reopens')
    checks.push('Activity sessions toggle open and closed while preserving the current record')
    checks.push('Projects expand recent sessions in the same sidebar; collapse and reopen preserve the selected record')

    await appendFile(file, JSON.stringify(record('second', 'fixture newly appended message', '2026-11-16T00:01:00Z')) + '\n')
    await js(`window.api.refresh()`)
    win.webContents.send('data:changed')
    await until(() => js(`Boolean(document.querySelector('[data-uuid="second"]'))`), 'record updates in place')
    checks.push('An open record updates when its transcript changes')

    await js(`document.querySelector('button[title="设置"]').click()`)
    await until(() => js(`Boolean(document.querySelector('.settings-dialog'))`), 'settings reopen')
    await js(`document.querySelector('.settings-dialog input').click()`)
    await js(`window.api.refresh()`)
    win.webContents.send('data:changed')
    await delay(100)
    assert(await js(`document.querySelector('.settings-dialog input').checked`))
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    checks.push('Background snapshots do not overwrite unsaved settings')

    await js(`localStorage.setItem('csm.leftRailCollapsed', 'true')`)
    await win.webContents.reload()
    await until(() => js(`Boolean(document.querySelector('.workspace-pane'))`), 'restore collapsed rail')
    assert(await js(`!document.querySelector('.rail')`))
    checks.push('Collapsed-panel preferences survive a reload')

    await js(`localStorage.setItem('csm.leftRailCollapsed', 'false'); localStorage.setItem('csm.navigationWidth', '480'); localStorage.setItem('csm.sessionListWidth', '640')`)
    await win.webContents.reload()
    await until(() => js(`Boolean(document.querySelector('.rail-nav button'))`), 'reload layout')
    assert.equal(await js(`document.querySelector('.rail-nav button').getAttribute('aria-expanded')`), 'false')
    await showActivity()
    await until(() => js(`Boolean(document.querySelector('.session-row'))`), 'reopen activity after reload')
    win.setSize(960, 600)
    await delay(100)
    const layout = await js(`({ viewport: innerWidth, scroll: document.documentElement.scrollWidth,
      workspace: document.querySelector('.workspace-pane').getBoundingClientRect().width })`)
    assert(layout.scroll <= layout.viewport, `Page overflows horizontally: ${JSON.stringify(layout)}`)
    assert(layout.workspace >= 299, `Workspace too narrow: ${JSON.stringify(layout)}`)
    checks.push(`Minimum-size layout: viewport ${layout.viewport}px, workspace ${Math.round(layout.workspace)}px, no page overflow`)

    const oldWidth = await js(`document.querySelector('.rail').getBoundingClientRect().width`)
    await js(`document.querySelector('.panel-resizer').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`)
    await delay(30)
    const newWidth = await js(`document.querySelector('.rail').getBoundingClientRect().width`)
    assert(newWidth < oldWidth, 'Keyboard resize did not change the panel width')
    checks.push('Panel separators accept keyboard resizing')

    // Force a late search reply, then clear the query and verify it cannot restore the spinner.
    let resolveSearch
    ipcMain.removeHandler('session:search')
    ipcMain.handle('session:search', () => new Promise((resolve) => { resolveSearch = resolve }))
    await js(`(() => { const input = document.querySelector('.search-box input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'fixture');
      input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await until(() => Boolean(resolveSearch), 'delayed search starts')
    await js(`document.querySelector('.search-clear').click()`)
    resolveSearch({ query: 'fixture', hits: [], truncated: false })
    await delay(60)
    assert(await js(`!document.querySelector('.search-status') && document.querySelector('.search-box input').value === ''`))
    checks.push('Clearing a pending search ignores its late reply')

    // Use IPC fakes for terminal lifecycle checks; no real Claude process is launched.
    let starts = 0
    let resolveStart
    ipcMain.removeHandler('terminal:start')
    ipcMain.handle('terminal:start', () => {
      starts += 1
      return new Promise((resolve) => { resolveStart = resolve })
    })
    ipcMain.removeHandler('terminal:stop')
    ipcMain.handle('terminal:stop', () => undefined)
    await js(`document.querySelector('.session-row').click()`)
    await until(() => js(`Boolean(document.querySelector('.detail-actions .primary'))`), 'record actions')
    await js(`document.querySelector('.detail-actions .primary').click()`)
    await until(() => js(`Boolean(document.querySelector('.terminal-start-dialog'))`), 'terminal dialog')
    await js(`document.querySelector('.terminal-start-dialog .primary').click()`)
    await until(() => Boolean(resolveStart), 'terminal startup request')
    assert(await js(`document.querySelector('button[title="重新开始"]').disabled`))
    win.webContents.send('terminal:data', { ptyId: 'fake-terminal', data: 'startup output\r\n' })
    win.webContents.send('terminal:exit', { ptyId: 'fake-terminal', exitCode: 2 })
    await delay(40)
    resolveStart({ ok: true, ptyId: 'fake-terminal' })
    await until(() => js(`document.querySelector('.terminal-status').textContent.includes('已结束')`), 'early exit recognized')
    assert.equal(starts, 1)
    await checkTabLayout('Single tab at minimum window width')
    checks.push('Terminal startup is guarded and an exit before the IPC reply is handled')
    const terminalLayout = await js(`({ viewport: innerWidth, scroll: document.documentElement.scrollWidth })`)
    assert(terminalLayout.scroll <= terminalLayout.viewport, 'Terminal causes page overflow')

    // Rejected startup must recover rather than remaining stuck in starting state.
    ipcMain.removeHandler('terminal:start')
    ipcMain.handle('terminal:start', () => { throw new Error('fixture startup failure') })
    await js(`document.querySelector('button[title="重新开始"]').click()`)
    await until(() => js(`document.querySelector('.toast')?.textContent.includes('fixture startup failure')`), 'startup error toast')
    assert(await js(`!document.querySelector('button[title="重新开始"]').disabled`))
    checks.push('Rejected terminal startup shows an error and permits retry')
    await require('./smoke-attachments.cjs')({ win, dir, projectDir, sessionId, configDir, js, until, delay, checks, file, showActivity, overlayCalls })

    const clickMenu = async (label) => {
      await js(`document.querySelector('button[title="标签管理"]').click()`)
      await until(() => js(`Boolean(document.querySelector('.tab-context-menu'))`), 'tab menu')
      await js(`Array.from(document.querySelectorAll('.tab-context-menu button')).find(b => b.textContent === ${JSON.stringify(label)}).click()`)
    }
    await clickMenu('关闭已结束对话')
    await until(() => js(`document.querySelectorAll('[data-tab-key]').length === 0`), 'close ended tabs')
    const otherDir = join(dir, 'projects', 'other')
    const otherCwd = join(dir, 'other-project')
    await mkdir(otherDir, { recursive: true })
    await mkdir(otherCwd)
    const batchKeys = []
    const batchIds = []
    for (let i = 0; i < 12; i += 1) {
      const id = `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`
      batchIds.push(id)
      const project = i < 6 ? 'demo' : 'other'
      batchKeys.push(project + '/' + id)
      await writeFile(join(i < 6 ? projectDir : otherDir, id + '.jsonl'), JSON.stringify({
        ...record('batch-' + i, 'batch fixture ' + i, '2026-11-16T01:00:00Z'),
        sessionId: id, cwd: i < 6 ? dir : otherCwd
      }) + '\n')
    }
    await js(`window.api.refresh()`)
    win.webContents.send('data:changed')
    await showActivity()
    await until(() => js(`document.querySelectorAll('.session-row').length === 13`), 'batch fixtures')
    const embeddedList = await js(`(() => {
      const list = document.querySelector('.rail-nav .embedded-sessions .session-list');
      if (!list) return null;
      return { overflow: getComputedStyle(list).overflowY, client: list.clientHeight, scroll: list.scrollHeight, viewport: innerHeight };
    })()`)
    assert(embeddedList && embeddedList.overflow === 'auto', 'Embedded lists scroll internally')
    assert(embeddedList.client <= Math.ceil(embeddedList.viewport * 0.38) + 2, 'Embedded lists are height-bounded')
    assert(embeddedList.scroll > embeddedList.client, 'Long embedded lists do not stretch the rail')
    checks.push('Embedded session lists are height-bounded, compact and scroll internally')
    await js(`window.api.setFavorite('demo/${sessionId}', true)`)
    await js(`window.api.refresh()`)
    win.webContents.send('data:changed')
    await clickProject('demo')
    const expectedRecent = await js(`window.api.getSnapshot().then(snapshot => snapshot.sessions.filter(s => s.projectKey === 'demo' && s.source === 'transcript').sort((a,b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key)).map(s => s.key))`)
    const actualRecent = await js(`Array.from(document.querySelector('[data-project-key="demo"]').parentElement.querySelectorAll('.session-row')).map(row => row.dataset.sessionKey)`)
    assert.deepEqual(actualRecent, expectedRecent)
    checks.push('Project recent sessions use descending activity time even when an older session is favorited')
    const requests = []
    const stops = []
    ipcMain.removeHandler('terminal:start')
    ipcMain.handle('terminal:start', (_event, options) => {
      const ptyId = 'batch-pty-' + requests.length
      requests.push({ ...options, ptyId })
      return { ok: true, ptyId }
    })
    ipcMain.removeHandler('terminal:stop')
    ipcMain.handle('terminal:stop', (_event, id) => { stops.push(id) })
    for (let i = 0; i < batchKeys.length; i += 1) {
      await showActivity()
      await until(() => js(`Boolean(document.querySelector('[data-session-key="${batchKeys[i]}"]'))`), 'global fixture session')
      await js(`document.querySelector('[data-session-key="${batchKeys[i]}"]').click()`)
      await until(() => js(`Boolean(document.querySelector('.detail-actions .primary'))`), 'batch record')
      await js(`document.querySelector('.detail-actions .primary').click()`)
      await until(() => js(`Boolean(document.querySelector('.terminal-start-dialog'))`), 'batch dialog')
      await js(`document.querySelector('.terminal-start-dialog .primary').click()`)
      await until(() => requests.length === i + 1, 'batch terminal')
    }
    await until(() => js(`document.querySelectorAll('[data-tab-key]').length === 12`), '12 tabs')
    checks.push('Twelve conversation tabs can be mounted concurrently')
    for (const width of [960, 1280, 2560]) {
      win.setSize(width, 800)
      await delay(80)
      await checkTabLayout('Twelve tabs at window width ' + width)
    }
    win.setSize(960, 600)
    await delay(80)
    checks.push('Tab titles stay readable and the strip uses all available width at 960, 1280 and 2560px')
    const tabKeys = await js(`Array.from(document.querySelectorAll('[data-tab-key]')).map(tab => tab.dataset.tabKey)`)
    await js(`document.querySelector('[data-tab-key="${tabKeys[0]}"]').click()`)
    await until(() => js(`document.querySelector('.session-row.active')?.dataset.sessionKey === '${batchKeys[0]}'`), 'first anchor')
    assert(await js(`document.querySelector('.rail-project.active')?.dataset.projectKey === 'demo'`))
    await js(`document.querySelector('[data-tab-key="${tabKeys[11]}"]').click()`)
    await until(() => js(`document.querySelector('.session-row.active')?.dataset.sessionKey === '${batchKeys[11]}'`), 'other anchor')
    assert(await js(`document.querySelector('.rail-project.active')?.dataset.projectKey === 'other'`))
    assert.equal(await js(`document.querySelectorAll('.rail-project-sessions').length`), 1, 'Only the opened project expands')
    assert.equal(await js(`document.querySelectorAll('.rail-project-main[aria-expanded="true"]').length`), 1, 'Only one project is marked expanded')
    await clickProject('demo')
    await js(`document.querySelector('button[title="新建对话"]').click()`)
    await until(() => js(`Boolean(document.querySelector('.terminal-start-dialog'))`), 'new conversation in browsed project')
    assert.equal(await js(`document.querySelector('.terminal-start-path').textContent`), dir)
    await js(`document.querySelector('.terminal-start-dialog .dialog-actions .btn').click()`)
    checks.push('New conversation uses the browsed project instead of the unrelated active terminal directory')
    await js(`document.querySelector('[data-tab-key="${tabKeys[0]}"]').click()`)
    await until(() => js(`Boolean(document.querySelector('[data-project-key="demo"]').parentElement.querySelector('.session-row.active'))`), 'reopen collapsed project from tab')
    assert(await js(`document.querySelector('[data-project-key="demo"] .rail-project-main').getAttribute('aria-expanded') === 'true'`))
    assert.equal(await js(`document.querySelectorAll('.rail-project-sessions').length`), 1, 'Returning to demo keeps one expanded project')
    await js(`document.querySelector('[data-tab-key="${tabKeys[11]}"]').click()`)
    checks.push('Switching tabs across projects synchronizes project and session anchors')
    ipcMain.removeHandler('terminal:stop')
    ipcMain.handle('terminal:stop', () => { throw new Error('fixture stop failure') })
    await js(`document.querySelector('[data-tab-key="${tabKeys[0]}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 70 }))`)
    await until(() => js(`Boolean(document.querySelector('.tab-context-menu'))`), 'failed-close menu')
    await js(`Array.from(document.querySelectorAll('.tab-context-menu button')).find(b => b.textContent === '关闭当前对话').click()`)
    await until(() => js(`Boolean(document.querySelector('[aria-label="关闭对话"]'))`), 'failed-close confirm')
    await js(`document.querySelector('[aria-label="关闭对话"] .danger').click()`)
    await until(() => js(`document.querySelector('.toast')?.textContent.includes('未能结束')`), 'stop failure reported')
    assert(await js(`document.querySelectorAll('[data-tab-key]').length === 12`))
    ipcMain.removeHandler('terminal:stop')
    ipcMain.handle('terminal:stop', (_event, id) => { stops.push(id) })
    checks.push('A tab remains open when its process cannot be stopped')
    for (const i of [0, 2]) {
      await js(`document.querySelector('[data-tab-key="${tabKeys[i]}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 70 }))`)
      await until(() => js(`Boolean(document.querySelector('.tab-context-menu'))`), 'right-click selection menu')
      await js(`Array.from(document.querySelectorAll('.tab-context-menu button')).find(b => b.textContent.trim() === '选择当前标签').click()`)
    }
    assert(await js(`document.querySelectorAll('[data-tab-key] input:checked').length === 2`))
    assert(await js(`!document.querySelector('.workspace-selection-toolbar')`))
    await clickMenu('取消多选')
    assert(await js(`document.querySelectorAll('[data-tab-key] input').length === 0`))
    checks.push('Right-click menus select multiple tabs and cancel selection without adding a toolbar')
    await clickMenu('全选标签')
    await delay(30)
    await checkTabLayout('Multiple selection at minimum width')
    const closingIndexes = [0, 2, 5, 11]
    for (let i = 0; i < tabKeys.length; i += 1) {
      if (!closingIndexes.includes(i)) await js(`document.querySelector('[data-tab-key="${tabKeys[i]}"] input').click()`)
    }
    assert(await js(`!document.querySelector('.workspace-selection-toolbar')`))
    await clickMenu('关闭选中 4 个对话')
    await until(() => js(`Boolean(document.querySelector('[role="dialog"][aria-label="关闭对话"]'))`), 'bulk confirmation')
    await js(`document.querySelector('[aria-label="关闭对话"] .dialog-actions .btn').click()`)
    assert(await js(`document.querySelectorAll('[data-tab-key]').length === 12`))
    assert.equal(stops.length, 0)
    await clickMenu('关闭选中 4 个对话')
    await until(() => js(`Boolean(document.querySelector('[aria-label="关闭对话"]'))`), 'bulk reconfirm')
    await js(`document.querySelector('[aria-label="关闭对话"] .dialog-actions .danger').click()`)
    await until(() => js(`document.querySelectorAll('[data-tab-key]').length === 8`), 'only selected tabs close')
    await until(() => stops.length === 4, 'selected processes stopped')
    assert.deepEqual(new Set(stops), new Set(closingIndexes.map(i => requests[i].ptyId)))
    await until(() => js(`document.querySelector('.session-row.active')?.dataset.sessionKey === '${batchKeys[10]}'`), 'neighbor anchor after closing active')
    checks.push('Bulk close confirms once, cancellation preserves processes, and only checked tabs close')
    await clickMenu('取消多选')
    const remaining = await js(`Array.from(document.querySelectorAll('[data-tab-key]')).map(tab => tab.dataset.tabKey)`)
    await js(`document.querySelector('[data-tab-key="${remaining[2]}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 70 }))`)
    await until(() => js(`Boolean(document.querySelector('.tab-context-menu'))`), 'right-click tab menu')
    await js(`Array.from(document.querySelectorAll('.tab-context-menu button')).find(b => b.textContent === '关闭右侧对话').click()`)
    await until(() => js(`Boolean(document.querySelector('[aria-label="关闭对话"]'))`), 'right side confirmation')
    await js(`document.querySelector('[aria-label="关闭对话"] .danger').click()`)
    await until(() => js(`document.querySelectorAll('[data-tab-key]').length === 3`), 'right side tabs closed')
    assert.deepEqual(await js(`Array.from(document.querySelectorAll('[data-tab-key]')).map(tab => tab.dataset.tabKey)`), remaining.slice(0, 3))
    await clickMenu('关闭其他对话')
    await until(() => js(`Boolean(document.querySelector('[aria-label="关闭对话"]'))`), 'other tabs confirmation')
    await js(`document.querySelector('[aria-label="关闭对话"] .danger').click()`)
    await until(() => js(`document.querySelectorAll('[data-tab-key]').length === 1`), 'other tabs closed')
    checks.push('Right-click actions close the right-hand tabs or other tabs without closing the target')

    await js(`document.querySelector('button[title="新建对话"]').click()`)
    await until(() => js(`Boolean(document.querySelector('.terminal-start-dialog'))`), 'new conversation dialog')
    await js(`document.querySelector('.terminal-start-dialog .primary').click()`)
    await until(() => requests.length === 13, 'new stable ID')
    const newId = requests[12].newSessionId
    assert.match(newId, /^[0-9a-f-]{36}$/)
    assert(!requests[12].sessionId)
    const newProject = requests[12].cwd === dir ? 'demo' : 'other'
    await writeFile(join(newProject === 'demo' ? projectDir : otherDir, newId + '.jsonl'), JSON.stringify({
      ...record('new-id', 'new conversation appears', '2026-11-16T02:00:00Z'), sessionId: newId, cwd: requests[12].cwd
    }) + '\n')
    await js(`window.api.refresh()`)
    win.webContents.send('data:changed')
    await until(() => js(`document.querySelector('.session-row.active')?.dataset.sessionKey === '${newProject}/${newId}'`), 'new conversation anchor after indexing')
    checks.push('New conversations keep a UUID and acquire their session anchor when indexed')
    await clickMenu('关闭全部对话')
    await until(() => js(`Boolean(document.querySelector('[aria-label="关闭对话"]'))`), 'all tabs confirmation')
    await js(`document.querySelector('[aria-label="关闭对话"] .danger').click()`)
    await until(() => js(`document.querySelectorAll('[data-tab-key]').length === 0`), 'all conversations closed')
    await showActivity()
    await until(() => js(`document.querySelectorAll('.session-row').length === 14`), 'global session list')

    // Exercise deletion UI with an in-memory backend; no real recycle-bin operation.
    let listSnapshot = await js(`window.api.getSnapshot()`)
    const deleteCalls = []
    ipcMain.removeHandler('snapshot:get')
    ipcMain.handle('snapshot:get', () => listSnapshot)
    ipcMain.removeHandler('sessions:delete')
    ipcMain.handle('sessions:delete', (_event, keys) => {
      deleteCalls.push(keys)
      const deletedKeys = deleteCalls.length === 1 ? [] : keys
      const failedKeys = keys.filter(key => !deletedKeys.includes(key))
      listSnapshot = { ...listSnapshot, scannedAt: Date.now(), sessions: listSnapshot.sessions.filter(s => !deletedKeys.includes(s.key)) }
      return { ok: failedKeys.length === 0, deletedKeys, failedKeys, message: failedKeys.length ? 'fixture partial failure' : 'fixture deleted' }
    })
    assert(await js(`!document.querySelector('.session-check') && !document.querySelector('.history-toolbar')`))
    const openSessionMenu = async (key) => {
      await js(`document.querySelector('[data-session-key="${key}"]').dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, clientX: innerWidth - 3, clientY: innerHeight - 3
      }))`)
      await until(() => js(`Boolean(document.querySelector('.session-context-menu'))`), 'session context menu')
      assert(await js(`(() => { const rect = document.querySelector('.session-context-menu').getBoundingClientRect();
        return rect.right <= innerWidth && rect.bottom <= innerHeight; })()`))
      await js(`Array.from(document.querySelectorAll('.session-context-menu button')).find(b => b.textContent.trim() === '删除会话').click()`)
    }
    await openSessionMenu(batchKeys[0])
    assert.equal(await js(`document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tabKey ?? null`), null)
    checks.push('Activity list has no multiselect controls; its right-click menu stays inside the window')
    await until(() => js(`Boolean(document.querySelector('[aria-label="删除活动会话"]'))`), 'delete confirmation')
    await js(`document.querySelector('[aria-label="删除活动会话"] .dialog-actions .btn').click()`)
    assert.equal(deleteCalls.length, 0)
    await openSessionMenu(batchKeys[0])
    await until(() => js(`Boolean(document.querySelector('[aria-label="删除活动会话"]'))`), 'delete reconfirm')
    await js(`document.querySelector('[aria-label="删除活动会话"] .danger').click()`)
    await until(() => js(`document.querySelector('.toast')?.textContent.includes('fixture partial failure')`), 'deletion failure reported')
    assert(await js(`document.querySelectorAll('.session-row').length === 14`))
    assert.deepEqual(deleteCalls[0], [batchKeys[0]])
    await openSessionMenu(batchKeys[0])
    await until(() => js(`Boolean(document.querySelector('[aria-label="删除活动会话"]'))`), 'delete retry confirmation')
    await js(`document.querySelector('[aria-label="删除活动会话"] .danger').click()`)
    await until(() => js(`document.querySelectorAll('.session-row').length === 13`), 'only target deleted')
    assert.deepEqual(deleteCalls[1], [batchKeys[0]])
    assert(await js(`Boolean(document.querySelector('[data-session-key="${batchKeys[2]}"]'))`))
    await openSessionMenu(batchKeys[2])
    await until(() => js(`Boolean(document.querySelector('[aria-label="删除活动会话"]'))`), 'row delete')
    await js(`document.querySelector('[aria-label="删除活动会话"] .danger').click()`)
    await until(() => deleteCalls.length === 3, 'row delete request')
    assert.deepEqual(deleteCalls[2], [batchKeys[2]])
    checks.push('Right-click deletion supports cancellation and retry and deletes only the chosen session')

    // Many recent sessions stay bounded; a tab must still reveal an older session.
    await js(`document.querySelectorAll('.rail-nav > .rail-item')[1].click()`)
    await showActivity()
    const olderSession = listSnapshot.sessions.find(s => s.key === batchKeys[11])
    const extraSessions = Array.from({ length: 25 }, (_, index) => ({
      ...olderSession, key: `other/recent-${index}`, id: `recent-${index}`,
      title: `最近会话 ${index + 1}`, updatedAt: Date.now() - index * 1000
    }))
    listSnapshot = { ...listSnapshot, scannedAt: Date.now(),
      sessions: [...listSnapshot.sessions.map(s => s.key === olderSession.key ? { ...s, updatedAt: 0 } : s), ...extraSessions] }
    win.webContents.send('data:changed')
    await until(() => js(`Boolean(document.querySelector('.more-sessions'))`), 'bounded recent list')
    assert.equal(await js(`document.querySelectorAll('.session-row').length`), 20, 'Default global recent list size')
    await clickProject('other')
    const otherRows = () => js(`document.querySelector('[data-project-key="other"]').parentElement.querySelectorAll('.session-row').length`)
    assert.equal(await otherRows(), 20)
    await js(`document.querySelector('[data-project-key="other"]').parentElement.querySelector('.more-sessions').click()`)
    await until(() => otherRows().then(count => count > 20), 'older conversations expand')
    await js(`document.querySelector('[data-session-key="${olderSession.key}"]').click()`)
    await until(() => js(`Boolean(document.querySelector('.detail-actions .primary'))`), 'older session record')
    await js(`document.querySelector('.detail-actions .primary').click()`)
    await until(() => js(`Boolean(document.querySelector('.terminal-start-dialog'))`), 'older session dialog')
    await js(`document.querySelector('.terminal-start-dialog .primary').click()`)
    await until(() => js(`document.querySelectorAll('[data-tab-key]').length === 1`), 'older session tab')
    const olderTab = await js(`document.querySelector('[data-tab-key]').dataset.tabKey`)
    await js(`document.querySelector('button[title="收起会话列表"]').click()`)
    await js(`document.querySelector('[data-tab-key="${olderTab}"]').click()`)
    await until(() => js(`document.querySelector('.session-row.active')?.dataset.sessionKey === '${olderSession.key}'`), 'older session auto-revealed')
    await until(() => js(`(() => {
      const row = document.querySelector('.session-row.active').getBoundingClientRect();
      const rail = document.querySelector('.rail').getBoundingClientRect();
      return row.top >= rail.top - 1 && row.bottom <= rail.bottom + 1;
    })()`), 'older session scroll layout settles')
    const olderBounds = await js(`(() => {
      const row = document.querySelector('.session-row.active').getBoundingClientRect();
      const rail = document.querySelector('.rail').getBoundingClientRect();
      return { rowTop: row.top, rowBottom: row.bottom, railTop: rail.top, railBottom: rail.bottom };
    })()`)
    assert(olderBounds.rowTop >= olderBounds.railTop - 1 && olderBounds.rowBottom <= olderBounds.railBottom + 1,
      `Older session should be visible: ${JSON.stringify(olderBounds)}`)
    checks.push('Recent lists show 20 sessions at a time and tab navigation automatically reveals and scrolls to older sessions')
    await js(`document.querySelector('button[title="收起项目与会话"]').click()`)
    await js(`document.querySelector('button[title="展开会话列表"], button[title="收起会话列表"]').click()`)
    await until(() => js(`Boolean(document.querySelector('.rail .session-row.active'))`), 'session toggle restores unified sidebar')
    checks.push('The session toggle restores the unified sidebar when it has been hidden')

    const forkSourceKey = await js(`document.querySelector('.rail .session-row.active')?.dataset.sessionKey`)
    assert(forkSourceKey, 'fork source session row')
    await js(`document.querySelector('.rail .session-row.active').dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: 420, clientY: 300
    }))`)
    await until(() => js(`Boolean(document.querySelector('.session-context-menu'))`), 'fork context menu')
    assert(await js(`Array.from(document.querySelectorAll('.session-context-menu button')).some(b => b.textContent.includes('复制并继续'))`))
    const forkRequests = []
    ipcMain.removeHandler('terminal:start')
    ipcMain.handle('terminal:start', (_event, options) => {
      forkRequests.push(options)
      return { ok: true, ptyId: 'fork-pty' }
    })
    await js(`Array.from(document.querySelectorAll('.session-context-menu button')).find(b => b.textContent.includes('复制并继续')).click()`)
    await until(() => js(`Boolean(document.querySelector('.terminal-start-dialog'))`), 'fork dialog')
    assert(await js(`document.querySelector('.terminal-start-dialog h2').textContent.includes('复制并继续')`))
    await js(`Array.from(document.querySelectorAll('.terminal-start-dialog .dialog-actions button')).find(b => b.textContent.includes('创建副本')).click()`)
    await until(() => forkRequests.length === 1, 'fork terminal started')
    const forkSourceId = forkSourceKey.split('/').pop()
    assert.equal(forkRequests[0].forkFromSessionId, forkSourceId)
    assert(forkRequests[0].newSessionId && forkRequests[0].newSessionId !== forkSourceId)
    assert(!forkRequests[0].sessionId)
    checks.push('Forking a conversation preallocates a new id and resumes the source with --fork-session')

    const scheduledName = 'smoke-scheduled-task'
    const scheduled = await js(`window.api.createScheduledTask(${JSON.stringify({
      name: scheduledName,
      enabled: true,
      projectPath: dir,
      type: 'command',
      command: 'echo smoke-scheduled',
      schedule: { kind: 'once', at: Date.now() + 3_600_000 }
    })})`)
    const scheduledRun = await js(`window.api.runScheduledTask(${JSON.stringify(scheduled.id)})`)
    assert(scheduledRun.ok, 'Scheduled task should start')
    await until(async () => {
      const tasks = await js(`window.api.listScheduledTasks()`)
      const task = tasks.find((item) => item.id === scheduled.id)
      return Boolean(task && !task.running && task.lastRun?.status === 'success')
    }, 'scheduled command task result')
    const scheduledRuns = await js(`window.api.listScheduledTaskRuns(${JSON.stringify(scheduled.id)})`)
    assert(scheduledRuns.length >= 1)
    const scheduledLog = await js(`window.api.readScheduledTaskLog(${JSON.stringify(scheduled.id)},${JSON.stringify(scheduledRuns[0].id)})`)
    assert(scheduledLog.content.includes('smoke-scheduled'))
    await js(`Array.from(document.querySelectorAll('.rail-item')).find(b => b.textContent.includes('定时任务')).click()`)
    await until(() => js(`document.querySelector('.scheduled-dialog')?.textContent.includes(${JSON.stringify(scheduledName)})`), 'scheduled task row')
    await js(`document.querySelector('.scheduled-dialog button[title="关闭"]').click()`)
    await until(() => js(`!document.querySelector('.scheduled-dialog')`), 'scheduled dialog closed')
    await js(`window.api.deleteScheduledTask(${JSON.stringify(scheduled.id)})`)
    checks.push('Scheduled command tasks can be created, run and inspected from the app')

    const existingTask = await js(`window.api.createScheduledTask(${JSON.stringify({
      name: 'smoke-existing-session-task',
      enabled: false,
      projectPath: dir,
      type: 'claude',
      prompt: '追加到已有会话',
      permissionMode: 'plan',
      sessionMode: 'existing',
      resumeSessionId: sessionId,
      schedule: { kind: 'once', at: Date.now() + 3_600_000 }
    })})`)
    assert.equal(existingTask.sessionMode, 'existing')
    assert.equal(existingTask.resumeSessionId, sessionId)
    await js(`window.api.deleteScheduledTask(${JSON.stringify(existingTask.id)})`)
    checks.push('Scheduled Claude tasks can target an existing session')

    if (process.env.CSM_NAV_SCREENSHOT) {
      win.setSize(1280, 800)
      await delay(100)
      await js(`document.querySelector('.rail').scrollTop = 0`)
      await writeFile(process.env.CSM_NAV_SCREENSHOT, (await win.webContents.capturePage()).toPNG())
    }

    const output = { checks, rendererErrors }
    if (process.env.CSM_SMOKE_OUTPUT) await writeFile(process.env.CSM_SMOKE_OUTPUT, JSON.stringify(output, null, 2))
    console.log(JSON.stringify(output, null, 2))
    assert.deepEqual(rendererErrors, [])
    clearTimeout(timeout)
    app.removeAllListeners('window-all-closed')
    win.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error.stack || error)
    console.error(JSON.stringify({ checks, rendererErrors }, null, 2))
    clearTimeout(timeout)
    app.removeAllListeners('window-all-closed')
    for (const win of BrowserWindow.getAllWindows()) win.destroy()
    app.exit(1)
  }
})()
