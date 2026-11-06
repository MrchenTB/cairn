/**
 * Feedback after a date change made on the Gantt (move, resize, draw on an undated row, or a
 * keyboard nudge): one quiet toast with the new range and an Undo that puts the dates back.
 *
 * There is only ever ONE such toast (a fixed id: the next change replaces it), and its Undo takes
 * back exactly what the toast says. A burst of changes to the same task (nudging with the keys,
 * fine-tuning with the mouse) is merged: the Undo then returns to the dates from before the
 * first one, which is what "undo what I just did" means, instead of stepping back one nudge at a
 * time behind a button that suggests it undoes more. A change to another task starts over.
 *
 * Undo never overwrites newer work: when a task in the record was changed since (in the modal, on
 * the list…) it says so and does nothing. Failed writes are reported by the store, with Retry.
 */
import { formatDateRange } from '@/domain/dates'
import type { ISODate, ScheduleChange } from '@/domain/types'
import { notify } from '@/lib/notify'
import { undoScheduleWrite, type ScheduleWriteRecord } from './planner'

export const DATE_TOAST_ID = 'gantt-dates'
/** Changes to the same task within this many ms count as one burst. */
export const BURST_MS = 8000
const TOAST_MS = 6000

export type DateChangeKind = 'moved' | 'resized' | 'scheduled'

const VERBS: Record<DateChangeKind, string> = {
  moved: 'Moved',
  resized: 'Resized',
  scheduled: 'Scheduled',
}

interface Shown {
  record: ScheduleWriteRecord
  at: number
}
let shown: Shown | null = null

/** Forgets the last toast's record (tests; also after a successful Undo). */
export function resetDateUndoForTests(): void {
  shown = null
}

const sameDates = (a: ScheduleChange, b: ScheduleChange) =>
  a.taskId === b.taskId &&
  (a.startDate ?? null) === (b.startDate ?? null) &&
  (a.dueDate ?? null) === (b.dueDate ?? null)

/** The record an Undo should restore: merged into the toast's burst when it continues it. */
export function mergeRecord(
  next: ScheduleWriteRecord,
  previous: Shown | null,
  now: number,
): ScheduleWriteRecord {
  if (
    previous &&
    now - previous.at < BURST_MS &&
    previous.record.applied.length === 1 &&
    next.applied.length === 1 &&
    // …on the same task, picking up exactly where the last change left it.
    sameDates(previous.record.applied[0], next.previous[0])
  ) {
    return { applied: next.applied, previous: previous.record.previous }
  }
  return next
}

/** "Nov 3 – Nov 7", "Nov 3 –", "– Nov 7" or "No dates" for stored dates. */
function rangeText(change: ScheduleChange, today: ISODate): string {
  const start = change.startDate ?? null
  const end = change.dueDate ?? null
  if (start === null && end === null) return 'No dates'
  return formatDateRange(start, end, today)
}

export function announceDateChange(options: {
  kind: DateChangeKind
  title: string
  /** e.g. "Nov 10 – Nov 11 · 2 days" */
  label: string
  record: ScheduleWriteRecord
  today: ISODate
  now?: number
}): void {
  const now = options.now ?? Date.now()
  const record = mergeRecord(options.record, shown, now)
  shown = { record, at: now }
  notify.success(`${VERBS[options.kind]} · ${options.label}`, {
    id: DATE_TOAST_ID,
    description: options.title,
    duration: TOAST_MS,
    action: {
      label: 'Undo',
      onClick: () => void undoDateChange(record, options.title, options.today),
    },
  })
}

export async function undoDateChange(
  record: ScheduleWriteRecord,
  title: string,
  today: ISODate,
): Promise<void> {
  const outcome = await undoScheduleWrite(record)
  if (outcome.status === 'restored') {
    shown = null
    // The task the toast was about (the first write), not a shifted successor.
    const first = record.previous[0]
    notify.success('Dates restored', {
      id: DATE_TOAST_ID,
      description: first ? `${title} · ${rangeText(first, today)}` : title,
      duration: 3000,
    })
  } else if (outcome.status === 'stale') {
    shown = null
    notify.info('Can’t undo', {
      id: DATE_TOAST_ID,
      description: `The dates of ${title} changed since, so they were left as they are.`,
      duration: 5000,
    })
  } else if (outcome.status === 'invalid') {
    notify.error('Couldn’t restore the dates', { description: outcome.error.message })
  }
  // 'failed': rolled back and toasted (with Retry) by the store.
}

/** Which kind of change a drop was, from the dates before and after (epoch days). */
export function classifyDateChange(
  origin: { start: number | null; end: number | null },
  dates: { start: number | null; end: number | null },
): DateChangeKind {
  if (origin.start === null && origin.end === null) return 'scheduled'
  if (origin.start !== null && origin.end !== null && dates.start !== null && dates.end !== null) {
    return dates.start - origin.start === dates.end - origin.end ? 'moved' : 'resized'
  }
  // A due-only / start-only marker has just the one date to move.
  return 'moved'
}
