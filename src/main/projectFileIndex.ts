import { readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

interface IndexedFiles { paths: string[]; complete: boolean }
const OMIT = new Set(['.git', '.svn', '.hg', 'node_modules', '.venv', 'venv', '__pycache__', '.gradle', '.m2', 'target', 'obj'])

export class ProjectFileIndex {
  private readonly cache = new Map<string, { expires: number; result: Promise<IndexedFiles> }>()

  clear(): void { this.cache.clear() }

  private async scan(root: string): Promise<IndexedFiles> {
    const paths: string[] = []
    const directories = [{ path: root, depth: 0 }]
    const deadline = Date.now() + 4000
    let visited = 0
    let complete = true
    while (directories.length) {
      if (visited > 50000 || Date.now() > deadline) { complete = false; break }
      const batch = directories.splice(0, 8)
      await Promise.all(batch.map(async (directory) => {
        try {
          for (const entry of await readdir(directory.path, { withFileTypes: true })) {
            if (++visited > 50000) { complete = false; break }
            // Do not traverse junctions or symlinks outside the project's tree.
            if (entry.isSymbolicLink()) continue
            const path = join(directory.path, entry.name)
            if (entry.isFile()) paths.push(path)
            else if (entry.isDirectory() && !OMIT.has(entry.name.toLowerCase())) {
              if (directory.depth >= 24) complete = false
              else directories.push({ path, depth: directory.depth + 1 })
            }
          }
        } catch { complete = false }
      }))
    }
    return { paths, complete }
  }

  async find(root: string, suffix: string): Promise<IndexedFiles> {
    const key = resolve(root).toLowerCase()
    let cached = this.cache.get(key)
    if (!cached || cached.expires <= Date.now()) {
      cached = { expires: Infinity, result: this.scan(root) }
      this.cache.set(key, cached)
      const entry = cached
      void entry.result.finally(() => { entry.expires = Date.now() + 3000 }).catch(() => undefined)
      if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!)
    }
    const result = await cached.result
    const ending = suffix.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
    return { complete: result.complete, paths: result.paths.filter((path) => {
      const local = relative(root, path).replace(/\\/g, '/').toLowerCase()
      return local === ending || local.endsWith('/' + ending)
    }) }
  }
}
