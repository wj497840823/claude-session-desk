import type { ActionResult, FileContext } from '@shared/types'
import { useStore } from '../store'

const cache = new Map<string, { result: Promise<ActionResult>; expires: number }>()
const pending = new Map<string, { context: FileContext; refs: Map<string, (value: ActionResult) => void> }>()
let scheduled = false
let revision: number | undefined

async function flush(): Promise<void> {
  scheduled = false
  const groups = [...pending.values()]
  pending.clear()
  await Promise.all(groups.map(async ({ context, refs }) => {
    const entries = [...refs]
    for (let start = 0; start < entries.length; start += 128) {
      const batch = entries.slice(start, start + 128)
      try {
        const results = await window.api.checkFileReferences(context, batch.map(([reference]) => reference))
        batch.forEach(([, complete], index) => complete(results[index] ?? { ok: false, message: '文件未核验' }))
      } catch {
        for (const [, complete] of batch) complete({ ok: false, message: '暂时无法核验文件' })
      }
    }
  }))
}

export function checkFileReference(context: FileContext, reference: string): Promise<ActionResult> {
  const current = useStore.getState().snapshot?.scannedAt
  if (revision !== current) { cache.clear(); revision = current }
  const scope = JSON.stringify([context.sessionKey, context.sessionId])
  const key = scope + '\n' + reference
  const existing = cache.get(key)
  if (existing && existing.expires > Date.now()) return existing.result
  const entry = { expires: Infinity, result: Promise.resolve<ActionResult>({ ok: false }) }
  entry.result = new Promise<ActionResult>((resolve) => {
    let group = pending.get(scope)
    if (!group) { group = { context, refs: new Map() }; pending.set(scope, group) }
    const previous = group.refs.get(reference)
    group.refs.set(reference, (value) => { previous?.(value); resolve(value) })
  }).then((value) => {
    entry.expires = Date.now() + (value.ok ? 30000 : 1500)
    return value
  })
  cache.set(key, entry)
  if (cache.size > 4096) cache.delete(cache.keys().next().value!)
  if (!scheduled) { scheduled = true; window.setTimeout(() => { void flush() }, 0) }
  return entry.result
}
