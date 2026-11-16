export function fitPanelWidths(
  viewport: number,
  requestedRail: number,
  requestedList: number,
  railCollapsed: boolean,
  listCollapsed: boolean
): { rail: number; list: number } {
  let rail = railCollapsed ? 0 : requestedRail
  let list = listCollapsed ? 0 : requestedList
  const separators = (railCollapsed ? 0 : 4) + (listCollapsed ? 0 : 4)
  const budget = Math.max(0, viewport - 300 - separators)
  if (!listCollapsed) list = Math.max(240, Math.min(list, budget - rail))
  if (!railCollapsed) rail = Math.max(160, Math.min(rail, budget - list))
  return { rail, list }
}
