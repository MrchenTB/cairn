/**
 * Row model: the project outline (src/domain/hierarchy.ts → buildProjectOutline) flattened into
 * the Gantt's fixed-height rows, honouring collapsed groups/parents. Order:
 *   null-phase group (header only when the project has phases) → phases in order → each group's
 *   top-level tasks (subtasks indented under their parent) → the group's milestones by date →
 *   "Unscheduled (n)" with every top-level task that has no dates at all (neither its own nor
 *   any subtask's), in the project's top-level task order.
 */
import type { OutlineTask, ProjectOutline } from '@/domain/hierarchy'
import { tryToEpochDay } from '@/domain/dates'
import { bySortOrder } from '@/domain/ordering'
import { rollupRange, taskSpan } from '@/domain/scheduling'
import type { Milestone, Phase, Task } from '@/domain/types'
import { toDaySpan, type DaySpan } from './geometry'
import type { DayRange } from './scale'

export const UNSCHEDULED_KEY = 'unscheduled'
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
  /** Tasks (any level) listed under this header. */
  taskCount: number
  collapsed: boolean
  /** Read-only bracket over the group's tasks and milestones. */
  rollup: DayRange | null
}

export interface TaskRow {
  kind: 'task'
  key: string
  task: Task
  depth: 0 | 1
  /** Number of subtasks (0 for leaves and subtasks). */
  subtaskCount: number
  /** Parent whose subtasks are hidden. */
  collapsed: boolean
  /** The task's own dates. */
  span: DaySpan
  /** Parent without own dates: bracket over its subtasks' dates. */
  rollup: DayRange | null
  /** Collapsed parent WITH own dates: thin line showing its hidden subtasks' extent. */
  subtaskRollup: DayRange | null
  /** Listed in the Unscheduled group. */
  inUnscheduledGroup: boolean
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

export interface UnscheduledHeaderRow {
  kind: 'unscheduled'
  key: typeof UNSCHEDULED_KEY
  /** Tasks (any level) in the group. */
  count: number
  collapsed: boolean
}

export type GanttRow = GroupRow | TaskRow | MilestoneRow | UnscheduledHeaderRow

export interface GanttRowModel {
  rows: GanttRow[]
  /** Row index of every task that currently has a row (collapsed ones are absent). */
  taskRowIndex: Map<string, number>
  /** Row index by row key (`task:…`, `milestone:…`, `group:…`, `unscheduled`). */
  rowIndexByKey: Map<string, number>
  /** Tasks (any level) in the Unscheduled group, collapsed or not. */
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

/** A top-level task goes to "Unscheduled" when neither it nor any subtask has a date. */
export function isUnscheduledOutlineTask(item: OutlineTask): boolean {
  return hasNoDates(item.task) && item.subtasks.every(hasNoDates)
}

export function buildGanttRows(
  outline: ProjectOutline,
  collapsed: ReadonlySet<string>,
): GanttRowModel {
  const rows: GanttRow[] = []
  const taskRowIndex = new Map<string, number>()
  let scheduledTaskCount = 0
  for (const group of outline.groups) {
    for (const item of group.tasks) {
      for (const task of [item.task, ...item.subtasks]) if (!hasNoDates(task)) scheduledTaskCount++
    }
  }

  const pushTask = (task: Task, depth: 0 | 1, subtasks: readonly Task[], unscheduled: boolean) => {
    const span = toDaySpan(taskSpan(task))
    const isCollapsed = subtasks.length > 0 && collapsed.has(taskRowKey(task.id))
    const subtaskRange = subtasks.length > 0 ? toDayRange(rollupRange(subtasks)) : null
    const rollup = span.kind === 'unscheduled' ? subtaskRange : null
    taskRowIndex.set(task.id, rows.length)
    rows.push({
      kind: 'task',
      key: taskRowKey(task.id),
      task,
      depth,
      subtaskCount: subtasks.length,
      collapsed: isCollapsed,
      span,
      rollup,
      subtaskRollup: span.kind !== 'unscheduled' && isCollapsed ? subtaskRange : null,
      inUnscheduledGroup: unscheduled,
      drawable: span.kind === 'unscheduled' && rollup === null,
    })
    return isCollapsed
  }

  const pushOutlineTask = (item: OutlineTask, unscheduled: boolean) => {
    const hidden = pushTask(item.task, 0, item.subtasks, unscheduled)
    if (hidden) return
    for (const subtask of item.subtasks) pushTask(subtask, 1, [], unscheduled)
  }

  const unscheduledItems: OutlineTask[] = []
  for (const group of outline.groups) {
    const items: OutlineTask[] = []
    for (const item of group.tasks) {
      if (isUnscheduledOutlineTask(item)) unscheduledItems.push(item)
      else items.push(item)
    }
    const isEmpty = items.length === 0 && group.milestones.length === 0
    // A project without phases is a flat list; the "No phase" header only appears next to phases.
    const withHeader = group.phase !== null || (outline.hasPhases && !isEmpty)
    if (!withHeader && isEmpty) continue
    if (withHeader) {
      const key = groupRowKey(group.phase)
      const groupTasks = items.flatMap((item) => [item.task, ...item.subtasks])
      const isCollapsed = collapsed.has(key)
      rows.push({
        kind: 'group',
        key,
        phase: group.phase,
        label: group.phase ? group.phase.name : 'No phase',
        taskCount: groupTasks.length,
        collapsed: isCollapsed,
        rollup: toDayRange(rollupRange(groupTasks, group.milestones)),
      })
      if (isCollapsed) continue
    }
    for (const item of items) pushOutlineTask(item, false)
    for (const milestone of group.milestones) {
      rows.push({
        kind: 'milestone',
        key: milestoneRowKey(milestone.id),
        milestone,
        day: tryToEpochDay(milestone.date),
      })
    }
  }

  // One top-level ordering space per project: the group follows it across phases.
  unscheduledItems.sort((a, b) => bySortOrder(a.task, b.task))
  let unscheduledCount = 0
  for (const item of unscheduledItems) unscheduledCount += 1 + item.subtasks.length
  if (unscheduledItems.length > 0) {
    const isCollapsed = collapsed.has(UNSCHEDULED_KEY)
    rows.push({
      kind: 'unscheduled',
      key: UNSCHEDULED_KEY,
      count: unscheduledCount,
      collapsed: isCollapsed,
    })
    if (!isCollapsed) for (const item of unscheduledItems) pushOutlineTask(item, true)
  }

  const rowIndexByKey = new Map(rows.map((row, index) => [row.key, index]))
  return { rows, taskRowIndex, rowIndexByKey, unscheduledCount, scheduledTaskCount }
}
