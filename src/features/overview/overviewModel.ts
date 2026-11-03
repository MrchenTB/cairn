/**
 * Overview view model. Bucket, progress and roll-up rules come from src/domain (myTasks,
 * overviewMetrics, progressByProject, rollupRange); this module only selects, limits and lays
 * out their results for the dashboard.
 */
import type { MyTasksBuckets } from '@/domain/buckets'
import { addDays, diffDays, isISODate, maxDate, minDate, startOfWeek } from '@/domain/dates'
import { compareMilestones } from '@/domain/hierarchy'
import { rollupRange } from '@/domain/scheduling'
import type { ISODate, Milestone, Project, Task, WorkspaceData } from '@/domain/types'

/** Rows in "Upcoming tasks" and "Upcoming milestones", and projects in "Active projects". */
export const UPCOMING_TASKS_LIMIT = 8
export const UPCOMING_MILESTONES_LIMIT = 8
export const ACTIVE_PROJECTS_LIMIT = 8
/** "Upcoming milestones" window: today … today + 30 days. */
export const MILESTONE_WINDOW_DAYS = 30
/** The mini timeline shows this many weeks from the start of the current week. */
export const TIMELINE_WEEKS = 6
export const TIMELINE_ROWS_LIMIT = 8

export type UpcomingTab = 'overdue' | 'today' | 'upcoming'

export interface UpcomingTasks {
  /** Overdue first, then due today, then the next 7 days (each in My Tasks order). */
  tasks: Task[]
  /** All tasks in those three buckets (tasks.length is capped by the limit). */
  total: number
  /** The My Tasks tab "View all" opens: the first non-empty bucket in the same order. */
  tab: UpcomingTab
}

export function upcomingTasks(
  buckets: MyTasksBuckets,
  limit: number = UPCOMING_TASKS_LIMIT,
): UpcomingTasks {
  const all = [...buckets.overdue, ...buckets.today, ...buckets.upcoming]
  const tab: UpcomingTab =
    buckets.overdue.length > 0 ? 'overdue' : buckets.today.length > 0 ? 'today' : 'upcoming'
  return { tasks: all.slice(0, Math.max(0, limit)), total: all.length, tab }
}

/** Own-property lookup: ids are data, never Object.prototype keys. */
function own<T>(table: Record<string, T>, id: string | null | undefined): T | undefined {
  return id && Object.hasOwn(table, id) ? table[id] : undefined
}

/**
 * Milestones dated today … today + `days`, in projects that are not archived (the same project
 * population as the task buckets), by date then name.
 */
export function upcomingMilestones(
  data: WorkspaceData,
  today: ISODate,
  days: number = MILESTONE_WINDOW_DAYS,
): Milestone[] {
  const end = addDays(today, days)
  return Object.values(data.milestones)
    .filter((milestone) => {
      const project = own(data.projects, milestone.projectId)
      return (
        project !== undefined &&
        project.status !== 'archived' &&
        isISODate(milestone.date) &&
        milestone.date >= today &&
        milestone.date <= end
      )
    })
    .sort(compareMilestones)
}

export interface DateSpan {
  start: ISODate
  /** Inclusive; equal to `start` for a single day. */
  end: ISODate
}

function validDate(value: ISODate | null): ISODate | null {
  return value && isISODate(value) ? value : null
}

/**
 * A project's span on a timeline: each end is the project's own date when set, otherwise the
 * roll-up of its tasks (any level) and milestones. When that mix is inconsistent (e.g. the project
 * is due before its first task starts) the union of all those dates is used. A project with a
 * single date overall is a one-day span; nothing dated → null.
 */
export function projectSpan(
  project: Pick<Project, 'startDate' | 'dueDate'>,
  tasks: readonly Pick<Task, 'startDate' | 'dueDate'>[],
  milestones: readonly Pick<Milestone, 'date'>[],
): DateSpan | null {
  const ownStart = validDate(project.startDate)
  const ownEnd = validDate(project.dueDate)
  const rollup = rollupRange(tasks, milestones)
  const start = ownStart ?? rollup?.start ?? ownEnd
  const end = ownEnd ?? rollup?.end ?? ownStart
  if (!start || !end) return null
  if (start <= end) return { start, end }
  return {
    start: minDate(ownStart, ownEnd, rollup?.start) ?? start,
    end: maxDate(ownStart, ownEnd, rollup?.end) ?? end,
  }
}

export interface TimelineWindow {
  /** First day shown (start of the current week). */
  start: ISODate
  /** Last day shown (inclusive). */
  end: ISODate
  days: number
  /** First day of each week column. */
  weeks: ISODate[]
}

export function timelineWindow(
  today: ISODate,
  weekStartsOn: 0 | 1,
  weeks: number = TIMELINE_WEEKS,
): TimelineWindow {
  const start = startOfWeek(today, weekStartsOn)
  const days = weeks * 7
  return {
    start,
    end: addDays(start, days - 1),
    days,
    weeks: Array.from({ length: weeks }, (_, index) => addDays(start, index * 7)),
  }
}

export interface PlacedSpan {
  /** Percent of the track width. */
  left: number
  width: number
  /** The span continues before / after the window (drawn with a flat edge). */
  clippedStart: boolean
  clippedEnd: boolean
}

/** Where a span sits on the window's track (percentages), or null when it is outside. */
export function placeSpan(span: DateSpan, window: TimelineWindow): PlacedSpan | null {
  const from = diffDays(window.start, span.start)
  const to = diffDays(window.start, span.end) + 1 // exclusive end
  if (to <= 0 || from >= window.days) return null
  const left = Math.max(0, from)
  const right = Math.min(window.days, to)
  return {
    left: (left / window.days) * 100,
    width: ((right - left) / window.days) * 100,
    clippedStart: from < 0,
    clippedEnd: to > window.days,
  }
}

/** Percent position of the middle of `date`'s day column, or null outside the window. */
export function dayCenter(date: ISODate, window: TimelineWindow): number | null {
  const index = diffDays(window.start, date)
  if (index < 0 || index >= window.days) return null
  return ((index + 0.5) / window.days) * 100
}

export interface TimelineRow {
  project: Project
  span: DateSpan | null
  placed: PlacedSpan | null
  /** The project's milestones inside the window, by date. */
  milestones: Milestone[]
}

export interface MiniTimeline {
  window: TimelineWindow
  /** Active projects with something in the window (bar or milestone), in project order, capped. */
  rows: TimelineRow[]
  /** Projects that qualified but were cut by the cap. */
  more: number
  /** Active projects with nothing in the window. */
  idle: number
}

/**
 * The Overview's "Next 6 weeks": one row per active project (in project order) whose span or
 * milestones fall inside the window.
 */
export function miniTimeline(
  data: WorkspaceData,
  activeProjects: readonly Project[],
  window: TimelineWindow,
  limit: number = TIMELINE_ROWS_LIMIT,
): MiniTimeline {
  const tasksByProject = new Map<string, Task[]>()
  for (const task of Object.values(data.tasks)) {
    const list = tasksByProject.get(task.projectId)
    if (list) list.push(task)
    else tasksByProject.set(task.projectId, [task])
  }
  const milestonesByProject = new Map<string, Milestone[]>()
  for (const milestone of Object.values(data.milestones)) {
    const list = milestonesByProject.get(milestone.projectId)
    if (list) list.push(milestone)
    else milestonesByProject.set(milestone.projectId, [milestone])
  }

  const qualified: TimelineRow[] = []
  for (const project of activeProjects) {
    const milestones = milestonesByProject.get(project.id) ?? []
    const span = projectSpan(project, tasksByProject.get(project.id) ?? [], milestones)
    const placed = span ? placeSpan(span, window) : null
    const inWindow = milestones
      .filter((m) => isISODate(m.date) && m.date >= window.start && m.date <= window.end)
      .sort(compareMilestones)
    if (placed || inWindow.length > 0) {
      qualified.push({ project, span, placed, milestones: inWindow })
    }
  }
  return {
    window,
    rows: qualified.slice(0, Math.max(0, limit)),
    more: Math.max(0, qualified.length - limit),
    idle: activeProjects.length - qualified.length,
  }
}
