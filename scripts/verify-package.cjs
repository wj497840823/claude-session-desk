const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const asar = require('@electron/asar')
const root = path.resolve(__dirname, '..')
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const archive = path.join(root, 'dist/win-unpacked/resources/app.asar')
const extract = (file) => asar.extractFile(archive, path.normalize(file))
const packaged = JSON.parse(extract('package.json').toString())
if (packaged.version !== expectedVersion) throw new Error('Wrong packaged version')
const files = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html',
  ...fs.readdirSync(path.join(root, 'out/renderer/assets')).map(file => 'out/renderer/assets/' + file)]
for (const file of files) {
  if (!extract(file).equals(fs.readFileSync(path.join(root, file)))) throw new Error('Packaged content mismatch: ' + file)
}
const modulePath = path.join(root, 'dist/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty')
const code = `
  const pty = require(${JSON.stringify(modulePath)});
  const results = Array.from({length: 12}, (_, i) => ({i, output:'', exitCode:null}));
  let exited = 0;
  for (const result of results) {
    const child = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d','/c','echo csm-packaged-pty-' + result.i], {
      cols:80, rows:24, cwd:process.cwd(), env:process.env, useConpty:true
    });
    child.onData(data => result.output += data);
    child.onExit(({exitCode}) => {
      result.exitCode = exitCode;
      if (++exited === results.length) setTimeout(() => {
        const passed = results.every(r => r.exitCode === 0 && r.output.includes('csm-packaged-pty-' + r.i));
        console.log(JSON.stringify({nativePtys:results.length, passed}));
        process.exit(passed ? 0 : 1);
      }, 30);
    });
  }
  setTimeout(() => process.exit(2), 12000);
`
const result = spawnSync(path.join(root, 'dist/win-unpacked/Claude Session Desk.exe'), ['-e', code], {
  cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 15000
})
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
if (result.error) throw result.error
if (result.status !== 0) throw new Error('Packaged PTY check failed: ' + result.status)
const summary = { version: packaged.version, filesVerified: files.length, nativePtys: 12, passed: true }
fs.mkdirSync(path.join(root, '.audit-backups'), { recursive: true })
fs.writeFileSync(path.join(root, '.audit-backups', 'package-' + expectedVersion + '.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
