import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  dialog,
  shell,
  type BrowserWindow,
  type OpenDialogOptions
} from 'electron'
import type {
  ActionResult,
  AppSettings,
  BatchDeleteResult,
  HistoryDetail,
  FileContext,
  SearchResponse,
  SessionDetail,
  Snapshot
} from '@shared/types'
import { ConfigStore } from './config'
import {
  CLAUDE_CLI_HINT,
  resolveClaudeLauncher
} from './claudeCli'
import { deletePaths } from './deletePlan'
import { buildMarkdown, safeExportFileName } from './exportMarkdown'
import { removeHistorySessions } from './history'
import { parseSessionDetail } from './parser'
import { buildResumeCommand, buildResumeSpawnArgs } from './resumeCommand'
import { Scanner, type ScanResult } from './scanner'
import { searchHistory, searchSessions } from './search'
import { isPathInside, parseSessionKey, SESSION_ID_RE } from './validation'
import type { FileScope } from './files'

const DETAIL_CACHE_LIMIT = 5

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tryBuildCommand(
  projectPath: string,
  sessionId: string,
  executable = 'claude'
): string | undefined {
  try {
    return buildResumeCommand(projectPath, sessionId, executable)
  } catch {
    return undefined
  }
}

export class AppServices {
  private index: ScanResult | null = null
  private refreshPromise: Promise<ScanResult> | null = null
  private readonly detailCache = new Map<string, SessionDetail>()
  private searchToken = 0

  constructor(
    private readonly dataRoot: string,
    private readonly config: ConfigStore,
    private readonly getWindow: () => BrowserWindow | null
  ) {}

  async initialize(): Promise<void> {
    await this.refresh(true).catch(() => undefined)
  }

  private startScan(force = false): Promise<ScanResult> {
    if (this.refreshPromise) {
      if (!force) return this.refreshPromise
      return this.refreshPromise
        .catch(() => undefined)
        .then(() => this.startScan(false))
    }
    this.refreshPromise = (async () => {
      const settings = await this.config.readSettings()
      return new Scanner(
        this.dataRoot,
        this.config,
        join(this.dataRoot, '..', 'history.jsonl'),
        settings
      ).scan()
    })()
      .then((result) => {
        this.index = result
        return result
      })
      .finally(() => {
        this.refreshPromise = null
      })
    return this.refreshPromise
  }

  private async ensureIndex(): Promise<ScanResult> {
    return this.index ?? this.startScan()
  }

  async refresh(force = false): Promise<Snapshot> {
    const result = await this.startScan(force)
    this.detailCache.clear()
    return result.snapshot
  }

  async getSettings(): Promise<AppSettings> {
    return this.config.readSettings()
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.config.updateSettings(patch)
  }

  async getSnapshot(): Promise<Snapshot> {
    const index = await this.ensureIndex()
    return index.snapshot
  }

  async getFileScope(context: FileContext, active?: FileScope): Promise<FileScope> {
    if (!context || typeof context !== 'object') throw new Error('非法文件上下文')
    if (context.sessionKey) {
      const { summary } = await this.findSession(context.sessionKey)
      if (!summary.projectPath) throw new Error('会话缺少项目目录')
      return { sessionId: summary.id, cwd: summary.projectPath }
    }
    if (!context.sessionId || !SESSION_ID_RE.test(context.sessionId)) throw new Error('非法会话标识')
    if (active?.sessionId === context.sessionId) return active
    const index = await this.ensureIndex()
    const summary = index.snapshot.sessions.find((item) => item.id === context.sessionId)
    if (!summary?.projectPath) throw new Error('会话不存在或尚未启动')
    return { sessionId: summary.id, cwd: summary.projectPath }
  }

  private async findSession(sessionKey: string) {
    const parsed = parseSessionKey(sessionKey)
    if (!parsed) throw new Error('非法会话标识')
    const index = await this.ensureIndex()
    const summary = index.snapshot.sessions.find(
      (session) => session.key === sessionKey
    )
    const filePath = index.sessionFiles[sessionKey]
    if (!summary) throw new Error('会话不存在或已被删除')
    return { summary, filePath, index }
  }

  async getDetail(sessionKey: string): Promise<SessionDetail> {
    const cached = this.detailCache.get(sessionKey)
    if (cached) {
      this.detailCache.delete(sessionKey)
      this.detailCache.set(sessionKey, cached)
      return cached
    }
    const { summary, filePath, index } = await this.findSession(sessionKey)
    if (summary.source !== 'transcript' || !filePath) {
      throw new Error('该会话没有完整对话文件')
    }
    const parsed = await parseSessionDetail(filePath)
    const detail: SessionDetail = {
      key: sessionKey,
      id: summary.id,
      title: summary.title,
      projectPath: summary.projectPath,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      events: parsed.events,
      totalEvents: parsed.events.length,
      skippedLines: parsed.skippedLines
    }
    // A refresh can finish while parsing; don't reinsert an obsolete detail.
    if (this.index !== index) return detail
    this.detailCache.set(sessionKey, detail)
    if (this.detailCache.size > DETAIL_CACHE_LIMIT) {
      const oldest = this.detailCache.keys().next().value
      if (oldest) this.detailCache.delete(oldest)
    }
    return detail
  }

  async getHistoryDetail(sessionKey: string): Promise<HistoryDetail> {
    const parsed = parseSessionKey(sessionKey)
    if (!parsed || parsed.projectKey !== 'history') {
      throw new Error('非法历史会话标识')
    }
    const index = await this.ensureIndex()
    const summary = index.snapshot.sessions.find(
      (session) => session.key === sessionKey
    )
    const prompts = index.historyRecords[sessionKey]
    if (!summary || !prompts) throw new Error('历史会话不存在')
    return {
      key: sessionKey,
      id: summary.id,
      title: summary.title,
      projectPath: summary.projectPath,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      prompts
    }
  }

  async search(query: string): Promise<SearchResponse> {
    const index = await this.ensureIndex()
    const token = ++this.searchToken
    const isCancelled = (): boolean => token !== this.searchToken
    const [transcript, history] = await Promise.all([
      searchSessions({
        query,
        sessions: index.snapshot.sessions,
        sessionFiles: index.sessionFiles,
        isCancelled
      }),
      searchHistory({
        query,
        sessions: index.snapshot.sessions,
        prompts: index.historyRecords,
        isCancelled
      })
    ])
    const hits = [...transcript.hits, ...history.hits]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 100)
    return {
      query,
      hits,
      truncated:
        transcript.truncated ||
        history.truncated ||
        transcript.hits.length + history.hits.length > 100,
      cancelled: transcript.cancelled || history.cancelled
    }
  }

  async setFavorite(sessionKey: string, favorite: boolean): Promise<string[]> {
    const parsed = parseSessionKey(sessionKey)
    if (!parsed) throw new Error('非法会话标识')
    const favorites = await this.config.setFavorite(parsed.sessionId, favorite)
    const index = await this.ensureIndex()
    for (const session of index.snapshot.sessions) {
      if (session.id === parsed.sessionId) {
        session.favorite = favorites.includes(parsed.sessionId)
      }
    }
    return favorites
  }

  async resume(sessionKey: string): Promise<ActionResult> {
    const { summary } = await this.findSession(sessionKey)
    if (summary.source === 'history') {
      return {
        ok: false,
        message: '该会话的完整对话已被 Claude 清理，无法恢复'
      }
    }
    const launcher = resolveClaudeLauncher()
    if (!launcher.resolved) {
      return { ok: false, message: CLAUDE_CLI_HINT }
    }
    const executable = launcher.command
    if (!summary.projectPath || !summary.cwdExists) {
      return {
        ok: false,
        message: '项目目录不存在，无法恢复会话',
        command: summary.projectPath
          ? tryBuildCommand(summary.projectPath, summary.id, executable)
          : undefined
      }
    }
    try {
      const command = tryBuildCommand(summary.projectPath, summary.id, executable)
      if (!command) return { ok: false, message: '无法构造恢复命令' }
      const { file, args } = buildResumeSpawnArgs(summary.id, executable)
      const child = spawn(file, args, {
        cwd: summary.projectPath,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      child.unref()
      return { ok: true, message: '已在新的终端窗口打开会话' }
    } catch (error) {
      return {
        ok: false,
        message: `启动终端失败：${errorMessage(error)}`,
        command: tryBuildCommand(summary.projectPath, summary.id, executable)
      }
    }
  }

  async delete(sessionKey: string): Promise<ActionResult> {
    const { summary, filePath } = await this.findSession(sessionKey)
    if (summary.source === 'history' || !filePath) {
      return { ok: false, message: '仅历史记录没有可删除的对话文件' }
    }
    const sidecarPath = join(dirname(filePath), summary.id)
    const paths = deletePaths(filePath, sidecarPath, existsSync(sidecarPath))
    const deleted: string[] = []
    try {
      for (const target of paths) {
        await shell.trashItem(target)
        deleted.push(target)
      }
      this.detailCache.delete(sessionKey)
      await this.refresh(true)
      return { ok: true, message: '会话已移入回收站' }
    } catch (error) {
      if (deleted.length > 0) await this.refresh(true).catch(() => undefined)
      return {
        ok: false,
        message: `删除失败：${errorMessage(error)}${
          deleted.length > 0 ? '（部分内容已移入回收站）' : ''
        }`
      }
    }
  }

  async deleteSessions(
    sessionKeys: string[],
    beforeDelete?: (sessionIds: string[]) => Promise<void>
  ): Promise<BatchDeleteResult> {
    const keys = [...new Set(sessionKeys)]
    if (keys.length === 0 || keys.length > 1000) throw new Error('请选择 1 到 1000 个会话')
    const targets = await Promise.all(keys.map((key) => this.findSession(key)))
    if (targets.some(({ summary, filePath }) => summary.source !== 'transcript' || !filePath)) {
      throw new Error('只能批量删除完整会话')
    }
    // Validate every key before stopping processes or moving any files.
    await beforeDelete?.(targets.map(({ summary }) => summary.id))
    const deletedKeys: string[] = []
    const failedKeys: string[] = []
    const errors: string[] = []
    for (let index = 0; index < targets.length; index += 1) {
      const { summary, filePath } = targets[index]
      try {
        const sidecar = join(dirname(filePath!), summary.id)
        for (const target of deletePaths(filePath!, sidecar, existsSync(sidecar))) {
          await shell.trashItem(target)
        }
        deletedKeys.push(keys[index])
      } catch (error) {
        failedKeys.push(keys[index])
        errors.push(`${summary.title}：${errorMessage(error)}`)
      }
    }
    await this.config.removeFavorites(targets.filter((_, i) => deletedKeys.includes(keys[i]))
      .map(({ summary }) => summary.id)).catch(() => undefined)
    this.detailCache.clear()
    await this.refresh(true)
    return {
      ok: failedKeys.length === 0, deletedKeys, failedKeys,
      message: failedKeys.length === 0 ? `已将 ${deletedKeys.length} 个会话移入回收站` :
        `已删除 ${deletedKeys.length} 个，${failedKeys.length} 个失败（部分附属数据可能已移入回收站）：${errors[0]}`
    }
  }

  async exportMarkdown(sessionKey: string): Promise<ActionResult> {
    const { summary } = await this.findSession(sessionKey)
    if (summary.source === 'history') {
      return { ok: false, message: '仅历史记录不支持导出完整对话' }
    }
    const detail = await this.getDetail(sessionKey)
    const parent = this.getWindow()
    const options = {
      defaultPath: safeExportFileName(detail.title, detail.id),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) {
      return { ok: false, message: '已取消' }
    }
    try {
      await writeFile(result.filePath, buildMarkdown(detail), 'utf8')
      return { ok: true, message: '导出成功', path: result.filePath }
    } catch (error) {
      return { ok: false, message: `导出失败：${errorMessage(error)}` }
    }
  }

  async deleteHistory(sessionKeys: string[]): Promise<ActionResult> {
    const unique = [...new Set(sessionKeys)]
    if (unique.length === 0) {
      return { ok: false, message: '没有选中的历史会话' }
    }
    const index = await this.ensureIndex()
    const ids: string[] = []

    for (const key of unique) {
      const parsed = parseSessionKey(key)
      if (!parsed || parsed.projectKey !== 'history') {
        return { ok: false, message: '只能删除仅历史记录的会话' }
      }
      const summary = index.snapshot.sessions.find((session) => session.key === key)
      if (!summary) continue
      if (summary.source !== 'history') {
        return { ok: false, message: '只能删除仅历史记录的会话' }
      }
      ids.push(parsed.sessionId)
    }

    if (ids.length === 0) {
      return { ok: false, message: '选中的历史会话已不存在' }
    }

    try {
      const result = await removeHistorySessions(
        join(this.dataRoot, '..', 'history.jsonl'),
        new Set(ids)
      )
      if (result.deletedSessions === 0) {
        return { ok: false, message: '没有找到可删除的历史记录' }
      }
      await this.config.removeFavorites(ids).catch(() => undefined)
      this.detailCache.clear()
      await this.refresh(true)
      return {
        ok: true,
        message: `已删除 ${result.deletedSessions} 个历史会话（${result.deletedPrompts} 条提示）`,
        path: result.backupPath
      }
    } catch (error) {
      return { ok: false, message: `删除历史记录失败：${errorMessage(error)}` }
    }
  }

  async openProjectFolder(projectKey: string): Promise<ActionResult> {
    const index = await this.ensureIndex()
    const project = index.snapshot.projects.find((item) => item.key === projectKey)
    const target = index.projectPaths[projectKey] || project?.path || ''
    if (!target) return { ok: false, message: '项目路径未知' }
    const error = await shell.openPath(target)
    return error ? { ok: false, message: error } : { ok: true }
  }

  async openProjectTerminal(projectKey: string): Promise<ActionResult> {
    const index = await this.ensureIndex()
    const project = index.snapshot.projects.find((item) => item.key === projectKey)
    const target = index.projectPaths[projectKey] || project?.path || ''
    if (!target) return { ok: false, message: '项目路径未知' }
    const folder = resolve(target)
    try {
      if (!existsSync(folder) || !statSync(folder).isDirectory()) {
        return { ok: false, message: '项目文件夹不存在' }
      }
    } catch (error) {
      return { ok: false, message: `无法访问项目文件夹：${errorMessage(error)}` }
    }
    try {
      if (process.platform === 'win32') {
        const comspec = process.env.ComSpec || 'cmd.exe'
        const child = spawn(
          comspec,
          ['/c', 'start', '', 'cmd.exe', '/k', `cd /d "${folder}"`],
          {
            cwd: folder,
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          }
        )
        child.unref()
        return { ok: true, message: '已在终端中打开项目' }
      }
      if (process.platform === 'darwin') {
        const child = spawn('open', ['-a', 'Terminal', folder], {
          detached: true,
          stdio: 'ignore'
        })
        child.unref()
        return { ok: true, message: '已在终端中打开项目' }
      }
      return { ok: false, message: '当前平台暂不支持从应用打开终端' }
    } catch (error) {
      return { ok: false, message: `打开终端失败：${errorMessage(error)}` }
    }
  }

  async deleteProjectSessions(projectKey: string, beforeDelete?: (ids: string[]) => Promise<void>): Promise<ActionResult> {
    const index = await this.ensureIndex()
    const project = index.snapshot.projects.find((item) => item.key === projectKey)
    if (!project) return { ok: false, message: '项目不存在' }
    const sessions = index.snapshot.sessions.filter(
      (session) =>
        session.projectKey === projectKey && session.source === 'transcript'
    )
    if (sessions.length === 0) {
      return { ok: false, message: '该项目下没有可删除的完整会话' }
    }

    await beforeDelete?.(sessions.map((session) => session.id))
    const deletedIds: string[] = []
    let deleted = 0
    try {
      for (const session of sessions) {
        const filePath = index.sessionFiles[session.key]
        if (!filePath) continue
        const sidecarPath = join(dirname(filePath), session.id)
        const paths = deletePaths(
          filePath,
          sidecarPath,
          existsSync(sidecarPath)
        )
        for (const target of paths) {
          await shell.trashItem(target)
        }
        deletedIds.push(session.id)
        deleted += 1
      }
    } catch (error) {
      await this.config.removeFavorites(deletedIds).catch(() => undefined)
      this.detailCache.clear()
      await this.refresh(true).catch(() => undefined)
      return {
        ok: false,
        message: `删除项目会话失败：${errorMessage(error)}${
          deleted > 0 ? `（已删除 ${deleted} 个）` : ''
        }`
      }
    }

    await this.config.removeFavorites(deletedIds).catch(() => undefined)
    this.detailCache.clear()
    await this.refresh(true)
    return {
      ok: true,
      message: `已删除 ${deleted} 个会话；项目文件夹和历史记录保留`
    }
  }

  async openExternalPath(target: string): Promise<ActionResult> {
    if (!isPathInside(this.dataRoot, target)) {
      return { ok: false, message: '不允许打开数据目录之外的文件' }
    }
    const error = await shell.openPath(target)
    return error ? { ok: false, message: error } : { ok: true }
  }

  async openFolder(target: string): Promise<ActionResult> {
    if (!target) return { ok: false, message: '未指定文件夹' }
    const folder = resolve(target)
    try {
      if (!existsSync(folder) || !statSync(folder).isDirectory()) {
        return { ok: false, message: '项目文件夹不存在' }
      }
    } catch (error) {
      return { ok: false, message: `无法访问项目文件夹：${errorMessage(error)}` }
    }
    const claudeDir = resolve(this.dataRoot, '..')
    if (folder === claudeDir || isPathInside(claudeDir, folder)) {
      return { ok: false, message: '不能打开 Claude 配置目录' }
    }
    const error = await shell.openPath(folder)
    return error ? { ok: false, message: error } : { ok: true }
  }

  async pickFolder(): Promise<ActionResult> {
    const parent = this.getWindow()
    const options: OpenDialogOptions = {
      title: '选择项目文件夹',
      properties: ['openDirectory']
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, message: '已取消' }
    }
    const selected = resolve(result.filePaths[0])
    try {
      if (!existsSync(selected) || !statSync(selected).isDirectory()) {
        return { ok: false, message: '请选择有效的文件夹' }
      }
    } catch (error) {
      return { ok: false, message: `无法访问该文件夹：${errorMessage(error)}` }
    }
    const claudeDir = resolve(this.dataRoot, '..')
    if (selected === claudeDir || isPathInside(claudeDir, selected)) {
      return { ok: false, message: '不能选择 Claude 配置目录作为项目' }
    }
    return { ok: true, path: selected }
  }

  projectName(projectPath: string): string {
    return projectPath ? basename(projectPath) : ''
  }
}
