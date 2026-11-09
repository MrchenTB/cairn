/**
 * Row model: the project outline (src/domain/hierarchy.ts → buildProjectOutline) flattened into
 * the Gantt's fixed-height rows, honouring collapsed groups/parents. Order:
 *   null-phase group (header only when the project has phases) → phases in order → each group's
 *   top-level tasks (subtasks indented under their parent) → the group's milestones by date.
 * Tasks always stay in their own phase; a task without dates keeps an empty, drawable lane there.
 *
 * Filter mode (`unscheduledOnly`, the toolbar's "Unscheduled n" toggle) walks the same outline but
 * keeps only tasks with neither a start nor a due date: a matching parent with just its matching
 * subtasks, or a scheduled parent as a `context` row above its matching subtasks. Groups without
 * a match and all milestones are left out. Everything downstream (indexes, virtualiser, links,
 * drag geometry) reads this one model, so nothing is hidden by CSS.
 */
import type { OutlineTask, ProjectOutline } from '@/domain/hierarchy'
import { tryToEpochDay } from '@/domain/dates'
import { rollupRange, taskSpan } from '@/domain/scheduling'
import type { Milestone, Phase, Task } from '@/domain/types'
import { toDaySpan, type DaySpan } from './geometry'
import type { DayRange } from './scale'

export const NO_PHASE_KEY = 'group:none'

export const taskRowKey = (taskId: string) => `task:${taskId}`
export const milestoneRowKey = (milestoneId: string) => `milestone:${milestoneId}`
export const groupKeyForPhaseId = (phaseId: string | null) =>
  phaseId ? `group:${phaseId}` : NO_PHASE_KEY
export const groupRowKey = (phase: Phase | null) => groupKeyForPhaseId(phase ? phase.id : null)

export interface GroupRow {
  kind: 'group'
  key: string
  phase: Phase | null
  label: string
  /** Tasks (any level) listed under this header; in filter mode only the matching ones. */
  taskCount: number
  /** Filter mode: `taskCount` counts only the tasks without dates. */
  unscheduledOnly: boolean
  collapsed: boolean
  /** Read-only bracket over the group's tasks and milestones. */
  rollup: DayRange | null
}

export interface TaskRow {
  kind: 'task'
  key: string
  task: Task
  depth: 0 | 1
  /** Number of subtasks shown below it (0 for leaves and subtasks). */
  subtaskCount: number
  /** Parent whose subtasks are hidden. */
  collapsed: boolean
  /** The task's own dates. */
  span: DaySpan
  /** Parent without own dates: bracket over its subtasks' dates. */
  rollup: DayRange | null
  /** Collapsed parent WITH own dates: thin line showing its hidden subtasks' extent. */
  subtaskRollup: DayRange | null
  /**
   * Filter mode only: a scheduled parent shown for its unscheduled subtasks. Not a match, not
   * counted in its group header.
   */
  context: boolean
  /** Empty lane: dragging across it (or double-clicking) schedules the task. */
  drawable: boolean
}

export interface MilestoneRow {
  kind: 'milestone'
  key: string
  milestone: Milestone
  /** null only for corrupt dates (the row still shows, without a diamond). */
  day: number | null
}

export type GanttRow = GroupRow | TaskRow | MilestoneRow

export interface GanttRowModel {
  rows: GanttRow[]
  /** Row index of every task that currently has a row (collapsed ones are absent). */
  taskRowIndex: Map<string, number>
  /** Row index by row key (`task:…`, `milestone:…`, `group:…`). */
  rowIndexByKey: Map<string, number>
  /**
   * Tasks (top-level and subtasks, not milestones) with neither start nor due date, across the
   * whole project: independent of collapsed rows and of the filter.
   */
  unscheduledCount: number
  /** Tasks with at least one date. */
  scheduledTaskCount: number
}

function toDayRange(range: { start: string; end: string } | null): DayRange | null {
  if (!range) return null
  const start = tryToEpochDay(range.start)
  const end = tryToEpochDay(range.end)
  return start === null || end === null ? null : { start, end }
}

function hasNoDates(task: Task): boolean {
  return taskSpan(task).kind === 'unscheduled'
}

export interface BuildRowsOptions {
  /** Filter mode: only tasks without dates (plus their scheduled parents as context rows). */
  unscheduledOnly?: boolean
}

/** One top-level item as shown: its subtasks may be a filtered subset of the real ones. */
interface ShownItem {
  item: OutlineTask
  shownSubtasks: readonly Task[]
  context: boolean
}

export function buildGanttRows(
  outline: ProjectOutline,
  collapsed: ReadonlySet<string>,
  options: BuildRowsOptions = {},
): GanttRowModel {
  const filtering = options.unscheduledOnly === true
  const rows: GanttRow[] = []
  const taskRowIndex = new Map<string, number>()
  let scheduledTaskCount = 0
  let unscheduledCount = 0
  for (const group of outline.groups) {
    for (const item of group.tasks) {
      for (const task of [item.task, ...item.subtasks]) {
        if (hasNoDates(task)) unscheduledCount++
        else scheduledTaskCount++
      }
    }
  }

  const pushTask = (
    task: Task,
    depth: 0 | 1,
    realSubtasks: readonly Task[],
    shownSubtasks: number,
    context: boolean,
  ) => {
    const span = toDaySpan(taskSpan(task))
    const isCollapsed = shownSubtasks > 0 && collapsed.has(taskRowKey(task.id))
    // Brackets stay truthful in filter mode: they come from the real subtasks, not the shown ones.
    const subtaskRange = realSubtasks.length > 0 ? toDayRange(rollupRange(realSubtasks)) : null
    const rollup = span.kind === 'unscheduled' ? subtaskRange : null
    taskRowIndex.set(task.id, rows.length)
    rows.push({
      kind: 'task',
      key: taskRowKey(task.id),
      task,
      depth,
      subtaskCount: shownSubtasks,
      collapsed: isCollapsed,
      span,
      rollup,
      subtaskRollup: span.kind !== 'unscheduled' && isCollapsed ? subtaskRange : null,
      context,
      drawable: span.kind === 'unscheduled' && rollup === null,
    })
    return isCollapsed
  }

  const pushShownItem = ({ item, shownSubtasks, context }: ShownItem) => {
    const hidden = pushTask(item.task, 0, item.subtasks, shownSubtasks.length, context)
    if (hidden) return
    for (const subtask of shownSubtasks) pushTask(subtask, 1, [], 0, false)
  }

  for (const group of outline.groups) {
    const items: ShownItem[] = []
    // Tasks that count in the header: everything, or in filter mode the matches (not context).
    const countedTasks: Task[] = []
    for (const item of group.tasks) {
      if (!filtering) {
        items.push({ item, shownSubtasks: item.subtasks, context: false })
        countedTasks.push(item.task, ...item.subtasks)
        continue
      }
      const matches = item.subtasks.filter(hasNoDates)
      const parentMatches = hasNoDates(item.task)
      if (!parentMatches && matches.length === 0) continue
      items.push({ item, shownSubtasks: matches, context: !parentMatches })
      if (parentMatches) countedTasks.push(item.task)
      countedTasks.push(...matches)
    }
    // Filter mode shows no milestones.
    const milestones = filtering ? [] : group.milestones
    const isEmpty = items.length === 0 && milestones.length === 0
    // A project without phases is a flat list; the "No phase" header only appears next to phases.
    // In filter mode a phase header needs a match too.
    const withHeader = filtering
      ? !isEmpty && (group.phase !== null || outline.hasPhases)
      : group.phase !== null || (outline.hasPhases && !isEmpty)
    if (!withHeader && isEmpty) continue
    if (withHeader) {
      const key = groupRowKey(group.phase)
      const isCollapsed = collapsed.has(key)
      rows.push({
        kind: 'group',
        key,
        phase: group.phase,
        label: group.phase ? group.phase.name : 'No phase',
        taskCount: countedTasks.length,
        unscheduledOnly: filtering,
        collapsed: isCollapsed,
        rollup: toDayRange(
          rollupRange(
            group.tasks.flatMap((item) => [item.task, ...item.subtasks]),
            group.milestones,
          ),
        ),
      })
      if (isCollapsed) continue
    }
    for (const shown of items) pushShownItem(shown)
    for (const milestone of milestones) {
      rows.push({
        kind: 'milestone',
        key: milestoneRowKey(milestone.id),
        milestone,
        day: tryToEpochDay(milestone.date),
      })
    }
  }

  const rowIndexByKey = new Map(rows.map((row, index) => [row.key, index]))
  return { rows, taskRowIndex, rowIndexByKey, unscheduledCount, scheduledTaskCount }
}
