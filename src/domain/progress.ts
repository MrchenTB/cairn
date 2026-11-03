/**
 * Project progress = completed LEAF tasks / total LEAF tasks.
 * A leaf task has no subtasks; parents are never counted; milestones never count.
 * No tasks → ratio/percent null ("No tasks"), never a fake 100%.
 */
import type { Task, WorkspaceData } from './types'

export interface ProgressInfo {
  total: number
  done: number
  /** 0..1, null when total === 0 */
  ratio: number | null
  /** 0..100 rounded down to an integer (99.6% shows 99 until really done), null when total === 0 */
  percent: number | null
}

function toProgress(done: number, total: number): ProgressInfo {
  if (total === 0) return { total: 0, done: 0, ratio: null, percent: null }
  // Integer arithmetic first: 29 / 100 * 100 would floor to 28.
  return { total, done, ratio: done / total, percent: Math.floor((done * 100) / total) }
}

/** `tasks` = all tasks (any level) of ONE project. */
export function computeProgress(tasks: readonly Task[]): ProgressInfo {
  const parentIds = new Set<string>()
  for (const task of tasks) if (task.parentTaskId) parentIds.add(task.parentTaskId)
  let total = 0
  let done = 0
  for (const task of tasks) {
    if (parentIds.has(task.id)) continue
    total++
    if (task.status === 'done') done++
  }
  return toProgress(done, total)
}
export function projectProgress(data: WorkspaceData, projectId: string): ProgressInfo {
  return computeProgress(Object.values(data.tasks).filter((task) => task.projectId === projectId))
}
/** Progress of every project in `data.projects` (same result as `projectProgress` per project). */
export function progressByProject(data: WorkspaceData): Record<string, ProgressInfo> {
  const tasks = Object.values(data.tasks)
  // A task is a parent when a task OF THE SAME PROJECT points at it (as in computeProgress).
  const parentIds = new Set<string>()
  for (const task of tasks) {
    if (!task.parentTaskId || !Object.hasOwn(data.tasks, task.parentTaskId)) continue
    if (data.tasks[task.parentTaskId].projectId === task.projectId) parentIds.add(task.parentTaskId)
  }
  const counts = new Map<string, { done: number; total: number }>()
  for (const projectId of Object.keys(data.projects)) counts.set(projectId, { done: 0, total: 0 })
  for (const task of tasks) {
    const count = counts.get(task.projectId)
    if (!count || parentIds.has(task.id)) continue
    count.total++
    if (task.status === 'done') count.done++
  }
  const result: Record<string, ProgressInfo> = {}
  for (const [projectId, count] of counts) result[projectId] = toProgress(count.done, count.total)
  return result
}
