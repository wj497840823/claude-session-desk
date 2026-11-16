import { afterEach, describe, expect, it, vi } from 'vitest'
import { debounce } from '../src/main/debounce'

afterEach(() => {
  vi.useRealTimers()
})

describe('debounce', () => {
  it('runs once after the quiet period', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const debounced = debounce(fn, 800)
    debounced()
    debounced()
    vi.advanceTimersByTime(799)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('can be cancelled', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const debounced = debounce(fn, 800)
    debounced()
    debounced.cancel()
    vi.advanceTimersByTime(2000)
    expect(fn).not.toHaveBeenCalled()
  })
})