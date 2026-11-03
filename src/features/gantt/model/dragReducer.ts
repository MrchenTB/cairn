/**
 * Pointer drag state machine for bars, markers, milestones and "drawing" a range on an empty lane
 * (gantt-evaluation §7.8). Pure: the chart feeds pointer samples in, renders `preview`, and commits
 * on release. Positions are absolute fractional epoch days (`dayFloat`), so auto-scroll and range
 * extension (origin shifts) never distort the delta.
 *
 *   idle ─down─► pending ─moved ≥ threshold─► dragging ─up─► commit(preview)
 *                   └──────────────up──────────────► click
 *   pending | dragging ─cancel (Esc, pointercancel, lost capture)─► idle (nothing written)
 */
import { tryFromEpochDay } from '@/domain/dates'
import type { ScheduleChange } from '@/domain/types'
import { DRAG_THRESHOLD_PX } from './constants'
import { snapDays } from './geometry'

/**
 * - move: shift start and end together (duration preserved)
 * - resize-start / resize-end: change one end; start ≤ end always (min 1 day)
 * - point: move the single date of a due marker, start marker or milestone
 * - draw: schedule an undated task: start = day under pointer-down, end = day under the pointer
 */
export type DragMode = 'move' | 'resize-start' | 'resize-end' | 'point' | 'draw'

export interface DragOrigin {
  mode: DragMode
  /** Dates before the drag, as epoch days (null = missing). */
  start: number | null
  end: number | null
}

export interface DragDates {
  start: number | null
  end: number | null
}

export interface PointerSample {
  clientX: number
  clientY: number
  /** Absolute fractional epoch day under the pointer. */
  dayFloat: number
}

export interface DragState {
  phase: 'pending' | 'dragging'
  origin: DragOrigin
  down: PointerSample
  last: PointerSample
  /** Whole days moved (move / resize / point). */
  deltaDays: number
  /** Dates to render (and to commit on release). */
  preview: DragDates
}

/**
 * Dates after a pointer travel of `deltaDays` (move / resize / point) or, for `draw`, from the
 * day under pointer-down (`anchorDay`) to the day under the pointer (`pointerDay`), in either
 * direction.
 */
export function previewDates(
  origin: DragOrigin,
  deltaDays: number,
  anchorDay = 0,
  pointerDay = 0,
): DragDates {
  const { start, end } = origin
  switch (origin.mode) {
    case 'move':
    case 'point':
      return {
        start: start === null ? null : start + deltaDays,
        end: end === null ? null : end + deltaDays,
      }
    case 'resize-start': {
      if (start === null) return { start, end }
      const next = start + deltaDays
      return { start: end === null ? next : Math.min(next, end), end }
    }
    case 'resize-end': {
      if (end === null) return { start, end }
      const next = end + deltaDays
      return { start, end: start === null ? next : Math.max(next, start) }
    }
    case 'draw':
      return { start: Math.min(anchorDay, pointerDay), end: Math.max(anchorDay, pointerDay) }
  }
}

function compute(origin: DragOrigin, down: PointerSample, last: PointerSample) {
  const deltaDays = snapDays(last.dayFloat - down.dayFloat)
  const preview = previewDates(
    origin,
    deltaDays,
    Math.floor(down.dayFloat),
    Math.floor(last.dayFloat),
  )
  return { deltaDays, preview }
}

/** Pointer-down: nothing moves until the pointer travels DRAG_THRESHOLD_PX. */
export function startDrag(origin: DragOrigin, down: PointerSample): DragState {
  return {
    phase: 'pending',
    origin,
    down,
    last: down,
    deltaDays: 0,
    preview:
      origin.mode === 'draw'
        ? previewDates(origin, 0, Math.floor(down.dayFloat), Math.floor(down.dayFloat))
        : { start: origin.start, end: origin.end },
  }
}

/**
 * A pointer move (or an auto-scroll step with the same client position but a new `dayFloat`).
 * Pending turns into dragging once the pointer has travelled `threshold` px on screen.
 */
export function updateDrag(
  state: DragState,
  sample: PointerSample,
  threshold = DRAG_THRESHOLD_PX,
): DragState {
  let phase = state.phase
  if (phase === 'pending') {
    const travel = Math.hypot(sample.clientX - state.down.clientX, sample.clientY - state.down.clientY)
    if (travel < threshold) return { ...state, last: sample }
    phase = 'dragging'
  }
  const { deltaDays, preview } = compute(state.origin, state.down, sample)
  return { ...state, phase, last: sample, deltaDays, preview }
}

/** Released without crossing the threshold → treat as a click (open the task). */
export function isClick(state: DragState): boolean {
  return state.phase === 'pending'
}

/** The drag ended somewhere other than where it started. */
export function hasDateChange(state: DragState): boolean {
  return (
    state.phase === 'dragging' &&
    (state.preview.start !== state.origin.start || state.preview.end !== state.origin.end)
  )
}

/** ISO dates for a preview; null when a date falls outside the supported calendar. */
export function toISODates(
  dates: DragDates,
): { startDate: string | null; dueDate: string | null } | null {
  const startDate = dates.start === null ? null : tryFromEpochDay(dates.start)
  const dueDate = dates.end === null ? null : tryFromEpochDay(dates.end)
  if ((dates.start !== null && !startDate) || (dates.end !== null && !dueDate)) return null
  return { startDate, dueDate }
}

/** The planner input for a finished task drag (null when out of the supported calendar). */
export function toScheduleChange(taskId: string, dates: DragDates): ScheduleChange | null {
  const iso = toISODates(dates)
  return iso ? { taskId, ...iso } : null
}
