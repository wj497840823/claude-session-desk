import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { debounce } from './debounce'

export interface WatchHandlers {
  onChange: () => void
  onError?: (error: Error) => void
}

export function watchDataRoot(root: string, handlers: WatchHandlers): () => void {
  const debounced = debounce(handlers.onChange, 1200)
  let watcher: FSWatcher

  try {
    // history.jsonl is a sibling of projects, and projects may not exist yet.
    const projectFolder = basename(root)
    watcher = watch(dirname(root), { recursive: true }, (_event, filename) => {
      const name = filename?.toString().replace(/\\/g, '/')
      if (!name || name === 'history.jsonl' || name === projectFolder ||
        name.startsWith(`${projectFolder}/`)) debounced()
    })
  } catch (error) {
    handlers.onError?.(error as Error)
    return () => undefined
  }

  watcher.on('error', (error) => handlers.onError?.(error as Error))

  return () => {
    debounced.cancel()
    watcher.close()
  }
}
