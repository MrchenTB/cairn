/**
 * Time scales for the Gantt: pixels per day, the rendered timeline range, the two header tiers
 * and the background grid. Pure functions over integer epoch days (see src/domain/dates.ts) —
 * no `Date` objects, so nothing here depends on the browser's time zone.
 */
import type { GanttScale } from '@/app/viewPrefs'
import {
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
  /** Week lines and weekend bands in the chart body (Day and Week only; Month has just month lines). */
  dayGrid: boolean
}

/*
 * Pixels per day. design-research §4.3 and tokens.css --gantt-day-width-* now match 36/16/5 (once drafted 32/14/4), and
 * gantt-evaluation §7.4 proposes 36/16/5. We use 36/16/5: bars snap with Math.round, so a one-day
 * move needs half a day of pointer travel — 18 / 8 / 2.5px. On Week that is 8px instead of 7px
 * (a one-day nudge stays deliberate but easy, well clear of the 3px click slop), Day columns fit
 * the "M 12" label with room to spare, and a month is ~150px so month labels and short bars stay
 * readable. Precise edits on Month go through Alt+←/→ on a focused bar or the Task Modal.
 */
export const SCALES: Record<GanttScale, ScaleSpec> = {
  day: {
    id: 'day',
    label: 'Day',
    dayWidth: 36,
    paddingDays: 14,
    extendDays: 42,
    dayGrid: true,
  },
  week: {
    id: 'week',
    label: 'Week',
    dayWidth: 16,
    paddingDays: 42,
    extendDays: 126,
    dayGrid: true,
  },
  month: {
    id: 'month',
    label: 'Month',
    dayWidth: 5,
    paddingDays: 92,
    extendDays: 366,
    dayGrid: false,
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
  // From the unit's last day: the day after December 9999 has no date of its own.
  const iso = fromEpochDay(start)
  if (unit === 'month') return toEpochDay(endOfMonth(iso)) + 1
  return toEpochDay(makeISODate(parseISODate(iso).year, 12, 31)) + 1
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

/**
 * True when a pill centred on `centerX` (`half` px to each side) covers, or comes within `gap` px
 * of, a header label that starts at `labelLeft` and is `labelWidth` wide (all in timeline px). The
 * today pill hides the label of the week / month it sits in rather than half-covering it.
 */
export function labelOverlapsPill(
  labelLeft: number,
  labelWidth: number,
  centerX: number,
  half: number,
  gap = 4,
): boolean {
  return labelLeft + labelWidth + gap > centerX - half && labelLeft - gap < centerX + half
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

/** Weekend band layer: Saturday + Sunday of every week, as one gradient tile per week. */
const WEEKEND_GRADIENT = (dayWidth: number) =>
  `linear-gradient(90deg, var(--gantt-weekend) 0 ${2 * dayWidth}px, transparent ${2 * dayWidth}px)`

/**
 * Regular grid painted with CSS gradients — no per-day DOM nodes. Two tiles per week, aligned by
 * a background-position offset to the origin's weekday: a hairline at the week start (the same on
 * Day and Week) and the Saturday + Sunday band. The band is one continuous column through every
 * row — it only reads as a calendar, not a checkerboard, because the phase header lanes paint
 * nothing over it and there is no per-day line. Weekend dates are also tinted in the Day header
 * cells (TimeHeader). Month = none (month lines are `gridLines`).
 */
export function gridBackgroundStyle(
  scale: GanttScale,
  originDay: number,
  dayWidth: number,
  weekStartsOn: 0 | 1,
): GridBackgroundStyle | null {
  if (!SCALES[scale].dayGrid) return null
  const originWeekday = dayOfWeek(fromEpochDay(originDay)) // 0 = Sunday
  const week = 7 * dayWidth
  return {
    backgroundImage: [
      'linear-gradient(90deg, var(--gantt-grid) 0 1px, transparent 1px)',
      WEEKEND_GRADIENT(dayWidth),
    ].join(', '),
    backgroundSize: `${week}px 100%, ${week}px 100%`,
    backgroundPosition: `${mod(weekStartsOn - originWeekday, 7) * dayWidth}px 0, ${mod(6 - originWeekday, 7) * dayWidth}px 0`,
  }
}

/**
 * The weekend band as CSS custom properties (`--wk-image`, `--wk-size`, `--wk-x`), set once on the
 * chart body. Text chips that sit on the lane (outside bar labels) paint the same band under
 * themselves, aligned to the grid, so an opaque chip never shows as a lighter patch on a weekend.
 * Empty on Month (no band).
 */
export function weekendBandVars(
  scale: GanttScale,
  originDay: number,
  dayWidth: number,
): Record<string, string> {
  if (!SCALES[scale].dayGrid) return {}
  const originWeekday = dayOfWeek(fromEpochDay(originDay))
  return {
    '--wk-image': WEEKEND_GRADIENT(dayWidth),
    '--wk-size': `${7 * dayWidth}px 100%`,
    '--wk-x': `${mod(6 - originWeekday, 7) * dayWidth}px`,
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
