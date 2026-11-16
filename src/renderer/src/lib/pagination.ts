export const PAGE_SIZE = 150

export function initialStart(
  total: number,
  events: Array<{ uuid: string }>,
  matchUuid: string | null
): number {
  const lastPageStart = Math.max(0, total - PAGE_SIZE)
  if (!matchUuid) return lastPageStart
  const index = events.findIndex((event) => event.uuid === matchUuid)
  if (index < 0 || index >= lastPageStart) return lastPageStart
  return Math.max(0, index - 50)
}

export function loadEarlier(start: number): number {
  return Math.max(0, start - PAGE_SIZE)
}