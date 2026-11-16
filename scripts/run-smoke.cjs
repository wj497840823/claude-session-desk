const { spawnSync } = require('node:child_process')
const { join, dirname, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { mkdtempSync, rmSync } = require('node:fs')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const fixtureDir = mkdtempSync(join(tmpdir(), 'csm-smoke-'))
env.CSM_SMOKE_DIR = fixtureDir
const result = spawnSync(require('electron'), [join(__dirname, 'smoke.cjs')], {
  cwd: join(__dirname, '..'), env, stdio: 'inherit', windowsHide: true, timeout: 60000
})
// Chromium releases its profile files only after the Electron process exits.
if (dirname(resolve(fixtureDir)) !== resolve(tmpdir())) throw new Error('Unexpected fixture directory')
rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
