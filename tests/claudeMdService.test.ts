import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeMdService, MAX_CLAUDE_MD_BYTES } from '../src/main/claudeMd'
import { tempDir } from './helpers'

const dirs: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await tempDir()
  dirs.push(dir)
  const home = join(dir, 'home')
  const userData = join(dir, 'config')
  const project = join(dir, 'project')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  const service = new ClaudeMdService({
    userData,
    homeDir: home,
    resolveProjectPath: async (key) => (key === 'p1' ? project : null)
  })
  return { dir, home, userData, project, service }
}

describe('ClaudeMdService files', () => {
  it('reads a missing global file without creating it', async () => {
    const { home, service } = await fixture()
    const info = await service.read({ scope: 'global' })
    expect(info.path).toBe(join(home, '.claude', 'CLAUDE.md'))
    expect(info.exists).toBe(false)
    expect(info.content).toBe('')
    expect(await readdir(join(home, '.claude')).catch(() => [])).toEqual([])
  })

  it('creates the global directory and file on write', async () => {
    const { home, service } = await fixture()
    const result = await service.write({ scope: 'global', content: '# Global\n' })
    expect(result.ok).toBe(true)
    expect(result.created).toBe(true)
    expect(result.changed).toBe(true)
    expect(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('# Global\n')
    expect((await service.read({ scope: 'global' })).content).toBe('# Global\n')
  })

  it('does not write or back up unchanged content', async () => {
    const { home, service } = await fixture()
    await service.write({ scope: 'global', content: '# Global\n' })
    const result = await service.write({ scope: 'global', content: '# Global\n' })
    expect(result.changed).toBe(false)
    expect(result.backupPath).toBeUndefined()
    expect(result.message).toBe('文件内容没有变化')
    expect((await readdir(join(home, '.claude'))).filter((name) => name.includes('.bak-'))).toEqual([])
  })

  it('backs up the old file before overwriting it', async () => {
    const { home, service } = await fixture()
    await service.write({ scope: 'global', content: 'old\n' })
    const result = await service.write({ scope: 'global', content: 'new\n' })
    expect(result.changed).toBe(true)
    expect(result.backupPath).toMatch(/CLAUDE\.md\.bak-\d{8}-\d{6}(-\d+)?$/)
    expect(await readFile(result.backupPath!, 'utf8')).toBe('old\n')
    expect(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('new\n')
  })

  it('aborts the write when the backup cannot be created', async () => {
    const { home, service } = await fixture()
    await service.write({ scope: 'global', content: 'old\n' })
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5))
    await mkdir(join(home, '.claude', 'CLAUDE.md.bak-20260102-030405'))
    await expect(service.write({ scope: 'global', content: 'new\n' }))
      .rejects.toThrow('备份路径被文件夹占用')
    expect(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('old\n')
  })

  it('writes project CLAUDE.md only for a known project', async () => {
    const { project, service } = await fixture()
    const result = await service.write({ scope: 'project', projectKey: 'p1', content: '# Project\n' })
    expect(result.path).toBe(join(project, 'CLAUDE.md'))
    await expect(service.read({ scope: 'project', projectKey: 'missing' })).rejects.toThrow('项目不存在')
    await expect(service.read({ scope: 'project' })).rejects.toThrow('缺少项目标识')
  })

  it('rejects content over 1 MiB', async () => {
    const { service } = await fixture()
    await expect(service.write({ scope: 'global', content: 'x'.repeat(MAX_CLAUDE_MD_BYTES + 1) }))
      .rejects.toThrow('1 MiB')
  })

  it('rejects reading a file over 1 MiB', async () => {
    const { home, service } = await fixture()
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', 'CLAUDE.md'), 'x'.repeat(MAX_CLAUDE_MD_BYTES + 1), 'utf8')
    await expect(service.read({ scope: 'global' })).rejects.toThrow('1 MiB')
  })

  it('uses a suffixed backup name when the same second already has a backup', async () => {
    const { home, service } = await fixture()
    await service.write({ scope: 'global', content: 'old\n' })
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5))
    await writeFile(
      join(home, '.claude', 'CLAUDE.md.bak-20260102-030405'),
      'occupied\n',
      'utf8'
    )
    const result = await service.write({ scope: 'global', content: 'new\n' })
    expect(result.backupPath).toBe(join(home, '.claude', 'CLAUDE.md.bak-20260102-030405-1'))
    expect(await readFile(result.backupPath!, 'utf8')).toBe('old\n')
    expect(await readFile(join(home, '.claude', 'CLAUDE.md.bak-20260102-030405'), 'utf8'))
      .toBe('occupied\n')
  })

  it('replaces an oversized existing file after backing it up', async () => {
    const { home, service } = await fixture()
    await mkdir(join(home, '.claude'), { recursive: true })
    const oversized = 'x'.repeat(MAX_CLAUDE_MD_BYTES + 1)
    await writeFile(join(home, '.claude', 'CLAUDE.md'), oversized, 'utf8')
    const result = await service.write({ scope: 'global', content: 'small\n' })
    expect(result.changed).toBe(true)
    expect(result.backupPath).toBeTruthy()
    expect(await readFile(result.backupPath!, 'utf8')).toBe(oversized)
    expect(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('small\n')
  })

  it('strips a UTF-8 BOM when reading CLAUDE.md', async () => {
    const { home, service } = await fixture()
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', 'CLAUDE.md'), '\uFEFF# Bom\n', 'utf8')
    expect((await service.read({ scope: 'global' })).content).toBe('# Bom\n')
  })
})

describe('ClaudeMdService project placement', () => {
  it('reads and writes .claude/CLAUDE.md when requested', async () => {
    const { project, service } = await fixture()
    const target = {
      scope: 'project' as const,
      projectKey: 'p1',
      placement: 'claude-dir' as const
    }
    const before = await service.read(target)
    expect(before.path).toBe(join(project, '.claude', 'CLAUDE.md'))
    expect(before.exists).toBe(false)
    expect(before.placement).toBe('claude-dir')

    const result = await service.write({ ...target, content: '# Hidden\n' })
    expect(result.ok).toBe(true)
    expect(result.path).toBe(join(project, '.claude', 'CLAUDE.md'))
    expect(await readFile(join(project, '.claude', 'CLAUDE.md'), 'utf8')).toBe('# Hidden\n')

    const after = await service.read(target)
    expect(after.exists).toBe(true)
    expect(after.content).toBe('# Hidden\n')
  })

  it('keeps root and .claude files independent', async () => {
    const { project, service } = await fixture()
    await service.write({ scope: 'project', projectKey: 'p1', content: '# Root\n' })
    await service.write({
      scope: 'project',
      projectKey: 'p1',
      placement: 'claude-dir',
      content: '# Hidden\n'
    })
    expect(await readFile(join(project, 'CLAUDE.md'), 'utf8')).toBe('# Root\n')
    expect(await readFile(join(project, '.claude', 'CLAUDE.md'), 'utf8')).toBe('# Hidden\n')
    expect((await service.read({ scope: 'project', projectKey: 'p1' })).content).toBe('# Root\n')
    expect((await service.read({
      scope: 'project',
      projectKey: 'p1',
      placement: 'claude-dir'
    })).content).toBe('# Hidden\n')
  })

  it('backs up the selected .claude file in place', async () => {
    const { project, service } = await fixture()
    await service.write({
      scope: 'project',
      projectKey: 'p1',
      placement: 'claude-dir',
      content: 'old\n'
    })
    const result = await service.write({
      scope: 'project',
      projectKey: 'p1',
      placement: 'claude-dir',
      content: 'new\n'
    })
    expect(result.backupPath).toMatch(/\.claude[\\/]CLAUDE\.md\.bak-/)
    expect(await readFile(result.backupPath!, 'utf8')).toBe('old\n')
    expect(await readFile(join(project, '.claude', 'CLAUDE.md'), 'utf8')).toBe('new\n')
  })

  it('reports both project locations', async () => {
    const { project, service } = await fixture()
    let locations = await service.locations({ scope: 'project', projectKey: 'p1' })
    expect(locations).toEqual([
      { placement: 'root', path: join(project, 'CLAUDE.md'), exists: false },
      { placement: 'claude-dir', path: join(project, '.claude', 'CLAUDE.md'), exists: false }
    ])
    await service.write({ scope: 'project', projectKey: 'p1', content: 'root\n' })
    locations = await service.locations({ scope: 'project', projectKey: 'p1' })
    expect(locations.map((item) => item.exists)).toEqual([true, false])
    await service.write({
      scope: 'project',
      projectKey: 'p1',
      placement: 'claude-dir',
      content: 'hidden\n'
    })
    locations = await service.locations({ scope: 'project', projectKey: 'p1' })
    expect(locations.map((item) => item.exists)).toEqual([true, true])
    expect(await service.locations({ scope: 'global' })).toEqual([])
  })

  it('rejects an invalid placement', async () => {
    const { service } = await fixture()
    await expect(service.read({
      scope: 'project',
      projectKey: 'p1',
      placement: 'bad' as never
    })).rejects.toThrow('非法的 CLAUDE.md 位置')
    await expect(service.write({
      scope: 'project',
      projectKey: 'p1',
      placement: 'bad' as never,
      content: 'x'
    })).rejects.toThrow('非法的 CLAUDE.md 位置')
  })

  it('ignores placement for the global scope', async () => {
    const { home, service } = await fixture()
    const info = await service.read({ scope: 'global', placement: 'claude-dir' })
    expect(info.path).toBe(join(home, '.claude', 'CLAUDE.md'))
    expect(info.placement).toBeUndefined()
  })
})

describe('ClaudeMdService templates', () => {
  it('lists built-in templates plus persisted custom templates', async () => {
    const { userData, service } = await fixture()
    const created = await service.saveTemplate({
      name: '团队规则',
      scope: 'project',
      description: '团队约定',
      content: '# Team\n'
    })
    expect(created.builtin).toBe(false)
    expect(created.id.startsWith('custom:')).toBe(true)
    const list = await service.listTemplates()
    expect(list.filter((template) => template.builtin)).toHaveLength(9)
    expect(list.find((template) => template.id === created.id)?.name).toBe('团队规则')

    const restored = new ClaudeMdService({
      userData,
      homeDir: userData,
      resolveProjectPath: async () => null
    })
    expect((await restored.listTemplates()).some((template) => template.id === created.id)).toBe(true)
  })

  it('updates and deletes custom templates', async () => {
    const { service } = await fixture()
    const created = await service.saveTemplate({ name: 'A', scope: 'global', content: 'a' })
    const updated = await service.saveTemplate({
      id: created.id,
      name: 'B',
      scope: 'global',
      content: 'b'
    })
    expect(updated.name).toBe('B')
    expect(updated.content).toBe('b')
    await service.deleteTemplate(created.id)
    expect((await service.listTemplates()).some((template) => template.id === created.id)).toBe(false)
    await expect(service.deleteTemplate(created.id)).rejects.toThrow('模板不存在')
  })

  it('refuses to modify or delete built-in templates', async () => {
    const { service } = await fixture()
    await expect(service.saveTemplate({
      id: 'builtin:global:01-minimal',
      name: 'x',
      scope: 'global',
      content: 'x'
    })).rejects.toThrow('内置模板不能修改')
    await expect(service.deleteTemplate('builtin:global:01-minimal'))
      .rejects.toThrow('内置模板不能删除')
  })

  it('falls back to no custom templates when the store is corrupt', async () => {
    const { userData, service } = await fixture()
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'claude-md-templates.json'), '{broken', 'utf8')
    const custom = (await service.listTemplates()).filter((template) => !template.builtin)
    expect(custom).toEqual([])
  })

  it('imports an .md file as a custom template', async () => {
    const { dir, service } = await fixture()
    const source = join(dir, 'review-rules.md')
    await writeFile(source, '# Review\n\nRead only.\n', 'utf8')
    const imported = await service.importTemplate('project', source)
    expect(imported.name).toBe('review-rules')
    expect(imported.scope).toBe('project')
    expect(imported.content).toBe('# Review\n\nRead only.\n')
    await expect(service.importTemplate('project', join(dir, 'notes.txt')))
      .rejects.toThrow('.md')
    await expect(service.importTemplate('project', join(dir, 'missing.md')))
      .rejects.toThrow('模板文件不存在')
    const folder = join(dir, 'folder.md')
    await mkdir(folder)
    await expect(service.importTemplate('project', folder))
      .rejects.toThrow('导入目标不是文件')
    const big = join(dir, 'big.md')
    await writeFile(big, 'x'.repeat(MAX_CLAUDE_MD_BYTES + 1), 'utf8')
    await expect(service.importTemplate('project', big)).rejects.toThrow('1 MiB')
  })

  it('validates template names and content sizes', async () => {
    const { service } = await fixture()
    await expect(service.saveTemplate({ name: '   ', scope: 'global', content: 'x' }))
      .rejects.toThrow('名称不能为空')
    await expect(service.saveTemplate({ name: 'x'.repeat(61), scope: 'global', content: 'x' }))
      .rejects.toThrow('60')
    await expect(service.saveTemplate({
      name: 'ok',
      scope: 'global',
      content: 'x'.repeat(MAX_CLAUDE_MD_BYTES + 1)
    })).rejects.toThrow('1 MiB')
    await expect(service.saveTemplate({
      name: 'ok',
      scope: 'global',
      description: 'x'.repeat(201),
      content: 'x'
    })).rejects.toThrow('200')
    await expect(service.saveTemplate({
      id: 'custom:missing',
      name: 'x',
      scope: 'global',
      content: 'x'
    })).rejects.toThrow('模板不存在')
  })

  it('enforces the 200 custom template limit', async () => {
    const { userData, service } = await fixture()
    const templates = Array.from({ length: 200 }, (_, index) => ({
      id: `custom:${index}`,
      name: `T${index}`,
      scope: 'global',
      description: '',
      content: 'x',
      createdAt: 1,
      updatedAt: 1
    }))
    await mkdir(userData, { recursive: true })
    await writeFile(
      join(userData, 'claude-md-templates.json'),
      JSON.stringify({ version: 1, templates }),
      'utf8'
    )
    await expect(service.saveTemplate({ name: 'extra', scope: 'global', content: 'x' }))
      .rejects.toThrow('上限')
  })

  it('ignores invalid stored entries and keeps valid custom templates', async () => {
    const { userData, service } = await fixture()
    const store = {
      version: 1,
      templates: [
        { id: 'builtin:global:01-minimal', name: 'bad builtin', scope: 'global', content: 'x' },
        { id: 'custom:valid', name: 'Valid', scope: 'project', description: 'ok', content: '# V\n', createdAt: 1, updatedAt: 2 },
        { id: 'custom:bad-scope', name: 'Bad', scope: 'other', content: 'x' },
        { id: 'custom:no-content', name: 'No content', scope: 'global' },
        { id: 'custom:huge', name: 'Huge', scope: 'global', content: 'x'.repeat(MAX_CLAUDE_MD_BYTES + 1) }
      ]
    }
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'claude-md-templates.json'), JSON.stringify(store), 'utf8')
    const custom = (await service.listTemplates()).filter((template) => !template.builtin)
    expect(custom).toHaveLength(1)
    expect(custom[0].id).toBe('custom:valid')
    expect(custom[0].name).toBe('Valid')
  })

  it('preserves a corrupt template store before falling back', async () => {
    const { userData, service } = await fixture()
    await mkdir(userData, { recursive: true })
    const storePath = join(userData, 'claude-md-templates.json')
    await writeFile(storePath, '{broken', 'utf8')
    expect((await service.listTemplates()).filter((template) => !template.builtin)).toEqual([])
    const files = await readdir(userData)
    const preserved = files.find((name) => name.startsWith('claude-md-templates.json.corrupt-'))
    expect(preserved).toBeTruthy()
    expect(files.includes('claude-md-templates.json')).toBe(false)
    expect(await readFile(join(userData, preserved!), 'utf8')).toBe('{broken')
  })

  it('serializes concurrent template creates and deletes', async () => {
    const { service } = await fixture()
    const [a, b] = await Promise.all([
      service.saveTemplate({ name: 'A', scope: 'global', content: 'a' }),
      service.saveTemplate({ name: 'B', scope: 'project', content: 'b' })
    ])
    const custom = (await service.listTemplates()).filter((template) => !template.builtin)
    expect(custom.map((template) => template.id).sort()).toEqual([a.id, b.id].sort())
    await Promise.all([
      service.deleteTemplate(a.id),
      service.saveTemplate({ name: 'C', scope: 'global', content: 'c' })
    ])
    const remaining = (await service.listTemplates()).filter((template) => !template.builtin)
    expect(remaining.some((template) => template.id === a.id)).toBe(false)
    expect(remaining.some((template) => template.name === 'C')).toBe(true)
  })

  it('enforces the content limit by UTF-8 bytes, not characters', async () => {
    const { service } = await fixture()
    const tooLarge = '中'.repeat(Math.floor(MAX_CLAUDE_MD_BYTES / 3) + 1)
    await expect(service.saveTemplate({ name: '中文', scope: 'global', content: tooLarge }))
      .rejects.toThrow('1 MiB')
  })

  it('allows updating an existing template when the store is at the limit', async () => {
    const { userData, service } = await fixture()
    const templates = Array.from({ length: 200 }, (_, index) => ({
      id: `custom:${index}`,
      name: `T${index}`,
      scope: 'global',
      description: '',
      content: 'x',
      createdAt: 1,
      updatedAt: 1
    }))
    await mkdir(userData, { recursive: true })
    await writeFile(
      join(userData, 'claude-md-templates.json'),
      JSON.stringify({ version: 1, templates }),
      'utf8'
    )
    const updated = await service.saveTemplate({
      id: 'custom:199',
      name: 'Updated',
      scope: 'global',
      content: 'y'
    })
    expect(updated.name).toBe('Updated')
    expect(updated.createdAt).toBe(1)
    expect(updated.updatedAt).toBeGreaterThan(1)
  })

  it('strips a UTF-8 BOM and rejects binary template files', async () => {
    const { dir, service } = await fixture()
    const bom = join(dir, 'bom.md')
    await writeFile(bom, '\uFEFF# BOM\n', 'utf8')
    const imported = await service.importTemplate('global', bom)
    expect(imported.content).toBe('# BOM\n')

    const binary = join(dir, 'binary.md')
    await writeFile(binary, 'a\u0000b', 'utf8')
    await expect(service.importTemplate('global', binary)).rejects.toThrow('二进制')
  })
})