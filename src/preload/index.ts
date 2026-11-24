import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ClaudeViewApi, TerminalActivityEvent } from '@shared/types'
import { IPC } from '@shared/ipc'

const api: ClaudeViewApi = {
  pickAttachments: (context) => ipcRenderer.invoke(IPC.attachmentsPick, context),
  attachDroppedFiles: (context, files) => ipcRenderer.invoke(IPC.attachmentsAdd, context,
    files.map((file) => webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]))),
  pasteClipboard: (context) => ipcRenderer.invoke(IPC.attachmentsPaste, context),
  listAttachments: (context) => ipcRenderer.invoke(IPC.attachmentsList, context),
  removeAttachments: (context, ids) => ipcRenderer.invoke(IPC.attachmentsRemove, context, ids),
  fileAction: (context, reference, action) => ipcRenderer.invoke(IPC.fileAction, context, reference, action),
  checkFileReferences: (context, references) => ipcRenderer.invoke(IPC.fileReferencesCheck, context, references),
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshotGet),
  refresh: () => ipcRenderer.invoke(IPC.snapshotRefresh),
  getSessionDetail: (sessionKey) =>
    ipcRenderer.invoke(IPC.sessionDetail, sessionKey),
  getSessionUsage: (sessionKey) =>
    ipcRenderer.invoke(IPC.sessionUsage, sessionKey),
  getHistoryDetail: (sessionKey) =>
    ipcRenderer.invoke(IPC.sessionHistoryDetail, sessionKey),
  search: (query, requestId) =>
    ipcRenderer.invoke(IPC.sessionSearch, query, requestId),
  setFavorite: (sessionKey, favorite) =>
    ipcRenderer.invoke(IPC.sessionFavorite, sessionKey, favorite),
  resumeSession: (sessionKey) => ipcRenderer.invoke(IPC.sessionResume, sessionKey),
  deleteSession: (sessionKey) => ipcRenderer.invoke(IPC.sessionDelete, sessionKey),
  deleteSessions: (sessionKeys) => ipcRenderer.invoke(IPC.sessionsDelete, sessionKeys),
  deleteHistorySessions: (sessionKeys) =>
    ipcRenderer.invoke(IPC.historyDelete, sessionKeys),
  exportSession: (sessionKey) => ipcRenderer.invoke(IPC.sessionExport, sessionKey),
  openProjectFolder: (projectKey) =>
    ipcRenderer.invoke(IPC.projectOpen, projectKey),
  openProjectTerminal: (projectKey) =>
    ipcRenderer.invoke(IPC.projectTerminalOpen, projectKey),
  deleteProjectSessions: (projectKey) =>
    ipcRenderer.invoke(IPC.projectSessionsDelete, projectKey),
  openExternalPath: (path) => ipcRenderer.invoke(IPC.pathOpen, path),
  openFolder: (path) => ipcRenderer.invoke(IPC.folderOpen, path),
  pickFolder: () => ipcRenderer.invoke(IPC.folderPick),
  startTerminal: (options) => ipcRenderer.invoke(IPC.terminalStart, options),
  writeTerminal: (ptyId, data) =>
    ipcRenderer.invoke(IPC.terminalWrite, ptyId, data),
  resizeTerminal: (ptyId, cols, rows) =>
    ipcRenderer.invoke(IPC.terminalResize, ptyId, cols, rows),
  stopTerminal: (ptyId) => ipcRenderer.invoke(IPC.terminalStop, ptyId),
  updateAttention: (summary) => ipcRenderer.invoke(IPC.attentionUpdate, summary),
  listInbox: () => ipcRenderer.invoke(IPC.inboxList),
  dismissInboxItem: (id) => ipcRenderer.invoke(IPC.inboxDismiss, id),
  listApprovals: () => ipcRenderer.invoke(IPC.approvalsList),
  resolveApproval: (id, decision) =>
    ipcRenderer.invoke(IPC.approvalsResolve, id, decision),
  onApprovalsChanged: (callback) => {
    const listener = (_event: unknown, requests: Parameters<typeof callback>[0]): void => {
      callback(requests)
    }
    ipcRenderer.on(IPC.approvalsChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.approvalsChanged, listener)
    }
  },
  onApprovalsOpen: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.approvalsOpen, listener)
    return () => {
      ipcRenderer.removeListener(IPC.approvalsOpen, listener)
    }
  },
  listScheduledTasks: () => ipcRenderer.invoke(IPC.schedulesList),
  createScheduledTask: (input) => ipcRenderer.invoke(IPC.schedulesCreate, input),
  updateScheduledTask: (id, input) => ipcRenderer.invoke(IPC.schedulesUpdate, id, input),
  deleteScheduledTask: (id) => ipcRenderer.invoke(IPC.schedulesDelete, id),
  setScheduledTaskEnabled: (id, enabled) => ipcRenderer.invoke(IPC.schedulesEnable, id, enabled),
  runScheduledTask: (id) => ipcRenderer.invoke(IPC.schedulesRun, id),
  cancelScheduledTask: (id) => ipcRenderer.invoke(IPC.schedulesCancel, id),
  pauseScheduledTask: (id, until, reason) =>
    ipcRenderer.invoke(IPC.schedulesPause, id, until, reason),
  resumeScheduledTask: (id) => ipcRenderer.invoke(IPC.schedulesResume, id),
  replayScheduledTask: (id) => ipcRenderer.invoke(IPC.schedulesReplay, id),
  answerScheduledAsk: (id, answer) =>
    ipcRenderer.invoke(IPC.schedulesAnswerAsk, id, answer),
  ignoreScheduledAsk: (id) => ipcRenderer.invoke(IPC.schedulesIgnoreAsk, id),
  getUsageSummary: () => ipcRenderer.invoke(IPC.usageSummary),
  getLocalApiInfo: () => ipcRenderer.invoke(IPC.localApiInfo),
  listScheduledTaskRuns: (id) => ipcRenderer.invoke(IPC.schedulesRuns, id),
  readScheduledTaskLog: (id, runId) => ipcRenderer.invoke(IPC.schedulesLog, id, runId),
  onSchedulesChanged: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.schedulesChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.schedulesChanged, listener)
    }
  },
  getGitStatus: (projectKey, force) =>
    ipcRenderer.invoke(IPC.gitStatus, projectKey, force),
  getGitStatuses: (projectKeys) =>
    ipcRenderer.invoke(IPC.gitStatusBatch, projectKeys),
  getGitDiff: (projectKey, path, group) =>
    ipcRenderer.invoke(IPC.gitDiff, projectKey, path, group),
  gitFileAction: (projectKey, path, action) =>
    ipcRenderer.invoke(IPC.gitFileAction, projectKey, path, action),
  stageGitFile: (projectKey, path) =>
    ipcRenderer.invoke(IPC.gitStageFile, projectKey, path),
  unstageGitFile: (projectKey, path) =>
    ipcRenderer.invoke(IPC.gitUnstageFile, projectKey, path),
  stageAllGit: (projectKey) => ipcRenderer.invoke(IPC.gitStageAll, projectKey),
  unstageAllGit: (projectKey) => ipcRenderer.invoke(IPC.gitUnstageAll, projectKey),
  commitGit: (projectKey, message, skipHooks) =>
    ipcRenderer.invoke(IPC.gitCommit, projectKey, message, skipHooks),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  setSessionRefreshInterest: (interest) =>
    ipcRenderer.invoke(IPC.sessionRefreshInterest, interest),
  readClaudeMd: (scope, projectKey, placement) =>
    ipcRenderer.invoke(IPC.claudeMdRead, scope, projectKey, placement),
  getClaudeMdLocations: (scope, projectKey) =>
    ipcRenderer.invoke(IPC.claudeMdLocations, scope, projectKey),
  writeClaudeMd: (input) => ipcRenderer.invoke(IPC.claudeMdWrite, input),
  listClaudeMdTemplates: () => ipcRenderer.invoke(IPC.claudeMdTemplatesList),
  saveClaudeMdTemplate: (input) =>
    ipcRenderer.invoke(IPC.claudeMdTemplateSave, input),
  deleteClaudeMdTemplate: (id) =>
    ipcRenderer.invoke(IPC.claudeMdTemplateDelete, id),
  importClaudeMdTemplate: (scope) =>
    ipcRenderer.invoke(IPC.claudeMdTemplateImport, scope),
  onTerminalData: (callback) => {
    const listener = (_event: unknown, payload: { ptyId: string; data: string }): void => {
      callback(payload)
    }
    ipcRenderer.on(IPC.terminalData, listener)
    return () => {
      ipcRenderer.removeListener(IPC.terminalData, listener)
    }
  },
  onTerminalExit: (callback) => {
    const listener = (
      _event: unknown,
      payload: { ptyId: string; exitCode: number; signal?: number }
    ): void => {
      callback(payload)
    }
    ipcRenderer.on(IPC.terminalExit, listener)
    return () => {
      ipcRenderer.removeListener(IPC.terminalExit, listener)
    }
  },
  onTerminalActivity: (callback) => {
    const listener = (
      _event: unknown,
      payload: TerminalActivityEvent
    ): void => {
      callback(payload)
    }
    ipcRenderer.on(IPC.terminalActivity, listener)
    return () => {
      ipcRenderer.removeListener(IPC.terminalActivity, listener)
    }
  },
  onFocusSession: (callback) => {
    const listener = (_event: unknown, sessionId: string): void => {
      callback(sessionId)
    }
    ipcRenderer.on(IPC.focusSession, listener)
    return () => {
      ipcRenderer.removeListener(IPC.focusSession, listener)
    }
  },
  captureScreenshot: (context) => ipcRenderer.invoke(IPC.screenshotCapture, context),
  onScreenshotTrigger: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.screenshotTrigger, listener)
    return () => {
      ipcRenderer.removeListener(IPC.screenshotTrigger, listener)
    }
  },
  onDataChanged: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.dataChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.dataChanged, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
