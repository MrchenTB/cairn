/**
 * Pure Board (Kanban) model: which cards each column shows, and how a drag / keyboard / menu move
 * becomes a `MoveTaskInput`. No React, no dnd-kit — everything here is unit tested.
 *
 * Rules (PRD §4.6, architecture §5 "Ordering"):
 * - exactly three fixed columns, To Do → In Progress → Done, showing TOP-LEVEL tasks only;
 * - every column is a subsequence of the project's ONE top-level ordering space, so a card is
 *   placed by passing the neighbours it has inside its destination column (`afterId`/`beforeId`)
 *   and the store resolves them against the whole space;
 * - a reorder inside one column never sends `status` (so status/dates are never touched);
 *   a move to another column sends `status` plus its neighbours there.
 */
import { formatDate } from '@/domain/dates'
import { dueBucket } from '@/domain/buckets'
import type { ProjectOutline } from '@/domain/hierarchy'
import { bySortOrder } from '@/domain/ordering'
import { computeProgress } from '@/domain/progress'
import {
  TASK_STATUSES,
  type ISODate,
  type MoveTaskInput,
  type Phase,
  type Task,
  type TaskStatus,
} from '@/domain/types'
import { PRIORITY_LABELS } from '@/components/task/labels'

/** The board's fixed columns, left to right. */
export const BOARD_COLUMNS: readonly TaskStatus[] = TASK_STATUSES

/** Card ids per column, top to bottom (what the board shows). */
export type BoardColumnIds = Record<TaskStatus, string[]>

// ---------------------------------------------------------------------------
// Phase filter (`?phase=` in the URL)
// ---------------------------------------------------------------------------

/** Filter value: every phase (default). */
export const ALL_PHASES = 'all'
/** Filter value: only tasks without a phase. */
export const NO_PHASE = 'none'
/** URL search param that holds the phase filter. */
export const PHASE_PARAM = 'phase'

/**
 * The effective phase filter for a raw `?phase=` value: a phase id of this project, `NO_PHASE`,
 * or `ALL_PHASES` (missing, unknown or deleted phases, and projects without phases).
 */
export function resolvePhaseFilter(
  raw: string | null | undefined,
  phases: readonly Phase[],
): string {
  if (!raw || phases.length === 0) return ALL_PHASES
  if (raw === NO_PHASE) return NO_PHASE
  return phases.some((phase) => phase.id === raw) ? raw : ALL_PHASES
}

/** The phase a filter selects (null for "All phases" / "No phase"). */
export function filteredPhase(filter: string, phases: readonly Phase[]): Phase | null {
  if (filter === ALL_PHASES || filter === NO_PHASE) return null
  return phases.find((phase) => phase.id === filter) ?? null
}

/** `phaseId` for a task created while `filter` is active (so it stays visible). */
export function phaseIdForNewTask(filter: string): string | null {
  return filter === ALL_PHASES || filter === NO_PHASE ? null : filter
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export interface BoardCard {
  task: Task
  /** The task's phase (null = no phase). */
  phase: Phase | null
  /** Subtask completion (total 0 = no subtasks). */
  subtasks: { done: number; total: number }
}

export interface BoardModel {
  /** Visible cards per column, in project order. */
  columns: Record<TaskStatus, BoardCard[]>
  /** Every top-level task id of the project in sortOrder (ignores the phase filter). */
  projectOrder: string[]
  /** Number of top-level tasks in the project (ignores the phase filter). */
  totalTasks: number
}

function emptyColumns<T>(): Record<TaskStatus, T[]> {
  return { todo: [], in_progress: [], done: [] }
}

/**
 * Builds the board from the project outline (`buildProjectOutline`, the same structure the List
 * uses — so both views agree on which tasks are top-level and which phase they belong to).
 * `filter` is a resolved phase filter (`resolvePhaseFilter`).
 */
export function buildBoard(outline: ProjectOutline, filter: string = ALL_PHASES): BoardModel {
  const all: BoardCard[] = []
  for (const group of outline.groups) {
    for (const { task, subtasks } of group.tasks) {
      const progress = computeProgress(subtasks)
      all.push({
        task,
        phase: group.phase,
        subtasks: { done: progress.done, total: progress.total },
      })
    }
  }
  // Groups split the ONE top-level order by phase; restore the project order.
  all.sort((a, b) => bySortOrder(a.task, b.task))

  const columns = emptyColumns<BoardCard>()
  for (const card of all) {
    const visible =
      filter === ALL_PHASES ||
      (filter === NO_PHASE ? card.phase === null : card.phase?.id === filter)
    if (visible) columns[card.task.status].push(card)
  }
  return { columns, projectOrder: all.map((card) => card.task.id), totalTasks: all.length }
}

/** Card ids per column. */
export function toColumnIds(columns: Record<TaskStatus, readonly BoardCard[]>): BoardColumnIds {
  return {
    todo: columns.todo.map((card) => card.task.id),
    in_progress: columns.in_progress.map((card) => card.task.id),
    done: columns.done.map((card) => card.task.id),
  }
}

// ---------------------------------------------------------------------------
// Ids used by the drag-and-drop layer
// ---------------------------------------------------------------------------

const COLUMN_PREFIX = 'column:'

/** Droppable id of a column (the empty area of a column, and empty columns). */
export function columnDroppableId(status: TaskStatus): string {
  return `${COLUMN_PREFIX}${status}`
}

/** The column a droppable id names, or null when it is not a column id. */
export function parseColumnDroppableId(id: unknown): TaskStatus | null {
  if (typeof id !== 'string' || !id.startsWith(COLUMN_PREFIX)) return null
  const status = id.slice(COLUMN_PREFIX.length)
  return (BOARD_COLUMNS as readonly string[]).includes(status) ? (status as TaskStatus) : null
}

/** The column that holds card `id` — or that `id` names (a column droppable id); null if unknown. */
export function findColumn(columns: BoardColumnIds, id: unknown): TaskStatus | null {
  const named = parseColumnDroppableId(id)
  if (named) return named
  if (typeof id !== 'string') return null
  for (const status of BOARD_COLUMNS) if (columns[status].includes(id)) return status
  return null
}

/**
 * Returns new columns with `activeId` moved into `toColumn` at `toIndex` (the index among the
 * destination's OTHER cards; clamped). Unknown cards leave the columns unchanged.
 */
export function moveCardInColumns(
  columns: BoardColumnIds,
  activeId: string,
  toColumn: TaskStatus,
  toIndex: number,
): BoardColumnIds {
  const from = findColumn(columns, activeId)
  if (!from) return columns
  const target = columns[toColumn].filter((id) => id !== activeId)
  const index = clampIndex(toIndex, target.length)
  const next: BoardColumnIds = { ...columns, [from]: columns[from].filter((id) => id !== activeId) }
  next[toColumn] = [...target.slice(0, index), activeId, ...target.slice(index)]
  return next
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return index > 0 ? length : 0
  return Math.min(Math.max(Math.trunc(index), 0), length)
}

// ---------------------------------------------------------------------------
// Drop → MoveTaskInput
// ---------------------------------------------------------------------------

/** Where a card was dropped. */
export interface BoardDrop {
  /** The dragged card (task id). */
  activeId: string
  /** The column it was dropped in. */
  overColumn: TaskStatus
  /** Its index in that column, counted WITHOUT the dragged card (clamped). */
  overIndex: number
}

/**
 * The `moveTask` input for a drop, or null when the drop changes nothing (same column, same
 * place) or the card is unknown.
 *
 * - `columns`: the board as it is BEFORE the drop (the card still in its own column). The card's
 *   column there is its current status.
 * - Same column → `{ taskId, afterId, beforeId }` only — never `status` (a reorder must not touch
 *   status or dates).
 * - Other column → `{ taskId, status, afterId, beforeId }` with the neighbours inside that column.
 * - Other, EMPTY column → there are no neighbours to anchor to, so the card keeps its place in the
 *   project order: its current project neighbours (`projectOrder`) are passed, which the store
 *   sees as "already placed" — only the status changes, and the List order stays as it was.
 */
export function moveForBoardDrop(
  drop: BoardDrop,
  columns: BoardColumnIds,
  projectOrder: readonly string[],
): MoveTaskInput | null {
  const { activeId, overColumn } = drop
  const fromColumn = findColumn(columns, activeId)
  if (!fromColumn || parseColumnDroppableId(activeId)) return null
  const others = columns[overColumn].filter((id) => id !== activeId)
  const index = clampIndex(drop.overIndex, others.length)
  const afterId = others[index - 1] ?? null
  const beforeId = others[index] ?? null

  if (fromColumn === overColumn) {
    if (columns[fromColumn].indexOf(activeId) === index) return null
    return { taskId: activeId, afterId, beforeId }
  }
  if (others.length === 0) {
    const at = projectOrder.indexOf(activeId)
    if (at >= 0) {
      return {
        taskId: activeId,
        status: overColumn,
        afterId: projectOrder[at - 1] ?? null,
        beforeId: projectOrder[at + 1] ?? null,
      }
    }
  }
  return { taskId: activeId, status: overColumn, afterId, beforeId }
}

/** Menu moves inside a column (the single-pointer alternative to dragging, WCAG 2.5.7). */
export type ColumnStep = 'top' | 'up' | 'down' | 'bottom'

/**
 * The drop that moves `taskId` one step / to an end of its own column, or null when it is already
 * there (or unknown). Feed the result to `moveForBoardDrop`.
 */
export function stepDrop(
  columns: BoardColumnIds,
  taskId: string,
  step: ColumnStep,
): BoardDrop | null {
  const column = findColumn(columns, taskId)
  if (!column || parseColumnDroppableId(taskId)) return null
  const ids = columns[column]
  const index = ids.indexOf(taskId)
  const last = ids.length - 1
  const target = step === 'top' ? 0 : step === 'up' ? index - 1 : step === 'down' ? index + 1 : last
  if (target < 0 || target > last || target === index) return null
  return { activeId: taskId, overColumn: column, overIndex: target }
}

// ---------------------------------------------------------------------------
// Drag geometry (pointer and keyboard)
// ---------------------------------------------------------------------------

/** Vertical geometry of a droppable (client coordinates). */
export interface VerticalRect {
  top: number
  height: number
}

/**
 * The card of `ids` whose vertical centre is nearest to `y` (first one on ties), or null when
 * none of them is measured. Used to aim at a card when the pointer is over a column but not over
 * a card (gaps, the space below the last card, the header).
 */
export function nearestCard(
  ids: readonly string[],
  y: number,
  rectOf: (id: string) => VerticalRect | null,
): string | null {
  let best: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const id of ids) {
    const rect = rectOf(id)
    if (!rect) continue
    const distance = Math.abs(rect.top + rect.height / 2 - y)
    if (distance < bestDistance) {
      best = id
      bestDistance = distance
    }
  }
  return best
}

/** What decides the side of the target card a card dragged into another column enters on. */
export type EntryProbe =
  /** Pointer drags: the pointer's y. */
  | { pointerY: number }
  /** Keyboard drags (the card is placed onto its target): the dragged card's top. */
  | { draggedTop: number }

/**
 * Index (among the destination column's cards `ids`, without the dragged card) at which a card
 * dragged in from ANOTHER column enters:
 * - over the column itself (an empty column) → the end;
 * - over a card → before it, or after it when the probe says the card is above: the pointer is
 *   below the card's bottom edge (it was aimed at from the space below or between cards — while
 *   the pointer is ON a card, the card under it takes that card's place, like sortable does), or
 *   the dragged card's top is below the card's middle (keyboard).
 * Unknown targets → the end.
 */
export function entryIndex(
  ids: readonly string[],
  overId: string,
  overRect: VerticalRect | null,
  probe: EntryProbe,
): number {
  const index = ids.indexOf(overId)
  if (index < 0 || !overRect) return ids.length
  const below =
    'pointerY' in probe
      ? probe.pointerY > overRect.top + overRect.height
      : probe.draggedTop > overRect.top + overRect.height / 2
  return index + (below ? 1 : 0)
}

// ---------------------------------------------------------------------------
// Keyboard dragging
// ---------------------------------------------------------------------------

export type BoardDirection = 'up' | 'down' | 'left' | 'right'

/**
 * Keyboard drag: the droppable to move the dragged card over next, or null to stay.
 * - up/down: the previous/next card in the same column (`currentId` = what the card is over now:
 *   a card id — possibly itself — or a column id);
 * - left/right: the adjacent column — its card whose vertical centre is closest to `centreY`, or
 *   the column itself when it has no other cards.
 */
export function keyboardTarget(
  columns: BoardColumnIds,
  activeId: string,
  currentId: string,
  direction: BoardDirection,
  centreY: number,
  rectOf: (id: string) => VerticalRect | null,
): string | null {
  const column = findColumn(columns, currentId) ?? findColumn(columns, activeId)
  if (!column) return null

  if (direction === 'up' || direction === 'down') {
    const ids = columns[column]
    const index = ids.indexOf(parseColumnDroppableId(currentId) ? activeId : currentId)
    if (index < 0) return null
    const next = ids[index + (direction === 'down' ? 1 : -1)]
    return next ?? null
  }

  const target = BOARD_COLUMNS[BOARD_COLUMNS.indexOf(column) + (direction === 'right' ? 1 : -1)]
  if (!target) return null
  const candidates = columns[target].filter((id) => id !== activeId)
  return nearestCard(candidates, centreY, rectOf) ?? columnDroppableId(target)
}

/** 1-based position of `id` in its column plus the column size (for announcements). */
export function positionIn(
  columns: BoardColumnIds,
  id: string,
): { column: TaskStatus; position: number; count: number } | null {
  const column = findColumn(columns, id)
  if (!column) return null
  const index = columns[column].indexOf(id)
  return { column, position: index + 1, count: columns[column].length }
}

// ---------------------------------------------------------------------------
// Accessible card description
// ---------------------------------------------------------------------------

/**
 * One sentence per piece of card meta, for screen readers (the visual meta row is aria-hidden):
 * "Priority: High. Overdue, due Nov 2, 2026. 2 of 5 subtasks done. Phase: Design."
 * The due wording follows the shared buckets (done tasks are never overdue).
 */
export function describeCard(
  card: BoardCard,
  today: ISODate,
  options: { showPhase?: boolean } = {},
): string {
  const { task, phase, subtasks } = card
  const parts: string[] = []
  if (task.priority !== 'none') parts.push(`Priority: ${PRIORITY_LABELS[task.priority]}.`)
  if (task.dueDate) {
    const bucket = dueBucket(task, today)
    const date = formatDate(task.dueDate, 'medium')
    parts.push(
      bucket === 'overdue'
        ? `Overdue, due ${date}.`
        : bucket === 'today'
          ? `Due today, ${date}.`
          : `Due ${date}.`,
    )
  }
  if (subtasks.total > 0) parts.push(`${subtasks.done} of ${subtasks.total} subtasks done.`)
  if (phase && options.showPhase !== false) parts.push(`Phase: ${phase.name}.`)
  return parts.join(' ')
}
