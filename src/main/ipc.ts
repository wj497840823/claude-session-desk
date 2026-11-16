import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { AppSettings } from '@shared/types'
import type { AppServices } from './services'
import type { TerminalService } from './terminal'
import type { FileService } from './files'
import type { FileContext } from '@shared/types'

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`非法参数：${label}`)
  }
  return value
}

export function registerIpc(
  services: AppServices,
  terminal: TerminalService,
  files: FileService,
  onSettingsChanged?: (settings: AppSettings) => void
): void {
  ipcMain.handle(IPC.attachmentsPick, (_event, context: FileContext) => files.pick(context))
  ipcMain.handle(IPC.attachmentsAdd, (_event, context: FileContext, paths: unknown) => files.add(context, paths))
  ipcMain.handle(IPC.attachmentsPaste, (_event, context: FileContext) => files.paste(context))
  ipcMain.handle(IPC.attachmentsList, (_event, context: FileContext) => files.list(context))
  ipcMain.handle(IPC.attachmentsRemove, (_event, context: FileContext, ids: unknown) => files.remove(context, ids))
  ipcMain.handle(IPC.fileAction, (_event, context: FileContext, reference: unknown, action: unknown) =>
    files.action(context, requireString(reference, 'reference'), action))
  ipcMain.handle(IPC.fileReferencesCheck, (_event, context: FileContext, references: unknown) => files.checkReferences(context, references))
  ipcMain.handle(IPC.snapshotGet, () => services.getSnapshot())
  ipcMain.handle(IPC.snapshotRefresh, () => { files.invalidate(); return services.refresh(true) })

  ipcMain.handle(IPC.sessionDetail, (_event, key: unknown) =>
    services.getDetail(requireString(key, 'sessionKey'))
  )

  ipcMain.handle(IPC.sessionHistoryDetail, (_event, key: unknown) =>
    services.getHistoryDetail(requireString(key, 'sessionKey'))
  )

  ipcMain.handle(IPC.sessionSearch, (_event, query: unknown, _requestId: unknown) => {
    const text = requireString(query, 'query')
    if (text.length > 200) throw new Error('搜索关键词过长')
    return services.search(text)
  })

  ipcMain.handle(IPC.sessionFavorite, (_event, key: unknown, favorite: unknown) => {
    if (typeof favorite !== 'boolean') throw new Error('非法参数：favorite')
    return services.setFavorite(requireString(key, 'sessionKey'), favorite)
  })

  ipcMain.handle(IPC.sessionResume, (_event, key: unknown) =>
    services.resume(requireString(key, 'sessionKey'))
  )

  ipcMain.handle(IPC.sessionDelete, (_event, key: unknown) =>
    services.deleteSessions([requireString(key, 'sessionKey')], (ids) => terminal.stopSessions(ids))
  )

  ipcMain.handle(IPC.sessionsDelete, (_event, keys: unknown) => {
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 1000 ||
      !keys.every((key) => typeof key === 'string')) throw new Error('非法批量删除参数')
    return services.deleteSessions(keys, (ids) => terminal.stopSessions(ids))
  })

  ipcMain.handle(IPC.historyDelete, (_event, keys: unknown) => {
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 1000) {
      throw new Error('非法历史删除参数')
    }
    if (!keys.every((key): key is string => typeof key === 'string')) {
      throw new Error('非法历史删除参数')
    }
    return services.deleteHistory(keys)
  })

  ipcMain.handle(IPC.sessionExport, (_event, key: unknown) =>
    services.exportMarkdown(requireString(key, 'sessionKey'))
  )

  ipcMain.handle(IPC.projectOpen, (_event, projectKey: unknown) =>
    services.openProjectFolder(requireString(projectKey, 'projectKey'))
  )

  ipcMain.handle(IPC.projectTerminalOpen, (_event, projectKey: unknown) =>
    services.openProjectTerminal(requireString(projectKey, 'projectKey'))
  )

  ipcMain.handle(IPC.projectSessionsDelete, (_event, projectKey: unknown) =>
    services.deleteProjectSessions(requireString(projectKey, 'projectKey'), (ids) => terminal.stopSessions(ids))
  )

  ipcMain.handle(IPC.pathOpen, (_event, target: unknown) =>
    services.openExternalPath(requireString(target, 'path'))
  )

  ipcMain.handle(IPC.folderOpen, (_event, target: unknown) =>
    services.openFolder(requireString(target, 'path'))
  )

  ipcMain.handle(IPC.folderPick, () => services.pickFolder())
  ipcMain.handle(IPC.terminalStart, (_event, options: unknown) =>
    terminal.start(options)
  )
  ipcMain.handle(IPC.terminalWrite, (_event, ptyId: unknown, data: unknown) => {
    terminal.write(requireString(ptyId, 'ptyId'), data)
  })
  ipcMain.handle(
    IPC.terminalResize,
    (_event, ptyId: unknown, cols: unknown, rows: unknown) => {
      terminal.resize(requireString(ptyId, 'ptyId'), cols, rows)
    }
  )
  ipcMain.handle(IPC.terminalStop, (_event, ptyId: unknown) => {
    return terminal.stop(requireString(ptyId, 'ptyId'))
  })

  ipcMain.handle(IPC.settingsUpdate, async (_event, patch: unknown) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('非法设置参数')
    }
    const settings = await services.updateSettings(patch as Partial<AppSettings>)
    onSettingsChanged?.(settings)
    return settings
  })
}
