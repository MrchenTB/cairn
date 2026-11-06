/**
 * Single entry point for changing task dates from ANY view (Gantt drag/resize, Task Modal,
 * List date fields) so the Manual/Auto dependency rules behave identically everywhere.
 *
 * - Manual mode (project.scheduleMode === 'manual'): write the change; if it creates dependency
 *   conflicts, show a warning toast with a "Review" action that opens the auto-resolve preview.
 * - Auto mode: if the change requires moving successors (computeAutoSchedule), open the preview
 *   dialog (task, old → new dates, Δ days). Confirm → ONE atomic applySchedule([change, ...shifts]);
 *   "Only move this task" → applySchedule([change]); Cancel → nothing is written. Without shifts
 *   the change is written directly.
 * - Either mode warns (with "Review") when the written change leaves NEW conflicts behind, e.g. a
 *   successor dragged before its predecessor (Auto never moves the task the user just edited).
 * - `planScheduleChange` resolves `true` when the change was written (or already in place),
 *   `false` when the user cancelled, validation failed (e.g. due < start) or the write failed
 *   (the store already toasted it and rolled back). `planScheduleChangeDetailed` tells which, with
 *   the validation message for inline feedback.
 *
 * The rules themselves (conflicts, shifts) live in src/domain/scheduling.ts; this module only
 * decides what to write and when to ask.
 */
import { getWorkspaceActions, useWorkspaceStore } from '@/data/store'
import { validateDateRange } from '@/domain/validation'
import {
  computeAutoScheduleDetailed,
  findConflicts,
  toScheduleChanges,
  type ScheduleShift,
} from '@/domain/scheduling'
import type {
  AppError,
  Dependency,
  Result,
  ScheduleChange,
  Task,
  WorkspaceData,
} from '@/domain/types'
import { notify, type NotifyAction } from '@/lib/notify'
import type { WriteOptions } from '@/data/contracts'
import type { ScheduleChangeSource } from './plannerTypes'
import {
  requestReschedule,
  type RescheduleExecutor,
  type RescheduleOutcome,
  type RescheduleRequest,
} from './rescheduleStore'

export type { ScheduleChangeSource } from './plannerTypes'

export type PlanOutcome =
  /** Something was written successfully. */
  | { status: 'written' }
  /** The task already had these dates; nothing to write. */
  | { status: 'unchanged' }
  /** The user closed the preview; nothing was written. */
  | { status: 'cancelled' }
  /** Rejected before writing (no toast): show `error.message` inline. */
  | { status: 'invalid'; error: AppError }
  /** The write failed remotely: rolled back and toasted (with Retry) by the store. */
  | { status: 'failed'; error: AppError }

// ---------------------------------------------------------------------------
// Plans (shared with the preview dialog, which recomputes them live)
// ---------------------------------------------------------------------------

export interface ReschedulePlan {
  /** The user's edit (request kind 'change'), otherwise null. */
  change: ScheduleChange | null
  /** Other tasks that move, in dependency order. */
  shifts: ScheduleShift[]
  /** Completed tasks Auto-schedule would have moved and keeps as they are (never written). */
  blocked: ScheduleShift[]
  /** Everything "Apply" writes in ONE applySchedule call. */
  writes: ScheduleChange[]
  /** Set when the plan can no longer be computed (task or dependency deleted meanwhile). */
  error: string | null
}

function own<T>(record: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(record, id) ? record[id] : undefined
}

/** Dependencies of one project (they never cross projects). */
export function projectDependencies(data: WorkspaceData, projectId: string): Dependency[] {
  return Object.values(data.dependencies).filter((d) => d.projectId === projectId)
}

/** What a preview request would write against the current data. */
export function computeReschedulePlan(
  request: RescheduleRequest,
  data: WorkspaceData,
): ReschedulePlan {
  const dependencies = projectDependencies(data, request.projectId)
  if (request.kind === 'change') {
    if (!own(data.tasks, request.change.taskId)) {
      return {
        change: null,
        shifts: [],
        blocked: [],
        writes: [],
        error: 'This task no longer exists.',
      }
    }
    const { shifts, blocked } = computeAutoScheduleDetailed(data.tasks, dependencies, [
      request.change,
    ])
    return {
      change: request.change,
      shifts,
      blocked,
      writes: [request.change, ...toScheduleChanges(shifts)],
      error: null,
    }
  }
  if (request.kind === 'dependency') {
    const dependency = own(data.dependencies, request.dependencyId)
    const predecessor = dependency ? own(data.tasks, dependency.predecessorId) : undefined
    if (!dependency || !predecessor) {
      return {
        change: null,
        shifts: [],
        blocked: [],
        writes: [],
        error: 'This dependency no longer exists.',
      }
    }
    // The predecessor keeps its dates; only what the new link forces moves.
    const pinned: ScheduleChange = {
      taskId: predecessor.id,
      startDate: predecessor.startDate,
      dueDate: predecessor.dueDate,
    }
    const { shifts, blocked } = computeAutoScheduleDetailed(data.tasks, dependencies, [pinned])
    return { change: null, shifts, blocked, writes: toScheduleChanges(shifts), error: null }
  }
  const { shifts, blocked } = computeAutoScheduleDetailed(data.tasks, dependencies, [])
  return { change: null, shifts, blocked, writes: toScheduleChanges(shifts), error: null }
}

// ---------------------------------------------------------------------------
// Planner (environment injected so decisions are unit-testable)
// ---------------------------------------------------------------------------

export interface PlannerEnv {
  getData(): WorkspaceData
  applySchedule(changes: readonly ScheduleChange[], options?: WriteOptions): Promise<Result>
  warn(message: string, options: { description?: string; action?: NotifyAction }): void
  requestReschedule(
    request: RescheduleRequest,
    execute: RescheduleExecutor,
  ): Promise<RescheduleOutcome>
}

/**
 * What one successful write changed, enough to take it back: the dates it wrote (`applied`) and
 * the dates those tasks had just before (`previous`). Auto mode's confirmed shifts are part of the
 * same record, so undoing restores them together, atomically.
 */
export interface ScheduleWriteRecord {
  applied: ScheduleChange[]
  previous: ScheduleChange[]
}

export type UndoOutcome =
  | { status: 'restored' }
  /** A task in the record was changed (or deleted) since: restoring would overwrite newer work. */
  | { status: 'stale' }
  | { status: 'invalid'; error: AppError }
  | { status: 'failed'; error: AppError }

export interface PlanOptions {
  source?: ScheduleChangeSource
  /** How a failed write is reported (the Task Modal names the task and the field). */
  writeOptions?: WriteOptions
  /**
   * Called once with the record of the write, right after it succeeded (not for 'unchanged', a
   * cancelled preview or a failed write).
   */
  onWritten?: (record: ScheduleWriteRecord) => void
}

export interface Planner {
  planScheduleChange(change: ScheduleChange, options?: PlanOptions): Promise<PlanOutcome>
  /** Puts back the dates before `record`, unless a task in it has changed since. */
  undoScheduleWrite(record: ScheduleWriteRecord): Promise<UndoOutcome>
  /** Opens the "resolve all conflicts" preview for a project (Manual "Review", conflicts chip). */
  reviewConflicts(projectId: string): Promise<PlanOutcome>
  /**
   * Call after a dependency was added: when it is already violated, Auto mode previews the shifts
   * it requires and Manual mode warns (with "Review"). No conflict → 'unchanged'.
   */
  reviewNewDependency(dependencyId: string): Promise<PlanOutcome>
}

function fromResult(result: Result): PlanOutcome {
  if (result.ok) return { status: 'written' }
  return result.error.kind === 'validation'
    ? { status: 'invalid', error: result.error }
    : { status: 'failed', error: result.error }
}

function fromReschedule(outcome: RescheduleOutcome): PlanOutcome {
  if (outcome.status === 'written') return { status: 'written' }
  if (outcome.status === 'failed') return { status: 'failed', error: outcome.error }
  return { status: 'cancelled' }
}

function invalid(message: string): PlanOutcome {
  return { status: 'invalid', error: { kind: 'validation', message } }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export function createPlanner(env: PlannerEnv): Planner {
  const conflictIds = (data: WorkspaceData, projectId: string) =>
    new Set(
      findConflicts(data.tasks, projectDependencies(data, projectId)).map((c) => c.dependencyId),
    )

  /** Warns about conflicts that did not exist before the write (`before` = conflict ids). */
  function warnAboutNewConflicts(projectId: string, before: ReadonlySet<string>): void {
    const data = env.getData()
    const created = findConflicts(data.tasks, projectDependencies(data, projectId)).filter(
      (conflict) => !before.has(conflict.dependencyId),
    )
    if (created.length === 0) return
    const title = (id: string) => own(data.tasks, id)?.title ?? 'A task'
    const [first] = created
    env.warn(plural(created.length, 'dependency conflict'), {
      description:
        created.length === 1
          ? `“${title(first.successorId)}” starts before “${title(first.predecessorId)}” finishes.`
          : 'Some tasks now start before their predecessors finish.',
      action: { label: 'Review', onClick: () => void planner.reviewConflicts(projectId) },
    })
  }

  const normalizeChange = (c: ScheduleChange): ScheduleChange => ({
    taskId: c.taskId,
    startDate: c.startDate ?? null,
    dueDate: c.dueDate ?? null,
  })

  const planner: Planner = {
    async undoScheduleWrite(record) {
      const data = env.getData()
      for (const applied of record.applied) {
        const task = own(data.tasks, applied.taskId)
        const wanted = normalizeChange(applied)
        if (!task || task.startDate !== wanted.startDate || task.dueDate !== wanted.dueDate) {
          return { status: 'stale' }
        }
      }
      const result = await env.applySchedule(record.previous)
      if (result.ok) return { status: 'restored' }
      return result.error.kind === 'validation'
        ? { status: 'invalid', error: result.error }
        : { status: 'failed', error: result.error }
    },

    async planScheduleChange(change, options = {}) {
      const data = env.getData()
      const task: Task | undefined = own(data.tasks, change.taskId)
      if (!task) return invalid('That task no longer exists.')
      const normalized: ScheduleChange = {
        taskId: change.taskId,
        startDate: change.startDate ?? null,
        dueDate: change.dueDate ?? null,
      }
      const error = validateDateRange(normalized.startDate, normalized.dueDate)
      if (error) return { status: 'invalid', error }
      if (normalized.startDate === task.startDate && normalized.dueDate === task.dueDate) {
        return { status: 'unchanged' }
      }
      const projectId = task.projectId
      const before = conflictIds(data, projectId)
      const mode = own(data.projects, projectId)?.scheduleMode ?? 'manual'

      // The dates the write replaces, read right before it (a preview may sit open for a while).
      let record: ScheduleWriteRecord | null = null
      const write = async (changes: readonly ScheduleChange[]): Promise<Result> => {
        const current = env.getData()
        const previous = changes.map((c) => {
          const t = own(current.tasks, c.taskId)
          return { taskId: c.taskId, startDate: t?.startDate ?? null, dueDate: t?.dueDate ?? null }
        })
        const result = await env.applySchedule(changes, options.writeOptions)
        if (result.ok) record = { applied: changes.map(normalizeChange), previous }
        return result
      }

      let outcome: PlanOutcome
      const { shifts, blocked } =
        mode === 'auto'
          ? computeAutoScheduleDetailed(data.tasks, projectDependencies(data, projectId), [
              normalized,
            ])
          : { shifts: [], blocked: [] }
      if (shifts.length > 0) {
        const decision = await env.requestReschedule(
          { kind: 'change', projectId, change: normalized, source: options.source ?? 'gantt' },
          (choice, writes) => write(choice === 'only' ? [normalized] : writes),
        )
        outcome = fromReschedule(decision)
      } else {
        // Called synchronously (no await before it): the optimistic update lands in the same tick
        // as the caller's drop, so a dragged bar never flickers back.
        outcome = fromResult(await write([normalized]))
      }
      if (outcome.status === 'written') {
        // The Task Modal shows conflicts live in its banner, and every pick now saves right away:
        // a toast would fire for the in-between state of changing both dates.
        if (options.source !== 'modal') warnAboutNewConflicts(projectId, before)
        // With a preview, the dialog already listed them; without one nobody would know.
        if (shifts.length === 0 && blocked.length > 0) {
          const names = blocked.map((s) => `“${own(data.tasks, s.taskId)?.title ?? 'A task'}”`)
          env.warn(
            blocked.length === 1
              ? '1 completed task was not moved'
              : `${blocked.length} completed tasks were not moved`,
            {
              description: `${names.slice(0, 2).join(', ')}${names.length > 2 ? '…' : ''} ${
                blocked.length === 1 ? 'is' : 'are'
              } done, so ${blocked.length === 1 ? 'its' : 'their'} dates stay as they were.`,
            },
          )
        }
        if (record) options.onWritten?.(record)
      }
      return outcome
    },

    async reviewConflicts(projectId) {
      const outcome = await env.requestReschedule(
        { kind: 'resolve', projectId },
        (_choice, writes) => env.applySchedule(writes),
      )
      return fromReschedule(outcome)
    },

    async reviewNewDependency(dependencyId) {
      const data = env.getData()
      const dependency = own(data.dependencies, dependencyId)
      if (!dependency) return { status: 'unchanged' }
      if (findConflicts(data.tasks, [dependency]).length === 0) return { status: 'unchanged' }
      const projectId = dependency.projectId
      const mode = own(data.projects, projectId)?.scheduleMode ?? 'manual'
      const request: RescheduleRequest = { kind: 'dependency', projectId, dependencyId }
      if (mode === 'auto' && computeReschedulePlan(request, data).writes.length > 0) {
        const outcome = await env.requestReschedule(request, (_choice, writes) =>
          env.applySchedule(writes),
        )
        return fromReschedule(outcome)
      }
      const before = new Set([...conflictIds(data, projectId)].filter((id) => id !== dependencyId))
      warnAboutNewConflicts(projectId, before)
      return { status: 'unchanged' }
    },
  }
  return planner
}

const browserPlanner = createPlanner({
  getData: () => useWorkspaceStore.getState().data,
  applySchedule: (changes, options) => getWorkspaceActions().applySchedule(changes, options),
  warn: (message, options) => {
    notify.warning(message, options)
  },
  requestReschedule,
})

/** Changes a task's dates through the project's dependency rules. See the module comment. */
export async function planScheduleChange(
  change: ScheduleChange,
  options: PlanOptions = {},
): Promise<boolean> {
  const outcome = await browserPlanner.planScheduleChange(change, options)
  return outcome.status === 'written' || outcome.status === 'unchanged'
}

/** Like `planScheduleChange`, but tells why nothing was written (validation message included). */
export function planScheduleChangeDetailed(
  change: ScheduleChange,
  options: PlanOptions = {},
): Promise<PlanOutcome> {
  return browserPlanner.planScheduleChange(change, options)
}

/** Takes back one write (see `ScheduleWriteRecord`). */
export function undoScheduleWrite(record: ScheduleWriteRecord): Promise<UndoOutcome> {
  return browserPlanner.undoScheduleWrite(record)
}

/** Opens the "resolve all conflicts" preview for a project. */
export function reviewConflicts(projectId: string): Promise<PlanOutcome> {
  return browserPlanner.reviewConflicts(projectId)
}

/** After `addDependency`: preview (Auto) or warn (Manual) when the new link is violated. */
export function reviewNewDependency(dependencyId: string): Promise<PlanOutcome> {
  return browserPlanner.reviewNewDependency(dependencyId)
}
