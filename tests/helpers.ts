import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function tempDir(prefix = 'csm-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function writeJsonl(
  filePath: string,
  records: Array<unknown | string>
): Promise<void> {
  const lines = records.map((record) =>
    typeof record === 'string' ? record : JSON.stringify(record)
  )
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8')
}