export interface ParsedGitFile {
  path: string
  origPath?: string
  indexStatus: string
  worktreeStatus: string
  untracked: boolean
  conflict: boolean
}

export interface ParsedGitStatus {
  branch: string | null
  oid: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  files: ParsedGitFile[]
  truncated: boolean
}

export interface NumstatEntry {
  path: string
  origPath?: string
  additions?: number
  deletions?: number
  binary: boolean
}

const MAX_STATUS_FILES = 2000

function numberOrUndefined(value: string): number | undefined {
  return /^\d+$/.test(value) ? Number(value) : undefined
}

export function parsePorcelainV2(
  input: string,
  maxFiles = MAX_STATUS_FILES
): ParsedGitStatus {
  const records = input.split('\0')
  const status: ParsedGitStatus = {
    branch: null,
    oid: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    truncated: false
  }

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue

    if (record.startsWith('# ')) {
      const space = record.indexOf(' ', 2)
      const key = space === -1 ? record.slice(2) : record.slice(2, space)
      const value = space === -1 ? '' : record.slice(space + 1)
      if (key === 'branch.oid') {
        status.oid = value === '(initial)' ? null : value
      } else if (key === 'branch.head') {
        status.detached = value === '(detached)'
        status.branch = status.detached ? null : value
      } else if (key === 'branch.upstream') {
        status.upstream = value
      } else if (key === 'branch.ab') {
        const match = /^\+(\d+)\s+-(\d+)$/.exec(value)
        if (match) {
          status.ahead = Number(match[1])
          status.behind = Number(match[2])
        }
      }
      continue
    }

    if (status.files.length >= maxFiles) {
      status.truncated = true
      break
    }

    const type = record[0]
    if (type === '1') {
      const parts = record.split(' ')
      const xy = parts[1] ?? '..'
      status.files.push({
        path: parts.slice(8).join(' '),
        indexStatus: xy[0] ?? '.',
        worktreeStatus: xy[1] ?? '.',
        untracked: false,
        conflict: false
      })
    } else if (type === '2') {
      const parts = record.split(' ')
      const xy = parts[1] ?? '..'
      const path = parts.slice(9).join(' ')
      const origPath = records[index + 1] ?? ''
      index += 1
      status.files.push({
        path,
        origPath,
        indexStatus: xy[0] ?? '.',
        worktreeStatus: xy[1] ?? '.',
        untracked: false,
        conflict: false
      })
    } else if (type === 'u') {
      const parts = record.split(' ')
      const xy = parts[1] ?? 'UU'
      status.files.push({
        path: parts.slice(10).join(' '),
        indexStatus: xy[0] ?? 'U',
        worktreeStatus: xy[1] ?? 'U',
        untracked: false,
        conflict: true
      })
    } else if (type === '?') {
      status.files.push({
        path: record.slice(2),
        indexStatus: '?',
        worktreeStatus: '?',
        untracked: true,
        conflict: false
      })
    }
  }

  return status
}

export function parseNumstatZ(input: string): NumstatEntry[] {
  const records = input.split('\0')
  const entries: NumstatEntry[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    const first = record.indexOf('\t')
    const second = record.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue

    const additions = record.slice(0, first)
    const deletions = record.slice(first + 1, second)
    const path = record.slice(second + 1)
    const binary = additions === '-' || deletions === '-'

    if (!path) {
      const origPath = records[index + 1] ?? ''
      const nextPath = records[index + 2] ?? ''
      index += 2
      entries.push({
        path: nextPath,
        origPath,
        additions: numberOrUndefined(additions),
        deletions: numberOrUndefined(deletions),
        binary
      })
    } else {
      entries.push({
        path,
        additions: numberOrUndefined(additions),
        deletions: numberOrUndefined(deletions),
        binary
      })
    }
  }

  return entries
}