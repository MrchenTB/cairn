/**
 * Keyboard alternative to dragging (WCAG 2.5.7): a focused bar / marker / diamond moves by one
 * day with Alt+←/→, and Alt+Shift+←/→ changes the due date of a range (never before its start).
 * Pure: returns the new dates as epoch days; the chart sends them through the planner.
 */
import type { DragDates } from './dragReducer'
import type { DaySpan } from './geometry'

export type NudgeKind = 'move' | 'resize-end'

export interface Nudge {
  kind: NudgeKind
  delta: 1 | -1
}

/** The nudge a key press asks for (Alt/Option + arrows), or null. */
export function nudgeFromKey(event: {
  key: string
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}): Nudge | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return null
  return { kind: event.shiftKey ? 'resize-end' : 'move', delta: event.key === 'ArrowLeft' ? -1 : 1 }
}

/**
 * New dates of a task span after a nudge, or null when the nudge does not apply (unscheduled, or
 * a due-date change on a task that has no due date, or a resize that would end before the start).
 */
export function nudgeSpan(span: DaySpan, nudge: Nudge): DragDates | null {
  const { start, end } = span
  if (span.kind === 'unscheduled') return null
  if (nudge.kind === 'move') {
    return {
      start: start === null ? null : start + nudge.delta,
      end: end === null ? null : end + nudge.delta,
    }
  }
  if (end === null) return null
  const next = end + nudge.delta
  if (start !== null && next < start) return null
  return { start, end: next }
}
