/**
 * Project progress = completed LEAF tasks / total LEAF tasks.
 * A leaf task has no subtasks; parents are never counted; milestones never count.
 * No tasks → ratio/percent null ("No tasks"), never a fake 100%.
 */
import type { Task, WorkspaceData } from './types'
import { notImplemented } from './_todo'

export interface ProgressInfo {
  total: number
  done: number
  /** 0..1, null when total === 0 */
  ratio: number | null
  /** 0..100 rounded down to an integer (99.6% shows 99 until really done), null when total === 0 */
  percent: number | null
}

/** `tasks` = all tasks (any level) of ONE project. */
export function computeProgress(tasks: readonly Task[]): ProgressInfo {
  return notImplemented('computeProgress' + tasks.length)
}
export function projectProgress(data: WorkspaceData, projectId: string): ProgressInfo {
  return notImplemented('projectProgress' + Object.keys(data).length + projectId)
}
export function progressByProject(data: WorkspaceData): Record<string, ProgressInfo> {
  return notImplemented('progressByProject' + Object.keys(data).length)
}
