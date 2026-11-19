const { ipcMain, clipboard, dialog, shell, desktopCapturer, screen, nativeImage } = require('electron')
const { readFile, writeFile, mkdir, stat } = require('node:fs/promises')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')

module.exports = async ({ win, dir, projectDir, sessionId, configDir, js, until, delay, checks, file, showActivity, overlayCalls }) => {
  const original = { read: clipboard.read, text: clipboard.readText, pick: dialog.showOpenDialog,
    open: shell.openPath, reveal: shell.showItemInFolder, web: shell.openExternal,
    sources: desktopCapturer.getSources }
  const opened = [], revealed = [], written = []
  const ptyId = 'attachment-test-pty'
  try {
    ipcMain.removeHandler('terminal:start')
    ipcMain.handle('terminal:start', () => ({ ok: true, ptyId }))
    ipcMain.removeHandler('terminal:write')
    ipcMain.handle('terminal:write', (_event, id, data) => { written.push({ id, data }) })
    shell.openPath = async (path) => { opened.push(path); return '' }
    shell.showItemInFolder = (path) => { revealed.push(path) }
    shell.openExternal = async () => undefined
    await js(`document.querySelector('button[title="重新开始"]').click()`)
    await until(() => js(`document.querySelector('.terminal-tab-view.active .terminal-status')?.textContent.includes('运行中')`), 'attachment terminal')

    win.webContents.send('terminal:activity', { ptyId, sessionId, activity: 'approval' })
    await until(() => js(`document.querySelector('.terminal-tab-view.active .terminal-status')?.textContent.includes('等待确认')`), 'approval activity status')
    assert(await js(`Boolean(document.querySelector('.terminal-tab-view.active .terminal-status.approval'))`))
    assert(await js(`document.querySelector('.terminal-tab.active .terminal-tab-letter.approval')?.textContent.trim() === 'A'`))
    assert(await js(`Boolean(document.querySelector('.terminal-tab.active .terminal-tab-attention.approval'))`))
    win.webContents.send('terminal:activity', { ptyId, sessionId, activity: 'idle' })
    await until(() => js(`document.querySelector('.terminal-tab-view.active .terminal-status')?.textContent.includes('等待输入')`), 'idle activity status')
    assert(await js(`document.querySelector('.terminal-tab.active .terminal-tab-letter.idle')?.textContent.trim() === 'D'`))
    assert(await js(`Boolean(document.querySelector('.terminal-tab.active .terminal-tab-attention.completed'))`))
    assert(await js(`document.querySelector('.terminal-tab.active .terminal-tab-project')?.textContent.trim().length > 0`))
    win.webContents.send('terminal:activity', { ptyId, sessionId, activity: 'working' })
    await until(() => js(`document.querySelector('.terminal-tab-view.active .terminal-status')?.textContent.includes('工作中')`), 'working activity status')
    assert(await js(`document.querySelector('.terminal-tab.active .terminal-tab-letter.working')?.textContent.trim() === 'W'`))
    assert(await js(`!document.querySelector('.terminal-tab.active .terminal-tab-attention')`))
    checks.push('Terminal activity events drive the tab status label and colour')

    win.webContents.send('terminal:activity', { ptyId, sessionId: 'attention-test-session', activity: 'approval' })
    await until(() => overlayCalls.some((description) => description.includes('个对话待查看')), 'taskbar attention badge')
    const attentionIndex = overlayCalls.findIndex((description) => description.includes('个对话待查看'))
    assert(overlayCalls[attentionIndex].includes('1 个对话待查看'))
    await until(() => js(`document.querySelector('.attention-chip')?.textContent.includes('待查看 1')`), 'topbar attention chip')
    await js(`document.querySelector('.attention-clear').click()`)
    await until(() => js(`!document.querySelector('.attention-chip')`), 'topbar attention cleared')
    await until(() => overlayCalls.slice(attentionIndex + 1).some((description) => description === ''), 'taskbar attention badge cleared')
    checks.push('Completed or approval conversations show a taskbar badge and a topbar count that can be cleared at once')

    clipboard.read = async () => []
    clipboard.readText = async () => 'right click paste'
    await js(`document.querySelector('.terminal-tab-view.active .terminal-body').dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 320, clientY: 240
    }))`)
    await until(() => written.some(item => item.data.includes('right click paste')), 'right-click paste')
    checks.push('Right-click pastes clipboard text into the terminal')
    await until(() => js(`localStorage.getItem('csm.openTabs')?.includes('${sessionId}')`), 'open tabs persisted')

    const png = await readFile(join(__dirname, '../build/icon.png'))
    clipboard.read = async () => [{ types: ['image/png'], getType: async () => new Blob([png], { type: 'image/png' }) }]
    clipboard.readText = async () => 'must not replace image'
    await js(`document.querySelector('.terminal-tab-view.active .xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true
    }))`)
    await until(() => written.some(item => item.data.includes('.png')), 'clipboard image inserted')
    await until(() => js(`document.querySelectorAll('.terminal-attachments .attachment-chip').length === 1`), 'clipboard image chip')
    const attachments = await js(`window.api.listAttachments({sessionId:'${sessionId}'})`)
    assert.equal(attachments.length, 1)
    assert(attachments[0].path.startsWith(join(configDir, 'attachments', sessionId)))
    assert((await stat(attachments[0].path)).size > 0)
    assert((await readFile(attachments[0].path)).subarray(0, 8).equals(png.subarray(0, 8)))
    assert(!written.some(item => item.data === '\r'), 'Pasted paths must be inserted without submitting')
    assert(await js(`!document.querySelector('.attachment-composer')`), 'Copied files and images must insert directly without a draft')
    checks.push('Ctrl+V inserts a screenshot path directly into the terminal without a draft or Enter; the attachment stays removable')

    clipboard.read = async () => []
    clipboard.readText = async () => 'plain pasted text'
    await js(`document.querySelector('button[title="粘贴文件、截图或文本（Ctrl+V）"]').click()`)
    await until(() => written.some(item => item.data.includes('plain pasted text')), 'normal text paste')
    checks.push('Plain clipboard text continues to paste normally')

    const docs = join(dir, '附件 中文')
    await mkdir(docs)
    const documentPath = join(docs, '需求 文件.txt')
    const imagePath = join(docs, '选择 图片.png')
    const droppedPath = join(docs, '拖入 数据.csv')
    await writeFile(documentPath, 'requirements')
    await writeFile(imagePath, png)
    await writeFile(droppedPath, 'name,value\na,1')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [documentPath, imagePath] })
    await js(`document.querySelector('button[title="添加文件或图片"]').click()`)
    await until(() => js(`document.querySelectorAll('.attachment-chip').length === 3`), 'chosen files chips')
    assert(await js(`document.querySelector('[aria-label="待发送内容"]').value.includes('需求 文件.txt')`))

    // Back the dropped File with a real disk file, then pass it through the real preload/webUtils bridge.
    await js(`(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'smoke-drop-file'; input.hidden = true; document.body.append(input) })()`)
    win.webContents.debugger.attach('1.3')
    const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument')
    const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#smoke-drop-file' })
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [droppedPath] })
    await js(`(() => { const data = new DataTransfer(); data.items.add(document.getElementById('smoke-drop-file').files[0]);
      document.querySelector('.terminal-tab-view.active').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })); })()`)
    await until(() => js(`document.querySelectorAll('.attachment-chip').length === 4`), 'dropped file chip')
    assert(await js(`document.querySelector('[aria-label="待发送内容"]').value.includes('拖入 数据.csv')`))
    const beforeInsert = written.length
    await js(`Array.from(document.querySelectorAll('.attachment-composer button')).find(b => b.textContent === '仅插入终端').click()`)
    await until(() => js(`!document.querySelector('.attachment-composer')`), 'paths inserted without submission')
    assert(written.slice(beforeInsert).some(item => item.data.includes('拖入 数据.csv')))
    assert(written.slice(beforeInsert).every(item => item.data !== '\r'))
    checks.push('File picker and disk-backed drop stage Chinese paths; insert-only writes paths without sending Enter')

    const copiedPath = join(docs, '复制的 文件.txt')
    await writeFile(copiedPath, 'clipboard file')
    clipboard.read = async () => [{ types: ['text/uri-list', 'image/png'], getType: async (type) => {
      assert.equal(type, 'text/uri-list', 'Copied files must take priority over image previews')
      return new Blob([pathToFileURL(copiedPath).href + '\r\n'])
    } }]
    const pasteFile = async () => {
      const before = written.length
      await js(`document.querySelector('button[title="粘贴文件、截图或文本（Ctrl+V）"]').click()`)
      await until(() => written.length > before, 'copied file inserted')
      await until(() => js(`!document.querySelector('button[title="添加文件或图片"]').disabled`), 'paste finishes')
    }
    await pasteFile()
    await pasteFile()
    assert(await js(`!document.querySelector('.attachment-composer')`), 'Copied files must insert directly without a draft')
    assert.equal(await js(`document.querySelectorAll('.terminal-attachments .attachment-chip').length`), 5)
    assert.equal(written.filter(item => item.data.includes('复制的 文件.txt')).length, 2, 'Each paste inserts the copied path')
    const copiedChipRemove = `Array.from(document.querySelectorAll('.terminal-attachments .attachment-chip')).find(chip => chip.textContent.includes('复制的 文件.txt')).querySelector('.attachment-remove')`
    const manifestPath = join(configDir, 'attachments', sessionId, 'manifest.json')
    const manifestBeforeFailure = await readFile(manifestPath)
    try {
      await writeFile(manifestPath, '{broken-json')
      await js(`${copiedChipRemove}.click()`)
      await until(() => js(`document.querySelector('.toast')?.textContent.includes('移除失败')`), 'failed removal reported')
      assert.equal(await js(`document.querySelectorAll('.terminal-attachments .attachment-chip').length`), 5)
      assert(await js(`Array.from(document.querySelectorAll('.terminal-attachments .attachment-chip')).some(chip => chip.textContent.includes('复制的 文件.txt'))`), 'Failed removal must keep the attachment reference')
    } finally { await writeFile(manifestPath, manifestBeforeFailure) }
    await until(() => js(`!${copiedChipRemove}.disabled`), 'removal can be retried')
    await js(`${copiedChipRemove}.click()`)
    await until(() => js(`document.querySelectorAll('.terminal-attachments .attachment-chip').length === 4`), 'copied file record removed')
    assert.equal((await js(`window.api.listAttachments({sessionId:'${sessionId}'})`)).length, 4)
    assert.equal((await stat(copiedPath)).size, 14)
    checks.push('Native copied files insert their paths directly on every paste without opening a draft')
    checks.push('Directly inserted attachment records remain removable, and a failed removal keeps the reference for retry without deleting the source')

    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    await js(`document.querySelector('button[title="添加文件或图片"]').click()`)
    await until(() => js(`!document.querySelector('button[title="添加文件或图片"]').disabled`), 'cancelled file picker')
    assert.equal((await js(`window.api.listAttachments({sessionId:'${sessionId}'})`)).length, 4)
    checks.push('Cancelling file selection keeps existing attachments unchanged')

    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [documentPath] })
    await js(`document.querySelector('button[title="添加文件或图片"]').click()`)
    await until(() => js(`Boolean(document.querySelector('[aria-label="待发送内容"]'))`), 'staged picker draft')
    ipcMain.removeHandler('terminal:write')
    ipcMain.handle('terminal:write', () => { throw new Error('fixture input failure') })
    await js(`document.querySelector('.attachment-composer .primary').click()`)
    await until(() => js(`document.querySelector('.toast')?.textContent.includes('草稿已保留')`), 'failed send retains draft')
    assert(await js(`document.querySelector('[aria-label="待发送内容"]').value.includes('需求 文件.txt')`))
    ipcMain.removeHandler('terminal:write')
    ipcMain.handle('terminal:write', (_event, id, data) => { written.push({ id, data }) })
    await js(`Array.from(document.querySelectorAll('.attachment-composer button')).find(b => b.textContent === '清空草稿').click()`)
    await until(() => js(`!document.querySelector('.attachment-composer')`), 'draft cleared after failed send')
    assert.equal((await js(`window.api.listAttachments({sessionId:'${sessionId}'})`)).length, 3)
    checks.push('A failed terminal write preserves the draft; clearing the draft also removes its attachment references')

    const context = { sessionId }
    const fileResult = await js(`window.api.fileAction(${JSON.stringify(context)},${JSON.stringify(documentPath)},'open')`)
    assert(fileResult.ok)
    assert(opened.includes(documentPath))
    assert.equal((await js(`window.api.listAttachments(${JSON.stringify(context)})`)).length, 3)

    // A plain terminal path includes wide CJK cells and exercises the real xterm link provider.
    const terminalFile = join(dir, '结果.txt')
    await writeFile(terminalFile, 'terminal result')
    win.webContents.send('terminal:data', { ptyId, data: '\r\n结果.txt\r\n' })
    await until(() => js(`Array.from(document.querySelectorAll('.terminal-tab-view.active .xterm-rows > div')).some(row => row.textContent.includes('结果.txt'))`), 'terminal output')
    const point = await js(`(() => { const row = Array.from(document.querySelectorAll('.terminal-tab-view.active .xterm-rows > div')).find(row => row.textContent.includes('结果.txt'));
      const r = row.getBoundingClientRect(); return { x:r.left + 8, y:r.top + r.height / 2 }; })()`)
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await delay(100)
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    await until(() => opened.includes(terminalFile), 'terminal file opens on click')
    checks.push('Clicking a terminal path opens the correct file with CJK cell positioning')
    win.webContents.send('terminal:data', { ptyId, data: '\r\n"' + documentPath + '"\r\n' })
    await until(() => js(`Array.from(document.querySelectorAll('.terminal-tab-view.active .xterm-rows > div')).some(row => row.textContent.includes('"C:'))`), 'wrapped terminal path')
    const wrappedPoint = await js(`(() => { const row = Array.from(document.querySelectorAll('.terminal-tab-view.active .xterm-rows > div')).find(row => row.textContent.includes('"C:'));
      const r = row.getBoundingClientRect(); return { x:r.left + 20, y:r.top + r.height / 2 }; })()`)
    const openedBeforeWrap = opened.length
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...wrappedPoint })
    await delay(100)
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...wrappedPoint, button: 'left', clickCount: 1 })
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...wrappedPoint, button: 'left', clickCount: 1 })
    await until(() => opened.length > openedBeforeWrap, 'wrapped path opens')
    assert.equal(opened.at(-1), documentPath)
    checks.push('Wrapped terminal paths retain spaces and open the complete file rather than a truncated fragment')
    const sourceDir = join(dir, 'sample-module', 'src', 'main', 'java')
    await mkdir(sourceDir, { recursive: true })
    const javaPath = join(sourceDir, 'SampleService.java')
    await writeFile(javaPath, 'class SampleService {}')
    await js('window.api.refresh()')
    win.webContents.send('data:changed')
    await delay(100)
    const clickTerminalRow = async (text) => {
      await until(() => js(`Array.from(document.querySelectorAll('.terminal-tab-view.active .xterm-rows > div')).some(row => row.textContent.startsWith(${JSON.stringify(text)}))`), 'terminal test row ' + text)
      const position = await js(`(() => {
        const row = Array.from(document.querySelectorAll('.terminal-tab-view.active .xterm-rows > div')).find(row => row.textContent.startsWith(${JSON.stringify(text)}));
        const box = row.getBoundingClientRect(); return { x: box.left + 8, y: box.top + box.height / 2 };
      })()`)
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position })
      await delay(250)
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 })
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 })
      await delay(50)
    }
    win.webContents.send('terminal:data', { ptyId, data: '\r\n\x1b[36mmissing-report.pdf\x1b[0m\r\n' +
      '\x1b]8;;file:///C:/not-a-real-directory/fake.pdf\x07\x1b[36mFAKE_FILE_LINK\x1b[0m\x1b]8;;\x07\r\n' })
    const noOpen = opened.length
    await clickTerminalRow('missing-report.pdf')
    await clickTerminalRow('FAKE_FILE_LINK')
    assert.equal(opened.length, noOpen, 'Nonexistent inferred and native OSC links must not activate')
    win.webContents.send('terminal:data', { ptyId, data: '\r\n\x1b]8;;' + pathToFileURL(javaPath).href + '\x07REAL_FILE_LINK\x1b]8;;\x07\r\n' })
    await clickTerminalRow('REAL_FILE_LINK')
    await until(() => opened.length > noOpen, 'verified native file opens')
    assert.equal(opened.at(-1), javaPath)
    const beforeShort = opened.length
    win.webContents.send('terminal:data', { ptyId, data: '\r\nSampleService.java:62-66\r\n' })
    await clickTerminalRow('SampleService.java:62-66')
    await until(() => opened.length > beforeShort, 'short Java filename opens real source')
    assert.equal(opened.at(-1), javaPath)
    checks.push('Terminal inferred and native OSC links reject missing targets; valid native links and short Java filenames open verified source files')
    win.webContents.debugger.detach()

    const link = pathToFileURL(documentPath).href
    await require('node:fs/promises').appendFile(file, JSON.stringify({
      type: 'assistant', uuid: 'file-answer', sessionId, timestamp: '2026-11-16T00:02:00Z',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-5',
        usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500 },
        content: [
          { type: 'text', text: `已完成：[打开报告](${link})\n\n另一个文件：\`结果.txt\`\n\n源码：[源码文件](SampleService.java:62-66)\n\n错误示例：[伪文件](missing-report.pdf)\n\n\`Throwable.getMessage()\`、\`/var/fdfs/logs/storaged.log\`` },
          {
            type: 'tool_use', id: 'todo-file-answer', name: 'TodoWrite',
            input: { todos: [
              { content: '读取报告', status: 'completed' },
              { content: '核对源码', status: 'in_progress' },
              { content: '整理结论', status: 'pending' }
            ] }
          }
        ]
      }
    }) + '\n')
    await js('window.api.refresh()')
    win.webContents.send('data:changed')
    await js(`document.querySelector('.workspace-record-tab').click()`)
    await until(() => js(`Boolean(document.querySelector('[data-uuid="file-answer"] a[data-file-reference]'))`), 'Markdown file link')
    await until(() => js(`Boolean(document.querySelector('.detail-usage'))`), 'usage summary')
    assert(await js(`document.querySelector('.detail-usage').textContent.includes('输入')`))
    assert(await js(`document.querySelector('.detail-usage').textContent.includes('上下文')`))
    await until(() => js(`Boolean(document.querySelector('.todo-panel'))`), 'task list panel')
    assert(await js(`document.querySelector('.todo-panel').textContent.includes('核对源码')`))
    checks.push('Session detail shows token usage, estimated cost/context and the latest TodoWrite task list')
    const before = opened.length
    await js(`document.querySelector('[data-uuid="file-answer"] a').click()`)
    await until(() => opened.length === before + 1, 'Markdown link opens file')
    assert.equal(opened.at(-1), documentPath)
    await js(`document.querySelector('[data-uuid="file-answer"] a').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 200 }))`)
    await until(() => js(`Boolean(document.querySelector('.file-reference-menu'))`), 'file menu')
    await js(`Array.from(document.querySelectorAll('.file-reference-menu button')).find(b => b.textContent === '在文件夹中定位').click()`)
    await until(() => revealed.includes(documentPath), 'reveal Markdown file')
    checks.push('Session answers open Markdown and inline file links and offer reveal-in-folder on right click')
    await until(() => js(`Array.from(document.querySelectorAll('[data-uuid="file-answer"] a[data-file-reference]')).some(a => a.textContent === '源码文件')`), 'verified short Markdown link')
    assert(await js(`!Array.from(document.querySelectorAll('[data-uuid="file-answer"] a')).some(a => a.textContent.includes('伪文件') || a.textContent.includes('getMessage') || a.textContent.includes('/var/fdfs'))`), 'Invalid references must remain plain text')
    checks.push('Markdown short source links resolve to actual files while methods, remote paths and missing targets remain plain text')
    assert(await js(`document.documentElement.scrollWidth <= innerWidth`))
    await js(`document.querySelector('[data-tab-key]').click()`)
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [documentPath] })
    await js(`document.querySelector('button[title="添加文件或图片"]').click()`)
    await until(() => js(`localStorage.getItem('csm.draft.${sessionId}')?.includes('需求 文件.txt')`), 'draft persisted')
    await js(`document.querySelector('[data-tab-key] .terminal-tab-close').click()`)
    await until(() => js(`Boolean(document.querySelector('[aria-label="关闭对话"]'))`), 'close draft tab confirmation')
    await js(`document.querySelector('[aria-label="关闭对话"] .danger').click()`)
    await until(() => js(`!document.querySelector('[data-tab-key]') && Boolean(document.querySelector('.detail-actions .primary'))`), 'draft tab closed')
    await until(() => js(`!localStorage.getItem('csm.openTabs')?.includes('${sessionId}')`), 'closed tab removed from restore list')
    await js(`document.querySelector('.detail-actions .primary').click()`)
    await until(() => js(`Boolean(document.querySelector('.terminal-start-dialog'))`), 'reopen draft session')
    await js(`document.querySelector('.terminal-start-dialog .primary').click()`)
    await until(() => js(`document.querySelector('.terminal-tab-view.active .terminal-status')?.textContent.includes('运行中')`), 'draft terminal restarted')
    assert(await js(`document.querySelector('[aria-label="待发送内容"]').value.includes('需求 文件.txt')`), 'A reopened session must restore its unsent draft')
    await js(`Array.from(document.querySelectorAll('.attachment-composer button')).find(b => b.textContent === '清空草稿').click()`)
    await until(() => js(`!document.querySelector('.attachment-composer')`), 'restored draft cleared')
    checks.push('Closing and reopening a conversation restores its unsent draft and removable file references')
    await js(`document.querySelector('.terminal-attachments .attachment-clear').click()`)
    await until(() => js(`!document.querySelector('.terminal-attachments')`), 'referenced files cleared')
    assert.equal((await js(`window.api.listAttachments({sessionId:'${sessionId}'})`)).length, 0)
    assert.equal((await readFile(documentPath, 'utf8')), 'requirements')
    assert((await js(`window.api.fileAction(${JSON.stringify(context)},${JSON.stringify(documentPath)},'open')`)).ok)
    checks.push('Referenced attachments can be cleared durably without deleting originals or breaking historical file links')

    // 1.1.5: command palette, in-session find, archive and screenshot.
    await showActivity()
    await until(() => js(`Boolean(document.querySelector('.session-row'))`), 'session rows for palette tests')
    const rowSelector = `.session-row[data-session-key$="${sessionId}"]`
    await js(`document.querySelector('${rowSelector}')?.click()`)
    await until(() => js(`Boolean(document.querySelector('.workspace-record')) && document.querySelector('.workspace-record').style.display !== 'none'`), 'record view active')
    await until(() => js(`Boolean(document.querySelector('.detail-usage'))`), 'record loaded for find')

    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))`)
    await until(() => js(`Boolean(document.querySelector('.command-palette'))`), 'command palette')
    assert(await js(`document.querySelector('.command-palette').textContent.includes('打开设置')`))
    await js(`(() => { const input = document.querySelector('.command-palette input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '设置'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await until(() => js(`document.querySelectorAll('.palette-item').length === 1 && document.querySelector('.palette-item').textContent.includes('打开设置')`), 'palette filter')
    await js(`document.querySelector('.palette-item').click()`)
    await until(() => js(`Boolean(document.querySelector('.settings-dialog'))`), 'palette opens settings')
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await until(() => js(`!document.querySelector('.settings-dialog')`), 'settings closed after palette')
    checks.push('Ctrl+Shift+P opens a searchable command palette that runs the selected action')

    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }))`)
    await until(() => js(`Boolean(document.querySelector('.find-bar'))`), 'in-session find bar')
    await js(`(() => { const input = document.querySelector('.find-bar input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '打开报告'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await until(() => js(`document.querySelector('.find-count')?.textContent.trim() !== '0 / 0'`), 'find matches')
    await js(`document.querySelector('.find-bar input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await until(() => js(`!document.querySelector('.find-bar')`), 'find bar closed')
    checks.push('Ctrl+F finds text in the current transcript and shows match navigation')

    await js(`document.querySelector('${rowSelector}')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 420, clientY: 220 }))`)
    await until(() => js(`Boolean(document.querySelector('.session-context-menu'))`), 'session context menu')
    await js(`Array.from(document.querySelectorAll('.session-context-menu button')).find(b => b.textContent.includes('归档会话')).click()`)
    await until(() => js(`!document.querySelector('${rowSelector}')`), 'archived session hidden')
    await until(() => js(`Array.from(document.querySelectorAll('.rail-item')).some(b => b.textContent.includes('已归档'))`), 'archive rail item')
    await js(`Array.from(document.querySelectorAll('.rail-item')).find(b => b.textContent.includes('已归档')).click()`)
    await until(() => js(`Boolean(document.querySelector('${rowSelector}'))`), 'archived session listed')
    await js(`document.querySelector('${rowSelector}').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 420, clientY: 220 }))`)
    await until(() => js(`Boolean(document.querySelector('.session-context-menu'))`), 'archived context menu')
    await js(`Array.from(document.querySelectorAll('.session-context-menu button')).find(b => b.textContent.includes('取消归档')).click()`)
    await until(() => js(`!document.querySelector('${rowSelector}')`), 'unarchived session leaves archive view')
    await js(`document.querySelectorAll('.rail-nav > .rail-item')[0].click()`)
    await until(() => js(`Boolean(document.querySelector('${rowSelector}'))`), 'session restored to active list')
    checks.push('Sessions can be archived and restored without deleting transcripts')

    desktopCapturer.getSources = async () => [{
      display_id: String(screen.getPrimaryDisplay().id),
      thumbnail: nativeImage.createFromPath(join(__dirname, '../build/icon.png'))
    }]
    await js(`document.querySelector('[data-tab-key]').click()`)
    await until(() => js(`Boolean(document.querySelector('.terminal-tab-view.active .terminal-status'))`), 'terminal active for screenshot')
    await until(() => js(`Boolean(document.querySelector('.terminal-tab-view.active .terminal-model'))`), 'terminal usage header')
    assert(await js(`document.querySelector('.terminal-tab-view.active .terminal-context')?.textContent.includes('上下文')`))
    checks.push('Terminal header shows the live model and context usage')
    const shotWrites = written.length
    const shotChips = await js(`document.querySelectorAll('.attachment-chip').length`)
    win.webContents.send('screenshot:trigger')
    await until(() => written.slice(shotWrites).some(item => item.data.includes('截图-')), 'screenshot path written')
    await until(() => js(`document.querySelectorAll('.attachment-chip').length > ${shotChips}`), 'screenshot attachment chip')
    const shotFiles = await js(`window.api.listAttachments({sessionId:'${sessionId}'})`)
    assert(shotFiles.some(item => item.path.includes('截图-') && item.kind === 'image'))
    checks.push('Ctrl+Shift+5 captures a screenshot and inserts its path into the active conversation')

    win.webContents.send('terminal:exit', { ptyId, exitCode: 0 })
    await until(() => js(`document.querySelector('.terminal-tab-view.active .terminal-status')?.textContent.includes('已结束')`), 'attachment terminal done')
    await showActivity()
  } finally {
    if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
    clipboard.read = original.read; clipboard.readText = original.text
    dialog.showOpenDialog = original.pick; shell.openPath = original.open
    shell.showItemInFolder = original.reveal; shell.openExternal = original.web
    desktopCapturer.getSources = original.sources
  }
}
