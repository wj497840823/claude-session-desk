const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const git = args => execFileSync('git', args, { cwd: root, windowsHide: true })
const top = git(['rev-parse', '--show-toplevel']).toString().trim()
if (path.resolve(top).toLowerCase() !== root.toLowerCase()) throw new Error('Expected a Git repository rooted at this project')
const files = git(['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean)
if (!files.length) throw new Error('Stage the reviewed public source files with git add before exporting')
const allowedRoot = new Set(['.gitignore', '.gitattributes', 'LICENSE', 'README.md', 'CONTRIBUTING.md',
  'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', 'electron-builder.yml',
  'electron.vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json', 'vitest.config.mts'])
const prohibited = /^(?:\.audit-backups|\.exe|\.superpowers|node_modules|out|dist|release-source|\.claude|\.codex)(?:\/|$)|^docs\/superpowers(?:\/|$)/
const problems = []
for (const file of files) {
  if (prohibited.test(file) || !(allowedRoot.has(file) || /^(?:src|tests|scripts|build|docs|\.github)\//.test(file))) problems.push({ file, reason: 'Unexpected or private path' })
  if (/\.(?:exe|zip|jsonl|key|pem|pfx|p12)$/i.test(file) || /(?:^|\/)\.env(?:\.|$)/.test(file)) problems.push({ file, reason: 'Private data, credential or binary file' })
}
const modes = git(['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean)
if (modes.some(entry => !/^100(?:644|755) /.test(entry))) throw new Error('Only regular source files may be exported')
const blobs = execFileSync('git', ['cat-file', '--batch'], {
  cwd: root, windowsHide: true, input: files.map(file => ':' + file).join('\n') + '\n', maxBuffer: 32 * 1024 * 1024
})
const checks = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['API secret', /\bsk-(?:ant-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{40,})\b/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Embedded URL credentials', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ['Personal Windows user path', /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+/]
]
const manifest = []
let offset = 0
for (const file of files) {
  const end = blobs.indexOf(10, offset)
  const header = blobs.subarray(offset, end).toString().split(' ')
  if (header[1] !== 'blob') throw new Error('Unexpected staged object: ' + file)
  const size = Number(header[2])
  const data = blobs.subarray(end + 1, end + 1 + size)
  offset = end + 2 + size
  if (size >= 50 * 1024 * 1024) problems.push({ file, reason: 'Large file should be distributed separately' })
  if (!/\.(?:png|bmp)$/i.test(file)) {
    const lines = data.toString('utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      for (const [reason, pattern] of checks) if (pattern.test(line)) problems.push({ file, line: index + 1, reason })
    })
  }
  manifest.push({ file, bytes: size, sha256: createHash('sha256').update(data).digest('hex') })
}
if (problems.length) { console.error(JSON.stringify({ passed: false, findings: problems }, null, 2)); process.exit(1) }
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const directory = path.join(root, 'release-source')
fs.mkdirSync(directory, { recursive: true })
const archive = path.join(directory, `claude-session-desk-${version}-source.zip`)
const tree = git(['write-tree']).toString().trim()
git(['archive', '--format=zip', '--prefix=claude-session-desk/', '--output=' + archive, tree])
const summary = { passed: true, version, files: manifest.length, tree, archive: path.basename(archive),
  bytes: fs.statSync(archive).size, sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), manifest }
fs.writeFileSync(path.join(directory, 'source-manifest.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ passed: true, version, files: manifest.length, archive, bytes: summary.bytes, sha256: summary.sha256 }))
