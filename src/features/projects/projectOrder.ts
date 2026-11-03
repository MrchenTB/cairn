/**
 * Pure helpers for the manual project order (Projects page). `moveProject(id, afterProjectId)`
 * takes the project that should end up directly BEFORE the moved one (null = first). The list
 * may be a filtered subsequence (Active only): the neighbour as seen there is still correct,
 * because hidden projects keep their relative order around it.
 */

/** The `afterProjectId` for dropping `activeId` onto `overId`, or undefined when nothing moves. */
export function dropAfterId(
  order: readonly string[],
  activeId: string,
  overId: string | null | undefined,
): string | null | undefined {
  const from = order.indexOf(activeId)
  const to = overId ? order.indexOf(overId) : -1
  if (from < 0 || to < 0 || from === to) return undefined
  const next = [...order]
  next.splice(from, 1)
  next.splice(to, 0, activeId)
  return next[to - 1] ?? null
}

/** The `afterProjectId` for "Move up" (-1) / "Move down" (+1), or undefined at the edge. */
export function stepAfterId(
  order: readonly string[],
  id: string,
  delta: -1 | 1,
): string | null | undefined {
  const from = order.indexOf(id)
  if (from < 0) return undefined
  return dropAfterId(order, id, order[from + delta])
}
