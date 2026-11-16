import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { watchDataRoot } from '../src/main/watcher'

const mocks = vi.hoisted(() => ({ watch: vi.fn() }))
vi.mock('node:fs', () => ({ watch: mocks.watch }))
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

it('watches history and transcript changes, ignores unrelated files, and cancels on close', () => {
  vi.useFakeTimers()
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn() })
  mocks.watch.mockReturnValue(watcher)
  const onChange = vi.fn()
  const stop = watchDataRoot(join('claude', 'projects'), { onChange })
  expect(mocks.watch.mock.calls[0][0]).toBe('claude')
  const change = mocks.watch.mock.calls[0][2]
  change('change', 'settings.json')
  change('change', 'history.jsonl.bak')
  vi.advanceTimersByTime(1500)
  expect(onChange).not.toHaveBeenCalled()
  change('change', 'history.jsonl')
  vi.advanceTimersByTime(1500)
  expect(onChange).toHaveBeenCalledTimes(1)
  change('change', 'projects/demo/file.jsonl')
  change('change', 'projects\\demo\\file.jsonl')
  vi.advanceTimersByTime(1500)
  expect(onChange).toHaveBeenCalledTimes(2)
  change('rename', 'projects')
  stop()
  vi.advanceTimersByTime(1500)
  expect(onChange).toHaveBeenCalledTimes(2)
  expect(watcher.close).toHaveBeenCalledOnce()
})

it('reports a failed watcher instead of silently pretending to watch', () => {
  const error = new Error('missing directory')
  mocks.watch.mockImplementationOnce(() => { throw error })
  const onError = vi.fn()
  watchDataRoot('missing', { onChange: vi.fn(), onError })()
  expect(onError).toHaveBeenCalledWith(error)
})
