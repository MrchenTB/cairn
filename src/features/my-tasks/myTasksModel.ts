/**
 * My Tasks view model: tab parsing, tab counts and the grouping of the All tab. Every rule comes
 * from `src/domain/buckets.ts` (myTasks / dueBucket); this module only arranges its output.
 */
import { dueBucket, isOpenTask, type DueBucket, type MyTasksBuckets } from '@/domain/buckets'
import type { ISODate, Task } from '@/domain/types'

/** Same values as the router's `/my-tasks/:tab` allow-list (src/app/router.tsx). */
export const MY_TASKS_TABS = ['today', 'upcoming', 'overdue', 'all'] as const
export type MyTasksTab = (typeof MY_TASKS_TABS)[number]
export const DEFAULT_MY_TASKS_TAB: MyTasksTab = 'today'

/** The tab for a `:tab` route param; anything unknown is Today (the router redirects it too). */
export function parseMyTasksTab(value: string | null | undefined): MyTasksTab {
  return (MY_TASKS_TABS as readonly string[]).includes(value ?? '')
    ? (value as MyTasksTab)
    : DEFAULT_MY_TASKS_TAB
}

export const TAB_LABELS: Record<MyTasksTab, string> = {
  today: 'Today',
  upcoming: 'Upcoming',
  overdue: 'Overdue',
  all: 'All',
}

/** One-line definitions (tab tooltips, info popover) — worded after the bucket rules. */
export const TAB_DEFINITIONS: Record<MyTasksTab, string> = {
  today: 'Due today and not done',
  upcoming: 'Due in the next 7 days, after today',
  overdue: 'Past their due date and not done',
  all: 'Every task, grouped by due date',
}

/** Query param of the All tab's "Show completed" switch (`?completed=1`; default off). */
export const SHOW_COMPLETED_PARAM = 'completed'

export interface MyTasksCounts {
  today: number
  upcoming: number
  overdue: number
  /** Open tasks (the All tab's rows while completed tasks are hidden). */
  all: number
  /** Done tasks (shown in the All tab with "Show completed"). */
  done: number
}

export function myTasksCounts(buckets: MyTasksBuckets): MyTasksCounts {
  const open = buckets.all.filter(isOpenTask).length
  return {
    today: buckets.today.length,
    upcoming: buckets.upcoming.length,
    overdue: buckets.overdue.length,
    all: open,
    done: buckets.all.length - open,
  }
}

/** The All tab's sections, in this order. */
export const ALL_TAB_GROUPS = ['overdue', 'today', 'upcoming', 'later', 'no_date', 'done'] as const

export const GROUP_LABELS: Record<DueBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
  later: 'Later',
  no_date: 'No due date',
  done: 'Completed',
}

export interface TaskGroup {
  bucket: DueBucket
  tasks: Task[]
}

/**
 * Splits the All list (`myTasks().all`, already sorted) into bucket sections, keeping its order
 * inside each section. Empty sections are left out; `done` only when completed tasks are shown.
 */
export function groupAllTasks(
  all: readonly Task[],
  today: ISODate,
  showCompleted: boolean,
): TaskGroup[] {
  const groups = new Map<DueBucket, Task[]>(ALL_TAB_GROUPS.map((bucket) => [bucket, []]))
  for (const task of all) groups.get(dueBucket(task, today))?.push(task)
  return ALL_TAB_GROUPS.filter((bucket) => showCompleted || bucket !== 'done')
    .map((bucket) => ({ bucket, tasks: groups.get(bucket) ?? [] }))
    .filter((group) => group.tasks.length > 0)
}

/**
 * Whether a task with `status` still belongs in the list it is shown in: Today / Upcoming /
 * Overdue (and Overview's upcoming list) only show open tasks, All shows done ones on request.
 */
export function staysInList(status: Task['status'], showsDone: boolean): boolean {
  return showsDone || status !== 'done'
}
