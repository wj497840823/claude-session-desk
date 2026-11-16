const { ipcMain, clipboard, dialog, shell } = require('electron')
const { readFile, writeFile, mkdir, stat } = require('node:fs/promises')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')

module.exports = async ({ win, dir, projectDir, sessionId, configDir, js, until, delay, checks, file, showActivity }) => {
  const original = { read: clipboard.read, text: clipboard.readText, pick: dialog.showOpenDialog,
    open: shell.openPath, reveal: shell.showItemInFolder, web: shell.openExternal }
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

    const png = await readFile(join(__dirname, '../build/icon.png'))
    clipboard.read = async () => [{ types: ['image/png'], getType: async () => new Blob([png], { type: 'image/png' }) }]
    clipboard.readText = async () => 'must not replace image'
    await js(`document.querySelector('.terminal-tab-view.active .xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true
    }))`)
    await until(() => js(`document.querySelectorAll('.attachment-chip').length === 1`), 'clipboard image chip')
    const attachments = await js(`window.api.listAttachments({sessionId:'${sessionId}'})`)
    assert.equal(attachments.length, 1)
    assert(attachments[0].path.startsWith(join(configDir, 'attachments', sessionId)))
    assert((await stat(attachments[0].path)).size > 0)
    assert((await readFile(attachments[0].path)).subarray(0, 8).equals(png.subarray(0, 8)))
    assert(!written.some(item => item.data.includes('.png')), 'Pasted files must remain editable until explicitly sent')
    assert(await js(`document.querySelector('[aria-label="待发送内容"]').value.includes('.png')`))
    await js(`document.querySelector('[aria-label="待发送内容"]').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true
    }))`)
    await until(() => written.some(item => item.data === '\r'), 'explicit draft send')
    await until(() => js(`!document.querySelector('.attachment-composer')`), 'sent draft clears')
    checks.push('Ctrl+V stages a screenshot with editable paths; Ctrl+Enter explicitly sends it and clears the draft')

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
      await js(`document.querySelector('button[title="粘贴文件、截图或文本（Ctrl+V）"]').click()`)
      await until(() => js(`Boolean(document.querySelector('[aria-label="待发送内容"]'))`), 'copied file draft')
      await until(() => js(`!document.querySelector('button[title="添加文件或图片"]').disabled`), 'paste finishes')
    }
    await pasteFile()
    await pasteFile()
    assert.equal(await js(`document.querySelectorAll('.pending-attachment').length`), 1)
    assert.equal(await js(`document.querySelector('[aria-label="待发送内容"]').value.split('复制的 文件.txt').length - 1`), 1)
    const manifestPath = join(configDir, 'attachments', sessionId, 'manifest.json')
    const manifestBeforeFailure = await readFile(manifestPath)
    try {
      await writeFile(manifestPath, '{broken-json')
      await js(`document.querySelector('.pending-attachment .attachment-remove').click()`)
      await until(() => js(`document.querySelector('.toast')?.textContent.includes('移除失败')`), 'failed removal reported')
      assert(await js(`document.querySelector('[aria-label="待发送内容"]').value.includes('复制的 文件.txt')`), 'Failed removal must keep the draft path')
      assert.equal(await js(`document.querySelectorAll('.pending-attachment').length`), 1)
    } finally { await writeFile(manifestPath, manifestBeforeFailure) }
    await until(() => js(`!document.querySelector('.pending-attachment .attachment-remove').disabled`), 'removal can be retried')
    await js(`document.querySelector('.pending-attachment .attachment-remove').click()`)
    await until(() => js(`!document.querySelector('.pending-attachment')`), 'copied file removed')
    assert(!(await js(`document.querySelector('[aria-label="待发送内容"]')?.value ?? ''`)).includes('复制的 文件.txt'))
    assert.equal((await stat(copiedPath)).size, 14)
    checks.push('Native copied files paste as paths, repeated paste deduplicates them, and removing a pending file removes its path without deleting the source')
    checks.push('Failed attachment removal keeps the reference and draft intact and supports retry')

    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    await js(`document.querySelector('button[title="添加文件或图片"]').click()`)
    await until(() => js(`!document.querySelector('button[title="添加文件或图片"]').disabled`), 'cancelled file picker')
    assert.equal((await js(`window.api.listAttachments({sessionId:'${sessionId}'})`)).length, 4)
    checks.push('Cancelling file selection keeps existing attachments unchanged')

    await pasteFile()
    ipcMain.removeHandler('terminal:write')
    ipcMain.handle('terminal:write', () => { throw new Error('fixture input failure') })
    await js(`document.querySelector('.attachment-composer .primary').click()`)
    await until(() => js(`document.querySelector('.toast')?.textContent.includes('草稿已保留')`), 'failed send retains draft')
    assert(await js(`document.querySelector('[aria-label="待发送内容"]').value.includes('复制的 文件.txt')`))
    ipcMain.removeHandler('terminal:write')
    ipcMain.handle('terminal:write', (_event, id, data) => { written.push({ id, data }) })
    await js(`Array.from(document.querySelectorAll('.attachment-composer button')).find(b => b.textContent === '清空草稿').click()`)
    await until(() => js(`!document.querySelector('.attachment-composer')`), 'draft cleared after failed send')
    assert.equal((await js(`window.api.listAttachments({sessionId:'${sessionId}'})`)).length, 4)
    checks.push('A failed terminal write preserves the draft; clearing the draft also removes its attachment references')

    const context = { sessionId }
    const fileResult = await js(`window.api.fileAction(${JSON.stringify(context)},${JSON.stringify(documentPath)},'open')`)
    assert(fileResult.ok)
    assert(opened.includes(documentPath))
    assert.equal((await js(`window.api.listAttachments(${JSON.stringify(context)})`)).length, 4)

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
      message: { role: 'assistant', content: [{ type: 'text', text: `已完成：[打开报告](${link})\n\n另一个文件：\`结果.txt\`\n\n源码：[源码文件](SampleService.java:62-66)\n\n错误示例：[伪文件](missing-report.pdf)\n\n\`Throwable.getMessage()\`、\`/var/fdfs/logs/storaged.log\`` }] }
    }) + '\n')
    await js('window.api.refresh()')
    win.webContents.send('data:changed')
    await js(`document.querySelector('.workspace-record-tab').click()`)
    await until(() => js(`Boolean(document.querySelector('[data-uuid="file-answer"] a[data-file-reference]'))`), 'Markdown file link')
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
    await pasteFile()
    await until(() => js(`localStorage.getItem('csm.draft.${sessionId}')?.includes('复制的 文件.txt')`), 'draft persisted')
    await js(`document.querySelector('[data-tab-key] .terminal-tab-close').click()`)
    await until(() => js(`Boolean(document.querySelector('[aria-label="关闭对话"]'))`), 'close draft tab confirmation')
    await js(`document.querySelector('[aria-label="关闭对话"] .danger').click()`)
    await until(() => js(`!document.querySelector('[data-tab-key]') && Boolean(document.querySelector('.detail-actions .primary'))`), 'draft tab closed')
    await js(`document.querySelector('.detail-actions .primary').click()`)
    await until(() => js(`Boolean(document.querySelector('.terminal-start-dialog'))`), 'reopen draft session')
    await js(`document.querySelector('.terminal-start-dialog .primary').click()`)
    await until(() => js(`document.querySelector('.terminal-tab-view.active .terminal-status')?.textContent.includes('运行中')`), 'draft terminal restarted')
    assert(await js(`document.querySelector('[aria-label="待发送内容"]').value.includes('复制的 文件.txt')`), 'A reopened session must restore its unsent draft')
    await js(`Array.from(document.querySelectorAll('.attachment-composer button')).find(b => b.textContent === '清空草稿').click()`)
    await until(() => js(`!document.querySelector('.attachment-composer')`), 'restored draft cleared')
    checks.push('Closing and reopening a conversation restores its unsent draft and removable file references')
    await js(`document.querySelector('.terminal-attachments .attachment-clear').click()`)
    await until(() => js(`!document.querySelector('.terminal-attachments')`), 'referenced files cleared')
    assert.equal((await js(`window.api.listAttachments({sessionId:'${sessionId}'})`)).length, 0)
    assert.equal((await readFile(documentPath, 'utf8')), 'requirements')
    assert((await js(`window.api.fileAction(${JSON.stringify(context)},${JSON.stringify(documentPath)},'open')`)).ok)
    checks.push('Referenced attachments can be cleared durably without deleting originals or breaking historical file links')
    win.webContents.send('terminal:exit', { ptyId, exitCode: 0 })
    await until(() => js(`document.querySelector('.terminal-tab-view.active .terminal-status')?.textContent.includes('已结束')`), 'attachment terminal done')
    await showActivity()
  } finally {
    if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
    clipboard.read = original.read; clipboard.readText = original.text
    dialog.showOpenDialog = original.pick; shell.openPath = original.open
    shell.showItemInFolder = original.reveal; shell.openExternal = original.web
  }
}
