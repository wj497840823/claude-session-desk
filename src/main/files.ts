import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { clipboard, dialog, nativeImage, shell, type BrowserWindow } from 'electron'
import type { ActionResult, Attachment, ClipboardPaste, FileContext } from '@shared/types'
import { parseFileReference } from '@shared/fileReferences'
import { ProjectFileIndex } from './projectFileIndex'

export interface FileScope { sessionId: string; cwd: string }
type StoredAttachment = Attachment & { hidden?: boolean }
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const PROGRAM_EXTENSIONS = new Set(['.exe', '.com', '.msi', '.bat', '.cmd', '.ps1', '.vbs', '.vbe', '.js', '.mjs', '.cjs', '.wsf', '.wsh', '.hta', '.scr', '.lnk', '.url', '.reg', '.py', '.sh'])

export function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return !rel || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

export class FileService {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly projectFiles = new ProjectFileIndex()
  constructor(
    private readonly userData: string,
    private readonly dataRoot: string,
    private readonly getScope: (context: FileContext) => Promise<FileScope>,
    private readonly getWindow: () => BrowserWindow | null
  ) {}

  invalidate(): void { this.projectFiles.clear() }

  async checkReferences(context: FileContext, references: unknown): Promise<ActionResult[]> {
    if (!Array.isArray(references) || references.length > 128 || !references.every((value) => typeof value === 'string' && value.length <= 4096)) {
      throw new Error('文件路径列表无效')
    }
    const results: ActionResult[] = []
    for (let offset = 0; offset < references.length; offset += 8) {
      results.push(...await Promise.all(references.slice(offset, offset + 8).map((reference) => this.action(context, reference, 'check'))))
    }
    return results
  }

  private directory(scope: FileScope): string {
    if (!/^[a-f\d-]{36}$/i.test(scope.sessionId)) throw new Error('非法会话标识')
    return join(this.userData, 'attachments', scope.sessionId)
  }

  private async readManifest(scope: FileScope): Promise<StoredAttachment[]> {
    try {
      const value: unknown = JSON.parse(await readFile(join(this.directory(scope), 'manifest.json'), 'utf8'))
      return Array.isArray(value) ? value.filter((item) => item && typeof item.path === 'string' &&
        isAbsolute(item.path) && typeof item.name === 'string' && typeof item.id === 'string') : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('附件清单读取失败')
    }
  }

  async list(context: FileContext): Promise<Attachment[]> {
    const scope = await this.getScope(context)
    await this.queues.get(scope.sessionId)?.catch(() => undefined)
    return (await this.readManifest(scope)).filter((item) => !item.hidden)
  }

  private async updateManifest<T>(scope: FileScope, update: (current: StoredAttachment[]) => { items: StoredAttachment[]; result: T }): Promise<T> {
    const previous = this.queues.get(scope.sessionId) ?? Promise.resolve()
    const pending = previous.catch(() => undefined).then(async () => {
      const dir = this.directory(scope)
      await mkdir(dir, { recursive: true })
      const current = await this.readManifest(scope)
      const { items, result } = update(current)
      const temp = join(dir, randomUUID() + '.tmp')
      try {
        await writeFile(temp, JSON.stringify(items), 'utf8')
        await rename(temp, join(dir, 'manifest.json'))
      } finally {
        await unlink(temp).catch(() => undefined)
      }
      return result
    })
    this.queues.set(scope.sessionId, pending)
    void pending.finally(() => { if (this.queues.get(scope.sessionId) === pending) this.queues.delete(scope.sessionId) }).catch(() => undefined)
    return pending
  }

  private remember(scope: FileScope, items: Attachment[]): Promise<Attachment[]> {
    return this.updateManifest(scope, (current) => {
      const byPath = new Map(current.map((item) => [item.path.toLowerCase(), item]))
      const result = items.map((item) => {
        const value = { ...item, id: byPath.get(item.path.toLowerCase())?.id ?? item.id }
        byPath.set(item.path.toLowerCase(), value)
        return value
      })
      return { items: [...byPath.values()], result }
    })
  }

  async remove(context: FileContext, ids: unknown): Promise<Attachment[]> {
    if (!Array.isArray(ids) || ids.length > 1000 || !ids.every((id) => typeof id === 'string')) throw new Error('附件标识无效')
    const scope = await this.getScope(context)
    return this.updateManifest(scope, (current) => {
      const removing = new Set(ids)
      // Keep files and historical access grants intact; only remove the visible reference.
      const items = current.map((item) => removing.has(item.id) ? { ...item, hidden: true } : item)
      return { items, result: items.filter((item) => !item.hidden) }
    })
  }

  async add(context: FileContext, paths: unknown): Promise<Attachment[]> {
    if (!Array.isArray(paths) || paths.length > 16 || !paths.every((p) => typeof p === 'string' && isAbsolute(p) && !/[\x00-\x1f\x7f]/.test(p))) {
      throw new Error('一次最多添加 16 个有效文件')
    }
    const scope = await this.getScope(context)
    const items: Attachment[] = []
    for (const path of [...new Set(paths as string[])]) {
      const canonical = await realpath(path).catch(() => { throw new Error(`文件不存在或无法访问：${basename(path)}`) })
      const info = await stat(canonical)
      if (!info.isFile()) throw new Error('请选择文件，不能添加文件夹')
      const image = IMAGE_EXTENSIONS.has(extname(canonical).toLowerCase())
      if (image && info.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 25 MB')
      const item: Attachment = { id: randomUUID(), path: canonical, name: basename(canonical),
        size: info.size, kind: image ? 'image' : 'file' }
      if (image) {
        try { item.preview = (await nativeImage.createThumbnailFromPath(canonical, { width: 120, height: 80 })).toDataURL() } catch { /* preview is optional */ }
      }
      items.push(item)
    }
    return items.length ? this.remember(scope, items) : []
  }

  async pick(context: FileContext): Promise<Attachment[]> {
    await this.getScope(context)
    const options: Electron.OpenDialogOptions = { title: '添加文件或图片', properties: ['openFile', 'multiSelections'] }
    const window = this.getWindow()
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : this.add(context, result.filePaths)
  }

  async paste(context: FileContext): Promise<ClipboardPaste> {
    const scope = await this.getScope(context)
    const items = await clipboard.read()
    for (const item of items) {
      if (!item.types.includes('text/uri-list')) continue
      const blob = await item.getType('text/uri-list')
      if (!('text' in blob) || blob.size > 1024 * 1024) throw new Error('剪贴板文件列表无效或过大')
      const uris = (await blob.text()).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
      if (uris.length && uris.every((uri) => /^file:\/\//i.test(uri))) {
        let paths: string[]
        try { paths = uris.map((uri) => fileURLToPath(uri)) } catch { throw new Error('剪贴板文件路径无效') }
        return { attachments: await this.add(context, paths) }
      }
    }
    for (const item of items) {
      const type = item.types.find((type) => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type))
      if (!type) continue
      const blob = await item.getType(type)
      if (!('arrayBuffer' in blob)) throw new Error('剪贴板图片格式无效')
      if (blob.size > MAX_IMAGE_BYTES) throw new Error('剪贴板图片不能超过 25 MB')
      const bytes = Buffer.from(await blob.arrayBuffer())
      const image = nativeImage.createFromBuffer(bytes)
      if (image.isEmpty()) throw new Error('无法读取剪贴板图片')
      const { width, height } = image.getSize()
      if (width * height > 50_000_000) throw new Error('图片分辨率过大，请先缩小图片')
      const dir = this.directory(scope)
      await mkdir(dir, { recursive: true })
      const id = randomUUID()
      const path = join(dir, `截图-${id}.png`)
      const png = image.toPNG()
      if (png.length > MAX_IMAGE_BYTES) throw new Error('图片转换后超过 25 MB，请缩小后再粘贴')
      await writeFile(path, png, { flag: 'wx' })
      const attachment: Attachment = { id, path, name: basename(path), kind: 'image', size: png.length,
        preview: image.resize({ width: Math.min(120, width) }).toDataURL() }
      try {
        return { attachments: await this.remember(scope, [attachment]) }
      } catch (error) {
        await unlink(path).catch(() => undefined)
        throw error
      }
    }
    return { attachments: [], text: await clipboard.readText() }
  }

  async action(context: FileContext, reference: string, action: unknown): Promise<ActionResult> {
    try {
      if (!['open', 'reveal', 'check'].includes(String(action))) throw new Error('非法文件操作')
      if (/^https?:\/\//i.test(reference)) {
        if (action !== 'open') throw new Error('网页不支持文件定位')
        const url = new URL(reference)
        await shell.openExternal(url.href)
        return { ok: true }
      }
      const parsed = parseFileReference(reference)
      if (!parsed) throw new Error('不支持该文件路径')
      const scope = await this.getScope(context)
      let local = parsed.path
      if (/^~[\\/]/.test(local)) local = join(homedir(), local.slice(2))
      if (process.platform === 'win32') {
        if (/^\/[a-z]:[\\/]/i.test(local)) local = local.slice(1)
        else if (/^\/[a-z]\//i.test(local)) local = local[1] + ':' + local.slice(2)
        else if (/^\/(?!\/)/.test(local)) throw new Error('这是 Linux 或远程环境路径，无法作为本机 Windows 文件打开')
      }
      const path = resolve(scope.cwd, local)
      const manifest = await this.readManifest(scope)
      const roots = [scope.cwd, this.directory(scope), this.dataRoot]
      const allowed = (target: string, candidates: string[]): boolean => candidates.some((root) => within(root, target)) ||
        manifest.some((item) => resolve(item.path).toLowerCase() === resolve(target).toLowerCase())
      if (!allowed(path, roots)) throw new Error('文件不在当前项目或已添加的附件中')
      let canonical: string
      let found = await realpath(path).catch(() => null)
      let decodedLocal = local
      if (!found) {
        // Markdown encodes spaces and non-ASCII characters in relative URLs.
        try { decodedLocal = decodeURIComponent(local) } catch { throw new Error('文件路径编码无效') }
        const decoded = resolve(scope.cwd, decodedLocal)
        if (!allowed(decoded, roots) || /[\x00-\x1f\x7f]/.test(decoded)) throw new Error('文件不在当前项目或已添加的附件中')
        found = await realpath(decoded).catch(() => null)
      }
      const bare = !/[\\/]/.test(decodedLocal)
      // Java answers frequently show only a filename or a shortened source suffix.
      // Resolve it only when a complete project scan yields one unambiguous match.
      if (!isAbsolute(decodedLocal) && (bare || !found)) {
        const indexed = await this.projectFiles.find(scope.cwd, decodedLocal)
        const candidates = new Map<string, string>()
        for (const candidate of indexed.paths) candidates.set(candidate.toLowerCase(), candidate)
        for (const item of manifest) {
          if (bare && basename(item.path).toLowerCase() === decodedLocal.toLowerCase()) candidates.set(item.path.toLowerCase(), item.path)
        }
        if (candidates.size > 1) throw new Error(`找到多个同名文件，请使用完整路径：${parsed.path}`)
        if (!indexed.complete) throw new Error(`项目文件未能完整核验，请使用完整路径：${parsed.path}`)
        if (candidates.size === 1) found = await realpath([...candidates.values()][0]).catch(() => null)
      }
      if (!found) throw new Error(`文件不存在或当前项目中未找到匹配项：${parsed.path}`)
      canonical = found
      const canonicalRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => resolve(root))))
      if (!allowed(canonical, canonicalRoots)) throw new Error('文件实际位置不在允许范围内')
      await stat(canonical)
      if (action === 'check') return { ok: true, path: canonical }
      if (action === 'reveal' || PROGRAM_EXTENSIONS.has(extname(canonical).toLowerCase())) {
        shell.showItemInFolder(canonical)
        return { ok: true, path: canonical,
          ...(action === 'open' ? { message: '已定位到文件；程序或脚本文件不会直接运行' } : {}) }
      }
      const error = await shell.openPath(canonical)
      return error ? { ok: false, message: error } : { ok: true, path: canonical }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
}
