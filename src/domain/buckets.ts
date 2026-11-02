/**
 * Due-date buckets and cross-project definitions. These definitions are used by
 * Overview, My Tasks, Sidebar badges and anywhere else — never re-implement them in a view.
 *
 * Population: tasks (ANY level: top-level and subtasks) whose project is NOT archived.
 * - overdue  : open (status !== 'done') and dueDate <  today
 * - today    : open and dueDate === today
 * - upcoming : open and today < dueDate <= today + UPCOMING_WINDOW_DAYS
 * - later    : open and dueDate beyond the window
 * - no_date  : open and no dueDate
 * - done     : status === 'done'
 * "today" always comes from `todayInTimeZone(preferences.timezone)` (hook: `useToday()`).
 */
import type { ISODate, Task, WorkspaceData } from './types'
import { notImplemented } from './_todo'

export const UPCOMING_WINDOW_DAYS = 7

export type DueBucket = 'overdue' | 'today' | 'upcoming' | 'later' | 'no_date' | 'done'

export function isOpenTask(task: Pick<Task, 'status'>): boolean {
  return notImplemented('isOpenTask' + task.status)
}
export function dueBucket(
  task: Pick<Task, 'status' | 'dueDate'>,
  today: ISODate,
  windowDays: number = UPCOMING_WINDOW_DAYS,
): DueBucket {
  return notImplemented('dueBucket' + task.status + today + windowDays)
}

export interface MyTasksBuckets {
  /** open, due today */
  today: Task[]
  /** open, due tomorrow..today+window */
  upcoming: Task[]
  /** open, due before today */
  overdue: Task[]
  /** every task in the population: open first (by due date, nulls last), then done (recently completed first) */
  all: Task[]
}
/**
 * Sorting inside today/upcoming/overdue: dueDate asc, then priority (urgent→none), then project
 * sortOrder, then task sortOrder.
 */
export function myTasks(data: WorkspaceData, today: ISODate): MyTasksBuckets {
  return notImplemented('myTasks' + Object.keys(data).length + today)
}

export interface OverviewMetrics {
  /** projects with status 'active' */
  activeProjects: number
  /** open tasks (any level) in non-archived projects */
  openTasks: number
  /** open tasks due today..today+window (= My Tasks today + upcoming) */
  dueSoon: number
  /** open tasks due before today (= My Tasks overdue) */
  overdue: number
}
export function overviewMetrics(data: WorkspaceData, today: ISODate): OverviewMetrics {
  return notImplemented('overviewMetrics' + Object.keys(data).length + today)
}
