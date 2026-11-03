/**
 * Formatting for record timestamps (created / updated / completed) in the user's time zone.
 * Calendar-day logic goes through src/domain/dates.ts; only the clock time uses Intl here.
 */
import { diffDays, formatDateSmart, todayInTimeZone } from '@/domain/dates'
import type { ISODate, Timestamp } from '@/domain/types'

const timeFormatters = new Map<string, Intl.DateTimeFormat>()
const fullFormatters = new Map<string, Intl.DateTimeFormat>()

function formatter(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  let result = cache.get(timeZone)
  if (!result) {
    try {
      result = new Intl.DateTimeFormat('en-US', { ...options, timeZone })
    } catch {
      result = new Intl.DateTimeFormat('en-US', options)
    }
    cache.set(timeZone, result)
  }
  return result
}

/**
 * 'today at 3:45 PM' · 'yesterday at 9:02 AM' · 'Nov 2' · 'Nov 2, 2025' (relative to `today`).
 * Returns null for an unreadable timestamp.
 */
export function formatTimestamp(
  timestamp: Timestamp,
  timeZone: string,
  today: ISODate,
): string | null {
  const moment = new Date(timestamp)
  if (Number.isNaN(moment.getTime())) return null
  let day: ISODate
  try {
    day = todayInTimeZone(timeZone, moment)
  } catch {
    return null
  }
  const offset = diffDays(today, day)
  const label = formatDateSmart(day, today)
  if (offset === 0 || offset === -1) {
    const time = formatter(timeFormatters, timeZone, { hour: 'numeric', minute: '2-digit' })
    return `${label.toLowerCase()} at ${time.format(moment)}`
  }
  return label
}

/** Full date and time for a tooltip, e.g. 'Nov 2, 2026, 3:45 PM'. */
export function formatTimestampFull(timestamp: Timestamp, timeZone: string): string {
  const moment = new Date(timestamp)
  if (Number.isNaN(moment.getTime())) return ''
  return formatter(fullFormatters, timeZone, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(moment)
}
