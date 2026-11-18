export const DEFAULT_RAIL_WIDTH = 296
export const RAIL_WIDTH_MIGRATION_KEY = 'csm.navigationWidthNarrowed'

export function adjustLegacyRailWidth(raw: string | null, migrated: boolean): number | null {
  if (migrated || raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value === 320 ? DEFAULT_RAIL_WIDTH : null
}

export function parseStoredBoolean(value: string | null, fallback: boolean): boolean {
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return fallback
}
