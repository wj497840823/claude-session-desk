import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { FileService } from '../src/main/files'
import { tempDir } from './helpers'

const mocks = vi.hoisted(() => ({ read: vi.fn(), text: vi.fn(), open: vi.fn(), reveal: vi.fn(), web: vi.fn() }))
vi.mock('electron', () => ({
  clipboard: { read: mocks.read, readText: mocks.text }, dialog: {},
  nativeImage: { createThumbnailFromPath: vi.fn().mockRejectedValue(new Error('no thumbnail')) },
  shell: { openPath: mocks.open, showItemInFolder: mocks.reveal, openExternal: mocks.web }
}))
const dirs: string[] = []
const SID = '11111111-1111-4111-8111-111111111111'
afterEach(async () => {
  vi.clearAllMocks()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})
async function fixture() {
  const dir = await tempDir()
  dirs.push(dir)
  const project = join(dir, 'project')
  await mkdir(project)
  const userData = join(dir, 'config')
  const getScope = async () => ({ sessionId: SID, cwd: project })
  const service = new FileService(userData, join(dir, 'claude'), getScope, () => null)
  mocks.open.mockResolvedValue('')
  return { dir, project, userData, service, getScope }
}

it('opens project files and reveals exact targets without requiring the Claude data directory', async () => {
  const { project, service } = await fixture()
  const path = join(project, '报告 结果.txt')
  await writeFile(path, 'report')
  expect(await service.action({ sessionId: SID }, '报告 结果.txt:12', 'open')).toMatchObject({ ok: true, path })
  expect(mocks.open).toHaveBeenCalledWith(path)
  expect((await service.action({ sessionId: SID }, encodeURIComponent('报告 结果.txt'), 'open')).ok).toBe(true)
  await service.action({ sessionId: SID }, path, 'reveal')
  expect(mocks.reveal).toHaveBeenCalledWith(path)
})

it('grants outside-project attachments persistently and preserves concurrent additions', async () => {
  const { dir, project, userData, service, getScope } = await fixture()
  const a = join(dir, 'outside-a.txt')
  const b = join(dir, 'outside-b.txt')
  await writeFile(a, 'a'); await writeFile(b, 'b')
  expect((await service.action({ sessionId: SID }, a, 'open')).ok).toBe(false)
  await Promise.all([service.add({ sessionId: SID }, [a]), service.add({ sessionId: SID }, [b])])
  const restored = new FileService(userData, join(dir, 'claude'), getScope, () => null)
  expect(await restored.list({ sessionId: SID })).toHaveLength(2)
  expect((await restored.action({ sessionId: SID }, a, 'open')).ok).toBe(true)
  expect((await restored.action({ sessionId: SID }, b, 'open')).ok).toBe(true)
  const traversal = join(project, '..', 'unapproved.txt')
  await writeFile(traversal, 'private')
  expect((await restored.action({ sessionId: SID }, '../unapproved.txt', 'open')).ok).toBe(false)
})

it('rejects symlink escapes, missing files and invalid attachment batches', async () => {
  const { dir, project, service } = await fixture()
  const outside = join(dir, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(outside, join(project, 'link'), 'junction')
  expect((await service.action({ sessionId: SID }, 'link/secret.txt', 'open')).ok).toBe(false)
  expect((await service.action({ sessionId: SID }, 'missing.txt', 'open')).message).toContain('不存在')
  await expect(service.add({ sessionId: SID }, [project])).rejects.toThrow('文件夹')
  await expect(service.add({ sessionId: SID }, Array(17).fill(join(project, 'a.txt')))).rejects.toThrow('16')
  expect(mocks.open).not.toHaveBeenCalled()
})

it('keeps normal text paste intact and reveals scripts instead of executing them', async () => {
  const { project, service } = await fixture()
  mocks.read.mockResolvedValue([])
  mocks.text.mockResolvedValue('plain text\nnext line')
  expect(await service.paste({ sessionId: SID })).toEqual({ attachments: [], text: 'plain text\nnext line' })
  const path = join(project, 'run.cmd')
  await writeFile(path, '@echo off')
  expect((await service.action({ sessionId: SID }, path, 'open')).ok).toBe(true)
  expect(mocks.reveal).toHaveBeenCalledWith(path)
  expect(mocks.open).not.toHaveBeenCalled()
  expect(await readFile(path, 'utf8')).toBe('@echo off')
})

it('rejects oversized clipboard images before allocating or decoding their bytes', async () => {
  const { service } = await fixture()
  const bytes = vi.fn()
  mocks.read.mockResolvedValue([{ types: ['image/png'], getType: async () => ({ size: 26 * 1024 * 1024, arrayBuffer: bytes }) }])
  await expect(service.paste({ sessionId: SID })).rejects.toThrow('25 MB')
  expect(bytes).not.toHaveBeenCalled()
})

it('pastes native copied files before image previews and deduplicates references', async () => {
  const { project, service } = await fixture()
  const paths = [join(project, '需求 文件.txt'), join(project, '图片.png')]
  await Promise.all(paths.map((path) => writeFile(path, 'fixture')))
  const imageRead = vi.fn()
  mocks.read.mockResolvedValue([{
    types: ['text/uri-list', 'image/png'], getType: async (type: string) => {
      if (type === 'image/png') { imageRead(); throw new Error('must not read preview') }
      return new Blob(['# copied files\r\n' + paths.map((path) => pathToFileURL(path).href).join('\r\n') + '\r\n'])
    }
  }])
  const result = await service.paste({ sessionId: SID })
  expect(result.attachments.map((item) => item.path)).toEqual(paths)
  expect(imageRead).not.toHaveBeenCalled()
  expect(mocks.text).not.toHaveBeenCalled()
  expect((await service.paste({ sessionId: SID })).attachments.map((item) => item.id)).toEqual(result.attachments.map((item) => item.id))
  expect(await service.list({ sessionId: SID })).toHaveLength(2)
})

it('removes visible references durably while preserving source files and historical links', async () => {
  const { dir, service, userData, getScope } = await fixture()
  const path = join(dir, 'outside-project.txt')
  await writeFile(path, 'keep this file')
  const [file] = await service.add({ sessionId: SID }, [path])
  expect(await service.remove({ sessionId: SID }, [file.id])).toEqual([])
  const restored = new FileService(userData, join(dir, 'claude'), getScope, () => null)
  expect(await restored.list({ sessionId: SID })).toEqual([])
  expect(await readFile(path, 'utf8')).toBe('keep this file')
  expect((await restored.action({ sessionId: SID }, path, 'open')).ok).toBe(true)
  const [addedAgain] = await restored.add({ sessionId: SID }, [path])
  expect(addedAgain.id).toBe(file.id)
  await Promise.all([restored.remove({ sessionId: SID }, [file.id]), restored.add({ sessionId: SID }, [path])])
  expect(await restored.list({ sessionId: SID })).toHaveLength(1)
})

it('preserves attachments when copied files are missing or removal input is invalid', async () => {
  const { project, service } = await fixture()
  const path = join(project, 'valid.txt')
  await writeFile(path, 'ok')
  await service.add({ sessionId: SID }, [path])
  mocks.read.mockResolvedValue([{ types: ['text/uri-list'], getType: async () => new Blob([
    [path, join(project, 'missing.txt')].map((value) => pathToFileURL(value).href).join('\n')
  ]) }])
  await expect(service.paste({ sessionId: SID })).rejects.toThrow('不存在')
  await expect(service.remove({ sessionId: SID }, ['valid', 123])).rejects.toThrow('标识')
  expect(await service.list({ sessionId: SID })).toHaveLength(1)
})

it('resolves short Java filenames and source suffixes only when unique in the project', async () => {
  const { project, service } = await fixture()
  const source = join(project, 'module', 'src', 'main', 'java', 'example')
  await mkdir(source, { recursive: true })
  const path = join(source, 'DownloadService.java')
  await writeFile(path, 'class DownloadService {}')
  expect(await service.action({ sessionId: SID }, 'DownloadService.java:62-66', 'check')).toMatchObject({ ok: true, path })
  expect(await service.action({ sessionId: SID }, 'src/main/java/example/DownloadService.java:62', 'open')).toMatchObject({ ok: true, path })
  expect(mocks.open).toHaveBeenCalledWith(path)
  const second = join(project, 'other')
  await mkdir(second)
  await writeFile(join(second, 'DownloadService.java'), 'another class')
  service.invalidate()
  expect(await service.action({ sessionId: SID }, 'DownloadService.java', 'check')).toMatchObject({ ok: false, message: expect.stringContaining('多个同名') })
  expect(await service.action({ sessionId: SID }, path, 'check')).toMatchObject({ ok: true, path })
})

it('keeps methods, fields, placeholders, remote Linux paths and missing files noninteractive', async () => {
  const { service } = await fixture()
  const results = await service.checkReferences({ sessionId: SID }, [
    'Throwable.getMessage()', 'FastDFSStorageEngineImpl.download()', 'fileNo/token',
    'group1/M00/00/00/xxxx.java', '/var/fdfs/logs/storaged.log', 'storage.conf'
  ])
  expect(results.every((result) => !result.ok)).toBe(true)
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.reveal).not.toHaveBeenCalled()
})

it('supports native Windows and Git Bash drive paths while retaining symlink checks', async () => {
  const { project, service } = await fixture()
  const path = join(project, '报告 结果.txt')
  await writeFile(path, 'result')
  const gitPath = '/' + path[0].toLowerCase() + path.slice(2).replace(/\\/g, '/')
  expect(await service.action({ sessionId: SID }, gitPath, 'check')).toMatchObject({ ok: true, path })
  expect(await service.action({ sessionId: SID }, '/' + path.replace(/\\/g, '/'), 'check')).toMatchObject({ ok: true, path })
})
