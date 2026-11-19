import type { ScheduleSpec } from './types'

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/
export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

function clockParts(time: string): { hours: number; minutes: number } | null {
  const match = CLOCK.exec(time)
  if (!match) return null
  return { hours: Number(match[1]), minutes: Number(match[2]) }
}

export function isValidSchedule(schedule: unknown): schedule is ScheduleSpec {
  if (!schedule || typeof schedule !== 'object') return false
  const value = schedule as Record<string, unknown>
  if (value.kind === 'once') {
    return typeof value.at === 'number' && Number.isFinite(value.at)
  }
  if (value.kind === 'daily') {
    return typeof value.time === 'string' && clockParts(value.time) !== null
  }
  if (value.kind === 'weekly') {
    return typeof value.time === 'string' &&
      clockParts(value.time) !== null &&
      Array.isArray(value.weekdays) &&
      value.weekdays.length > 0 &&
      value.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  }
  if (value.kind === 'interval') {
    return typeof value.minutes === 'number' &&
      Number.isInteger(value.minutes) &&
      value.minutes >= 1 &&
      value.minutes <= 10_080
  }
  return false
}

export function computeNextRun(
  schedule: ScheduleSpec,
  from: number,
  lastRunAt?: number
): number {
  if (schedule.kind === 'once') return schedule.at
  if (schedule.kind === 'interval') {
    const interval = schedule.minutes * 60_000
    if (lastRunAt === undefined) return from + interval
    const steps = Math.max(1, Math.ceil((from - lastRunAt) / interval))
    return lastRunAt + steps * interval
  }

  const clock = clockParts(schedule.time)
  if (!clock) return from

  if (schedule.kind === 'daily') {
    const candidate = new Date(from)
    candidate.setHours(clock.hours, clock.minutes, 0, 0)
    if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1)
    return candidate.getTime()
  }

  const weekdays = new Set(schedule.weekdays)
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from)
    candidate.setDate(candidate.getDate() + offset)
    candidate.setHours(clock.hours, clock.minutes, 0, 0)
    if (candidate.getTime() > from && weekdays.has(candidate.getDay())) {
      return candidate.getTime()
    }
  }
  return from
}

export function describeSchedule(schedule: ScheduleSpec): string {
  if (schedule.kind === 'once') {
    return `仅一次：${new Date(schedule.at).toLocaleString('zh-CN')}`
  }
  if (schedule.kind === 'daily') return `每天 ${schedule.time}`
  if (schedule.kind === 'interval') return `每 ${schedule.minutes} 分钟`
  const days = [...new Set(schedule.weekdays)]
    .sort((left, right) => left - right)
    .map((day, index) => `${index === 0 ? '' : '周'}${WEEKDAY_LABELS[day]}`)
    .join('、')
  return `每周${days} ${schedule.time}`
}