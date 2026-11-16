import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AppServices } from '../src/main/services'
import { ConfigStore } from '../src/main/config'
import { tempDir, writeJsonl } from './helpers'

const mocked = vi.hoisted(() => ({ trash: vi.fn() }))
vi.mock('electron', () => ({ dialog: {}, shell: { trashItem: mocked.trash } }))
const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks(); mocked.trash.mockReset()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})
async function fixture() {
  const dir = await tempDir()
  dirs.push(dir)
  const root = join(dir, 'projects')
  await mkdir(join(root, 'demo'), { recursive: true })
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
  for (const id of ids) await writeJsonl(join(root, 'demo', id + '.jsonl'), [{
    type: 'user', uuid: id, sessionId: id, cwd: dir,
    message: { role: 'user', content: id }
  }])
  const config = new ConfigStore(join(dir, 'config'))
  for (const id of ids) await config.setFavorite(id, true)
  const service = new AppServices(root, config, () => null)
  await service.getSnapshot()
  return { service, config, ids, keys: ids.map((id) => 'demo/' + id) }
}

it('validates the complete batch before stopping or deleting anything', async () => {
  const { service, keys } = await fixture()
  const stop = vi.fn()
  await expect(service.deleteSessions([keys[0], 'demo/33333333-3333-4333-8333-333333333333'], stop)).rejects.toThrow()
  expect(stop).not.toHaveBeenCalled()
  expect(mocked.trash).not.toHaveBeenCalled()
  expect((await service.getSnapshot()).sessions).toHaveLength(2)
})

it('waits for terminal shutdown, reports partial failure, and refreshes once', async () => {
  const { service, config, ids, keys } = await fixture()
  const order: string[] = []
  const stop = vi.fn(async () => { order.push('stopped') })
  mocked.trash.mockImplementation(async (path: string) => {
    order.push('trash')
    if (path.endsWith(ids[1] + '.jsonl')) throw new Error('fixture access denied')
    await rm(path)
  })
  const refresh = vi.spyOn(service, 'refresh')
  const result = await service.deleteSessions([keys[0], keys[0], keys[1]], stop)
  expect(stop).toHaveBeenCalledWith(ids)
  expect(order[0]).toBe('stopped')
  expect(result).toMatchObject({ ok: false, deletedKeys: [keys[0]], failedKeys: [keys[1]] })
  expect(refresh).toHaveBeenCalledOnce()
  expect((await service.getSnapshot()).sessions.map((s) => s.key)).toEqual([keys[1]])
  expect(await config.readFavorites()).toEqual([ids[1]])
})
