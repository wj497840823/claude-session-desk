import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type {
  ClaudeMdFileInfo,
  ClaudeMdLocationInfo,
  ClaudeMdPlacement,
  ClaudeMdSaveInput,
  ClaudeMdSaveResult,
  ClaudeMdScope,
  ClaudeMdTemplate,
  ClaudeMdTemplateInput
} from '@shared/types'
import { BUILTIN_CLAUDE_MD_TEMPLATES } from './claudeMdTemplates'
import { writeJsonAtomic } from './config'

export const MAX_CLAUDE_MD_BYTES = 1024 * 1024
const MAX_BACKUP_ATTEMPTS = 100
const MAX_TEMPLATES = 200
const MAX_NAME_LENGTH = 60
const MAX_DESCRIPTION_LENGTH = 200

interface StoredTemplate {
  id: string
  name: string
  scope: ClaudeMdScope
  description: string
  content: string
  createdAt: number
  updatedAt: number
}

interface TemplateStore {
  version: 1
  templates: StoredTemplate[]
}

export interface ClaudeMdTarget {
  scope: ClaudeMdScope
  projectKey?: string
  placement?: ClaudeMdPlacement
}

export interface ClaudeMdServiceOptions {
  userData: string
  homeDir?: string
  resolveProjectPath: (projectKey: string) => Promise<string | null>
}

function normalizeScope(value: unknown): ClaudeMdScope {
  if (value === 'global' || value === 'project') return value
  throw new Error('非法的 CLAUDE.md 作用域')
}

function normalizePlacement(value: unknown): ClaudeMdPlacement {
  if (value === undefined || value === null || value === 'root') return 'root'
  if (value === 'claude-dir') return 'claude-dir'
  throw new Error('非法的 CLAUDE.md 位置')
}

function validateContent(value: unknown): string {
  if (typeof value !== 'string') throw new Error('CLAUDE.md 内容必须是文本')
  if (value.includes('\u0000')) throw new Error('内容包含二进制字符')
  if (Buffer.byteLength(value, 'utf8') > MAX_CLAUDE_MD_BYTES) {
    throw new Error('CLAUDE.md 内容超过 1 MiB 限制')
  }
  return value
}

function validateName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('模板名称必须是文本')
  const name = value.trim()
  if (!name) throw new Error('模板名称不能为空')
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`模板名称不能超过 ${MAX_NAME_LENGTH} 个字符`)
  }
  return name
}

function validateDescription(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error('模板说明必须是文本')
  const description = value.trim()
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`模板说明不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符`)
  }
  return description
}

function normalizeStoredTemplate(value: unknown): StoredTemplate | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const id = item.id
  const name = item.name
  const scope = item.scope
  const content = item.content
  if (typeof id !== 'string' || !id.startsWith('custom:')) return null
  if (typeof name !== 'string' || !name.trim()) return null
  if (scope !== 'global' && scope !== 'project') return null
  if (typeof content !== 'string') return null
  if (Buffer.byteLength(content, 'utf8') > MAX_CLAUDE_MD_BYTES) return null
  return {
    id,
    name: name.trim().slice(0, MAX_NAME_LENGTH),
    scope,
    description: typeof item.description === 'string'
      ? item.description.slice(0, MAX_DESCRIPTION_LENGTH)
      : '',
    content,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function timestampSuffix(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function fsErrorMessage(error: unknown, action: string): string {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EACCES' || code === 'EPERM') return `${action}：权限不足`
  if (code === 'ENOSPC') return `${action}：磁盘空间不足`
  if (code === 'ENOTDIR') return `${action}：路径不是文件夹`
  if (code === 'EISDIR') return `${action}：路径是文件夹`
  return `${action}：${error instanceof Error ? error.message : String(error)}`
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, content, 'utf8')
    await rename(tempPath, path)
  } catch (error) {
    throw new Error(fsErrorMessage(error, '无法保存 CLAUDE.md'))
  } finally {
    await unlink(tempPath).catch(() => undefined)
  }
}

export class ClaudeMdService {
  private readonly homeDir: string
  private readonly userData: string
  private readonly resolveProjectPath: (projectKey: string) => Promise<string | null>
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: ClaudeMdServiceOptions) {
    this.homeDir = options.homeDir ?? homedir()
    this.userData = options.userData
    this.resolveProjectPath = options.resolveProjectPath
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation)
    this.queue = pending.then(() => undefined, () => undefined)
    return pending
  }

  private async resolveProjectDirectory(projectKey: string | undefined): Promise<string> {
    const key = projectKey?.trim()
    if (!key) throw new Error('缺少项目标识')
    const projectPath = await this.resolveProjectPath(key)
    if (!projectPath) throw new Error('项目不存在或尚未加载')

    let info: Stats
    try {
      info = await stat(projectPath)
    } catch {
      throw new Error('项目文件夹不存在')
    }
    if (!info.isDirectory()) throw new Error('项目路径不是文件夹')
    return resolve(projectPath)
  }

  private async resolveTarget(
    target: ClaudeMdTarget
  ): Promise<{ path: string; placement?: ClaudeMdPlacement }> {
    const scope = normalizeScope(target.scope)
    if (scope === 'global') {
      return { path: join(this.homeDir, '.claude', 'CLAUDE.md') }
    }

    const placement = normalizePlacement(target.placement)
    const projectPath = await this.resolveProjectDirectory(target.projectKey)
    const path = placement === 'claude-dir'
      ? join(projectPath, '.claude', 'CLAUDE.md')
      : join(projectPath, 'CLAUDE.md')
    return { path, placement }
  }

  async read(target: ClaudeMdTarget): Promise<ClaudeMdFileInfo> {
    const scope = normalizeScope(target.scope)
    const resolved = await this.resolveTarget({
      scope,
      projectKey: target.projectKey,
      placement: target.placement
    })
    return this.readResolved(resolved.path, scope, resolved.placement)
  }

  async locations(target: ClaudeMdTarget): Promise<ClaudeMdLocationInfo[]> {
    const scope = normalizeScope(target.scope)
    if (scope === 'global') return []
    const projectPath = await this.resolveProjectDirectory(target.projectKey)
    const entries: Array<{ placement: ClaudeMdPlacement; path: string }> = [
      { placement: 'root', path: join(projectPath, 'CLAUDE.md') },
      { placement: 'claude-dir', path: join(projectPath, '.claude', 'CLAUDE.md') }
    ]
    const result: ClaudeMdLocationInfo[] = []
    for (const entry of entries) {
      let exists = false
      try {
        exists = (await stat(entry.path)).isFile()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(fsErrorMessage(error, '无法读取 CLAUDE.md'))
        }
      }
      result.push({ ...entry, exists })
    }
    return result
  }

  private async readResolved(
    path: string,
    scope: ClaudeMdScope,
    placement?: ClaudeMdPlacement
  ): Promise<ClaudeMdFileInfo> {
    let info: Stats
    try {
      info = await stat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { scope, path, exists: false, content: '', placement }
      }
      throw new Error(fsErrorMessage(error, '无法读取 CLAUDE.md'))
    }
    if (!info.isFile()) throw new Error('CLAUDE.md 路径不是文件')
    if (info.size > MAX_CLAUDE_MD_BYTES) throw new Error('CLAUDE.md 超过 1 MiB，无法读取')

    try {
      const raw = await readFile(path, 'utf8')
      return { scope, path, exists: true, content: raw.replace(/^\uFEFF/, ''), placement }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { scope, path, exists: false, content: '', placement }
      }
      throw new Error(fsErrorMessage(error, '无法读取 CLAUDE.md'))
    }
  }

  async write(input: ClaudeMdSaveInput): Promise<ClaudeMdSaveResult> {
    const scope = normalizeScope(input.scope)
    const content = validateContent(input.content)
    const { path } = await this.resolveTarget({
      scope,
      projectKey: input.projectKey,
      placement: input.placement
    })

    return this.enqueue(async () => {
      let previousInfo: Stats | null = null
      try {
        previousInfo = await stat(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(fsErrorMessage(error, '无法读取 CLAUDE.md'))
        }
      }
      if (previousInfo && !previousInfo.isFile()) {
        throw new Error('CLAUDE.md 路径不是文件')
      }

      if (previousInfo && previousInfo.size <= MAX_CLAUDE_MD_BYTES) {
        try {
          const previousContent = await readFile(path, 'utf8')
          if (previousContent === content) {
            return {
              ok: true,
              message: '文件内容没有变化',
              path,
              created: false,
              changed: false
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            previousInfo = null
          } else {
            throw new Error(fsErrorMessage(error, '无法读取 CLAUDE.md'))
          }
        }
      }

      const existed = Boolean(previousInfo)
      try {
        await mkdir(dirname(path), { recursive: true })
      } catch (error) {
        throw new Error(fsErrorMessage(error, '无法创建 CLAUDE.md 目录'))
      }

      const backupPath = existed ? await this.writeBackup(path) : undefined
      await writeFileAtomic(path, content)

      return {
        ok: true,
        message: !existed
          ? '已创建 CLAUDE.md'
          : `已保存，旧内容备份为 ${basename(backupPath!)}`,
        path,
        backupPath,
        created: !existed,
        changed: true
      }
    })
  }

  private async writeBackup(path: string): Promise<string> {
    const stamp = timestampSuffix(new Date())
    for (let index = 0; index < MAX_BACKUP_ATTEMPTS; index += 1) {
      const candidate = `${path}.bak-${stamp}${index === 0 ? '' : `-${index}`}`
      try {
        await copyFile(path, candidate, constants.COPYFILE_EXCL)
        return candidate
      } catch (error) {
        if ((await stat(candidate).catch(() => null))?.isDirectory()) {
          throw new Error('无法创建备份文件：备份路径被文件夹占用')
        }
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw new Error(fsErrorMessage(error, '无法创建备份文件'))
      }
    }
    throw new Error('无法创建备份文件：同名备份过多')
  }

  private get templatesPath(): string {
    return join(this.userData, 'claude-md-templates.json')
  }

  private async readStore(): Promise<TemplateStore> {
    let raw: string
    try {
      raw = await readFile(this.templatesPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, templates: [] }
      }
      throw new Error(fsErrorMessage(error, '无法读取模板配置'))
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      await this.preserveCorruptStore()
      return { version: 1, templates: [] }
    }
    if (!parsed || typeof parsed !== 'object') {
      await this.preserveCorruptStore()
      return { version: 1, templates: [] }
    }
    const value = parsed as Record<string, unknown>
    if (value.version !== 1 || !Array.isArray(value.templates)) {
      await this.preserveCorruptStore()
      return { version: 1, templates: [] }
    }

    const seen = new Set<string>()
    const templates = value.templates
      .map(normalizeStoredTemplate)
      .filter((template): template is StoredTemplate => Boolean(template))
      .filter((template) => {
        if (seen.has(template.id)) return false
        seen.add(template.id)
        return true
      })
      .slice(0, MAX_TEMPLATES)
    return { version: 1, templates }
  }

  private async preserveCorruptStore(): Promise<void> {
    const backup = `${this.templatesPath}.corrupt-${timestampSuffix(new Date())}-${randomUUID().slice(0, 8)}`
    await rename(this.templatesPath, backup).catch(() => undefined)
  }

  private async writeStore(store: TemplateStore): Promise<void> {
    try {
      await writeJsonAtomic(this.templatesPath, store)
    } catch (error) {
      throw new Error(fsErrorMessage(error, '无法保存模板配置'))
    }
  }

  async listTemplates(): Promise<ClaudeMdTemplate[]> {
    const store = await this.readStore()
    return [
      ...BUILTIN_CLAUDE_MD_TEMPLATES.map((template) => ({ ...template, builtin: true })),
      ...store.templates.map((template) => ({ ...template, builtin: false }))
    ]
  }

  async saveTemplate(input: ClaudeMdTemplateInput): Promise<ClaudeMdTemplate> {
    const scope = normalizeScope(input.scope)
    if (input.id !== undefined && typeof input.id !== 'string') {
      throw new Error('非法模板标识')
    }
    if (typeof input.id === 'string' && input.id.startsWith('builtin:')) {
      throw new Error('内置模板不能修改，请先复制为自定义模板')
    }
    if (typeof input.id === 'string' && !input.id.startsWith('custom:')) {
      throw new Error('非法模板标识')
    }
    const name = validateName(input.name)
    const description = validateDescription(input.description)
    const content = validateContent(input.content)

    return this.enqueue(async () => {
      const store = await this.readStore()
      if (typeof input.id === 'string') {
        const index = store.templates.findIndex((template) => template.id === input.id)
        if (index < 0) throw new Error('模板不存在')
        const updated: StoredTemplate = {
          ...store.templates[index],
          name,
          scope,
          description,
          content,
          updatedAt: Date.now()
        }
        store.templates[index] = updated
        await this.writeStore(store)
        return { ...updated, builtin: false }
      }

      if (store.templates.length >= MAX_TEMPLATES) {
        throw new Error('自定义模板数量已达上限（200 个）')
      }
      const now = Date.now()
      const created: StoredTemplate = {
        id: `custom:${randomUUID()}`,
        name,
        scope,
        description,
        content,
        createdAt: now,
        updatedAt: now
      }
      store.templates.push(created)
      await this.writeStore(store)
      return { ...created, builtin: false }
    })
  }

  async deleteTemplate(id: string): Promise<void> {
    if (typeof id !== 'string' || !id) throw new Error('缺少模板标识')
    if (id.startsWith('builtin:')) throw new Error('内置模板不能删除')
    if (!id.startsWith('custom:')) throw new Error('非法模板标识')

    await this.enqueue(async () => {
      const store = await this.readStore()
      const next = store.templates.filter((template) => template.id !== id)
      if (next.length === store.templates.length) throw new Error('模板不存在')
      await this.writeStore({ version: 1, templates: next })
    })
  }

  async importTemplate(scope: ClaudeMdScope, sourcePath: string): Promise<ClaudeMdTemplate> {
    const targetScope = normalizeScope(scope)
    if (extname(sourcePath).toLowerCase() !== '.md') {
      throw new Error('只能导入 .md 模板文件')
    }

    let info: Stats
    try {
      info = await stat(sourcePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('模板文件不存在')
      }
      throw new Error(fsErrorMessage(error, '无法读取模板文件'))
    }
    if (!info.isFile()) throw new Error('导入目标不是文件')
    if (info.size > MAX_CLAUDE_MD_BYTES) throw new Error('模板文件超过 1 MiB 限制')

    let content: string
    try {
      content = await readFile(sourcePath, 'utf8')
    } catch (error) {
      throw new Error(fsErrorMessage(error, '无法读取模板文件'))
    }
    content = content.replace(/^\uFEFF/, '')
    if (content.includes('\u0000')) throw new Error('模板文件包含二进制内容')

    const fileName = basename(sourcePath, extname(sourcePath)).trim()
    return this.saveTemplate({
      name: fileName.slice(0, MAX_NAME_LENGTH) || '导入模板',
      scope: targetScope,
      description: `导入自 ${basename(sourcePath)}`.slice(0, MAX_DESCRIPTION_LENGTH),
      content
    })
  }
}