import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ open: vi.fn(), reveal: vi.fn() }))
vi.mock('electron', () => ({
  shell: { openPath: mocks.open, showItemInFolder: mocks.reveal }
}))

const execFileAsync = promisify(execFile)
const dirs: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function hasGit(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}

async function repoFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'csm-git-'))
  dirs.push(dir)
  await git(dir, ['init', '-q'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await git(dir, ['config', 'user.name', 'Test'])
  await git(dir, ['config', 'core.autocrlf', 'false'])
  return dir
}

async function serviceFor(projectPath: string) {
  const { GitService } = await import('../src/main/git')
  return new GitService({
    resolveProjectPath: async (key) => (key === 'p1' ? projectPath : null)
  })
}

const available = await hasGit()
const describeGit = available ? describe : describe.skip

describeGit('GitService read', () => {
  it('reports modified and untracked files', async () => {
    const repo = await repoFixture()
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['commit', '-qm', 'init'])
    await writeFile(join(repo, 'a.txt'), 'two\n')
    await writeFile(join(repo, 'b.txt'), 'new\n')

    const service = await serviceFor(repo)
    const status = await service.status('p1', true)

    expect(status.isRepo).toBe(true)
    expect(status.branch).toBeTruthy()
    expect(status.counts.files).toBe(2)
    const a = status.files.find((file) => file.path === 'a.txt')
    expect(a?.worktreeKind).toBe('modified')
    expect(a?.indexKind).toBeNull()
    const b = status.files.find((file) => file.path === 'b.txt')
    expect(b?.untracked).toBe(true)
  })

  it('splits staged and unstaged changes for the same file', async () => {
    const repo = await repoFixture()
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['commit', '-qm', 'init'])
    await writeFile(join(repo, 'a.txt'), 'two\n')
    await git(repo, ['add', 'a.txt'])
    await writeFile(join(repo, 'a.txt'), 'three\n')

    const service = await serviceFor(repo)
    const status = await service.status('p1', true)
    const a = status.files.find((file) => file.path === 'a.txt')

    expect(a?.indexKind).toBe('modified')
    expect(a?.worktreeKind).toBe('modified')
    expect(status.counts.staged).toBe(1)
    expect(status.counts.unstaged).toBe(1)
  })

  it('returns staged, unstaged and untracked diffs', async () => {
    const repo = await repoFixture()
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['commit', '-qm', 'init'])
    await writeFile(join(repo, 'a.txt'), 'two\n')
    await writeFile(join(repo, 'b.txt'), 'new\n')

    const service = await serviceFor(repo)
    const unstaged = await service.diff('p1', 'a.txt', 'unstaged')
    expect(unstaged.diff).toContain('+two')
    const untracked = await service.diff('p1', 'b.txt', 'untracked')
    expect(untracked.diff).toContain('+new')
  })

  it('reports a non-repository project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csm-git-'))
    dirs.push(dir)
    const service = await serviceFor(dir)
    const status = await service.status('p1', true)
    expect(status.isRepo).toBe(false)
    expect(status.error?.code).toBe('not-a-repo')
  })

  it('uses literal pathspecs for files with glob characters', async () => {
    const repo = await repoFixture()
    const name = 'a[1].txt'
    await writeFile(join(repo, name), 'one\n')
    await git(repo, ['add', '-A', '.'])
    await git(repo, ['commit', '-qm', 'init'])
    await writeFile(join(repo, name), 'two\n')

    const service = await serviceFor(repo)
    const status = await service.status('p1', true)
    expect(status.files.some((file) => file.path === name)).toBe(true)
    const diff = await service.diff('p1', name, 'unstaged')
    expect(diff.diff).toContain('+two')
  })

  it('ignores inherited Git repository overrides', async () => {
    const repoA = await repoFixture()
    const repoB = await repoFixture()
    await writeFile(join(repoA, 'a.txt'), 'one\n')
    await git(repoA, ['add', '-A', '.'])
    await git(repoA, ['commit', '-qm', 'init'])
    await writeFile(join(repoA, 'a.txt'), 'two\n')
    const service = await serviceFor(repoA)
    const previous = {
      dir: process.env.GIT_DIR,
      workTree: process.env.GIT_WORK_TREE,
      index: process.env.GIT_INDEX_FILE
    }
    process.env.GIT_DIR = join(repoB, '.git')
    process.env.GIT_WORK_TREE = repoB
    try {
      const status = await service.status('p1', true)
      expect(status.isRepo).toBe(true)
      expect(status.repoRoot?.replace(/\\/g, '/').toLowerCase())
        .toBe(repoA.replace(/\\/g, '/').toLowerCase())
      expect(status.files.find((file) => file.path === 'a.txt')?.worktreeKind).toBe('modified')
    } finally {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      restore('GIT_DIR', previous.dir)
      restore('GIT_WORK_TREE', previous.workTree)
      restore('GIT_INDEX_FILE', previous.index)
    }
  })

  it('rejects diff for a path outside the current status', async () => {
    const repo = await repoFixture()
    const service = await serviceFor(repo)
    await service.status('p1', true)
    await expect(service.diff('p1', '../outside.txt', 'unstaged')).rejects.toThrow(
      '文件不在当前变更列表中'
    )
  })

  it('stages and unstages a single file', async () => {
    const repo = await repoFixture()
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['commit', '-qm', 'init'])
    await writeFile(join(repo, 'b.txt'), 'new\n')

    const service = await serviceFor(repo)
    await service.status('p1', true)
    const staged = await service.stageFile('p1', 'b.txt')
    expect(staged.ok).toBe(true)

    let status = await service.status('p1', true)
    expect(status.files.find((file) => file.path === 'b.txt')?.indexKind).toBe('added')

    const unstaged = await service.unstageFile('p1', 'b.txt')
    expect(unstaged.ok).toBe(true)

    status = await service.status('p1', true)
    expect(status.files.find((file) => file.path === 'b.txt')?.untracked).toBe(true)
  })

  it('unstages files before the first commit', async () => {
    const repo = await repoFixture()
    await writeFile(join(repo, 'first.txt'), 'hello\n')
    const service = await serviceFor(repo)
    await service.status('p1', true)
    const staged = await service.stageFile('p1', 'first.txt')
    expect(staged.ok).toBe(true)
    await service.status('p1', true)

    const result = await service.unstageFile('p1', 'first.txt')
    expect(result.ok).toBe(true)
    const status = await service.status('p1', true)
    expect(status.files.find((file) => file.path === 'first.txt')?.untracked).toBe(true)
  })

  it('stages and unstages all changes', async () => {
    const repo = await repoFixture()
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['commit', '-qm', 'init'])
    await writeFile(join(repo, 'a.txt'), 'two\n')
    await writeFile(join(repo, 'b.txt'), 'new\n')

    const service = await serviceFor(repo)
    const staged = await service.stageAll('p1')
    expect(staged.ok).toBe(true)
    let status = await service.status('p1', true)
    expect(status.counts.staged).toBe(2)

    const unstaged = await service.unstageAll('p1')
    expect(unstaged.ok).toBe(true)
    status = await service.status('p1', true)
    expect(status.counts.staged).toBe(0)
  })

  it('commits staged changes and returns a short hash', async () => {
    const repo = await repoFixture()
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['commit', '-qm', 'init'])
    await writeFile(join(repo, 'a.txt'), 'two\n')

    const service = await serviceFor(repo)
    await service.status('p1', true)
    await service.stageFile('p1', 'a.txt')
    await service.status('p1', true)

    const result = await service.commit('p1', 'update a', true)
    expect(result.ok).toBe(true)
    expect(result.commit).toMatch(/^[0-9a-f]+$/)

    const status = await service.status('p1', true)
    expect(status.counts.files).toBe(0)
  })

  it('rejects commits without staged changes or with an empty message', async () => {
    const repo = await repoFixture()
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['commit', '-qm', 'init'])

    const service = await serviceFor(repo)
    const emptyMessage = await service.commit('p1', '   ', true)
    expect(emptyMessage.ok).toBe(false)

    const nothingStaged = await service.commit('p1', 'nothing', true)
    expect(nothingStaged.ok).toBe(false)
    expect(nothingStaged.message).toBe('没有已暂存的变更')
  })

  it('rejects paths outside the last status whitelist', async () => {
    const repo = await repoFixture()
    const service = await serviceFor(repo)
    await service.status('p1', true)
    const result = await service.stageFile('p1', '../outside.txt')
    expect(result.ok).toBe(false)
  })

  it('serializes concurrent stage operations', async () => {
    const repo = await repoFixture()
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['commit', '-qm', 'init'])
    await writeFile(join(repo, 'a.txt'), 'two\n')
    await writeFile(join(repo, 'b.txt'), 'new\n')

    const service = await serviceFor(repo)
    await service.status('p1', true)
    const [first, second] = await Promise.all([
      service.stageFile('p1', 'a.txt'),
      service.stageFile('p1', 'b.txt')
    ])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    const status = await service.status('p1', true)
    expect(status.counts.staged).toBe(2)
  })

  it('scopes status to a project subdirectory and uses project-relative paths', async () => {
    const repo = await repoFixture()
    await mkdir(join(repo, 'pkg'), { recursive: true })
    await writeFile(join(repo, 'pkg', 'a.txt'), 'one\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-qm', 'init'])
    await writeFile(join(repo, 'pkg', 'a.txt'), 'two\n')
    await writeFile(join(repo, 'root.txt'), 'outside\n')

    const service = await serviceFor(join(repo, 'pkg'))
    const status = await service.status('p1', true)
    expect(status.files.map((file) => file.path)).toEqual(['a.txt'])
    expect(status.files[0].worktreeKind).toBe('modified')

    const diff = await service.diff('p1', 'a.txt', 'unstaged')
    expect(diff.diff).toContain('+two')

    const staged = await service.stageFile('p1', 'a.txt')
    expect(staged.ok).toBe(true)
    const after = await service.status('p1', true)
    expect(after.files.find((file) => file.path === 'a.txt')?.indexKind).toBe(
      'modified'
    )
  })

  it('stages a deleted file', async () => {
    const repo = await repoFixture()
    await writeFile(join(repo, 'a.txt'), 'one\n')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['commit', '-qm', 'init'])
    await rm(join(repo, 'a.txt'))

    const service = await serviceFor(repo)
    await service.status('p1', true)
    const result = await service.stageFile('p1', 'a.txt')
    expect(result.ok).toBe(true)
    const status = await service.status('p1', true)
    expect(status.files.find((file) => file.path === 'a.txt')?.indexKind).toBe(
      'deleted'
    )
  })
})