/**
 * Per-project counts shown by the Projects feature (task column, delete confirmation). Open vs.
 * done uses the shared bucket rule (`isOpenTask`); progress itself comes from domain/progress.
 */
import { isOpenTask } from '@/domain/buckets'
import type { WorkspaceData } from '@/domain/types'

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
  tasks: number
  phases: number
  milestones: number
}

/** What deleting a project removes along with it (tasks include subtasks). */
export function projectContents(data: WorkspaceData, projectId: string): ProjectContents {
  const count = (rows: Record<string, { projectId: string }>) =>
    Object.values(rows).filter((row) => row.projectId === projectId).length
  return {
    tasks: count(data.tasks),
    phases: count(data.phases),
    milestones: count(data.milestones),
  }
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

/** The delete confirmation text, e.g. "Deletes 12 tasks, 2 phases and 1 milestone." */
export function deleteProjectDescription(contents: ProjectContents): string {
  return `Deletes ${listJoin([
    plural(contents.tasks, 'task'),
    plural(contents.phases, 'phase'),
    plural(contents.milestones, 'milestone'),
  ])} along with the project. This can’t be undone.`
}
