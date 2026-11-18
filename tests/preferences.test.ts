import { expect, it } from 'vitest'
import { adjustLegacyRailWidth, parseStoredBoolean } from '../src/renderer/src/lib/preferences'

it('restores collapsed panels from the boolean strings written by the store', () => {
  expect(parseStoredBoolean(String(true), false)).toBe(true)
  expect(parseStoredBoolean(String(false), true)).toBe(false)
  expect(parseStoredBoolean('1', false)).toBe(true)
  expect(parseStoredBoolean('0', true)).toBe(false)
  expect(parseStoredBoolean(null, true)).toBe(true)
  expect(parseStoredBoolean('corrupt', true)).toBe(true)
})

it('narrows the legacy default rail width once without touching custom widths', () => {
  expect(adjustLegacyRailWidth('320', false)).toBe(296)
  expect(adjustLegacyRailWidth('360', false)).toBeNull()
  expect(adjustLegacyRailWidth('240', false)).toBeNull()
  expect(adjustLegacyRailWidth('320', true)).toBeNull()
  expect(adjustLegacyRailWidth(null, false)).toBeNull()
})
