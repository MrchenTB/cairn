/**
 * Gantt scheduling rules (continuous calendar days, no working-day calendar in V1).
 *
 * Dates are inclusive. For Finish-to-Start (FS) dependency P → S:
 *   S must start on or after (finish of P) + 1 day.
 * With optional dates we use bounds so we only flag CERTAIN conflicts:
 *   earliestFinish(P) = P.dueDate ?? P.startDate   (null when P is unscheduled)
 *   latestStart(S)    = S.startDate ?? S.dueDate   (null when S is unscheduled)
 *   conflict  ⇔  both non-null and latestStart(S) <= earliestFinish(P)
 *   requiredStart(S) = max over predecessors of earliestFinish(P) + 1
 *
 * Auto-schedule only ever moves successors LATER (never earlier), preserving duration:
 *   range (both dates)  → shift both by the same delta
 *   due_only            → dueDate := requiredStart
 *   start_only          → startDate := requiredStart
 * Tasks listed in `changes` (the user's explicit edit) are fixed and never moved again.
 */
import type { Dependency, ISODate, Milestone, ScheduleChange, Task } from './types'
import { notImplemented } from './_todo'

export type SpanKind = 'range' | 'due_only' | 'start_only' | 'unscheduled'
export interface TaskSpan {
  kind: SpanKind
  start: ISODate | null
  end: ISODate | null
}
export function taskSpan(task: Pick<Task, 'startDate' | 'dueDate'>): TaskSpan {
  return notImplemented('taskSpan' + task.startDate + task.dueDate)
}
export function earliestFinish(task: Pick<Task, 'startDate' | 'dueDate'>): ISODate | null {
  return notImplemented('earliestFinish' + task.startDate + task.dueDate)
}
export function latestStart(task: Pick<Task, 'startDate' | 'dueDate'>): ISODate | null {
  return notImplemented('latestStart' + task.startDate + task.dueDate)
}

export interface DependencyConflict {
  dependencyId: string
  predecessorId: string
  successorId: string
  /** first date the successor may start */
  requiredStart: ISODate
  /** latestStart(successor), which is <= earliestFinish(predecessor) */
  actualStart: ISODate
  /** days the successor would have to move later: diffDays(actualStart, requiredStart) (>= 1) */
  shiftDays: number
}
/** Accepts tasks as a map or array; dependencies whose tasks are missing are ignored. */
export function findConflicts(
  tasks: Record<string, Task> | readonly Task[],
  dependencies: readonly Dependency[],
): DependencyConflict[] {
  return notImplemented('findConflicts' + Object.keys(tasks).length + dependencies.length)
}

export type DependencyValidationReason =
  | 'missing' // a task id does not exist
  | 'self' // predecessor === successor
  | 'cross_project' // tasks belong to different projects
  | 'hierarchy' // one task is the parent of the other
  | 'duplicate' // the same predecessor → successor already exists
  | 'cycle' // would create a cycle (includes the reverse edge already existing)

export type DependencyValidation =
  | { ok: true }
  | { ok: false; reason: DependencyValidationReason; message: string }

export function validateNewDependency(
  tasks: Record<string, Task>,
  dependencies: readonly Pick<Dependency, 'predecessorId' | 'successorId'>[],
  predecessorId: string,
  successorId: string,
): DependencyValidation {
  return notImplemented(
    'validateNewDependency' +
      Object.keys(tasks).length +
      dependencies.length +
      predecessorId +
      successorId,
  )
}
/** True when adding predecessor → successor would close a cycle (or predecessor === successor). */
export function wouldCreateCycle(
  dependencies: readonly Pick<Dependency, 'predecessorId' | 'successorId'>[],
  predecessorId: string,
  successorId: string,
): boolean {
  return notImplemented('wouldCreateCycle' + dependencies.length + predecessorId + successorId)
}

export interface ScheduleShift {
  taskId: string
  from: { startDate: ISODate | null; dueDate: ISODate | null }
  to: { startDate: ISODate | null; dueDate: ISODate | null }
  /** days moved later (>= 1) */
  deltaDays: number
}
/**
 * Applies `changes` (fixed), then walks the dependency graph in topological order and pushes
 * every violating successor later. Returns ONLY the additional shifts (not `changes`), in
 * topological order. Pass `changes: []` to resolve all existing conflicts of a project.
 * Robust to cycles in input data (ignores edges that cannot be ordered) and never throws.
 */
export function computeAutoSchedule(
  tasks: Record<string, Task>,
  dependencies: readonly Dependency[],
  changes: readonly ScheduleChange[],
): ScheduleShift[] {
  return notImplemented(
    'computeAutoSchedule' + Object.keys(tasks).length + dependencies.length + changes.length,
  )
}

/** Min start / max end over scheduled tasks (any span kind) and milestones; null when none. */
export function rollupRange(
  tasks: readonly Pick<Task, 'startDate' | 'dueDate'>[],
  milestones: readonly Pick<Milestone, 'date'>[] = [],
): { start: ISODate; end: ISODate } | null {
  return notImplemented('rollupRange' + tasks.length + milestones.length)
}
