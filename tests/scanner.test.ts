import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS } from '@shared/types'
import { ConfigStore } from '../src/main/config'
import { Scanner } from '../src/main/scanner'
import { tempDir, writeJsonl } from './helpers'

const SID1 = '44444444-4444-4444-8444-444444444444'
const SID2 = '55555555-5555-4555-8555-555555555555'
const H1 = '66666666-6666-4666-8666-666666666666'
const H2 = '77777777-7777-4777-8777-777777777777'
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})

async function setup() {
  const root = await tempDir()
  const configDir = await tempDir()
  const realProject = await tempDir()
  dirs.push(root, configDir, realProject)
  const projectDir = join(root, 'E--demo')
  await mkdir(projectDir, { recursive: true })
  await writeJsonl(join(projectDir, `${SID1}.jsonl`), [
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-11-13T10:00:00.000Z',
      cwd: realProject,
      sessionId: SID1,
      origin: { kind: 'human' },
      message: { role: 'user', content: '第一个会话' }
    },
    { type: 'ai-title', aiTitle: '会话一', sessionId: SID1 }
  ])
  await writeJsonl(join(projectDir, `${SID2}.jsonl`), [
    {
      type: 'user',
      uuid: 'u2',
      timestamp: '2026-11-14T10:00:00.000Z',
      cwd: realProject,
      sessionId: SID2,
      origin: { kind: 'human' },
      message: { role: 'user', content: '第二个会话' }
    }
  ])
  await mkdir(join(projectDir, SID1), { recursive: true })
  const config = new ConfigStore(configDir)
  await config.setFavorite(SID1, true)
  return { root, configDir, projectDir, realProject, config }
}

describe('Scanner', () => {
  it('scans projects, sessions, favorites and sidecars', async () => {
    const { root, configDir, projectDir, realProject, config } = await setup()
    const result = await new Scanner(
      root,
      config,
      join(configDir, 'history.jsonl')
    ).scan()

    expect(result.snapshot.dataRootExists).toBe(true)
    expect(result.snapshot.projects).toHaveLength(1)
    expect(result.snapshot.projects[0]).toMatchObject({
      key: 'E--demo',
      name: basename(realProject),
      path: realProject,
      sessionCount: 2
    })
    expect(result.snapshot.sessions).toHaveLength(2)

    const first = result.snapshot.sessions.find((session) => session.id === SID1)
    expect(first).toMatchObject({
      title: '会话一',
      favorite: true,
      cwdExists: true,
      hasSidecar: true,
      messageCount: 1
    })
    expect(result.sessionFiles[`E--demo/${SID1}`]).toBe(
      join(projectDir, `${SID1}.jsonl`)
    )
    expect(result.projectPaths['E--demo']).toBe(realProject)
  })

  it('writes the metadata cache', async () => {
    const { root, configDir, config } = await setup()
    await new Scanner(root, config, join(configDir, 'history.jsonl')).scan()
    const cache = JSON.parse(await readFile(join(configDir, 'cache.json'), 'utf8'))
    expect(Object.keys(cache.sessions)).toHaveLength(2)
    expect(cache.version).toBe(1)
  })

  it('returns an empty snapshot when the data root is missing', async () => {
    const configDir = await tempDir()
    dirs.push(configDir)
    const result = await new Scanner(
      join(configDir, 'missing'),
      new ConfigStore(configDir),
      join(configDir, 'missing-history.jsonl')
    ).scan()
    expect(result.snapshot.dataRootExists).toBe(false)
    expect(result.snapshot.projects).toEqual([])
    expect(result.snapshot.sessions).toEqual([])
  })

  it('merges history-only sessions and creates projects for missing directories', async () => {
    const { root, configDir, realProject, config } = await setup()
    const otherProject = await tempDir()
    dirs.push(otherProject)
    const historyFile = join(configDir, 'history.jsonl')
    await writeJsonl(historyFile, [
      {
        display: '与 transcript 重复的提示',
        pastedContents: {},
        timestamp: 1000,
        project: realProject,
        sessionId: SID1
      },
      {
        display: '仅历史会话一',
        pastedContents: {},
        timestamp: 2000,
        project: realProject,
        sessionId: H1
      },
      {
        display: '仅历史会话二',
        pastedContents: {},
        timestamp: 3000,
        project: otherProject,
        sessionId: H2
      }
    ])

    const result = await new Scanner(root, config, historyFile, {
      ...DEFAULT_APP_SETTINGS,
      loadHistory: true
    }).scan()
    expect(result.snapshot.transcriptCount).toBe(2)
    expect(result.snapshot.historyOnlyCount).toBe(2)
    expect(result.snapshot.historyFileExists).toBe(true)
    expect(result.snapshot.sessions).toHaveLength(4)

    const demo = result.snapshot.projects.find((project) => project.key === 'E--demo')
    expect(demo).toMatchObject({
      transcriptCount: 2,
      historyCount: 1,
      sessionCount: 3
    })

    const pseudo = result.snapshot.projects.find((project) =>
      project.key.startsWith('history:')
    )
    expect(pseudo).toMatchObject({
      path: otherProject,
      transcriptCount: 0,
      historyCount: 1,
      sessionCount: 1
    })
    expect(result.snapshot.sessions.find((session) => session.key === `history/${H1}`)).toMatchObject({
      source: 'history',
      promptCount: 1
    })
    expect(result.historyRecords[`history/${H1}`]).toHaveLength(1)
    expect(result.historyRecords[`history/${SID1}`]).toBeUndefined()
  })

  it('does not load history when disabled in settings', async () => {
    const { root, configDir, realProject, config } = await setup()
    const historyFile = join(configDir, 'history.jsonl')
    await writeJsonl(historyFile, [
      {
        display: '默认不加载的历史',
        pastedContents: {},
        timestamp: 5000,
        project: realProject,
        sessionId: H1
      }
    ])

    const result = await new Scanner(root, config, historyFile).scan()
    expect(result.snapshot.historyOnlyCount).toBe(0)
    expect(result.snapshot.sessions).toHaveLength(2)
    expect(result.historyRecords).toEqual({})
  })
  it('does not rewrite the metadata cache when nothing changed', async () => {
    const { root, configDir, config } = await setup()
    const historyFile = join(configDir, 'history.jsonl')
    await new Scanner(root, config, historyFile).scan()
    const writeCache = vi.spyOn(config, 'writeCache')
    await new Scanner(root, config, historyFile).scan()
    expect(writeCache).not.toHaveBeenCalled()
    writeCache.mockRestore()
  })

})
