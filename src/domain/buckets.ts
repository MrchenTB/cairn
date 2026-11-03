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
import { addDays } from './dates'
import { bySortOrder } from './ordering'
import type { ISODate, Task, TaskPriority, WorkspaceData } from './types'

export const UPCOMING_WINDOW_DAYS = 7

export type DueBucket = 'overdue' | 'today' | 'upcoming' | 'later' | 'no_date' | 'done'

export function isOpenTask(task: Pick<Task, 'status'>): boolean {
  return task.status !== 'done'
}

/** Bucket against a precomputed window end (ISO strings compare chronologically). */
function bucketOf(
  task: Pick<Task, 'status' | 'dueDate'>,
  today: ISODate,
  windowEnd: ISODate,
): DueBucket {
  if (!isOpenTask(task)) return 'done'
  const due = task.dueDate
  if (!due) return 'no_date'
  if (due < today) return 'overdue'
  if (due === today) return 'today'
  return due <= windowEnd ? 'upcoming' : 'later'
}

export function dueBucket(
  task: Pick<Task, 'status' | 'dueDate'>,
  today: ISODate,
  windowDays: number = UPCOMING_WINDOW_DAYS,
): DueBucket {
  return bucketOf(task, today, addDays(today, windowDays))
}

/** The bucket population: every task (any level) whose project exists and is not archived. */
export function bucketPopulation(data: WorkspaceData): Task[] {
  return Object.values(data.tasks).filter((task) => {
    const project = Object.hasOwn(data.projects, task.projectId)
      ? data.projects[task.projectId]
      : undefined
    return project !== undefined && project.status !== 'archived'
  })
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

const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
}

function priorityRank(task: Task): number {
  return PRIORITY_RANK[task.priority] ?? PRIORITY_RANK.none
}

/** Ascending, missing dates last. */
function compareDueDates(a: ISODate | null, b: ISODate | null): number {
  if (a === b) return 0
  if (!a) return 1
  if (!b) return -1
  return a < b ? -1 : 1
}

/**
 * Tie-breakers shared by every list: project order, then the task's position in the project
 * outline (a subtask sorts right after its parent, among its siblings).
 */
function positionComparator(data: WorkspaceData): (a: Task, b: Task) => number {
  const anchorOf = (task: Task): Task =>
    task.parentTaskId && Object.hasOwn(data.tasks, task.parentTaskId)
      ? data.tasks[task.parentTaskId]
      : task
  return (a, b) => {
    if (a.projectId !== b.projectId) {
      const projectA = data.projects[a.projectId]
      const projectB = data.projects[b.projectId]
      const byProject = bySortOrder(projectA, projectB)
      if (byProject !== 0) return byProject
    }
    const anchorA = anchorOf(a)
    const anchorB = anchorOf(b)
    if (anchorA !== anchorB) return bySortOrder(anchorA, anchorB)
    const levelA = anchorA === a ? 0 : 1
    const levelB = anchorB === b ? 0 : 1
    return levelA - levelB || bySortOrder(a, b)
  }
}

/** Epoch ms of a timestamp; missing/unparseable → -Infinity (sorts last when descending). */
function timestampValue(value: string | null): number {
  const time = value ? Date.parse(value) : Number.NaN
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time
}

function compareDescending(a: number, b: number): number {
  return a === b ? 0 : a > b ? -1 : 1
}

/**
 * Sorting inside today/upcoming/overdue: dueDate asc, then priority (urgent→none), then project
 * sortOrder, then task sortOrder.
 */
export function myTasks(data: WorkspaceData, today: ISODate): MyTasksBuckets {
  const windowEnd = addDays(today, UPCOMING_WINDOW_DAYS)
  const buckets: MyTasksBuckets = { today: [], upcoming: [], overdue: [], all: [] }
  const open: Task[] = []
  const done: Task[] = []
  for (const task of bucketPopulation(data)) {
    const bucket = bucketOf(task, today, windowEnd)
    if (bucket === 'done') {
      done.push(task)
      continue
    }
    open.push(task)
    if (bucket === 'today' || bucket === 'upcoming' || bucket === 'overdue') {
      buckets[bucket].push(task)
    }
  }

  const byPosition = positionComparator(data)
  const byDue = (a: Task, b: Task) =>
    compareDueDates(a.dueDate, b.dueDate) || priorityRank(a) - priorityRank(b) || byPosition(a, b)
  buckets.today.sort(byDue)
  buckets.upcoming.sort(byDue)
  buckets.overdue.sort(byDue)
  open.sort(byDue)

  // Recently completed first (then recently updated); timestamps parsed once, not per compare.
  const completed = new Map(done.map((task) => [task, timestampValue(task.completedAt)]))
  const updated = new Map(done.map((task) => [task, timestampValue(task.updatedAt)]))
  done.sort(
    (a, b) =>
      compareDescending(completed.get(a) as number, completed.get(b) as number) ||
      compareDescending(updated.get(a) as number, updated.get(b) as number) ||
      byPosition(a, b),
  )
  buckets.all = [...open, ...done]
  return buckets
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
  const windowEnd = addDays(today, UPCOMING_WINDOW_DAYS)
  const metrics: OverviewMetrics = { activeProjects: 0, openTasks: 0, dueSoon: 0, overdue: 0 }
  for (const project of Object.values(data.projects)) {
    if (project.status === 'active') metrics.activeProjects++
  }
  for (const task of bucketPopulation(data)) {
    const bucket = bucketOf(task, today, windowEnd)
    if (bucket === 'done') continue
    metrics.openTasks++
    if (bucket === 'today' || bucket === 'upcoming') metrics.dueSoon++
    else if (bucket === 'overdue') metrics.overdue++
  }
  return metrics
}
