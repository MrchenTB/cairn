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
 * Tasks listed in `changes` (the user's explicit edit) are fixed and never moved again, and only
 * the tasks those changes force move (see `computeAutoSchedule`); `changes: []` resolves every
 * conflict.
 *
 * Completed tasks are history. Auto-schedule never moves a task whose status is 'done' (it is
 * reported as `blocked` instead), and a violated dependency whose SUCCESSOR is done is not a
 * conflict to act on but a historical inconsistency (`findHistoricalInconsistencies`): moving the
 * successor would rewrite what happened, and the predecessor cannot be moved earlier. A done
 * predecessor with an open successor is an ordinary conflict (the successor can still move).
 *
 * Implementation note: all arithmetic runs on epoch-day integers. Every function here treats a
 * date that is not a real 'YYYY-MM-DD' date (e.g. '2026-02-29') as missing, so corrupt data never
 * throws and spans, conflicts and auto-schedule always agree on what is scheduled.
 */
import { isISODate, tryFromEpochDay, tryToEpochDay } from './dates'
import { stronglyConnectedComponents } from './graph'
import type { Dependency, ISODate, Milestone, ScheduleChange, Task } from './types'

type DatedTask = Pick<Task, 'startDate' | 'dueDate'>

export type SpanKind = 'range' | 'due_only' | 'start_only' | 'unscheduled'
export interface TaskSpan {
  kind: SpanKind
  start: ISODate | null
  end: ISODate | null
}

function validDate(date: ISODate | null | undefined): ISODate | null {
  return isISODate(date) ? date : null
}

export function taskSpan(task: DatedTask): TaskSpan {
  const start = validDate(task.startDate)
  const end = validDate(task.dueDate)
  if (start && end) return { kind: 'range', start, end }
  if (start) return { kind: 'start_only', start, end: null }
  if (end) return { kind: 'due_only', start: null, end }
  return { kind: 'unscheduled', start: null, end: null }
}
export function earliestFinish(task: DatedTask): ISODate | null {
  return validDate(task.dueDate) ?? validDate(task.startDate)
}
export function latestStart(task: DatedTask): ISODate | null {
  return validDate(task.startDate) ?? validDate(task.dueDate)
}

/** `earliestFinish` as an epoch day. */
function finishDay(task: DatedTask): number | null {
  return tryToEpochDay(task.dueDate) ?? tryToEpochDay(task.startDate)
}
/** `latestStart` as an epoch day. */
function startDay(task: DatedTask): number | null {
  return tryToEpochDay(task.startDate) ?? tryToEpochDay(task.dueDate)
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

function isTaskList(tasks: Record<string, Task> | readonly Task[]): tasks is readonly Task[] {
  return Array.isArray(tasks)
}

function ownTask(tasks: Record<string, Task>, id: string): Task | undefined {
  return Object.hasOwn(tasks, id) ? tasks[id] : undefined
}

function taskLookup(
  tasks: Record<string, Task> | readonly Task[],
): (id: string) => Task | undefined {
  if (isTaskList(tasks)) {
    const byId = new Map(tasks.map((task) => [task.id, task]))
    return (id) => byId.get(id)
  }
  return (id) => ownTask(tasks, id)
}

/**
 * The conflicts to act on: violated dependencies whose successor is not done (so it can still
 * move). Accepts tasks as a map or array; dependencies whose tasks are missing are ignored.
 */
export function findConflicts(
  tasks: Record<string, Task> | readonly Task[],
  dependencies: readonly Dependency[],
): DependencyConflict[] {
  return scanViolations(tasks, dependencies)
    .filter((v) => !v.successorDone)
    .map((v) => v.conflict)
}

/**
 * Violated dependencies whose successor is already done: what happened is kept as it is, so these
 * are neither flagged as conflicts nor moved by Auto-schedule. Kept visible in the Task Modal.
 */
export function findHistoricalInconsistencies(
  tasks: Record<string, Task> | readonly Task[],
  dependencies: readonly Dependency[],
): DependencyConflict[] {
  return scanViolations(tasks, dependencies)
    .filter((v) => v.successorDone)
    .map((v) => v.conflict)
}

interface Violation {
  conflict: DependencyConflict
  successorDone: boolean
}

function scanViolations(
  tasks: Record<string, Task> | readonly Task[],
  dependencies: readonly Dependency[],
): Violation[] {
  const getTask = taskLookup(tasks)
  const conflicts: Violation[] = []
  for (const dependency of dependencies) {
    if (dependency.predecessorId === dependency.successorId) continue
    const predecessor = getTask(dependency.predecessorId)
    const successor = getTask(dependency.successorId)
    if (!predecessor || !successor) continue
    const finish = finishDay(predecessor)
    const start = startDay(successor)
    if (finish === null || start === null || start > finish) continue
    const requiredStart = tryFromEpochDay(finish + 1)
    const actualStart = tryFromEpochDay(start)
    if (requiredStart === null || actualStart === null) continue // past 9999-12-31
    conflicts.push({
      conflict: {
        dependencyId: dependency.id,
        predecessorId: predecessor.id,
        successorId: successor.id,
        requiredStart,
        actualStart,
        shiftDays: finish + 1 - start,
      },
      successorDone: successor.status === 'done',
    })
  }
  return conflicts
}

export type DependencyValidationReason =
  | 'missing' // a task id does not exist
  | 'self' // predecessor === successor
  | 'cross_project' // tasks belong to different projects
  | 'hierarchy' // one task is the parent of the other
  | 'duplicate' // the same predecessor → successor already exists
  | 'cycle' // would create a cycle (includes the reverse edge already existing)

export type DependencyValidation =
  { ok: true } | { ok: false; reason: DependencyValidationReason; message: string }

const DEPENDENCY_MESSAGES: Record<DependencyValidationReason, string> = {
  missing: 'That task no longer exists.',
  self: "A task can't depend on itself.",
  cross_project: 'Dependencies can only link tasks in the same project.',
  hierarchy: "A task can't depend on its own parent or subtask.",
  duplicate: 'This dependency already exists.',
  cycle: 'This would create a circular dependency.',
}

function rejected(reason: DependencyValidationReason): DependencyValidation {
  return { ok: false, reason, message: DEPENDENCY_MESSAGES[reason] }
}

/** Checks, in order: missing, self, cross_project, hierarchy, duplicate, cycle. */
export function validateNewDependency(
  tasks: Record<string, Task>,
  dependencies: readonly Pick<Dependency, 'predecessorId' | 'successorId'>[],
  predecessorId: string,
  successorId: string,
): DependencyValidation {
  const predecessor = ownTask(tasks, predecessorId)
  const successor = ownTask(tasks, successorId)
  if (!predecessor || !successor) return rejected('missing')
  if (predecessorId === successorId) return rejected('self')
  if (predecessor.projectId !== successor.projectId) return rejected('cross_project')
  if (predecessor.parentTaskId === successorId || successor.parentTaskId === predecessorId) {
    return rejected('hierarchy')
  }
  const duplicate = dependencies.some(
    (d) => d.predecessorId === predecessorId && d.successorId === successorId,
  )
  if (duplicate) return rejected('duplicate')
  if (wouldCreateCycle(dependencies, predecessorId, successorId)) return rejected('cycle')
  return { ok: true }
}
/** True when adding predecessor → successor would close a cycle (or predecessor === successor). */
export function wouldCreateCycle(
  dependencies: readonly Pick<Dependency, 'predecessorId' | 'successorId'>[],
  predecessorId: string,
  successorId: string,
): boolean {
  if (predecessorId === successorId) return true
  const successorsOf = new Map<string, string[]>()
  for (const { predecessorId: from, successorId: to } of dependencies) {
    const targets = successorsOf.get(from)
    if (targets) targets.push(to)
    else successorsOf.set(from, [to])
  }
  // A cycle appears iff the new successor can already reach the new predecessor.
  const pending = [successorId]
  const seen = new Set(pending)
  while (pending.length > 0) {
    for (const next of successorsOf.get(pending.pop() as string) ?? []) {
      if (next === predecessorId) return true
      if (!seen.has(next)) {
        seen.add(next)
        pending.push(next)
      }
    }
  }
  return false
}

export interface ScheduleShift {
  taskId: string
  from: { startDate: ISODate | null; dueDate: ISODate | null }
  to: { startDate: ISODate | null; dueDate: ISODate | null }
  /** days moved later (>= 1) */
  deltaDays: number
}
/**
 * The shifts an edit requires (the Auto-mode preview). Applies `changes` (fixed: they take their
 * new dates and never move), then walks the dependency graph in topological order. Returns ONLY
 * the additional shifts (not `changes`), in topological order.
 *
 * Scope: with `changes`, a task moves only when a changed or already-moved predecessor requires
 * it (its latest start is on/before that predecessor's finish); it then lands after ALL of its
 * predecessors. Conflicts the edit does not touch are left alone, so an unrelated conflict never
 * shows up in a preview. To preview one dependency (e.g. a link just drawn), pass its predecessor
 * with unchanged dates. Pass `changes: []` to resolve every existing conflict of a project.
 *
 * Robust to cycles in input data and never throws: edges inside a cycle (same strongly connected
 * component) are ignored; edges into and out of a cycle still apply. A shift that would pass
 * 9999-12-31 is skipped.
 */
export function computeAutoSchedule(
  tasks: Record<string, Task>,
  dependencies: readonly Dependency[],
  changes: readonly ScheduleChange[],
): ScheduleShift[] {
  return computeAutoScheduleDetailed(tasks, dependencies, changes).shifts
}

export interface AutoScheduleResult {
  /** What would be written besides the user's own change. Never a done task. */
  shifts: ScheduleShift[]
  /**
   * Completed tasks that would have had to move but are kept as they are (their dates are
   * history). The dates here are what the move WOULD have been, for telling the user; they are
   * never written. Their successors are judged against the dates they really have.
   */
  blocked: ScheduleShift[]
}

/** `computeAutoSchedule` plus the completed tasks it refused to move. */
export function computeAutoScheduleDetailed(
  tasks: Record<string, Task>,
  dependencies: readonly Dependency[],
  changes: readonly ScheduleChange[],
): AutoScheduleResult {
  try {
    return autoSchedule(tasks, dependencies, changes)
  } catch {
    // Defensive only: the walk below does not throw for any data shape we know of.
    return { shifts: [], blocked: [] }
  }
}

function autoSchedule(
  tasks: Record<string, Task>,
  dependencies: readonly Dependency[],
  changes: readonly ScheduleChange[],
): AutoScheduleResult {
  // Dense node indices for the tasks that take part in at least one usable dependency.
  const nodeIds: string[] = []
  const nodeIndex = new Map<string, number>()
  const start: Array<number | null> = []
  const due: Array<number | null> = []
  const fixed: boolean[] = []
  const nodeOf = (task: Task): number => {
    let node = nodeIndex.get(task.id)
    if (node === undefined) {
      node = nodeIds.length
      nodeIds.push(task.id)
      nodeIndex.set(task.id, node)
      start.push(tryToEpochDay(task.startDate))
      due.push(tryToEpochDay(task.dueDate))
      fixed.push(false)
    }
    return node
  }

  const edges: Array<[number, number]> = []
  for (const dependency of dependencies) {
    if (dependency.predecessorId === dependency.successorId) continue
    const predecessor = ownTask(tasks, dependency.predecessorId)
    const successor = ownTask(tasks, dependency.successorId)
    if (!predecessor || !successor) continue
    edges.push([nodeOf(predecessor), nodeOf(successor)])
  }
  if (edges.length === 0) return { shifts: [], blocked: [] }

  // The user's explicit edit: new dates are inputs, and those tasks never move again.
  for (const change of changes) {
    const node = nodeIndex.get(change.taskId)
    if (node === undefined) continue
    start[node] = tryToEpochDay(change.startDate)
    due[node] = tryToEpochDay(change.dueDate)
    fixed[node] = true
  }

  const n = nodeIds.length
  const successors: number[][] = Array.from({ length: n }, () => [])
  for (const [from, to] of edges) successors[from].push(to)
  const component = stronglyConnectedComponents(successors)

  // Kahn's algorithm over the edges that can be ordered (endpoints in different components).
  const indegree = new Int32Array(n)
  for (const [from, to] of edges) if (component[from] !== component[to]) indegree[to]++
  // Epoch days, max over processed predecessors of earliestFinish + 1: `required` over all of
  // them, `forced` over those that push (changed or shifted by this call).
  const required = new Float64Array(n).fill(Number.NEGATIVE_INFINITY)
  const forced = new Float64Array(n).fill(Number.NEGATIVE_INFINITY)
  const pushes = Uint8Array.from(fixed, Number)
  const resolveAll = changes.length === 0

  /**
   * Moves `node` when `trigger` (the start its pushing predecessors require) is after its latest
   * start; it then starts on its required start (after ALL predecessors, >= trigger). Updates the
   * working dates.
   */
  const shiftLater = (node: number, trigger: number, commit: boolean): ScheduleShift | null => {
    const currentStart = start[node]
    const currentDue = due[node]
    const latest = currentStart ?? currentDue
    if (latest === null || latest >= trigger) return null
    // Same delta for every known date: range keeps its duration, a single date lands on `need`.
    const need = required[node]
    const delta = need - latest
    const nextStart = currentStart === null ? null : currentStart + delta
    const nextDue = currentDue === null ? null : currentDue + delta
    const nextStartDate = nextStart === null ? null : tryFromEpochDay(nextStart)
    const nextDueDate = nextDue === null ? null : tryFromEpochDay(nextDue)
    if ((nextStart !== null && !nextStartDate) || (nextDue !== null && !nextDueDate)) return null
    // A completed task is only measured, never changed: its successors see its real dates.
    if (commit) {
      start[node] = nextStart
      due[node] = nextDue
    }
    const task = tasks[nodeIds[node]]
    const from = { startDate: task.startDate, dueDate: task.dueDate }
    return {
      taskId: task.id,
      from,
      // An unparseable original date (treated as missing) is left exactly as it was.
      to: { startDate: nextStartDate ?? from.startDate, dueDate: nextDueDate ?? from.dueDate },
      deltaDays: delta,
    }
  }

  const queue: number[] = []
  for (let node = 0; node < n; node++) if (indegree[node] === 0) queue.push(node)
  const shifts: ScheduleShift[] = []
  const blocked: ScheduleShift[] = []
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]
    if (!fixed[node]) {
      const done = tasks[nodeIds[node]].status === 'done'
      const shift = shiftLater(node, resolveAll ? required[node] : forced[node], !done)
      if (shift && done) {
        blocked.push(shift)
      } else if (shift) {
        shifts.push(shift)
        pushes[node] = 1
      }
    }
    const finish = due[node] ?? start[node]
    for (const next of successors[node]) {
      if (component[node] === component[next]) continue
      if (finish !== null) {
        if (finish + 1 > required[next]) required[next] = finish + 1
        if (pushes[node] && finish + 1 > forced[next]) forced[next] = finish + 1
      }
      if (--indegree[next] === 0) queue.push(next)
    }
  }
  return { shifts, blocked }
}

/** The writes for `applySchedule([change, ...toScheduleChanges(shifts)])`. */
export function toScheduleChanges(shifts: readonly ScheduleShift[]): ScheduleChange[] {
  return shifts.map((shift) => ({
    taskId: shift.taskId,
    startDate: shift.to.startDate,
    dueDate: shift.to.dueDate,
  }))
}

/** Min start / max end over scheduled tasks (any span kind) and milestones; null when none. */
export function rollupRange(
  tasks: readonly Pick<Task, 'startDate' | 'dueDate'>[],
  milestones: readonly Pick<Milestone, 'date'>[] = [],
): { start: ISODate; end: ISODate } | null {
  let min: ISODate | null = null
  let max: ISODate | null = null
  const dates: Array<ISODate | null> = []
  for (const task of tasks) dates.push(task.startDate, task.dueDate)
  for (const milestone of milestones) dates.push(milestone.date)
  for (const date of dates) {
    if (!date || !isISODate(date)) continue
    if (min === null || date < min) min = date
    if (max === null || date > max) max = date
  }
  return min === null || max === null ? null : { start: min, end: max }
}
