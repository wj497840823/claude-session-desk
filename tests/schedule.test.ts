import { describe, expect, it } from 'vitest'
import {
  computeNextRun,
  describeSchedule,
  isValidSchedule
} from '../src/shared/schedule'

const date = (day: number, hour: number, minute: number): number =>
  new Date(2026, 10, day, hour, minute, 0, 0).getTime()

describe('computeNextRun', () => {
  it('keeps a once schedule at its timestamp', () => {
    expect(computeNextRun({ kind: 'once', at: date(20, 9, 0) }, date(19, 8, 0))).toBe(date(20, 9, 0))
  })

  it('finds the next daily occurrence', () => {
    expect(computeNextRun({ kind: 'daily', time: '09:30' }, date(19, 8, 0))).toBe(date(19, 9, 30))
    expect(computeNextRun({ kind: 'daily', time: '09:30' }, date(19, 10, 0))).toBe(date(20, 9, 30))
  })

  it('finds the next weekly occurrence', () => {
    // 2026-11-19 is Thursday. Monday=1, Wednesday=3.
    expect(computeNextRun(
      { kind: 'weekly', weekdays: [1, 3], time: '09:00' },
      date(19, 10, 0)
    )).toBe(date(23, 9, 0))
    expect(computeNextRun(
      { kind: 'weekly', weekdays: [1, 3], time: '09:00' },
      date(23, 10, 0)
    )).toBe(date(25, 9, 0))
  })

  it('aligns interval schedules to the next future slot', () => {
    expect(computeNextRun(
      { kind: 'interval', minutes: 30 },
      date(19, 10, 0),
      date(19, 10, 0)
    )).toBe(date(19, 10, 30))
    expect(computeNextRun(
      { kind: 'interval', minutes: 30 },
      date(19, 10, 31),
      date(19, 10, 0)
    )).toBe(date(19, 11, 0))
    expect(computeNextRun(
      { kind: 'interval', minutes: 30 },
      date(19, 10, 0)
    )).toBe(date(19, 10, 30))
  })
})

describe('describeSchedule', () => {
  it('writes readable schedule labels', () => {
    expect(describeSchedule({ kind: 'daily', time: '09:30' })).toBe('每天 09:30')
    expect(describeSchedule({ kind: 'weekly', weekdays: [1, 3], time: '09:00' })).toContain('每周一、周三')
    expect(describeSchedule({ kind: 'interval', minutes: 30 })).toBe('每 30 分钟')
    expect(describeSchedule({ kind: 'once', at: date(20, 9, 0) })).toContain('仅一次')
  })
})

describe('isValidSchedule', () => {
  it('accepts supported schedules and rejects malformed values', () => {
    expect(isValidSchedule({ kind: 'daily', time: '23:59' })).toBe(true)
    expect(isValidSchedule({ kind: 'daily', time: '24:00' })).toBe(false)
    expect(isValidSchedule({ kind: 'weekly', weekdays: [], time: '09:00' })).toBe(false)
    expect(isValidSchedule({ kind: 'weekly', weekdays: [7], time: '09:00' })).toBe(false)
    expect(isValidSchedule({ kind: 'interval', minutes: 0 })).toBe(false)
    expect(isValidSchedule({ kind: 'interval', minutes: 60 })).toBe(true)
    expect(isValidSchedule({ kind: 'once', at: 123 })).toBe(true)
    expect(isValidSchedule({ kind: 'once', at: Number.NaN })).toBe(false)
  })
})