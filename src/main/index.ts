import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  globalShortcut,
  nativeImage,
  nativeTheme,
  shell
} from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings, AttentionSummary, TerminalActivityEvent } from '@shared/types'
import { IPC } from '@shared/ipc'
import { ConfigStore } from './config'
import { registerIpc } from './ipc'
import { AppServices } from './services'
import { TerminalService } from './terminal'
import { watchDataRoot } from './watcher'
import { externalWebUrl } from './validation'
import { FileService } from './files'

app.setPath('userData', process.env.CLAUDE_SESSION_MANAGER_USER_DATA ||
  join(app.getPath('appData'), 'claude-session-manager'))
if (process.platform === 'win32') app.setAppUserModelId('com.local.claude-session-manager')

const dataRoot =
  process.env.CLAUDE_SESSION_MANAGER_ROOT ||
  join(homedir(), '.claude', 'projects')
const config = new ConfigStore(app.getPath('userData'))
let mainWindow: BrowserWindow | null = null
const services = new AppServices(dataRoot, config, () => mainWindow)
let desktopNotifications = true
const notifiedAt = new Map<string, number>()

function notifyTerminalActivity(event: TerminalActivityEvent & { title: string }): void {
  if (!desktopNotifications || event.activity === 'working' || !event.sessionId) return
  if (!Notification.isSupported()) return
  const window = mainWindow
  if (window && !window.isDestroyed() && window.isVisible() && !window.isMinimized() && window.isFocused()) return
  const now = Date.now()
  if (now - (notifiedAt.get(event.sessionId) ?? 0) < 4000) return
  notifiedAt.set(event.sessionId, now)
  const approval = event.activity === 'approval'
  try {
    const notification = new Notification({
      title: `${event.title || 'Claude 对话'} · ${approval ? '等待确认' : '回复完成'}`,
      body: approval ? 'Claude 正在等待你批准操作。' : '可以回到对话查看结果。'
    })
    notification.on('click', () => {
      showMainWindow()
      mainWindow?.webContents.send(IPC.focusSession, event.sessionId)
    })
    notification.show()
  } catch {
    // Notifications are best-effort.
  }
}

const terminal = new TerminalService(() => mainWindow, notifyTerminalActivity)
const files = new FileService(app.getPath('userData'), dataRoot,
  (context) => services.getFileScope(context, context?.sessionId ? terminal.getFileContext(context.sessionId) : undefined),
  () => mainWindow)
let stopWatching: (() => void) | null = null
let watchErrorNotified = false
let tray: Tray | null = null
let isQuitting = false
let backgroundNoticeShown = false
let minimizeToTray = true
let pendingRefresh = false
let lastAttention: AttentionSummary = { total: 0, completed: 0, approval: 0 }

function refreshData(): void {
  files.invalidate()
  if (!mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()) {
    pendingRefresh = true
    return
  }
  void services
    .refresh()
    .then(() => mainWindow?.webContents.send(IPC.dataChanged))
    .catch(() => undefined)
}

function flushPendingRefresh(): void {
  if (!pendingRefresh) return
  pendingRefresh = false
  refreshData()
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function notifyBackground(): void {
  if (backgroundNoticeShown || !tray) return
  backgroundNoticeShown = true
  try {
    if (process.platform === 'win32') {
      tray.displayBalloon({
        title: 'Claude Session Desk',
        content: '程序仍在后台运行，点击托盘图标可恢复窗口。',
        iconType: 'info'
      })
    } else {
      new Notification({
        title: 'Claude Session Desk',
        body: '程序仍在后台运行，点击托盘图标可恢复窗口。'
      }).show()
    }
  } catch {
    // Notifications are best-effort.
  }
}

function applyAttention(summary: AttentionSummary): void {
  lastAttention = summary
  const count = Math.min(summary.total, 99)
  tray?.setToolTip(
    count > 0 ? `Claude Session Desk · ${count} 个对话待查看` : 'Claude Session Desk'
  )
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  if (count <= 0) {
    try { window.setOverlayIcon(null, '') } catch { /* platform without overlays */ }
    return
  }
  const directory = app.isPackaged
    ? join(process.resourcesPath, 'badges')
    : join(__dirname, '../../build/badges')
  const suffix = count > 9 ? '9plus' : String(count)
  const prefix = summary.approval > 0 ? 'attention' : 'done'
  const image = nativeImage.createFromPath(join(directory, `${prefix}-${suffix}.png`))
  if (image.isEmpty()) {
    try { window.setOverlayIcon(null, '') } catch { /* ignore */ }
    return
  }
  try {
    window.setOverlayIcon(image, `${count} 个对话待查看`)
  } catch {
    // Overlay icons are supported on Windows only.
  }
}

function createTray(): void {
  if (tray) return
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'tray.png'), join(process.resourcesPath, 'icon.png')]
    : [join(__dirname, '../../build/tray.png'), join(__dirname, '../../build/icon.png')]
  let image = nativeImage.createEmpty()
  for (const iconPath of candidates) {
    image = nativeImage.createFromPath(iconPath)
    if (!image.isEmpty()) break
  }
  if (image.isEmpty()) return

  tray = new Tray(image.resize({ width: 16, height: 16 }))
  tray.setToolTip(
    lastAttention.total > 0
      ? `Claude Session Desk · ${lastAttention.total} 个对话待查看`
      : 'Claude Session Desk'
  )
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => showMainWindow()
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => showMainWindow())
}

function destroyTray(): void {
  tray?.destroy()
  tray = null
}

function registerScreenshotShortcut(): void {
  try {
    globalShortcut.register('CommandOrControl+Shift+5', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.screenshotTrigger)
      }
    })
  } catch {
    // A shortcut conflict must not prevent the app from starting.
  }
}

function applySettings(settings: AppSettings): void {
  minimizeToTray = settings.minimizeToTray
  desktopNotifications = settings.desktopNotifications
  nativeTheme.themeSource = settings.theme
  if (minimizeToTray) createTray()
  else destroyTray()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Claude Session Desk',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const openLink = (url: string): void => {
    const external = externalWebUrl(url)
    if (external) void shell.openExternal(external).catch(() => undefined)
  }
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openLink(url)
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    terminal.dispose()
    mainWindow = null
  })
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    applyAttention(lastAttention)
  })
  mainWindow.on('show', flushPendingRefresh)
  mainWindow.on('restore', flushPendingRefresh)
  mainWindow.on('focus', flushPendingRefresh)

  // Hide instead of quit when tray background mode is enabled; otherwise
  // closing the window keeps the original quit behavior.
  mainWindow.on('close', (event) => {
    if (isQuitting || !minimizeToTray || !tray) return
    event.preventDefault()
    mainWindow?.hide()
    notifyBackground()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    const settings = await config.readSettings()
    minimizeToTray = settings.minimizeToTray
    desktopNotifications = settings.desktopNotifications
    nativeTheme.themeSource = settings.theme
    registerIpc(services, terminal, files, applySettings, showMainWindow, applyAttention)
    registerScreenshotShortcut()
    if (minimizeToTray) createTray()
    createWindow()

    void services.initialize().finally(() => {
      stopWatching = watchDataRoot(dataRoot, {
        onChange: () => {
          refreshData()
        },
        onError: () => {
          if (!watchErrorNotified) {
            watchErrorNotified = true
            mainWindow?.webContents.send(IPC.dataChanged)
          }
        }
      })
    })

    app.on('activate', () => {
      showMainWindow()
    })
  })
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('before-quit', () => {
  isQuitting = true
  terminal.dispose()
  stopWatching?.()
  stopWatching = null
  destroyTray()
})

app.on('window-all-closed', () => {
  if (!isQuitting && minimizeToTray && tray) return
  terminal.dispose()
  stopWatching?.()
  stopWatching = null
  if (process.platform !== 'darwin') app.quit()
})
