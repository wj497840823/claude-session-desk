import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { shell } from 'electron'
import type {
  ActionResult,
  GitCommitResult,
  GitDiff,
  GitDiffGroup,
  GitFileEntry,
  GitStatus
} from '@shared/types'
import { buildGitStatus } from './gitGroup'
import { parseNumstatZ, parsePorcelainV2 } from './gitPorcelain'
import { isPathInside } from './validation'

const MAX_STATUS_BUFFER = 8 * 1024 * 1024
const MAX_DIFF_BUFFER = 2 * 1024 * 1024
const MAX_DIFF_LINES = 4000
const STATUS_TTL = 5000
const NEGATIVE_TTL = 60000
const REPO_ROOT_TTL = 60000

export type GitErrorCode = 'not-a-repo' | 'git-missing' | 'timeout' | 'failed'

export class GitError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface GitServiceOptions {
  resolveProjectPath: (projectKey: string) => Promise<string | null>
}

interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function toDisplayPath(prefix: string, rawPath: string): string {
  return prefix ? normalizePath(posix.relative(prefix, rawPath)) : normalizePath(rawPath)
}

function toRepoPath(prefix: string, path: string): string {
  const combined = prefix ? `${prefix}/${path}` : path
  return posix.normalize(combined)
}

function pathsForEntry(entry: GitFileEntry, prefix: string): string[] {
  const paths = entry.origPath ? [entry.path, entry.origPath] : [entry.path]
  return paths.map((path) => toRepoPath(prefix, path))
}

function validPaths(repoRoot: string, paths: string[]): boolean {
  return paths.every(
    (path) =>
      Boolean(path) &&
      !path.includes('\0') &&
      isPathInside(repoRoot, resolve(repoRoot, path))
  )
}

export class GitService {
  private readonly repoInfos = new Map<
    string,
    { root: string | null; prefix: string; at: number }
  >()
  private readonly cache = new Map<
    string,
    { status: GitStatus; at: number; negative: boolean }
  >()
  private readonly whitelist = new Map<string, Map<string, GitFileEntry>>()
  private readonly inflight = new Map<string, Promise<GitStatus>>()
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly options: GitServiceOptions) {}

  async status(projectKey: string, force = false): Promise<GitStatus> {
    const cached = this.cache.get(projectKey)
    if (!force && cached) {
      const ttl = cached.negative ? NEGATIVE_TTL : STATUS_TTL
      if (Date.now() - cached.at < ttl) return cached.status
    }

    const existing = this.inflight.get(projectKey)
    if (existing) {
      if (!force) return existing
      await existing.catch(() => undefined)
      const next = this.inflight.get(projectKey)
      if (next) return next
    }

    const promise = this.loadStatus(projectKey).then((status) => {
      const negative =
        !status.isRepo &&
        (status.error?.code === 'not-a-repo' ||
          status.error?.code === 'git-missing')
      this.cache.set(projectKey, { status, at: Date.now(), negative })
      const paths = new Map<string, GitFileEntry>()
      for (const file of status.files) {
        paths.set(file.path, file)
        if (file.origPath) paths.set(file.origPath, file)
      }
      this.whitelist.set(projectKey, paths)
      return status
    })

    this.inflight.set(projectKey, promise)
    void promise
      .finally(() => {
        if (this.inflight.get(projectKey) === promise) {
          this.inflight.delete(projectKey)
        }
      })
      .catch(() => undefined)
    return promise
  }

  async statusBatch(projectKeys: string[]): Promise<GitStatus[]> {
    const keys = [...new Set(projectKeys)].slice(0, 50)
    const results: GitStatus[] = []
    let cursor = 0
    const workers = Array.from(
      { length: Math.min(4, keys.length) },
      async () => {
        while (cursor < keys.length) {
          const key = keys[cursor]
          cursor += 1
          results.push(await this.status(key))
        }
      }
    )
    await Promise.all(workers)
    return results
  }

  async diff(
    projectKey: string,
    path: string,
    group: GitDiffGroup
  ): Promise<GitDiff> {
    const status =
      this.cache.get(projectKey)?.status ?? (await this.status(projectKey, true))
    const entry = status.files.find((file) => file.path === path)
    if (!entry) throw new Error('文件不在当前变更列表中')

    const scope = await this.projectScope(projectKey)
    if (!scope) throw new Error('项目不是 Git 仓库')
    const repoPath = toRepoPath(scope.prefix, path)
    if (!validPaths(scope.repoRoot, [repoPath])) throw new Error('非法文件路径')
    const absolute = resolve(scope.repoRoot, repoPath)

    let args: string[]
    let allowFailure = false
    if (group === 'untracked') {
      const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
      args = [
        '-C', scope.repoRoot,
        '-c', 'core.fsmonitor=false',
        'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '-U3',
        '--', nullDevice, absolute
      ]
      allowFailure = true
    } else if (group === 'staged') {
      args = [
        '-C', scope.repoRoot,
        '-c', 'core.fsmonitor=false',
        'diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '-U3',
        '--', repoPath
      ]
    } else {
      args = [
        '-C', scope.repoRoot,
        '-c', 'core.fsmonitor=false',
        'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3',
        '--', repoPath
      ]
    }

    const result = await this.exec(args, 10000, MAX_DIFF_BUFFER * 2)
    if (result.code !== 0 && !(allowFailure && result.code === 1)) {
      throw new Error(result.stderr.trim() || '读取 diff 失败')
    }

    const raw = result.stdout
    const truncated =
      raw.length > MAX_DIFF_BUFFER || raw.split('\n').length > MAX_DIFF_LINES
    const diff = truncated ? raw.slice(0, MAX_DIFF_BUFFER) : raw
    let additions = 0
    let deletions = 0
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
      else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
    }

    return {
      path,
      diff,
      binary: /Binary files .* differ|GIT binary patch/.test(diff),
      truncated,
      additions,
      deletions
    }
  }

  async fileAction(
    projectKey: string,
    path: string,
    action: 'open' | 'reveal'
  ): Promise<ActionResult> {
    const scope = await this.projectScope(projectKey)
    if (!scope) return { ok: false, message: '项目不是 Git 仓库' }
    const entry = this.whitelist.get(projectKey)?.get(path)
    if (!entry) return { ok: false, message: '文件不在当前变更列表中' }
    const repoPath = toRepoPath(scope.prefix, path)
    if (!validPaths(scope.repoRoot, [repoPath])) {
      return { ok: false, message: '非法文件路径' }
    }
    const absolute = resolve(scope.repoRoot, repoPath)
    if (action === 'open' && !existsSync(absolute)) {
      return { ok: false, message: '文件已不存在' }
    }
    if (action === 'reveal') {
      shell.showItemInFolder(absolute)
      return { ok: true }
    }
    const error = await shell.openPath(absolute)
    return error ? { ok: false, message: error } : { ok: true }
  }

  async stageFile(projectKey: string, path: string): Promise<ActionResult> {
    const entry = this.whitelist.get(projectKey)?.get(path)
    return this.runLocked(projectKey, async () => {
      if (!entry) return { ok: false, message: '文件不在当前变更列表中' }
      const scope = await this.projectScope(projectKey)
      if (!scope) return { ok: false, message: '项目不是 Git 仓库' }
      const paths = pathsForEntry(entry, scope.prefix)
      if (!validPaths(scope.repoRoot, paths)) {
        return { ok: false, message: '非法文件路径' }
      }

      const result = await this.exec(
        ['--literal-pathspecs', '-C', scope.repoRoot, 'add', '-A', '--', ...paths],
        15000,
        1024 * 1024
      )
      if (result.code !== 0) {
        return { ok: false, message: result.stderr.trim() || '暂存失败' }
      }
      this.invalidate(projectKey)
      return { ok: true }
    })
  }

  async unstageFile(projectKey: string, path: string): Promise<ActionResult> {
    const entry = this.whitelist.get(projectKey)?.get(path)
    return this.runLocked(projectKey, async () => {
      if (!entry || entry.indexKind === null) {
        return { ok: false, message: '该文件没有暂存变更' }
      }
      const scope = await this.projectScope(projectKey)
      if (!scope) return { ok: false, message: '项目不是 Git 仓库' }
      const paths = pathsForEntry(entry, scope.prefix)
      if (!validPaths(scope.repoRoot, paths)) {
        return { ok: false, message: '非法文件路径' }
      }

      const result = await this.exec(
        ['--literal-pathspecs', '-C', scope.repoRoot, 'reset', '-q', 'HEAD', '--', ...paths],
        15000,
        1024 * 1024
      )
      if (result.code !== 0) {
        return { ok: false, message: result.stderr.trim() || '取消暂存失败' }
      }
      this.invalidate(projectKey)
      return { ok: true }
    })
  }

  async stageAll(projectKey: string): Promise<ActionResult> {
    return this.runLocked(projectKey, async () => {
      const status = await this.status(projectKey, true)
      if (!status.isRepo) {
        return { ok: false, message: status.error?.message ?? '项目不是 Git 仓库' }
      }
      const scope = await this.projectScope(projectKey)
      if (!scope) return { ok: false, message: '项目不是 Git 仓库' }

      const paths = status.files
        .filter(
          (file) => !file.conflict && (file.untracked || file.worktreeKind !== null)
        )
        .map((file) => toRepoPath(scope.prefix, file.path))
      if (paths.length === 0) return { ok: true, message: '没有可暂存的文件' }
      if (!validPaths(scope.repoRoot, paths)) {
        return { ok: false, message: '非法文件路径' }
      }

      for (let index = 0; index < paths.length; index += 100) {
        const chunk = paths.slice(index, index + 100)
        const result = await this.exec(
          ['--literal-pathspecs', '-C', scope.repoRoot, 'add', '-A', '--', ...chunk],
          15000,
          1024 * 1024
        )
        if (result.code !== 0) {
          return { ok: false, message: result.stderr.trim() || '暂存失败' }
        }
      }
      this.invalidate(projectKey)
      return { ok: true }
    })
  }

  async unstageAll(projectKey: string): Promise<ActionResult> {
    return this.runLocked(projectKey, async () => {
      const scope = await this.projectScope(projectKey)
      if (!scope) return { ok: false, message: '项目不是 Git 仓库' }
      const result = await this.exec(
        ['--literal-pathspecs', '-C', scope.repoRoot, 'reset', '-q', 'HEAD', '--', scope.prefix || '.'],
        15000,
        1024 * 1024
      )
      if (result.code !== 0) {
        return { ok: false, message: result.stderr.trim() || '取消暂存失败' }
      }
      this.invalidate(projectKey)
      return { ok: true }
    })
  }

  async commit(
    projectKey: string,
    message: string,
    skipHooks: boolean
  ): Promise<GitCommitResult> {
    const text = message.trim()
    if (!text) return { ok: false, message: '请填写提交说明' }
    if (text.length > 8000) return { ok: false, message: '提交说明过长' }
    if (text.includes('\0')) return { ok: false, message: '提交说明包含非法字符' }

    return this.runLocked(projectKey, async () => {
      const scope = await this.projectScope(projectKey)
      if (!scope) return { ok: false, message: '项目不是 Git 仓库' }
      const status = await this.status(projectKey, true)
      if (!status.isRepo) {
        return { ok: false, message: status.error?.message ?? '项目不是 Git 仓库' }
      }
      if (status.counts.unmerged > 0) {
        return { ok: false, message: '存在未解决的冲突，无法提交' }
      }
      if (status.counts.staged === 0) {
        return { ok: false, message: '没有已暂存的变更' }
      }

      const args = [
        '--literal-pathspecs', '-C', scope.repoRoot,
        '-c', 'core.fsmonitor=false',
        'commit', '-m', text
      ]
      if (skipHooks) args.push('--no-verify')

      const result = await this.exec(args, 120000, 4 * 1024 * 1024)
      if (result.code !== 0) {
        return {
          ok: false,
          message: result.stderr.trim() || result.stdout.trim() || '提交失败'
        }
      }

      this.invalidate(projectKey)
      const hash = await this.exec(
        ['-C', scope.repoRoot, 'rev-parse', '--short', 'HEAD'],
        3000,
        1024 * 1024
      )
      return { ok: true, commit: hash.code === 0 ? hash.stdout.trim() : undefined }
    })
  }

  private invalidate(projectKey: string): void {
    this.cache.delete(projectKey)
    this.whitelist.delete(projectKey)
  }

  private runLocked<T>(
    projectKey: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const previous = this.locks.get(projectKey) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(fn)
    this.locks.set(projectKey, run)
    void run
      .finally(() => {
        if (this.locks.get(projectKey) === run) this.locks.delete(projectKey)
      })
      .catch(() => undefined)
    return run
  }

  private async loadStatus(projectKey: string): Promise<GitStatus> {
    try {
      const projectPath = await this.options.resolveProjectPath(projectKey)
      if (!projectPath) {
        return this.errorStatus(projectKey, 'failed', '项目路径未知')
      }
      if (!existsSync(projectPath)) {
        return this.errorStatus(projectKey, 'failed', '项目文件夹不存在')
      }

      const repoInfo = await this.resolveRepoInfo(projectPath)
      if (!repoInfo) {
        return this.errorStatus(projectKey, 'not-a-repo', '该项目不是 Git 仓库')
      }

      const repoRoot = repoInfo.root
      const prefix = repoInfo.prefix
      const pathspec = prefix || '.'
      const statusResult = await this.exec(
        [
          '-C', repoRoot,
          '-c', 'core.fsmonitor=false',
          'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all',
          '--', pathspec
        ],
        6000,
        MAX_STATUS_BUFFER
      )
      if (statusResult.code !== 0) {
        return this.errorStatus(
          projectKey,
          'failed',
          statusResult.stderr.trim() || '读取 Git 状态失败'
        )
      }

      const parsed = parsePorcelainV2(statusResult.stdout)
      for (const file of parsed.files) {
        file.path = toDisplayPath(prefix, file.path)
        if (file.origPath) {
          file.origPath = toDisplayPath(prefix, file.origPath)
        }
      }
      const displayStats = (
        entries: ReturnType<typeof parseNumstatZ>
      ): ReturnType<typeof parseNumstatZ> =>
        entries.map((entry) => ({
          ...entry,
          path: toDisplayPath(prefix, entry.path),
          origPath: entry.origPath
            ? toDisplayPath(prefix, entry.origPath)
            : undefined
        }))
      const [stagedResult, worktreeResult] = await Promise.all([
        this.exec(
          [
            '-C', repoRoot,
            '-c', 'core.fsmonitor=false',
            'diff', '--numstat', '-z', '--cached', '--', pathspec
          ],
          6000,
          MAX_STATUS_BUFFER
        ),
        this.exec(
          [
            '-C', repoRoot,
            '-c', 'core.fsmonitor=false',
            'diff', '--numstat', '-z', '--', pathspec
          ],
          6000,
          MAX_STATUS_BUFFER
        )
      ])

      return buildGitStatus({
        projectKey,
        repoRoot,
        parsed,
        stagedStats:
          stagedResult.code === 0
            ? displayStats(parseNumstatZ(stagedResult.stdout))
            : [],
        worktreeStats:
          worktreeResult.code === 0
            ? displayStats(parseNumstatZ(worktreeResult.stdout))
            : []
      })
    } catch (error) {
      const gitError =
        error instanceof GitError
          ? error
          : new GitError('failed', errorMessage(error))
      return this.errorStatus(projectKey, gitError.code, gitError.message)
    }
  }

  private async resolveRepoInfo(
    projectPath: string
  ): Promise<{ root: string; prefix: string } | null> {
    const cached = this.repoInfos.get(projectPath)
    if (cached && Date.now() - cached.at < REPO_ROOT_TTL) {
      return cached.root ? { root: cached.root, prefix: cached.prefix } : null
    }
    const result = await this.exec(
      ['-C', projectPath, 'rev-parse', '--show-toplevel', '--show-prefix'],
      3000,
      1024 * 1024
    )
    if (result.code !== 0) {
      this.repoInfos.set(projectPath, { root: null, prefix: '', at: Date.now() })
      return null
    }
    const [topline = '', prefixLine = ''] = result.stdout.split(/\r?\n/)
    const root = normalizePath(topline.trim())
    const prefix = normalizePath(prefixLine.trim()).replace(/\/+$/, '')
    if (!root) {
      this.repoInfos.set(projectPath, { root: null, prefix: '', at: Date.now() })
      return null
    }
    this.repoInfos.set(projectPath, { root, prefix, at: Date.now() })
    return { root, prefix }
  }

  private async projectScope(
    projectKey: string
  ): Promise<{ repoRoot: string; prefix: string } | null> {
    const projectPath = await this.options.resolveProjectPath(projectKey)
    if (!projectPath || !existsSync(projectPath)) return null
    const repoInfo = await this.resolveRepoInfo(projectPath)
    if (!repoInfo) return null
    return { repoRoot: repoInfo.root, prefix: repoInfo.prefix }
  }

  private errorStatus(
    projectKey: string,
    code: GitErrorCode,
    message: string
  ): GitStatus {
    return {
      projectKey,
      isRepo: false,
      branch: null,
      oid: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
      counts: {
        files: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        unmerged: 0,
        modified: 0,
        added: 0,
        deleted: 0,
        renamed: 0
      },
      truncated: false,
      error: { code, message },
      scannedAt: Date.now()
    }
  }

  private exec(
    args: string[],
    timeout: number,
    maxBuffer: number
  ): Promise<ExecResult> {
    // Never let a launcher/hook environment redirect Git to another repository.
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    for (const key of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_NAMESPACE'
    ]) {
      delete env[key]
    }
    return new Promise((resolvePromise, reject) => {
      execFile(
        'git',
        args,
        {
          timeout,
          maxBuffer,
          windowsHide: true,
          encoding: 'utf8',
          env
        },
        (error, stdout, stderr) => {
          if (error) {
            const value = error as NodeJS.ErrnoException & {
              killed?: boolean
            }
            if (value.code === 'ENOENT') {
              reject(new GitError('git-missing', '未检测到 Git，请安装后重试'))
              return
            }
            if (value.killed) {
              reject(new GitError('timeout', 'Git 命令执行超时'))
              return
            }
            resolvePromise({
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? ''),
              code: typeof value.code === 'number' ? value.code : 1
            })
            return
          }
          resolvePromise({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            code: 0
          })
        }
      )
    })
  }
}