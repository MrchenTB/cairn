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
  computeAutoSchedule,
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
      return { change: null, shifts: [], writes: [], error: 'This task no longer exists.' }
    }
    const shifts = computeAutoSchedule(data.tasks, dependencies, [request.change])
    return {
      change: request.change,
      shifts,
      writes: [request.change, ...toScheduleChanges(shifts)],
      error: null,
    }
  }
  if (request.kind === 'dependency') {
    const dependency = own(data.dependencies, request.dependencyId)
    const predecessor = dependency ? own(data.tasks, dependency.predecessorId) : undefined
    if (!dependency || !predecessor) {
      return { change: null, shifts: [], writes: [], error: 'This dependency no longer exists.' }
    }
    // The predecessor keeps its dates; only what the new link forces moves.
    const pinned: ScheduleChange = {
      taskId: predecessor.id,
      startDate: predecessor.startDate,
      dueDate: predecessor.dueDate,
    }
    const shifts = computeAutoSchedule(data.tasks, dependencies, [pinned])
    return { change: null, shifts, writes: toScheduleChanges(shifts), error: null }
  }
  const shifts = computeAutoSchedule(data.tasks, dependencies, [])
  return { change: null, shifts, writes: toScheduleChanges(shifts), error: null }
}

// ---------------------------------------------------------------------------
// Planner (environment injected so decisions are unit-testable)
// ---------------------------------------------------------------------------

export interface PlannerEnv {
  getData(): WorkspaceData
  applySchedule(changes: readonly ScheduleChange[]): Promise<Result>
  warn(message: string, options: { description?: string; action?: NotifyAction }): void
  requestReschedule(
    request: RescheduleRequest,
    execute: RescheduleExecutor,
  ): Promise<RescheduleOutcome>
}

export interface Planner {
  planScheduleChange(
    change: ScheduleChange,
    options?: { source?: ScheduleChangeSource },
  ): Promise<PlanOutcome>
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

  const planner: Planner = {
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

      let outcome: PlanOutcome
      const shifts =
        mode === 'auto'
          ? computeAutoSchedule(data.tasks, projectDependencies(data, projectId), [normalized])
          : []
      if (shifts.length > 0) {
        const decision = await env.requestReschedule(
          { kind: 'change', projectId, change: normalized, source: options.source ?? 'gantt' },
          (choice, writes) => env.applySchedule(choice === 'only' ? [normalized] : writes),
        )
        outcome = fromReschedule(decision)
      } else {
        // Called synchronously (no await before it): the optimistic update lands in the same tick
        // as the caller's drop, so a dragged bar never flickers back.
        outcome = fromResult(await env.applySchedule([normalized]))
      }
      if (outcome.status === 'written') warnAboutNewConflicts(projectId, before)
      return outcome
    },

    async reviewConflicts(projectId) {
      const outcome = await env.requestReschedule({ kind: 'resolve', projectId }, (_choice, writes) =>
        env.applySchedule(writes),
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
      const before = new Set(
        [...conflictIds(data, projectId)].filter((id) => id !== dependencyId),
      )
      warnAboutNewConflicts(projectId, before)
      return { status: 'unchanged' }
    },
  }
  return planner
}

const browserPlanner = createPlanner({
  getData: () => useWorkspaceStore.getState().data,
  applySchedule: (changes) => getWorkspaceActions().applySchedule(changes),
  warn: (message, options) => {
    notify.warning(message, options)
  },
  requestReschedule,
})

/** Changes a task's dates through the project's dependency rules. See the module comment. */
export async function planScheduleChange(
  change: ScheduleChange,
  options: { source?: ScheduleChangeSource } = {},
): Promise<boolean> {
  const outcome = await browserPlanner.planScheduleChange(change, options)
  return outcome.status === 'written' || outcome.status === 'unchanged'
}

/** Like `planScheduleChange`, but tells why nothing was written (validation message included). */
export function planScheduleChangeDetailed(
  change: ScheduleChange,
  options: { source?: ScheduleChangeSource } = {},
): Promise<PlanOutcome> {
  return browserPlanner.planScheduleChange(change, options)
}

/** Opens the "resolve all conflicts" preview for a project. */
export function reviewConflicts(projectId: string): Promise<PlanOutcome> {
  return browserPlanner.reviewConflicts(projectId)
}

/** After `addDependency`: preview (Auto) or warn (Manual) when the new link is violated. */
export function reviewNewDependency(dependencyId: string): Promise<PlanOutcome> {
  return browserPlanner.reviewNewDependency(dependencyId)
}
