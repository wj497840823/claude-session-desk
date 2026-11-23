import type { GitChangeKind, GitFileEntry, GitStatus } from '@shared/types'
import type { NumstatEntry, ParsedGitStatus } from './gitPorcelain'

export interface BuildGitStatusInput {
  projectKey: string
  repoRoot: string
  parsed: ParsedGitStatus
  stagedStats: NumstatEntry[]
  worktreeStats: NumstatEntry[]
}

function kindOf(status: string): GitChangeKind | null {
  switch (status) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typechange'
    default:
      return null
  }
}

function statMap(entries: NumstatEntry[]): Map<string, NumstatEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]))
}

export function buildGitStatus(input: BuildGitStatusInput): GitStatus {
  const stagedStats = statMap(input.stagedStats)
  const worktreeStats = statMap(input.worktreeStats)

  const files: GitFileEntry[] = input.parsed.files.map((file) => {
    if (file.untracked) {
      return {
        path: file.path,
        indexKind: null,
        worktreeKind: null,
        untracked: true
      }
    }
    if (file.conflict) {
      return {
        path: file.path,
        indexKind: null,
        worktreeKind: null,
        conflict: true
      }
    }
    const staged = stagedStats.get(file.path)
    const worktree = worktreeStats.get(file.path)
    return {
      path: file.path,
      origPath: file.origPath,
      indexKind: kindOf(file.indexStatus),
      worktreeKind: kindOf(file.worktreeStatus),
      stagedAdditions: staged?.additions,
      stagedDeletions: staged?.deletions,
      worktreeAdditions: worktree?.additions,
      worktreeDeletions: worktree?.deletions,
      binary: Boolean(staged?.binary || worktree?.binary)
    }
  })

  const kinds = new Map<GitChangeKind, Set<string>>()
  for (const file of files) {
    if (file.indexKind) {
      const set = kinds.get(file.indexKind) ?? new Set<string>()
      set.add(file.path)
      kinds.set(file.indexKind, set)
    }
    if (file.worktreeKind) {
      const set = kinds.get(file.worktreeKind) ?? new Set<string>()
      set.add(file.path)
      kinds.set(file.worktreeKind, set)
    }
  }

  return {
    projectKey: input.projectKey,
    isRepo: true,
    repoRoot: input.repoRoot,
    branch: input.parsed.branch,
    oid: input.parsed.oid,
    detached: input.parsed.detached,
    upstream: input.parsed.upstream,
    ahead: input.parsed.ahead,
    behind: input.parsed.behind,
    files,
    counts: {
      files: files.length,
      staged: files.filter((file) => !file.conflict && file.indexKind !== null).length,
      unstaged: files.filter((file) => !file.conflict && file.worktreeKind !== null).length,
      untracked: files.filter((file) => file.untracked).length,
      unmerged: files.filter((file) => file.conflict).length,
      modified: kinds.get('modified')?.size ?? 0,
      added: kinds.get('added')?.size ?? 0,
      deleted: kinds.get('deleted')?.size ?? 0,
      renamed: kinds.get('renamed')?.size ?? 0
    },
    truncated: input.parsed.truncated,
    scannedAt: Date.now()
  }
}