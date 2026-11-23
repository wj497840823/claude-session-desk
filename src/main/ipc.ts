import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AppSettings,
  AttentionSummary,
  ClaudeMdScope,
  GitDiffGroup,
  ScheduledTaskInput
} from '@shared/types'
import type { AppServices } from './services'
import type { TerminalService } from './terminal'
import type { FileService } from './files'
import type { ScheduledTaskService } from './scheduledTasks'
import type { ClaudeMdService } from './claudeMd'
import type { GitService } from './git'
import { captureScreenshot } from './screenshot'
import type { FileContext } from '@shared/types'

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`非法参数：${label}`)
  }
  return value
}

function requireClaudeMdScope(value: unknown): ClaudeMdScope {
  if (value === 'global' || value === 'project') return value
  throw new Error('非法 CLAUDE.md 作用域')
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`非法参数：${label}`)
  return value
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`非法参数：${label}`)
  return value
}

export function registerIpc(
  services: AppServices,
  terminal: TerminalService,
  files: FileService,
  onSettingsChanged?: (settings: AppSettings) => void,
  onScreenshotCaptured?: () => void,
  onAttentionChanged?: (summary: AttentionSummary) => void,
  scheduledTasks?: ScheduledTaskService,
  claudeMd?: ClaudeMdService,
  git?: GitService
): void {
  const requireSchedules = (): ScheduledTaskService => {
    if (!scheduledTasks) throw new Error('定时任务服务未启动')
    return scheduledTasks
  }
  const requireClaudeMd = (): ClaudeMdService => {
    if (!claudeMd) throw new Error('CLAUDE.md 服务未启动')
    return claudeMd
  }
  const requireGit = (): GitService => {
    if (!git) throw new Error('Git 服务未启动')
    return git
  }
  ipcMain.handle(IPC.schedulesList, () => scheduledTasks?.list() ?? [])
  ipcMain.handle(IPC.schedulesCreate, (_event, input: ScheduledTaskInput) =>
    requireSchedules().create(input))
  ipcMain.handle(IPC.schedulesUpdate, (_event, id: unknown, input: ScheduledTaskInput) =>
    requireSchedules().update(requireString(id, 'taskId'), input))
  ipcMain.handle(IPC.schedulesDelete, (_event, id: unknown) =>
    requireSchedules().remove(requireString(id, 'taskId')))
  ipcMain.handle(IPC.schedulesEnable, (_event, id: unknown, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('非法启用状态')
    return requireSchedules().setEnabled(requireString(id, 'taskId'), enabled)
  })
  ipcMain.handle(IPC.schedulesRun, (_event, id: unknown) =>
    requireSchedules().runNow(requireString(id, 'taskId')))
  ipcMain.handle(IPC.schedulesCancel, (_event, id: unknown) =>
    requireSchedules().cancel(requireString(id, 'taskId')))
  ipcMain.handle(IPC.schedulesRuns, (_event, id: unknown) =>
    requireSchedules().runs(requireString(id, 'taskId')))
  ipcMain.handle(IPC.schedulesLog, (_event, id: unknown, runId: unknown) =>
    requireSchedules().readLog(requireString(id, 'taskId'), requireString(runId, 'runId')))
  ipcMain.handle(IPC.attentionUpdate, (_event, summary: unknown) => {
    if (!summary || typeof summary !== 'object') throw new Error('非法提示参数')
    const value = summary as Record<string, unknown>
    const total = value.total
    const completed = value.completed
    const approval = value.approval
    if (![total, completed, approval].every((count) =>
      typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 999
    )) throw new Error('非法提示参数')
    onAttentionChanged?.({
      total: Math.min(total as number, (completed as number) + (approval as number)),
      completed: completed as number,
      approval: approval as number
    })
  })
  ipcMain.handle(IPC.screenshotCapture, async (_event, context: FileContext) => {
    const attachments = await captureScreenshot(context, files)
    onScreenshotCaptured?.()
    return attachments
  })
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

  ipcMain.handle(IPC.sessionUsage, (_event, key: unknown) =>
    services.getUsage(requireString(key, 'sessionKey'))
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

  ipcMain.handle(IPC.claudeMdRead, (_event, scope: unknown, projectKey: unknown) =>
    requireClaudeMd().read({
      scope: requireClaudeMdScope(scope),
      projectKey: optionalString(projectKey, 'projectKey')
    })
  )

  ipcMain.handle(IPC.claudeMdWrite, (_event, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('非法 CLAUDE.md 参数')
    }
    const value = input as Record<string, unknown>
    return requireClaudeMd().write({
      scope: requireClaudeMdScope(value.scope),
      projectKey: optionalString(value.projectKey, 'projectKey'),
      content: requireText(value.content, 'content')
    })
  })

  ipcMain.handle(IPC.claudeMdTemplatesList, () => requireClaudeMd().listTemplates())

  ipcMain.handle(IPC.claudeMdTemplateSave, (_event, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('非法模板参数')
    }
    const value = input as Record<string, unknown>
    return requireClaudeMd().saveTemplate({
      id: optionalString(value.id, 'id'),
      name: requireText(value.name, 'name'),
      description: optionalString(value.description, 'description') ?? '',
      scope: requireClaudeMdScope(value.scope),
      content: requireText(value.content, 'content')
    })
  })

  ipcMain.handle(IPC.claudeMdTemplateDelete, (_event, id: unknown) =>
    requireClaudeMd().deleteTemplate(requireString(id, 'templateId'))
  )

  ipcMain.handle(IPC.claudeMdTemplateImport, async (event, scope: unknown) => {
    const service = requireClaudeMd()
    const targetScope = requireClaudeMdScope(scope)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      title: '导入 CLAUDE.md 模板',
      filters: [{ name: 'Markdown 模板', extensions: ['md'] }],
      properties: ['openFile']
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return service.importTemplate(targetScope, result.filePaths[0])
  })

  ipcMain.handle(IPC.gitStatus, (_event, projectKey: unknown, force: unknown) => {
    if (force !== undefined && typeof force !== 'boolean') throw new Error('非法刷新参数')
    return requireGit().status(requireString(projectKey, 'projectKey'), force === true)
  })

  ipcMain.handle(IPC.gitStatusBatch, (_event, keys: unknown) => {
    if (
      !Array.isArray(keys) ||
      keys.length === 0 ||
      keys.length > 50 ||
      !keys.every((key) => typeof key === 'string')
    ) {
      throw new Error('非法批量 Git 参数')
    }
    return requireGit().statusBatch(keys)
  })

  ipcMain.handle(
    IPC.gitDiff,
    (_event, projectKey: unknown, path: unknown, group: unknown) => {
      if (
        group !== 'staged' &&
        group !== 'unstaged' &&
        group !== 'untracked' &&
        group !== 'conflict'
      ) {
        throw new Error('非法 diff 分组')
      }
      return requireGit().diff(
        requireString(projectKey, 'projectKey'),
        requireString(path, 'path'),
        group as GitDiffGroup
      )
    }
  )

  ipcMain.handle(
    IPC.gitFileAction,
    (_event, projectKey: unknown, path: unknown, action: unknown) => {
      if (action !== 'open' && action !== 'reveal') throw new Error('非法文件操作')
      return requireGit().fileAction(
        requireString(projectKey, 'projectKey'),
        requireString(path, 'path'),
        action
      )
    }
  )

  ipcMain.handle(IPC.gitStageFile, (_event, projectKey: unknown, path: unknown) =>
    requireGit().stageFile(
      requireString(projectKey, 'projectKey'),
      requireString(path, 'path')
    )
  )

  ipcMain.handle(IPC.gitUnstageFile, (_event, projectKey: unknown, path: unknown) =>
    requireGit().unstageFile(
      requireString(projectKey, 'projectKey'),
      requireString(path, 'path')
    )
  )

  ipcMain.handle(IPC.gitStageAll, (_event, projectKey: unknown) =>
    requireGit().stageAll(requireString(projectKey, 'projectKey'))
  )

  ipcMain.handle(IPC.gitUnstageAll, (_event, projectKey: unknown) =>
    requireGit().unstageAll(requireString(projectKey, 'projectKey'))
  )

  ipcMain.handle(
    IPC.gitCommit,
    (_event, projectKey: unknown, message: unknown, skipHooks: unknown) => {
      if (typeof message !== 'string') throw new Error('非法提交说明')
      if (typeof skipHooks !== 'boolean') throw new Error('非法钩子参数')
      return requireGit().commit(
        requireString(projectKey, 'projectKey'),
        message,
        skipHooks
      )
    }
  )

  ipcMain.handle(IPC.settingsUpdate, async (_event, patch: unknown) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('非法设置参数')
    }
    const settings = await services.updateSettings(patch as Partial<AppSettings>)
    onSettingsChanged?.(settings)
    return settings
  })
}
