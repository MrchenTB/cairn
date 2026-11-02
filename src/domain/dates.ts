/**
 * Calendar-date helpers. Every function works on 'YYYY-MM-DD' strings using pure
 * calendar arithmetic (epoch-day numbers / UTC), so results never depend on the
 * browser's time zone. Only `todayInTimeZone`, `toLocalDate` and `fromLocalDate`
 * touch real clocks / local time, and they are explicit about it.
 */
import type { ISODate } from './types'
import { notImplemented } from './_todo'

export function isISODate(value: unknown): value is ISODate {
  return notImplemented('isISODate' + String(value))
}
/** Returns the date when valid, throws a RangeError otherwise. */
export function assertISODate(value: string): ISODate {
  return notImplemented('assertISODate' + value)
}
/** month is 1-12 */
export function parseISODate(date: ISODate): { year: number; month: number; day: number } {
  return notImplemented('parseISODate' + date)
}
/** month is 1-12; throws RangeError for impossible dates (e.g. 2026-02-30). */
export function makeISODate(year: number, month: number, day: number): ISODate {
  return notImplemented('makeISODate' + year + month + day)
}
/** Days since 1970-01-01 (can be negative). */
export function toEpochDay(date: ISODate): number {
  return notImplemented('toEpochDay' + date)
}
export function fromEpochDay(epochDay: number): ISODate {
  return notImplemented('fromEpochDay' + epochDay)
}
export function addDays(date: ISODate, days: number): ISODate {
  return notImplemented('addDays' + date + days)
}
/** Adds calendar months, clamping the day to the target month's length (Jan 31 + 1 = Feb 28/29). */
export function addMonths(date: ISODate, months: number): ISODate {
  return notImplemented('addMonths' + date + months)
}
/** `to - from` in days. diffDays('2026-11-01', '2026-11-03') === 2 */
export function diffDays(from: ISODate, to: ISODate): number {
  return notImplemented('diffDays' + from + to)
}
/** Inclusive length: durationDays('2026-11-02', '2026-11-04') === 3 */
export function durationDays(start: ISODate, end: ISODate): number {
  return notImplemented('durationDays' + start + end)
}
/** -1 / 0 / 1 */
export function compareISODate(a: ISODate, b: ISODate): number {
  return notImplemented('compareISODate' + a + b)
}
/** Smallest non-empty date, or null. */
export function minDate(...dates: Array<ISODate | null | undefined>): ISODate | null {
  return notImplemented('minDate' + dates.length)
}
/** Largest non-empty date, or null. */
export function maxDate(...dates: Array<ISODate | null | undefined>): ISODate | null {
  return notImplemented('maxDate' + dates.length)
}
export function clampDate(date: ISODate, min: ISODate, max: ISODate): ISODate {
  return notImplemented('clampDate' + date + min + max)
}
/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(date: ISODate): number {
  return notImplemented('dayOfWeek' + date)
}
export function isWeekend(date: ISODate): boolean {
  return notImplemented('isWeekend' + date)
}
export function startOfWeek(date: ISODate, weekStartsOn: 0 | 1): ISODate {
  return notImplemented('startOfWeek' + date + weekStartsOn)
}
export function endOfWeek(date: ISODate, weekStartsOn: 0 | 1): ISODate {
  return notImplemented('endOfWeek' + date + weekStartsOn)
}
export function startOfMonth(date: ISODate): ISODate {
  return notImplemented('startOfMonth' + date)
}
export function endOfMonth(date: ISODate): ISODate {
  return notImplemented('endOfMonth' + date)
}
/** month is 1-12 */
export function daysInMonth(year: number, month: number): number {
  return notImplemented('daysInMonth' + year + month)
}
/** Inclusive list of dates from start to end ([] when end < start). */
export function eachDay(start: ISODate, end: ISODate): ISODate[] {
  return notImplemented('eachDay' + start + end)
}
/** ISO-8601 week number (1-53). */
export function isoWeekNumber(date: ISODate): number {
  return notImplemented('isoWeekNumber' + date)
}
/**
 * The calendar date "now" in the given IANA time zone (e.g. 'Asia/Taipei').
 * Falls back to the browser time zone when `timeZone` is invalid.
 */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): ISODate {
  return notImplemented('todayInTimeZone' + timeZone + now.getTime())
}
export function getBrowserTimeZone(): string {
  return notImplemented('getBrowserTimeZone')
}
export function isValidTimeZone(timeZone: string): boolean {
  return notImplemented('isValidTimeZone' + timeZone)
}
/** Local-midnight Date for date-picker widgets ONLY. */
export function toLocalDate(date: ISODate): Date {
  return notImplemented('toLocalDate' + date)
}
/** Reads the local Y/M/D of a Date coming from a date-picker widget. */
export function fromLocalDate(date: Date): ISODate {
  return notImplemented('fromLocalDate' + date.getTime())
}

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

/** Formats a calendar date with Intl (en-US by default) WITHOUT time-zone drift. */
export function formatDate(date: ISODate, style: DateFormatStyle, locale = 'en-US'): string {
  return notImplemented('formatDate' + date + style + locale)
}
/** 'Today' | 'Tomorrow' | 'Yesterday' | 'Nov 2' (same year as today) | 'Nov 2, 2027'. */
export function formatDateSmart(date: ISODate, today: ISODate): string {
  return notImplemented('formatDateSmart' + date + today)
}
/** 'Nov 2 – Nov 5', 'Nov 2 – Jan 3, 2027', 'Due Nov 5', 'Starts Nov 2', '' */
export function formatDateRange(
  start: ISODate | null,
  end: ISODate | null,
  today?: ISODate,
): string {
  return notImplemented('formatDateRange' + start + end + today)
}
