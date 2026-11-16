const stoppers = new Map<string, () => Promise<void>>()

export function registerTerminalStopper(key: string, stop: () => Promise<void>): () => void {
  stoppers.set(key, stop)
  return () => { if (stoppers.get(key) === stop) stoppers.delete(key) }
}

export async function stopTerminalTabs(keys: string[]): Promise<{ closed: string[]; failed: string[] }> {
  const unique = [...new Set(keys)]
  const results = await Promise.allSettled(unique.map((key) => stoppers.get(key)?.()))
  return {
    closed: unique.filter((_, i) => results[i].status === 'fulfilled'),
    failed: unique.filter((_, i) => results[i].status === 'rejected')
  }
}
