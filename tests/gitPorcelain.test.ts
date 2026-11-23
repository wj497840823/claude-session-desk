import { describe, expect, it } from 'vitest'
import { parseNumstatZ, parsePorcelainV2 } from '../src/main/gitPorcelain'

function statusRecord(record: string): string {
  return `${record}\0`
}

describe('parsePorcelainV2', () => {
  it('parses branch headers and ordinary entries', () => {
    const input = [
      '# branch.oid 5b32cfc9b3bc2bc783654a8fc8e2d34f2dea153c',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa src/main/ipc.ts',
      '? docs/new file.md',
      ''
    ].join('\0')
    const status = parsePorcelainV2(input)
    expect(status.branch).toBe('main')
    expect(status.detached).toBe(false)
    expect(status.upstream).toBe('origin/main')
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(1)
    expect(status.files).toHaveLength(2)
    expect(status.files[0]).toMatchObject({
      path: 'src/main/ipc.ts',
      indexStatus: '.',
      worktreeStatus: 'M',
      untracked: false,
      conflict: false
    })
    expect(status.files[1]).toMatchObject({ path: 'docs/new file.md', untracked: true })
  })

  it('handles detached HEAD and initial commit', () => {
    const status = parsePorcelainV2(
      ['# branch.oid (initial)', '# branch.head (detached)', ''].join('\0')
    )
    expect(status.oid).toBeNull()
    expect(status.branch).toBeNull()
    expect(status.detached).toBe(true)
  })

  it('consumes the original path of a rename', () => {
    const input =
      statusRecord(
        '2 RM N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R100 new name.txt'
      ) +
      'old name.txt\0' +
      statusRecord('? after.txt')
    const status = parsePorcelainV2(input)
    expect(status.files).toHaveLength(2)
    expect(status.files[0]).toMatchObject({
      path: 'new name.txt',
      origPath: 'old name.txt',
      indexStatus: 'R',
      worktreeStatus: 'M'
    })
    expect(status.files[1].path).toBe('after.txt')
  })

  it('parses unmerged entries and skips ignored entries', () => {
    const input =
      statusRecord(
        'u UU N... 100644 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc conflict dir/file.txt'
      ) + statusRecord('! ignored.log')
    const status = parsePorcelainV2(input)
    expect(status.files).toHaveLength(1)
    expect(status.files[0]).toMatchObject({
      path: 'conflict dir/file.txt',
      conflict: true,
      indexStatus: 'U',
      worktreeStatus: 'U'
    })
  })

  it('truncates when the file limit is exceeded', () => {
    const input = Array.from({ length: 3 }, (_, index) =>
      statusRecord(`? file${index}.txt`)
    ).join('')
    const status = parsePorcelainV2(input, 2)
    expect(status.files).toHaveLength(2)
    expect(status.truncated).toBe(true)
  })
})

describe('parseNumstatZ', () => {
  it('parses ordinary entries', () => {
    const entries = parseNumstatZ('12\t3\tsrc/main/ipc.ts\0-\t-\timage.png\0')
    expect(entries).toEqual([
      { path: 'src/main/ipc.ts', additions: 12, deletions: 3, binary: false },
      { path: 'image.png', additions: undefined, deletions: undefined, binary: true }
    ])
  })

  it('parses rename entries with an empty path field', () => {
    const entries = parseNumstatZ('2\t0\t\0old.txt\0new.txt\0')
    expect(entries).toEqual([
      { path: 'new.txt', origPath: 'old.txt', additions: 2, deletions: 0, binary: false }
    ])
  })
})