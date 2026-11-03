/**
 * Project structure helpers: Project → (optional Phase) → Task → (optional, ONE level) Subtask.
 */
import { bySortOrder } from './ordering'
import type { Milestone, Phase, Project, Result, Task } from './types'

/** parentTaskId → children sorted by sortOrder. */
export function buildChildrenIndex(tasks: readonly Task[]): Map<string, Task[]> {
  const index = new Map<string, Task[]>()
  for (const task of tasks) {
    if (!task.parentTaskId) continue
    const children = index.get(task.parentTaskId)
    if (children) children.push(task)
    else index.set(task.parentTaskId, [task])
  }
  for (const children of index.values()) children.sort(bySortOrder)
  return index
}
/** True when no task has `taskId` as parent. */
export function isLeafTask(taskId: string, tasks: readonly Task[]): boolean {
  return !tasks.some((task) => task.parentTaskId === taskId)
}
/** Top-level tasks of a project, sorted (one ordering space per project, across phases). */
export function topLevelTasks(tasks: readonly Task[], projectId: string): Task[] {
  return tasks
    .filter((task) => task.projectId === projectId && !task.parentTaskId)
    .sort(bySortOrder)
}
/** Subtasks of a parent, sorted. */
export function subtasksOf(tasks: readonly Task[], parentTaskId: string): Task[] {
  return tasks.filter((task) => task.parentTaskId === parentTaskId).sort(bySortOrder)
}

function invalid(message: string): Result {
  return { ok: false, error: { kind: 'validation', message } }
}

/**
 * Can `task` become a subtask of `parent`? Rules: not itself, same project, parent is top-level,
 * `task` has no subtasks of its own. Returns a validation error with a readable message otherwise.
 */
export function canBecomeSubtaskOf(task: Task, parent: Task, tasks: readonly Task[]): Result {
  if (task.id === parent.id) return invalid("A task can't be its own subtask.")
  if (task.projectId !== parent.projectId) {
    return invalid('A subtask must be in the same project as its parent.')
  }
  if (parent.parentTaskId) return invalid('Only top-level tasks can have subtasks.')
  if (tasks.some((other) => other.parentTaskId === task.id)) {
    return invalid("A task that has subtasks can't become a subtask.")
  }
  return { ok: true, value: undefined }
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

const nameCollator = new Intl.Collator(undefined, { numeric: true })

/** Milestone order: date, then name, then id (deterministic). */
export function compareMilestones(a: Milestone, b: Milestone): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  return nameCollator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * Builds the List/Gantt outline. Inputs may contain other projects' rows; they are filtered out.
 * Tasks or milestones whose phase is not among `phases` go to the null-phase group. A subtask
 * whose parent is missing (or is itself a subtask) is shown as a top-level task, so corrupt
 * data never makes a task disappear.
 */
export function buildProjectOutline(
  project: Project,
  phases: readonly Phase[],
  tasks: readonly Task[],
  milestones: readonly Milestone[],
): ProjectOutline {
  const projectPhases = phases.filter((phase) => phase.projectId === project.id).sort(bySortOrder)
  const noPhase: OutlineGroup = { phase: null, tasks: [], milestones: [] }
  const groups: OutlineGroup[] = [noPhase]
  const groupByPhaseId = new Map<string, OutlineGroup>()
  for (const phase of projectPhases) {
    const group: OutlineGroup = { phase, tasks: [], milestones: [] }
    groups.push(group)
    groupByPhaseId.set(phase.id, group)
  }
  const groupOf = (phaseId: string | null) => (phaseId && groupByPhaseId.get(phaseId)) || noPhase

  const projectTasks = tasks.filter((task) => task.projectId === project.id)
  const byId = new Map(projectTasks.map((task) => [task.id, task]))
  const children = new Map<string, Task[]>()
  const roots: Task[] = []
  for (const task of projectTasks) {
    const parent = task.parentTaskId ? byId.get(task.parentTaskId) : undefined
    if (parent && parent.id !== task.id && !parent.parentTaskId) {
      const siblings = children.get(parent.id)
      if (siblings) siblings.push(task)
      else children.set(parent.id, [task])
    } else {
      roots.push(task)
    }
  }
  roots.sort(bySortOrder)
  for (const task of roots) {
    const subtasks = (children.get(task.id) ?? []).sort(bySortOrder)
    groupOf(task.phaseId).tasks.push({ task, subtasks })
  }

  for (const milestone of milestones) {
    if (milestone.projectId === project.id) groupOf(milestone.phaseId).milestones.push(milestone)
  }
  for (const group of groups) group.milestones.sort(compareMilestones)

  return { project, hasPhases: projectPhases.length > 0, groups }
}
