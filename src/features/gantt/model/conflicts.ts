/**
 * Conflict presentation for the chart. The rule itself is `findConflicts` (src/domain/scheduling);
 * this module only (a) re-evaluates the links of bars whose dates are being dragged or waiting for
 * a write, so lines and warnings follow the bar live, and (b) words a successor's warning.
 */
import { formatDateRange } from '@/domain/dates'
import { findConflicts, type DependencyConflict } from '@/domain/scheduling'
import type { Dependency, ISODate, Task } from '@/domain/types'

/** Dates shown instead of the stored ones (live drag or pending write), per task id. */
export type DateOverrides = ReadonlyMap<
  string,
  { startDate: ISODate | null; dueDate: ISODate | null }
>

/**
 * `base` (= findConflicts over stored dates) with every dependency touching an overridden task
 * re-checked against the overridden dates. Returns `base` itself when nothing is overridden.
 */
export function liveConflicts(
  base: readonly DependencyConflict[],
  dependencies: readonly Dependency[],
  tasks: Record<string, Task>,
  overrides: DateOverrides,
): readonly DependencyConflict[] {
  if (overrides.size === 0) return base
  const touched = dependencies.filter(
    (d) => overrides.has(d.predecessorId) || overrides.has(d.successorId),
  )
  if (touched.length === 0) return base
  const touchedIds = new Set(touched.map((d) => d.id))
  const involved = new Map<string, Task>()
  for (const dependency of touched) {
    for (const id of [dependency.predecessorId, dependency.successorId]) {
      if (involved.has(id) || !Object.hasOwn(tasks, id)) continue
      const override = overrides.get(id)
      involved.set(id, override ? { ...tasks[id], ...override } : tasks[id])
    }
  }
  return [
    ...base.filter((conflict) => !touchedIds.has(conflict.dependencyId)),
    ...findConflicts([...involved.values()], touched),
  ]
}

/**
 * One warning per successor, e.g. `Should start after “Wireframes” ends — on Nov 9 or later`, or
 * with several violated predecessors `Should start after 2 tasks end — on Nov 13 or later` (the
 * latest required start).
 */
export function conflictMessages(
  conflicts: readonly DependencyConflict[],
  tasks: Record<string, Task>,
  today: ISODate,
): Map<string, string> {
  const bySuccessor = new Map<string, DependencyConflict[]>()
  for (const conflict of conflicts) {
    const list = bySuccessor.get(conflict.successorId)
    if (list) list.push(conflict)
    else bySuccessor.set(conflict.successorId, [conflict])
  }
  const messages = new Map<string, string>()
  for (const [successorId, list] of bySuccessor) {
    // The latest required start wins: the successor has to clear every predecessor.
    const required = list.reduce((max, c) => (c.requiredStart > max ? c.requiredStart : max), '')
    const label = formatDateRange(required, required, today)
    if (list.length === 1) {
      const title = Object.hasOwn(tasks, list[0].predecessorId)
        ? tasks[list[0].predecessorId].title
        : 'its predecessor'
      messages.set(successorId, `Should start after “${title}” ends — on ${label} or later`)
    } else {
      messages.set(
        successorId,
        `Should start after ${list.length} tasks end — on ${label} or later`,
      )
    }
  }
  return messages
}
