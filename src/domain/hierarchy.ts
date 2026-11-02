/**
 * Project structure helpers: Project → (optional Phase) → Task → (optional, ONE level) Subtask.
 */
import type { Milestone, Phase, Project, Result, Task } from './types'
import { notImplemented } from './_todo'

/** parentTaskId → children sorted by sortOrder. */
export function buildChildrenIndex(tasks: readonly Task[]): Map<string, Task[]> {
  return notImplemented('buildChildrenIndex' + tasks.length)
}
/** True when no task has `taskId` as parent. */
export function isLeafTask(taskId: string, tasks: readonly Task[]): boolean {
  return notImplemented('isLeafTask' + taskId + tasks.length)
}
/** Top-level tasks of a project, sorted (one ordering space per project, across phases). */
export function topLevelTasks(tasks: readonly Task[], projectId: string): Task[] {
  return notImplemented('topLevelTasks' + tasks.length + projectId)
}
/** Subtasks of a parent, sorted. */
export function subtasksOf(tasks: readonly Task[], parentTaskId: string): Task[] {
  return notImplemented('subtasksOf' + tasks.length + parentTaskId)
}
/**
 * Can `task` become a subtask of `parent`? Rules: not itself, same project, parent is top-level,
 * `task` has no subtasks of its own. Returns a validation error with a readable message otherwise.
 */
export function canBecomeSubtaskOf(task: Task, parent: Task, tasks: readonly Task[]): Result {
  return notImplemented('canBecomeSubtaskOf' + task.id + parent.id + tasks.length)
}

export interface OutlineTask {
  task: Task
  /** sorted subtasks (empty for leaf tasks) */
  subtasks: Task[]
}
export interface OutlineGroup {
  /** null = tasks without a phase ("No phase") */
  phase: Phase | null
  /** top-level tasks of this group in sortOrder */
  tasks: OutlineTask[]
  /** milestones of this group sorted by date, then name */
  milestones: Milestone[]
}
export interface ProjectOutline {
  project: Project
  /** true when the project has at least one phase */
  hasPhases: boolean
  /**
   * groups[0] is ALWAYS the null-phase group (possibly empty), followed by one group per phase
   * in phase sortOrder (empty phases included).
   */
  groups: OutlineGroup[]
}
/** Builds the List/Gantt outline. Inputs may contain other projects' rows; they are filtered out. */
export function buildProjectOutline(
  project: Project,
  phases: readonly Phase[],
  tasks: readonly Task[],
  milestones: readonly Milestone[],
): ProjectOutline {
  return notImplemented(
    'buildProjectOutline' + project.id + phases.length + tasks.length + milestones.length,
  )
}
