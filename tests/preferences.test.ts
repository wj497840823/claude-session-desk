import { expect, it } from 'vitest'
import { parseStoredBoolean } from '../src/renderer/src/lib/preferences'

it('restores collapsed panels from the boolean strings written by the store', () => {
  expect(parseStoredBoolean(String(true), false)).toBe(true)
  expect(parseStoredBoolean(String(false), true)).toBe(false)
  expect(parseStoredBoolean('1', false)).toBe(true)
  expect(parseStoredBoolean('0', true)).toBe(false)
  expect(parseStoredBoolean(null, true)).toBe(true)
  expect(parseStoredBoolean('corrupt', true)).toBe(true)
})
