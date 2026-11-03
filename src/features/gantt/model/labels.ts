/**
 * Text for the live drag tooltip and the screen-reader announcements (pure). Dates are formatted
 * with the shared calendar helpers, so the year only appears outside the current one.
 */
import { STATUS_LABELS } from '@/components/task/labels'
import { durationDays, formatDateRange, fromEpochDay } from '@/domain/dates'
import type { ISODate, Task } from '@/domain/types'
import type { DragDates, DragMode } from './dragReducer'
import type { DaySpan } from './geometry'

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function iso(day: number | null): ISODate | null {
  return day === null ? null : fromEpochDay(day)
}

/** "Nov 4 – Nov 7 · 4 days", "Due Nov 5", "Starts Nov 2" or "Nov 5" (a single-day range). */
export function datesLabel(dates: DragDates, today: ISODate): string {
  const start = iso(dates.start)
  const end = iso(dates.end)
  if (start && end) {
    const days = (dates.end as number) - (dates.start as number) + 1
    return `${formatDateRange(start, end, today)} · ${plural(days, 'day')}`
  }
  return formatDateRange(start, end, today) || 'No dates'
}

/** Signed day difference, e.g. "+2 days", "−1 day", or null for no change. */
export function deltaLabel(days: number): string | null {
  if (days === 0) return null
  return `${days > 0 ? '+' : '−'}${plural(Math.abs(days), 'day')}`
}

/** Which end moved for a mode: the dragged date's change in days (draw: none). */
export function dragDelta(mode: DragMode, dates: DragDates, origin: DragDates): number {
  const diff = (a: number | null, b: number | null) => (a !== null && b !== null ? a - b : 0)
  switch (mode) {
    case 'move':
    case 'point':
      return origin.start !== null ? diff(dates.start, origin.start) : diff(dates.end, origin.end)
    case 'resize-start':
      return diff(dates.start, origin.start)
    case 'resize-end':
      return diff(dates.end, origin.end)
    case 'draw':
      return 0
  }
}

/** Tooltip content while dragging a task (bar, marker, drawn range) or a milestone. */
export function dragTooltip(
  mode: DragMode,
  dates: DragDates,
  origin: DragDates,
  today: ISODate,
  milestone = false,
): { text: string; detail: string | null } {
  const text = milestone
    ? formatDateRange(iso(dates.start), iso(dates.start), today)
    : datesLabel(dates, today)
  return { text, detail: deltaLabel(dragDelta(mode, dates, origin)) }
}

/**
 * Accessible name of a bar / marker, e.g. "Design review, Nov 2 – Nov 5, 4 days, In Progress",
 * plus "overdue" and the conflict explanation when they apply.
 */
export function barAriaLabel(
  task: Pick<Task, 'title' | 'status'>,
  span: DaySpan,
  today: ISODate,
  conflict: string | null,
  overdue: boolean,
): string {
  const start = iso(span.start)
  const end = iso(span.end)
  const parts = [task.title]
  if (span.kind === 'range' && start && end) {
    parts.push(formatDateRange(start, end, today), plural(durationDays(start, end), 'day'))
  } else if (span.kind === 'due_only') {
    parts.push(formatDateRange(null, end, today), 'no start date')
  } else if (span.kind === 'start_only') {
    parts.push(formatDateRange(start, null, today), 'no due date')
  }
  parts.push(STATUS_LABELS[task.status])
  if (overdue) parts.push('overdue')
  if (conflict) parts.push(`dependency conflict: ${conflict}`)
  return parts.join(', ')
}
