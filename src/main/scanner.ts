import { createHash } from 'node:crypto'
import { existsSync, type Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  AppSettings,
  HistoryPrompt,
  ProjectSummary,
  SessionSummary,
  Snapshot
} from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/types'
import { ConfigStore } from './config'
import { parseHistoryFile, type HistoryParseResult } from './history'
import { parseSessionMeta, type SessionMeta } from './parser'

export interface ScanResult {
  snapshot: Snapshot
  sessionFiles: Record<string, string>
  projectPaths: Record<string, string>
  historyRecords: Record<string, HistoryPrompt[]>
}

let historyCache: {
  path: string
  mtimeMs: number
  size: number
  result: HistoryParseResult
} | null = null

function normalizeProjectPath(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase()
}

export class Scanner {
  constructor(
    private readonly root: string,
    private readonly configStore: ConfigStore,
    private readonly historyFile: string = join(root, '..', 'history.jsonl'),
    private readonly settings: AppSettings = DEFAULT_APP_SETTINGS
  ) {}

  async scan(): Promise<ScanResult> {
    const [cache, favorites] = await Promise.all([
      this.configStore.readCache(), this.configStore.readFavorites()
    ])
    const favoriteIds = new Set(favorites)
    const projects: ProjectSummary[] = []
    const sessions: SessionSummary[] = []
    const sessionFiles: Record<string, string> = {}
    const projectPaths: Record<string, string> = {}
    const historyRecords: Record<string, HistoryPrompt[]> = {}
    const projectByPath = new Map<string, ProjectSummary>()
    let skippedFiles = 0
    let dataRootExists = true
    let cacheChanged = false
    const cwdChecks = new Map<string, Promise<boolean>>()
    const cwdExists = (cwd: string): Promise<boolean> => {
      if (!cwd) return Promise.resolve(false)
      let check = cwdChecks.get(cwd)
      if (!check) {
        check = stat(cwd).then((info) => info.isDirectory(), () => false)
        cwdChecks.set(cwd, check)
      }
      return check
    }

    let projectDirs: Dirent[] = []
    try {
      projectDirs = (await readdir(this.root, { withFileTypes: true })).filter(
        (entry) => entry.isDirectory()
      )
    } catch {
      dataRootExists = false
    }

    if (dataRootExists) {
      for (const projectDirEntry of projectDirs) {
        const projectKey = projectDirEntry.name
        const projectDir = join(this.root, projectKey)
        let fileNames: string[] = []
        const sidecars = new Set<string>()
        try {
          const entries = await readdir(projectDir, { withFileTypes: true })
          fileNames = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
            .map((entry) => entry.name)
          for (const entry of entries) {
            if (entry.isDirectory()) sidecars.add(entry.name)
          }
        } catch {
          skippedFiles += 1
          continue
        }

        const sessionsHere: SessionSummary[] = []
        let projectPath = ''
        let lastActivity = 0

        // Bound disk concurrency so large archives don't open every file at once.
        for (let offset = 0; offset < fileNames.length; offset += 8) {
          const batch = await Promise.all(fileNames.slice(offset, offset + 8).map(async (fileName) => {
            const filePath = join(projectDir, fileName)
            try {
              const fileStat = await stat(filePath)
              const cached = cache.sessions[filePath]
              let meta: SessionMeta

              if (
                cached &&
                cached.mtimeMs === fileStat.mtimeMs &&
                cached.size === fileStat.size
              ) {
                meta = cached.meta
              } else {
                meta = await parseSessionMeta(filePath, fileStat)
                cache.sessions[filePath] = {
                  mtimeMs: fileStat.mtimeMs,
                  size: fileStat.size,
                  meta
                }
                cacheChanged = true
              }

              const cwd = meta.cwd ?? ''
              const key = `${projectKey}/${meta.sessionId}`
              sessionFiles[key] = filePath

              const summary: SessionSummary = {
                key,
                id: meta.sessionId,
                projectKey,
                projectPath: cwd,
                title: meta.title,
                titleSource: meta.titleSource,
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt,
                messageCount: meta.messageCount,
                sizeBytes: fileStat.size,
                favorite: favoriteIds.has(meta.sessionId),
                cwdExists: await cwdExists(cwd),
                hasSidecar: sidecars.has(meta.sessionId),
                source: 'transcript',
                promptCount: 0
              }
              return summary
            } catch {
              skippedFiles += 1
              return null
            }
          }))
          for (const summary of batch) {
            if (!summary) continue
            if (!projectPath && summary.projectPath) projectPath = summary.projectPath
            sessionsHere.push(summary)
            sessions.push(summary)
            lastActivity = Math.max(lastActivity, summary.updatedAt)
          }
        }

        projectPaths[projectKey] = projectPath
        const displayName = projectPath ? basename(projectPath) || projectKey : projectKey
        const project: ProjectSummary = {
          key: projectKey,
          name: displayName,
          path: projectPath,
          sessionCount: sessionsHere.length,
          transcriptCount: sessionsHere.length,
          historyCount: 0,
          lastActivity
        }
        projects.push(project)
        if (projectPath) projectByPath.set(normalizeProjectPath(projectPath), project)
      }
    }

    const historyFileExists = existsSync(this.historyFile)
    const transcriptIds = new Set(
      sessions.filter((session) => session.source === 'transcript').map((session) => session.id)
    )

    if (!this.settings.loadHistory) {
      historyCache = null
    } else if (historyFileExists) {
      try {
        const historyStat = await stat(this.historyFile)
        let history: HistoryParseResult
        if (
          historyCache &&
          historyCache.path === this.historyFile &&
          historyCache.mtimeMs === historyStat.mtimeMs &&
          historyCache.size === historyStat.size
        ) {
          history = historyCache.result
        } else {
          history = await parseHistoryFile(this.historyFile)
          historyCache = {
            path: this.historyFile,
            mtimeMs: historyStat.mtimeMs,
            size: historyStat.size,
            result: history
          }
        }
        for (const historySession of history.sessions) {
          if (transcriptIds.has(historySession.sessionId)) continue

          let project = historySession.projectPath
            ? projectByPath.get(normalizeProjectPath(historySession.projectPath))
            : undefined
          if (!project) {
            const projectPath = historySession.projectPath
            const normalized = projectPath ? normalizeProjectPath(projectPath) : 'unknown'
            const projectKey = projectPath
              ? `history:${createHash('sha1').update(normalized).digest('hex').slice(0, 12)}`
              : 'history:unknown'
            project = {
              key: projectKey,
              name: projectPath ? basename(projectPath) || projectPath : '未知项目',
              path: projectPath,
              sessionCount: 0,
              transcriptCount: 0,
              historyCount: 0,
              lastActivity: 0
            }
            projects.push(project)
            projectByPath.set(normalized, project)
            projectPaths[project.key] = projectPath
          }

          const key = `history/${historySession.sessionId}`
          const summary: SessionSummary = {
            key,
            id: historySession.sessionId,
            projectKey: project.key,
            projectPath: historySession.projectPath,
            title: historySession.title,
            titleSource: 'first-prompt',
            createdAt: historySession.createdAt,
            updatedAt: historySession.updatedAt,
            messageCount: historySession.prompts.length,
            sizeBytes: 0,
            favorite: favoriteIds.has(historySession.sessionId),
            cwdExists: await cwdExists(historySession.projectPath),
            hasSidecar: false,
            source: 'history',
            promptCount: historySession.prompts.length
          }
          sessions.push(summary)
          historyRecords[key] = historySession.prompts
          project.historyCount += 1
          project.lastActivity = Math.max(project.lastActivity, summary.updatedAt)
        }
      } catch {
        skippedFiles += 1
      }
    }

    for (const project of projects) {
      project.sessionCount = project.transcriptCount + project.historyCount
    }

    const seenFiles = new Set(Object.values(sessionFiles))
    for (const cachedPath of Object.keys(cache.sessions)) {
      if (!seenFiles.has(cachedPath)) {
        delete cache.sessions[cachedPath]
        cacheChanged = true
      }
    }
    if (cacheChanged) await this.configStore.writeCache(cache)

    const visibleProjects = projects.filter((project) => project.sessionCount > 0)
    visibleProjects.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)

    const transcriptCount = sessions.filter(
      (session) => session.source === 'transcript'
    ).length
    const historyOnlyCount = sessions.filter(
      (session) => session.source === 'history'
    ).length

    return {
      snapshot: {
        projects: visibleProjects,
        sessions,
        scannedAt: Date.now(),
        skippedFiles,
        dataRoot: this.root,
        dataRootExists,
        historyFileExists,
        transcriptCount,
        historyOnlyCount,
        settings: this.settings
      },
      sessionFiles,
      projectPaths,
      historyRecords
    }
  }
}
