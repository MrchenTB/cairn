/**
 * Time scales for the Gantt: pixels per day, the rendered timeline range, the two header tiers
 * and the background grid. Pure functions over integer epoch days (see src/domain/dates.ts) —
 * no `Date` objects, so nothing here depends on the browser's time zone.
 */
import type { GanttScale } from '@/app/viewPrefs'
import {
  addMonths,
  dayOfWeek,
  endOfMonth,
  endOfWeek,
  formatDate,
  fromEpochDay,
  makeISODate,
  parseISODate,
  startOfMonth,
  startOfWeek,
  toEpochDay,
} from '@/domain/dates'

/** Inclusive range of epoch days. */
export interface DayRange {
  start: number
  end: number
}

export interface ScaleSpec {
  id: GanttScale
  label: string
  /** Pixels per calendar day. */
  dayWidth: number
  /** Empty days added before the earliest and after the latest date (data ∪ today). */
  paddingDays: number
  /** Days added when the user scrolls (or drags) close to either end. */
  extendDays: number
  /** Weekend shading and day/week grid lines (Day and Week only). */
  shadeWeekends: boolean
}

/*
 * Pixels per day. design-research §4.3 drafts 32/14/4 (tokens.css --gantt-day-width-*), and
 * gantt-evaluation §7.4 proposes 36/16/5. We use 36/16/5: bars snap with Math.round, so a one-day
 * move needs half a day of pointer travel — 18 / 8 / 2.5px. On Week that is 8px instead of 7px
 * (a one-day nudge stays deliberate but easy, well clear of the 3px click slop), Day columns fit
 * the "M 12" label with room to spare, and a month is ~150px so month labels and short bars stay
 * readable. Precise edits on Month go through Alt+←/→ on a focused bar or the Task Modal.
 */
export const SCALES: Record<GanttScale, ScaleSpec> = {
  day: { id: 'day', label: 'Day', dayWidth: 36, paddingDays: 14, extendDays: 42, shadeWeekends: true },
  week: {
    id: 'week',
    label: 'Week',
    dayWidth: 16,
    paddingDays: 42,
    extendDays: 126,
    shadeWeekends: true,
  },
  month: {
    id: 'month',
    label: 'Month',
    dayWidth: 5,
    paddingDays: 92,
    extendDays: 366,
    shadeWeekends: false,
  },
}

/** Supported calendar (dates.ts): 0001-01-01 … 9999-12-31, kept a month away from both ends. */
const MIN_DAY = toEpochDay('0001-02-01')
const MAX_DAY = toEpochDay('9999-11-30')
/** Scrolling never grows the timeline past ~40 years (data outside is still always included). */
export const MAX_RANGE_DAYS = 366 * 40

function clampDay(day: number): number {
  return Math.min(MAX_DAY, Math.max(MIN_DAY, Math.round(day)))
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m
}

/** First day of the scale's unit containing `day` (week for Day/Week, month for Month). */
export function alignRangeStart(day: number, scale: GanttScale, weekStartsOn: 0 | 1): number {
  const iso = fromEpochDay(clampDay(day))
  return toEpochDay(scale === 'month' ? startOfMonth(iso) : startOfWeek(iso, weekStartsOn))
}

/** Last day of the scale's unit containing `day`. */
export function alignRangeEnd(day: number, scale: GanttScale, weekStartsOn: 0 | 1): number {
  const iso = fromEpochDay(clampDay(day))
  return toEpochDay(scale === 'month' ? endOfMonth(iso) : endOfWeek(iso, weekStartsOn))
}

/**
 * The timeline range for a scale: [min(data, today) − padding, max(data, today) + padding],
 * aligned to whole weeks (Day/Week) or months (Month), and at least `minDays` long (so the grid
 * always fills the viewport).
 */
export function timelineRange(
  bounds: DayRange | null,
  today: number,
  scale: GanttScale,
  weekStartsOn: 0 | 1,
  minDays = 0,
): DayRange {
  const spec = SCALES[scale]
  const lo = Math.min(bounds ? bounds.start : today, today) - spec.paddingDays
  const hi = Math.max(bounds ? bounds.end : today, today) + spec.paddingDays
  const start = alignRangeStart(lo, scale, weekStartsOn)
  let end = alignRangeEnd(hi, scale, weekStartsOn)
  if (end - start + 1 < minDays) end = alignRangeEnd(start + minDays - 1, scale, weekStartsOn)
  return { start, end }
}

/** Grows `range` on one side by `days` (aligned), unless it already spans MAX_RANGE_DAYS. */
export function extendRange(
  range: DayRange,
  side: 'start' | 'end',
  days: number,
  scale: GanttScale,
  weekStartsOn: 0 | 1,
): DayRange {
  if (range.end - range.start + 1 >= MAX_RANGE_DAYS) return range
  return side === 'start'
    ? { start: alignRangeStart(range.start - days, scale, weekStartsOn), end: range.end }
    : { start: range.start, end: alignRangeEnd(range.end + days, scale, weekStartsOn) }
}

export function unionRange(a: DayRange, b: DayRange): DayRange {
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) }
}

export function containsRange(outer: DayRange, inner: DayRange): boolean {
  return inner.start >= outer.start && inner.end <= outer.end
}

// ---------------------------------------------------------------------------
// Header tiers
// ---------------------------------------------------------------------------

export type HeaderUnit = 'day' | 'week' | 'month' | 'year'

/** Which calendar unit each tier shows per scale (design-research §5.6). */
export const HEADER_UNITS: Record<GanttScale, { top: HeaderUnit; bottom: HeaderUnit }> = {
  day: { top: 'month', bottom: 'day' },
  week: { top: 'month', bottom: 'week' },
  month: { top: 'year', bottom: 'month' },
}

export interface HeaderCell {
  key: string
  /** First / last day of the unit (not clipped). */
  startDay: number
  endDay: number
  /** Position and width in timeline pixels, clipped to the timeline range. */
  x: number
  width: number
  label: string
  /** Narrow weekday letter shown before the day number (Day scale). */
  prefix?: string
  /** Full description (tooltip / accessible name). */
  title: string
  weekend: boolean
  /** The unit contains today. */
  today: boolean
}

export interface HeaderTiers {
  top: HeaderCell[]
  bottom: HeaderCell[]
}

function unitStart(day: number, unit: HeaderUnit, weekStartsOn: 0 | 1): number {
  if (unit === 'day') return day
  const iso = fromEpochDay(day)
  if (unit === 'week') return toEpochDay(startOfWeek(iso, weekStartsOn))
  if (unit === 'month') return toEpochDay(startOfMonth(iso))
  return toEpochDay(makeISODate(parseISODate(iso).year, 1, 1))
}

function nextUnitStart(start: number, unit: HeaderUnit): number {
  if (unit === 'day') return start + 1
  if (unit === 'week') return start + 7
  return toEpochDay(addMonths(fromEpochDay(start), unit === 'month' ? 1 : 12))
}

/** [start, end] of every unit intersecting [from, to] (inclusive), in order. */
export function eachUnit(
  from: number,
  to: number,
  unit: HeaderUnit,
  weekStartsOn: 0 | 1,
): Array<[number, number]> {
  const units: Array<[number, number]> = []
  if (to < from) return units
  let start = unitStart(clampDay(from), unit, weekStartsOn)
  const last = clampDay(to)
  while (start <= last) {
    const next = nextUnitStart(start, unit)
    units.push([start, next - 1])
    start = next
  }
  return units
}

export function isWeekendDay(day: number): boolean {
  const weekday = dayOfWeek(fromEpochDay(day))
  return weekday === 0 || weekday === 6
}

function labelFor(
  unit: HeaderUnit,
  tier: 'top' | 'bottom',
  start: number,
): Pick<HeaderCell, 'label' | 'prefix' | 'title'> {
  const iso = fromEpochDay(start)
  switch (unit) {
    case 'day':
      return {
        label: formatDate(iso, 'day'),
        prefix: formatDate(iso, 'weekdayNarrow'),
        title: formatDate(iso, 'long'),
      }
    case 'week':
      return { label: formatDate(iso, 'short'), title: `Week of ${formatDate(iso, 'medium')}` }
    case 'month':
      return tier === 'top'
        ? { label: formatDate(iso, 'shortMonthYear'), title: formatDate(iso, 'monthYear') }
        : { label: formatDate(iso, 'month'), title: formatDate(iso, 'monthYear') }
    case 'year':
      return { label: formatDate(iso, 'year'), title: formatDate(iso, 'year') }
  }
}

/**
 * Header cells for the visible `window` (only those are rendered), positioned in timeline pixels
 * relative to `range.start`. Cells at the range edges are clipped to the range.
 */
export function buildHeaderTiers(options: {
  scale: GanttScale
  range: DayRange
  window: DayRange
  dayWidth: number
  weekStartsOn: 0 | 1
  today: number
}): HeaderTiers {
  const { scale, range, window, dayWidth, weekStartsOn, today } = options
  const from = Math.max(window.start, range.start)
  const to = Math.min(window.end, range.end)
  const cells = (unit: HeaderUnit, tier: 'top' | 'bottom'): HeaderCell[] =>
    eachUnit(from, to, unit, weekStartsOn).map(([start, end]) => {
      const clippedStart = Math.max(start, range.start)
      const clippedEnd = Math.min(end, range.end)
      return {
        key: `${unit}:${start}`,
        startDay: start,
        endDay: end,
        x: (clippedStart - range.start) * dayWidth,
        width: (clippedEnd - clippedStart + 1) * dayWidth,
        ...labelFor(unit, tier, start),
        weekend: unit === 'day' && isWeekendDay(start),
        today: start <= today && today <= end,
      }
    })
  const units = HEADER_UNITS[scale]
  return { top: cells(units.top, 'top'), bottom: cells(units.bottom, 'bottom') }
}

// ---------------------------------------------------------------------------
// Background grid
// ---------------------------------------------------------------------------

export interface GridLine {
  key: string
  /** Timeline pixels. */
  x: number
  strong: boolean
}

/**
 * Irregular boundary lines inside `window` (regular day/week lines are CSS gradients, see
 * `gridBackgroundStyle`): month starts on Day/Week, month + (strong) year starts on Month.
 * No line at the very start of the range.
 */
export function gridLines(options: {
  scale: GanttScale
  range: DayRange
  window: DayRange
  dayWidth: number
}): GridLine[] {
  const { scale, range, window, dayWidth } = options
  const from = Math.max(window.start, range.start)
  const to = Math.min(window.end, range.end)
  const lines: GridLine[] = []
  for (const [start] of eachUnit(from, to, 'month', 1)) {
    if (start <= range.start || start < from) continue
    const yearStart = parseISODate(fromEpochDay(start)).month === 1
    lines.push({
      key: `m:${start}`,
      x: (start - range.start) * dayWidth,
      strong: scale !== 'month' || yearStart,
    })
  }
  return lines
}

export interface GridBackgroundStyle {
  backgroundImage: string
  backgroundSize: string
  backgroundPosition: string
}

/**
 * Regular grid painted with CSS gradients — no per-day DOM nodes. Each layer is one tile per
 * period (day or week) so a background-position offset aligns it to the origin's weekday:
 * Day = day lines + week lines (strong) + weekends; Week = week lines + weekends; Month = none.
 */
export function gridBackgroundStyle(
  scale: GanttScale,
  originDay: number,
  dayWidth: number,
  weekStartsOn: 0 | 1,
): GridBackgroundStyle | null {
  if (!SCALES[scale].shadeWeekends) return null
  const originWeekday = dayOfWeek(fromEpochDay(originDay)) // 0 = Sunday
  const week = 7 * dayWidth
  const line = (token: string) => `linear-gradient(90deg, var(${token}) 0 1px, transparent 1px)`
  const layers: Array<{ image: string; size: string; position: string }> = []
  if (scale === 'day') {
    layers.push({ image: line('--gantt-grid'), size: `${dayWidth}px 100%`, position: '0 0' })
  }
  layers.push({
    image: line(scale === 'day' ? '--gantt-grid-strong' : '--gantt-grid'),
    size: `${week}px 100%`,
    position: `${mod(weekStartsOn - originWeekday, 7) * dayWidth}px 0`,
  })
  layers.push({
    image: `linear-gradient(90deg, var(--gantt-weekend) 0 ${2 * dayWidth}px, transparent ${2 * dayWidth}px)`,
    size: `${week}px 100%`,
    position: `${mod(6 - originWeekday, 7) * dayWidth}px 0`,
  })
  return {
    backgroundImage: layers.map((layer) => layer.image).join(', '),
    backgroundSize: layers.map((layer) => layer.size).join(', '),
    backgroundPosition: layers.map((layer) => layer.position).join(', '),
  }
}

// ---------------------------------------------------------------------------
// Visible window
// ---------------------------------------------------------------------------

/** Days visible in a timeline viewport of `width` px scrolled to `scrollLeft`. */
export function visibleDayRange(
  scrollLeft: number,
  width: number,
  originDay: number,
  dayWidth: number,
): DayRange {
  const start = originDay + Math.floor(Math.max(scrollLeft, 0) / dayWidth)
  const end = originDay + Math.floor((Math.max(scrollLeft, 0) + Math.max(width - 1, 0)) / dayWidth)
  return { start, end }
}

/**
 * The window header cells and grid lines are rendered for: the visible days plus one viewport on
 * each side. Returns `previous` unchanged while the visible days stay inside it, so horizontal
 * scrolling re-renders the header only every viewport or so.
 */
export function renderWindow(visible: DayRange, previous: DayRange | null): DayRange {
  if (previous && containsRange(previous, visible)) return previous
  const span = visible.end - visible.start + 1
  return { start: visible.start - span, end: visible.end + span }
}
