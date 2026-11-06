/**
 * Row model of the cross-project Timeline (PRD §4.8), pure and unit-tested. One row per listed
 * project in the projects list's order; projects with nothing dated go to the bottom under
 * "Unscheduled". Expanding a project adds its scheduled top-level tasks (in outline order) and
 * then its milestones (by date). Those child rows ARE the Gantt's task / milestone rows
 * (built by `buildGanttRows`), so they draw exactly as they do in the project's Gantt.
 */
import { formatDateRange, fromEpochDay, isISODate, tryToEpochDay } from '@/domain/dates'
import { buildProjectOutline, compareMilestones } from '@/domain/hierarchy'
import { bySortOrder } from '@/domain/ordering'
import { computeProgress, type ProgressInfo } from '@/domain/progress'
import { rollupRange } from '@/domain/scheduling'
import type {
  ISODate,
  Milestone,
  Phase,
  Project,
  ProjectStatus,
  Task,
  WorkspaceData,
} from '@/domain/types'
import { ROW_HEIGHT } from '@/features/gantt/model/constants'
import {
  UNSCHEDULED_KEY,
  buildGanttRows,
  isUnscheduledOutlineTask,
  taskRowKey,
  type MilestoneRow,
  type TaskRow,
} from '@/features/gantt/model/rows'
import { unionRange, type DayRange } from '@/features/gantt/model/scale'
import { dataBounds } from '@/features/gantt/model/viewport'
import { projectSpan } from '@/features/overview/overviewModel'

/** Project rows are a little taller than the 32px task rows, so the hierarchy reads at a glance. */
export const PROJECT_ROW_HEIGHT = 36
export const UNSCHEDULED_SECTION_KEY = 'section:unscheduled'

export const projectRowKey = (projectId: string) => `project:${projectId}`

/** A milestone drawn as a diamond on its project's row. */
export interface MilestoneMark {
  milestone: Milestone
  day: number
}

export interface ProjectRow {
  kind: 'project'
  key: string
  project: Project
  /**
   * Bar extent (inclusive epoch days). Each end is the project's own date when set, otherwise the
   * roll-up of its tasks (any level) and milestones. null = nothing dated: listed as Unscheduled.
   */
  range: DayRange | null
  /** At least one end of `range` comes from the roll-up rather than the project's own dates. */
  rolledUp: boolean
  /** Leaf-task progress (milestones never count). */
  progress: ProgressInfo
  /** In date order; milestones with corrupt dates have no diamond. */
  milestones: MilestoneMark[]
  /** Rows an expansion would list: scheduled top-level tasks + milestones. 0 = nothing to expand. */
  childCount: number
  /** Its child rows follow it. */
  expanded: boolean
}

export interface UnscheduledSectionRow {
  kind: 'section'
  key: typeof UNSCHEDULED_SECTION_KEY
  /** Projects listed under this header. */
  count: number
}

export type TimelineRow = ProjectRow | UnscheduledSectionRow | TaskRow | MilestoneRow

export interface TimelineRowModel {
  rows: TimelineRow[]
  /** Earliest / latest date of every listed project (collapsed or not); null = nothing dated. */
  bounds: DayRange | null
  /** Sum of all row heights. */
  totalHeight: number
  /** Projects with a row. */
  projectCount: number
  /** Listed projects that have a bar. */
  scheduledCount: number
  /** Completed projects in the workspace, listed or not. */
  completedCount: number
  /** The first project with a row, in row order. */
  firstProject: Project | null
}

export interface TimelineRowOptions {
  /** Project ids whose rows are expanded. */
  expanded: ReadonlySet<string>
  /** Also list completed projects (archived projects are never listed). */
  includeCompleted: boolean
}

export function rowHeightOf(row: TimelineRow): number {
  return row.kind === 'project' ? PROJECT_ROW_HEIGHT : ROW_HEIGHT
}

function groupByProject<T extends { projectId: string }>(items: Iterable<T>): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const group = groups.get(item.projectId)
    if (group) group.push(item)
    else groups.set(item.projectId, [item])
  }
  return groups
}

function isListed(status: ProjectStatus, includeCompleted: boolean): boolean {
  return status === 'active' || (status === 'completed' && includeCompleted)
}

function toDayRange(span: { start: ISODate; end: ISODate } | null): DayRange | null {
  if (!span) return null
  const start = tryToEpochDay(span.start)
  const end = tryToEpochDay(span.end)
  return start === null || end === null ? null : { start, end }
}

/**
 * The rows under an expanded project: its scheduled top-level tasks, then its milestones. Every
 * parent is collapsed for `buildGanttRows`: the Timeline never lists subtasks, their dates show
 * as the parent's roll-up.
 */
function childRows(
  project: Project,
  phases: readonly Phase[],
  tasks: readonly Task[],
  milestones: readonly Milestone[],
): { taskRows: TaskRow[]; milestoneRows: MilestoneRow[] } {
  const outline = buildProjectOutline(project, phases, tasks, milestones)
  const collapsed = new Set<string>([UNSCHEDULED_KEY])
  for (const group of outline.groups) {
    for (const item of group.tasks) {
      if (item.subtasks.length > 0) collapsed.add(taskRowKey(item.task.id))
    }
  }
  const taskRows: TaskRow[] = []
  const milestoneRows: MilestoneRow[] = []
  for (const row of buildGanttRows(outline, collapsed).rows) {
    // No chevron in the row: there is nothing to reveal under a task here.
    if (row.kind === 'task') taskRows.push({ ...row, subtaskCount: 0, collapsed: false })
    else if (row.kind === 'milestone') milestoneRows.push(row)
  }
  milestoneRows.sort((a, b) => compareMilestones(a.milestone, b.milestone))
  return { taskRows, milestoneRows }
}

export function buildTimelineRows(
  data: WorkspaceData,
  { expanded, includeCompleted }: TimelineRowOptions,
): TimelineRowModel {
  const phasesByProject = groupByProject(Object.values(data.phases))
  const tasksByProject = groupByProject(Object.values(data.tasks))
  const milestonesByProject = groupByProject(Object.values(data.milestones))

  const allProjects = Object.values(data.projects)
  const projects = allProjects
    .filter((project) => isListed(project.status, includeCompleted))
    .sort(bySortOrder)

  const rows: TimelineRow[] = []
  const unscheduled: ProjectRow[] = []
  let bounds: DayRange | null = null

  for (const project of projects) {
    const phases = phasesByProject.get(project.id) ?? []
    const tasks = tasksByProject.get(project.id) ?? []
    const milestones = milestonesByProject.get(project.id) ?? []

    const projectBounds = dataBounds(tasks, milestones, project)
    if (projectBounds) bounds = bounds ? unionRange(bounds, projectBounds) : projectBounds

    const marks: MilestoneMark[] = []
    for (const milestone of [...milestones].sort(compareMilestones)) {
      const day = tryToEpochDay(milestone.date)
      if (day !== null) marks.push({ milestone, day })
    }
    const scheduledTasks = buildProjectOutline(project, phases, tasks, milestones)
      .groups.flatMap((group) => group.tasks)
      .filter((item) => !isUnscheduledOutlineTask(item)).length
    const childCount = scheduledTasks + milestones.length

    const range = toDayRange(projectSpan(project, tasks, milestones))
    const isExpanded = range !== null && childCount > 0 && expanded.has(project.id)
    const row: ProjectRow = {
      kind: 'project',
      key: projectRowKey(project.id),
      project,
      range,
      rolledUp:
        rollupRange(tasks, milestones) !== null &&
        !(isISODate(project.startDate) && isISODate(project.dueDate)),
      progress: computeProgress(tasks),
      milestones: marks,
      childCount,
      expanded: isExpanded,
    }
    if (!range) {
      unscheduled.push(row)
      continue
    }
    rows.push(row)
    if (isExpanded) {
      const { taskRows, milestoneRows } = childRows(project, phases, tasks, milestones)
      rows.push(...taskRows, ...milestoneRows)
    }
  }

  const scheduledCount = projects.length - unscheduled.length
  if (unscheduled.length > 0) {
    rows.push({ kind: 'section', key: UNSCHEDULED_SECTION_KEY, count: unscheduled.length })
    rows.push(...unscheduled)
  }

  let totalHeight = 0
  for (const row of rows) totalHeight += rowHeightOf(row)
  const firstRow = rows.find((row): row is ProjectRow => row.kind === 'project')

  return {
    rows,
    bounds,
    totalHeight,
    projectCount: projects.length,
    scheduledCount,
    completedCount: allProjects.filter((project) => project.status === 'completed').length,
    firstProject: firstRow?.project ?? null,
  }
}

/** Each listed project's next milestone to come (on or after today), for the accent ring. */
export function nextMilestoneIds(
  rows: readonly TimelineRow[],
  today: ISODate,
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.kind !== 'project') continue
    const next = row.milestones.find((mark) => mark.milestone.date >= today)
    if (next) ids.add(next.milestone.id)
  }
  return ids
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * "Nov 2 – Dec 1", "Due Dec 1" (only that date is known) or "No dates". A range that is not
 * entirely the project's own says which end comes from its tasks and milestones.
 */
function datesLabel({ range, rolledUp, project }: ProjectRow, today: ISODate): string {
  if (!range) return 'No dates'
  if (rolledUp) {
    const extent = formatDateRange(fromEpochDay(range.start), fromEpochDay(range.end), today)
    // An own date only counts when the bar really starts / ends there (an inconsistent mix is
    // drawn as the union of everything).
    const ownStart =
      isISODate(project.startDate) && tryToEpochDay(project.startDate) === range.start
    const ownEnd = isISODate(project.dueDate) && tryToEpochDay(project.dueDate) === range.end
    const source = ownStart ? 'end' : ownEnd ? 'start' : null
    return `${extent} (${source ? `${source} from` : 'from'} its tasks and milestones)`
  }
  const own = (date: ISODate | null) => (isISODate(date) ? date : null)
  return formatDateRange(own(project.startDate), own(project.dueDate), today)
}

/** "3 of 8 tasks done · 37%" or "No tasks" (never a fake 100%). */
export function progressLabel(progress: ProgressInfo): string {
  if (progress.percent === null) return 'No tasks'
  return `${progress.done} of ${plural(progress.total, 'task')} done · ${progress.percent}%`
}

/** What a project row shows, in words: its bar's tooltip and screen-reader description. */
export function projectRowSummary(row: ProjectRow, today: ISODate): string {
  const parts = [datesLabel(row, today), progressLabel(row.progress)]
  if (row.project.status === 'completed') parts.unshift('Completed')
  if (row.milestones.length > 0) parts.push(plural(row.milestones.length, 'milestone'))
  return parts.join(' · ')
}
