import { describe, expect, it } from 'vitest'
import { buildGitStatus } from '../src/main/gitGroup'
import type { ParsedGitStatus } from '../src/main/gitPorcelain'

function parsed(overrides: Partial<ParsedGitStatus> = {}): ParsedGitStatus {
  return {
    branch: 'main',
    oid: 'abc',
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    truncated: false,
    ...overrides
  }
}

describe('buildGitStatus', () => {
  it('splits staged and unstaged changes on the same file', () => {
    const status = buildGitStatus({
      projectKey: 'p1',
      repoRoot: '/repo',
      parsed: parsed({
        files: [
          {
            path: 'a.txt',
            indexStatus: 'M',
            worktreeStatus: 'M',
            untracked: false,
            conflict: false
          }
        ]
      }),
      stagedStats: [{ path: 'a.txt', additions: 2, deletions: 0, binary: false }],
      worktreeStats: [{ path: 'a.txt', additions: 1, deletions: 1, binary: false }]
    })
    expect(status.files).toEqual([
      {
        path: 'a.txt',
        origPath: undefined,
        indexKind: 'modified',
        worktreeKind: 'modified',
        stagedAdditions: 2,
        stagedDeletions: 0,
        worktreeAdditions: 1,
        worktreeDeletions: 1,
        binary: false
      }
    ])
    expect(status.counts).toMatchObject({
      files: 1,
      staged: 1,
      unstaged: 1,
      untracked: 0,
      unmerged: 0,
      modified: 1
    })
  })

  it('keeps untracked and conflict entries separate from staged counts', () => {
    const status = buildGitStatus({
      projectKey: 'p1',
      repoRoot: '/repo',
      parsed: parsed({
        files: [
          {
            path: 'new.txt',
            indexStatus: '?',
            worktreeStatus: '?',
            untracked: true,
            conflict: false
          },
          {
            path: 'conflict.txt',
            indexStatus: 'U',
            worktreeStatus: 'U',
            untracked: false,
            conflict: true
          }
        ]
      }),
      stagedStats: [],
      worktreeStats: []
    })
    expect(status.counts).toMatchObject({
      files: 2,
      staged: 0,
      unstaged: 0,
      untracked: 1,
      unmerged: 1
    })
    expect(status.files[0].untracked).toBe(true)
    expect(status.files[1].conflict).toBe(true)
  })

  it('counts renames and deletions once per path', () => {
    const status = buildGitStatus({
      projectKey: 'p1',
      repoRoot: '/repo',
      parsed: parsed({
        files: [
          {
            path: 'new.txt',
            origPath: 'old.txt',
            indexStatus: 'R',
            worktreeStatus: '.',
            untracked: false,
            conflict: false
          },
          {
            path: 'gone.txt',
            indexStatus: 'D',
            worktreeStatus: '.',
            untracked: false,
            conflict: false
          }
        ]
      }),
      stagedStats: [{ path: 'new.txt', additions: 2, deletions: 2, binary: false }],
      worktreeStats: []
    })
    expect(status.counts.files).toBe(2)
    expect(status.counts.renamed).toBe(1)
    expect(status.counts.deleted).toBe(1)
    expect(status.counts.staged).toBe(2)
  })
})