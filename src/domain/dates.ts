/**
 * Calendar-date helpers. Every function works on 'YYYY-MM-DD' strings using pure
 * calendar arithmetic (epoch-day numbers / UTC), so results never depend on the
 * browser's time zone. Only `todayInTimeZone`, `toLocalDate` and `fromLocalDate`
 * touch real clocks / local time, and they are explicit about it.
 *
 * Supported range: 0001-01-01 … 9999-12-31 (proleptic Gregorian, 4-digit years, like a
 * PostgreSQL `date` in AD). Functions that take an `ISODate` throw a RangeError for strings
 * that are not real dates in that range; `compareISODate`, `minDate`, `maxDate` and
 * `clampDate` only compare strings (correct for valid dates) and never throw.
 */
import type { ISODate } from './types'

const MS_PER_DAY = 86_400_000
const MIN_YEAR = 1
const MAX_YEAR = 9999
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

interface DateParts {
  year: number
  month: number
  day: number
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function monthLength(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : MONTH_LENGTHS[month - 1]
}

function readDigits(value: string, from: number, to: number): number {
  let n = 0
  for (let i = from; i < to; i++) {
    const digit = value.charCodeAt(i) - 48
    if (digit < 0 || digit > 9) return -1
    n = n * 10 + digit
  }
  return n
}

/** Strict 'YYYY-MM-DD' parser (no regex, no Date); null when malformed or impossible. */
function parseParts(value: unknown): DateParts | null {
  if (typeof value !== 'string' || value.length !== 10) return null
  if (value.charCodeAt(4) !== 45 || value.charCodeAt(7) !== 45) return null
  const year = readDigits(value, 0, 4)
  const month = readDigits(value, 5, 7)
  const day = readDigits(value, 8, 10)
  if (year < MIN_YEAR || month < 1 || month > 12 || day < 1) return null
  if (day > monthLength(year, month)) return null
  return { year, month, day }
}

function partsOrThrow(date: ISODate): DateParts {
  const parts = parseParts(date)
  if (!parts) throw new RangeError(`Invalid date ${JSON.stringify(date)} (expected YYYY-MM-DD)`)
  return parts
}

function formatParts(year: number, month: number, day: number): ISODate {
  return `${String(year).padStart(4, '0')}-${month < 10 ? '0' : ''}${month}-${day < 10 ? '0' : ''}${day}`
}

// Howard Hinnant's civil-calendar algorithms: exact integer arithmetic for any year,
// without Date.UTC's quirk of mapping years 0-99 to 1900-1999.
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const mp = month > 2 ? month - 3 : month + 9
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146_097 + doe - 719_468
}

function civilFromDays(epochDay: number): DateParts {
  const z = epochDay + 719_468
  const era = Math.floor(z / 146_097)
  const doe = z - era * 146_097
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  )
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day }
}

const MIN_EPOCH_DAY = daysFromCivil(MIN_YEAR, 1, 1)
const MAX_EPOCH_DAY = daysFromCivil(MAX_YEAR, 12, 31)

function mod(n: number, m: number): number {
  return ((n % m) + m) % m
}

export function isISODate(value: unknown): value is ISODate {
  return parseParts(value) !== null
}
/** Returns the date when valid, throws a RangeError otherwise. */
export function assertISODate(value: string): ISODate {
  partsOrThrow(value)
  return value
}
/** month is 1-12 */
export function parseISODate(date: ISODate): { year: number; month: number; day: number } {
  return partsOrThrow(date)
}
/** month is 1-12; throws RangeError for impossible dates (e.g. 2026-02-30). */
export function makeISODate(year: number, month: number, day: number): ISODate {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < MIN_YEAR ||
    year > MAX_YEAR ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthLength(year, month)
  ) {
    throw new RangeError(`Invalid date: year ${year}, month ${month}, day ${day}`)
  }
  return formatParts(year, month, day)
}
/** Days since 1970-01-01 (can be negative). */
export function toEpochDay(date: ISODate): number {
  const { year, month, day } = partsOrThrow(date)
  return daysFromCivil(year, month, day)
}
export function fromEpochDay(epochDay: number): ISODate {
  const date = tryFromEpochDay(epochDay)
  if (date === null) throw new RangeError(`Epoch day out of range: ${epochDay}`)
  return date
}
/** Like `toEpochDay` but returns null instead of throwing (null/invalid input). */
export function tryToEpochDay(value: unknown): number | null {
  const parts = parseParts(value)
  return parts ? daysFromCivil(parts.year, parts.month, parts.day) : null
}
/** Like `fromEpochDay` but returns null for non-integers or days outside the supported range. */
export function tryFromEpochDay(epochDay: number): ISODate | null {
  if (!Number.isInteger(epochDay) || epochDay < MIN_EPOCH_DAY || epochDay > MAX_EPOCH_DAY) {
    return null
  }
  const { year, month, day } = civilFromDays(epochDay)
  return formatParts(year, month, day)
}
/** `days` must be an integer (RangeError otherwise). */
export function addDays(date: ISODate, days: number): ISODate {
  if (!Number.isInteger(days)) throw new RangeError(`days must be an integer, got ${days}`)
  return fromEpochDay(toEpochDay(date) + days)
}
/** Adds calendar months, clamping the day to the target month's length (Jan 31 + 1 = Feb 28/29). */
export function addMonths(date: ISODate, months: number): ISODate {
  if (!Number.isInteger(months)) throw new RangeError(`months must be an integer, got ${months}`)
  const { year, month, day } = partsOrThrow(date)
  const total = year * 12 + (month - 1) + months
  const targetYear = Math.floor(total / 12)
  const targetMonth = total - targetYear * 12 + 1
  return makeISODate(targetYear, targetMonth, Math.min(day, monthLength(targetYear, targetMonth)))
}
/** `to - from` in days. diffDays('2026-11-01', '2026-11-03') === 2 */
export function diffDays(from: ISODate, to: ISODate): number {
  return toEpochDay(to) - toEpochDay(from)
}
/** Inclusive length: durationDays('2026-11-02', '2026-11-04') === 3 (≤ 0 when end < start). */
export function durationDays(start: ISODate, end: ISODate): number {
  return diffDays(start, end) + 1
}
/** -1 / 0 / 1 (plain string comparison, which is chronological for 'YYYY-MM-DD'). */
export function compareISODate(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0
}
/** Smallest non-empty date, or null. */
export function minDate(...dates: Array<ISODate | null | undefined>): ISODate | null {
  let min: ISODate | null = null
  for (const date of dates) if (date && (min === null || date < min)) min = date
  return min
}
/** Largest non-empty date, or null. */
export function maxDate(...dates: Array<ISODate | null | undefined>): ISODate | null {
  let max: ISODate | null = null
  for (const date of dates) if (date && (max === null || date > max)) max = date
  return max
}
/** Clamps into [min, max]; when min > max, min wins. */
export function clampDate(date: ISODate, min: ISODate, max: ISODate): ISODate {
  const upper = date > max ? max : date
  return upper < min ? min : upper
}
/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(date: ISODate): number {
  // 1970-01-01 was a Thursday (4).
  return mod(toEpochDay(date) + 4, 7)
}
export function isWeekend(date: ISODate): boolean {
  const day = dayOfWeek(date)
  return day === 0 || day === 6
}
export function startOfWeek(date: ISODate, weekStartsOn: 0 | 1): ISODate {
  const epochDay = toEpochDay(date)
  const first = weekStartsOn === 0 ? 0 : 1
  return fromEpochDay(epochDay - mod(mod(epochDay + 4, 7) - first, 7))
}
export function endOfWeek(date: ISODate, weekStartsOn: 0 | 1): ISODate {
  return fromEpochDay(toEpochDay(startOfWeek(date, weekStartsOn)) + 6)
}
export function startOfMonth(date: ISODate): ISODate {
  const { year, month } = partsOrThrow(date)
  return formatParts(year, month, 1)
}
export function endOfMonth(date: ISODate): ISODate {
  const { year, month } = partsOrThrow(date)
  return formatParts(year, month, monthLength(year, month))
}
/** month is 1-12 */
export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`Invalid year/month: ${year}-${month}`)
  }
  return monthLength(year, month)
}
/** Inclusive list of dates from start to end ([] when end < start). */
export function eachDay(start: ISODate, end: ISODate): ISODate[] {
  const from = toEpochDay(start)
  const to = toEpochDay(end)
  const days: ISODate[] = []
  for (let epochDay = from; epochDay <= to; epochDay++) days.push(fromEpochDay(epochDay))
  return days
}
/** ISO-8601 week number (1-53). */
export function isoWeekNumber(date: ISODate): number {
  const epochDay = toEpochDay(date)
  // The ISO week belongs to the year of its Thursday.
  const thursday = epochDay - mod(epochDay + 3, 7) + 3
  const { year } = civilFromDays(thursday)
  return Math.floor((thursday - daysFromCivil(year, 1, 1)) / 7) + 1
}

// ---------------------------------------------------------------------------
// Time zones (the only clock-dependent part)
// ---------------------------------------------------------------------------

const zonedFormatters = new Map<string, Intl.DateTimeFormat | null>()

/** Cached 'en-CA' (YYYY-MM-DD) formatter for a zone; null when the zone is invalid. */
function zonedDateFormatter(timeZone: unknown): Intl.DateTimeFormat | null {
  if (typeof timeZone !== 'string' || timeZone === '') return null
  let formatter = zonedFormatters.get(timeZone)
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        calendar: 'gregory',
        numberingSystem: 'latn',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
    } catch {
      formatter = null
    }
    zonedFormatters.set(timeZone, formatter)
  }
  return formatter
}

/**
 * The calendar date "now" in the given IANA time zone (e.g. 'Asia/Taipei').
 * Falls back to the browser time zone when `timeZone` is invalid (then to 'UTC').
 */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): ISODate {
  const formatter =
    zonedDateFormatter(timeZone) ??
    zonedDateFormatter(getBrowserTimeZone()) ??
    (zonedDateFormatter('UTC') as Intl.DateTimeFormat)
  let year = 0
  let month = 0
  let day = 0
  for (const part of formatter.formatToParts(now)) {
    if (part.type === 'year') year = Number(part.value)
    else if (part.type === 'month') month = Number(part.value)
    else if (part.type === 'day') day = Number(part.value)
  }
  return makeISODate(year, month, day)
}
/** The runtime's IANA time zone, or 'UTC' when it cannot be determined. */
export function getBrowserTimeZone(): string {
  try {
    const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    if (zonedDateFormatter(timeZone)) return timeZone
  } catch {
    // Intl unavailable or broken: fall through
  }
  return 'UTC'
}
export function isValidTimeZone(timeZone: string): boolean {
  return zonedDateFormatter(timeZone) !== null
}
/** Local-midnight Date for date-picker widgets ONLY. */
export function toLocalDate(date: ISODate): Date {
  const { year, month, day } = partsOrThrow(date)
  const local = new Date(2000, 0, 1)
  // setFullYear avoids the Date constructor's 0-99 → 1900s mapping.
  local.setFullYear(year, month - 1, day)
  local.setHours(0, 0, 0, 0)
  return local
}
/** Reads the local Y/M/D of a Date coming from a date-picker widget. */
export function fromLocalDate(date: Date): ISODate {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError('Invalid Date')
  }
  return makeISODate(date.getFullYear(), date.getMonth() + 1, date.getDate())
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export type DateFormatStyle =
  | 'short' // Nov 2
  | 'medium' // Nov 2, 2026
  | 'long' // Monday, November 2, 2026
  | 'weekday' // Mon
  | 'weekdayNarrow' // M
  | 'month' // Nov
  | 'monthLong' // November
  | 'monthYear' // November 2026
  | 'shortMonthYear' // Nov 2026
  | 'day' // 2
  | 'year' // 2026

const FORMAT_OPTIONS: Record<DateFormatStyle, Intl.DateTimeFormatOptions> = {
  short: { month: 'short', day: 'numeric' },
  medium: { month: 'short', day: 'numeric', year: 'numeric' },
  long: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
  weekday: { weekday: 'short' },
  weekdayNarrow: { weekday: 'narrow' },
  month: { month: 'short' },
  monthLong: { month: 'long' },
  monthYear: { month: 'long', year: 'numeric' },
  shortMonthYear: { month: 'short', year: 'numeric' },
  day: { day: 'numeric' },
  year: { year: 'numeric' },
}

const utcFormatters = new Map<string, Intl.DateTimeFormat>()

function utcFormatter(style: DateFormatStyle, locale: string): Intl.DateTimeFormat {
  const key = `${locale}\u0000${style}`
  let formatter = utcFormatters.get(key)
  if (!formatter) {
    const options: Intl.DateTimeFormatOptions = {
      ...(FORMAT_OPTIONS[style] ?? FORMAT_OPTIONS.medium),
      timeZone: 'UTC',
    }
    try {
      formatter = new Intl.DateTimeFormat(locale, options)
    } catch {
      formatter = new Intl.DateTimeFormat('en-US', options)
    }
    utcFormatters.set(key, formatter)
  }
  return formatter
}

/** Formats a calendar date with Intl (en-US by default) WITHOUT time-zone drift. */
export function formatDate(date: ISODate, style: DateFormatStyle, locale = 'en-US'): string {
  // UTC midnight of the date, formatted in UTC: the calendar day can never shift.
  return utcFormatter(style, locale).format(new Date(toEpochDay(date) * MS_PER_DAY))
}
/** 'Today' | 'Tomorrow' | 'Yesterday' | 'Nov 2' (same year as today) | 'Nov 2, 2027'. */
export function formatDateSmart(date: ISODate, today: ISODate): string {
  const diff = diffDays(today, date)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return formatInYear(date, partsOrThrow(today).year)
}

function formatInYear(date: ISODate, referenceYear: number): string {
  return formatDate(date, partsOrThrow(date).year === referenceYear ? 'short' : 'medium')
}

/**
 * 'Nov 2 – Nov 5', 'Nov 2 – Jan 3, 2027', 'Due Nov 5', 'Starts Nov 2', ''
 * Years are shown for dates outside the reference year (today's year, or the first date's
 * year when `today` is omitted); a range within one year shows its year once, at the end.
 */
export function formatDateRange(
  start: ISODate | null,
  end: ISODate | null,
  today?: ISODate,
): string {
  if (!start && !end) return ''
  const referenceYear = partsOrThrow((today || start || end) as ISODate).year
  if (start && end) {
    if (start === end) return formatInYear(start, referenceYear)
    const startYear = partsOrThrow(start).year
    const endYear = partsOrThrow(end).year
    const startLabel = formatDate(
      start,
      startYear === referenceYear || startYear === endYear ? 'short' : 'medium',
    )
    return `${startLabel} – ${formatInYear(end, referenceYear)}`
  }
  if (end) return `Due ${formatInYear(end, referenceYear)}`
  return `Starts ${formatInYear(start as ISODate, referenceYear)}`
}
