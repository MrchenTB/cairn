/**
 * Counts shown by the Projects feature (task column, project / phase delete confirmations). Open
 * vs. done uses the shared bucket rule (`isOpenTask`); progress itself comes from domain/progress.
 */
import { isOpenTask } from '@/domain/buckets'
import type { Milestone, Task, WorkspaceData } from '@/domain/types'

export interface TaskCounts {
  /** Tasks of any level that are not done. */
  open: number
  /** All tasks of the project, subtasks included. */
  total: number
}

/** Open / total tasks (any level) of every project in `data.projects`. */
export function taskCountsByProject(data: WorkspaceData): Record<string, TaskCounts> {
  const counts: Record<string, TaskCounts> = {}
  for (const projectId of Object.keys(data.projects)) counts[projectId] = { open: 0, total: 0 }
  for (const task of Object.values(data.tasks)) {
    const count = Object.hasOwn(counts, task.projectId) ? counts[task.projectId] : undefined
    if (!count) continue
    count.total++
    if (isOpenTask(task)) count.open++
  }
  return counts
}

export interface ProjectContents {
  /** Top-level tasks. */
  tasks: number
  subtasks: number
  phases: number
  milestones: number
}

/** What deleting a project removes along with it, from one project's rows. */
export function contentsOf(
  tasks: readonly Pick<Task, 'parentTaskId'>[],
  phases: readonly unknown[],
  milestones: readonly unknown[],
): ProjectContents {
  const subtasks = tasks.filter((task) => task.parentTaskId).length
  return {
    tasks: tasks.length - subtasks,
    subtasks,
    phases: phases.length,
    milestones: milestones.length,
  }
}

/** What deleting a project removes along with it. */
export function projectContents(data: WorkspaceData, projectId: string): ProjectContents {
  const of = <T extends { projectId: string }>(rows: Record<string, T>) =>
    Object.values(rows).filter((row) => row.projectId === projectId)
  return contentsOf(of(data.tasks), of(data.phases), of(data.milestones))
}

/** "1 task", "3 tasks", "0 phases". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`
}

/** "a, b and c" (English list). */
export function listJoin(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/**
 * The delete confirmation text, e.g. "Deletes 12 tasks, 4 subtasks, 2 phases and 1 milestone along
 * with the project." Zero counts are left out.
 */
export function deleteProjectDescription(contents: ProjectContents): string {
  const parts: string[] = []
  if (contents.tasks > 0) parts.push(plural(contents.tasks, 'task'))
  if (contents.subtasks > 0) parts.push(plural(contents.subtasks, 'subtask'))
  if (contents.phases > 0) parts.push(plural(contents.phases, 'phase'))
  if (contents.milestones > 0) parts.push(plural(contents.milestones, 'milestone'))
  if (parts.length === 0)
    return 'The project has no tasks, phases or milestones. This can’t be undone.'
  return `Deletes ${listJoin(parts)} along with the project. This can’t be undone.`
}

export interface PhaseContents {
  /** Top-level tasks of the phase (what its List group counts). */
  tasks: number
  /** Their subtasks (they always carry the parent's phase). */
  subtasks: number
  milestones: number
}

/** What a phase groups: its tasks (top-level / subtasks) and milestones. */
export function phaseContents(
  phaseId: string,
  tasks: readonly Pick<Task, 'phaseId' | 'parentTaskId'>[],
  milestones: readonly Pick<Milestone, 'phaseId'>[],
): PhaseContents {
  let top = 0
  let subtasks = 0
  for (const task of tasks) {
    if (task.phaseId !== phaseId) continue
    if (task.parentTaskId) subtasks++
    else top++
  }
  return {
    tasks: top,
    subtasks,
    milestones: milestones.filter((milestone) => milestone.phaseId === phaseId).length,
  }
}

/**
 * The phase delete confirmation, e.g. "Its 3 tasks, 2 subtasks and 1 milestone become ungrouped
 * (No phase). Nothing else is deleted." Zero counts are left out.
 */
export function deletePhaseDescription(contents: PhaseContents): string {
  const parts: string[] = []
  if (contents.tasks > 0) parts.push(plural(contents.tasks, 'task'))
  if (contents.subtasks > 0) parts.push(plural(contents.subtasks, 'subtask'))
  if (contents.milestones > 0) parts.push(plural(contents.milestones, 'milestone'))
  if (parts.length === 0) return 'The phase is empty. Nothing else is deleted.'
  const single =
    parts.length === 1 && contents.tasks + contents.subtasks + contents.milestones === 1
  return `Its ${listJoin(parts)} ${single ? 'becomes' : 'become'} ungrouped (No phase). Nothing else is deleted.`
}
