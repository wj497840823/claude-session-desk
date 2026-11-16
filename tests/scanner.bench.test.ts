import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ConfigStore } from '../src/main/config'
import { Scanner } from '../src/main/scanner'
import { tempDir, writeJsonl } from './helpers'

// Opt in with CSM_BENCHMARK=1; timings are observations, never CI thresholds.
it.skipIf(!process.env.CSM_BENCHMARK)('measures a 300-session scan with 100 records each', async () => {
  const dir = await tempDir('csm-benchmark-')
  try {
    const root = join(dir, 'projects')
    const project = join(root, 'demo')
    await mkdir(project, { recursive: true })
    for (let session = 0; session < 300; session += 1) {
      const sessionId = randomUUID()
      await writeJsonl(join(project, `${sessionId}.jsonl`), Array.from({ length: 100 }, (_, i) => ({
        type: 'user', uuid: `${session}-${i}`, sessionId, cwd: dir,
        timestamp: '2026-11-16T00:00:00Z',
        message: { role: 'user', content: `Record ${i} ${'sample '.repeat(60)}` }
      })))
    }
    const cold: number[] = []
    const warm: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const config = new ConfigStore(join(dir, `config-${i}`))
      const scanner = new Scanner(root, config)
      let start = performance.now()
      expect((await scanner.scan()).snapshot.sessions).toHaveLength(300)
      cold.push(Math.round(performance.now() - start))
      start = performance.now()
      await scanner.scan()
      warm.push(Math.round(performance.now() - start))
    }
    const result = JSON.stringify({ sessions: 300, records: 30000, coldMs: cold, warmMs: warm })
    console.log(result)
    if (process.env.CSM_BENCHMARK_OUTPUT) {
      await writeFile(process.env.CSM_BENCHMARK_OUTPUT, result, 'utf8')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)
