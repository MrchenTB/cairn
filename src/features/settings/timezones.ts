/**
 * Time zones for the Settings picker: every IANA zone the runtime knows, with its UTC offset right
 * now (offsets move with daylight saving) and a lower-cased haystack the picker filters on.
 */
import { getBrowserTimeZone, isValidTimeZone } from '@/domain/dates'

export interface TimeZoneOption {
  /** IANA id, e.g. 'America/New_York'. */
  id: string
  /** Readable form of the id: 'America/New York'. */
  name: string
  /** Offset from UTC in minutes at the reference moment. */
  offsetMinutes: number
  /** 'UTC+08:00' */
  offset: string
  /** Lower-cased text the picker matches the query against. */
  haystack: string
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** Minutes the zone is ahead of UTC at `at` (negative = behind). */
export function offsetMinutesAt(timeZone: string, at: Date = new Date()): number {
  const fields: Record<string, number> = {}
  for (const part of formatterFor(timeZone).formatToParts(at)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value)
  }
  const wallClockAsUtc = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  )
  return Math.round((wallClockAsUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 480 → 'UTC+08:00', -210 → 'UTC-03:30', 0 → 'UTC+00:00'. */
export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** Spellings of an offset a user might type: 'utc+08:00', 'gmt+8', '+5:30' … */
function offsetSpellings(offsetMinutes: number): string[] {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  const hours = Math.floor(abs / 60)
  const minutes = abs % 60
  const padded = `${sign}${pad(hours)}:${pad(minutes)}`
  const short = minutes === 0 ? `${sign}${hours}` : `${sign}${hours}:${pad(minutes)}`
  return [`utc${padded}`, `gmt${padded}`, `utc${short}`, `gmt${short}`, padded, short]
}

/** One zone described at `at`. */
export function describeTimeZone(id: string, at: Date = new Date()): TimeZoneOption {
  const offsetMinutes = isValidTimeZone(id) ? offsetMinutesAt(id, at) : 0
  const name = id.replaceAll('_', ' ')
  return {
    id,
    name,
    offsetMinutes,
    offset: formatOffset(offsetMinutes),
    haystack: [name, id, ...offsetSpellings(offsetMinutes)].join(' ').toLowerCase(),
  }
}

/**
 * Every supported zone plus UTC and the `extra` ids (the saved zone, the browser's zone: both can
 * be spellings the runtime's list leaves out), ordered by offset then name.
 */
export function listTimeZones(
  at: Date = new Date(),
  extra: readonly string[] = [],
): TimeZoneOption[] {
  const ids = new Set<string>(['UTC', getBrowserTimeZone(), ...extra])
  try {
    for (const id of Intl.supportedValuesOf('timeZone')) ids.add(id)
  } catch {
    // Older runtimes: the ids above are still offered.
  }
  return [...ids]
    .filter((id) => isValidTimeZone(id))
    .map((id) => describeTimeZone(id, at))
    .sort((a, b) => a.offsetMinutes - b.offsetMinutes || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Zones containing every whitespace-separated term of `query` ('taipei', 'utc+8', 'new york'). */
export function filterTimeZones(
  options: readonly TimeZoneOption[],
  query: string,
): TimeZoneOption[] {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean)
  if (terms.length === 0) return [...options]
  return options.filter((option) => terms.every((term) => option.haystack.includes(term)))
}
