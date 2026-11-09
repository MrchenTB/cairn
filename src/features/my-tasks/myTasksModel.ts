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
  all: 'All Tasks',
}

/** One-line definitions (tab tooltips, info popover) — worded after the bucket rules. */
export const TAB_DEFINITIONS: Record<MyTasksTab, string> = {
  today: 'Due today, or between its start and due dates',
  upcoming: 'Due in the next 7 days, after today',
  overdue: 'Past their due date and not done',
  all: 'Every open task, grouped by due date',
}

/** Query param of the All tab's "Show completed" switch (`?completed=1`; default off). */
export const SHOW_COMPLETED_PARAM = 'completed'

/**
 * Query param of the All tab's "Due soon" filter (`?due=soon`): only the Today and Upcoming
 * sections, i.e. the tasks the Overview's "Due soon" number counts (today … today + 7 days).
 */
export const DUE_FILTER_PARAM = 'due'
export const DUE_SOON = 'soon'
/** The All tab filtered to "Due soon" — where the Overview's Due soon card leads. */
export const DUE_SOON_HREF = `/my-tasks/all?${DUE_FILTER_PARAM}=${DUE_SOON}`

/** Whether a `?due=` value asks for the Due soon filter (anything else is ignored). */
export function isDueSoonFilter(value: string | null | undefined): boolean {
  return value === DUE_SOON
}

export interface MyTasksCounts {
  /** The Today tab: due today plus scheduled across today (disjoint, so no task is counted twice). */
  today: number
  upcoming: number
  overdue: number
  /** Due today or in the next 7 days — the Overview's Due soon number (not the Today tab count). */
  dueSoon: number
  /** Open tasks (the All tab's rows while completed tasks are hidden). */
  all: number
  /** Done tasks (shown in the All tab with "Show completed"). */
  done: number
}

export function myTasksCounts(buckets: MyTasksBuckets): MyTasksCounts {
  const open = buckets.all.filter(isOpenTask).length
  return {
    today: buckets.today.length + buckets.scheduledToday.length,
    upcoming: buckets.upcoming.length,
    overdue: buckets.overdue.length,
    dueSoon: buckets.today.length + buckets.upcoming.length,
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

/** The Today tab's two sections (keys are also the section heading ids). */
export const TODAY_SECTION_LABELS = {
  dueToday: 'Due today',
  scheduledToday: 'Scheduled today',
} as const

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

/** The Due soon filter: keeps the Today and Upcoming sections of the All tab's groups. */
export function dueSoonGroups(groups: readonly TaskGroup[]): TaskGroup[] {
  return groups.filter((group) => group.bucket === 'today' || group.bucket === 'upcoming')
}

/**
 * Whether a task with `status` still belongs in the list it is shown in: Today / Upcoming /
 * Overdue (and Overview's upcoming list) only show open tasks, All shows done ones on request.
 */
export function staysInList(status: Task['status'], showsDone: boolean): boolean {
  return showsDone || isOpenTask({ status })
}
