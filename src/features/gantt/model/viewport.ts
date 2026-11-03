/**
 * Viewport math for the single Gantt scroll container (pure, unit-tested): data bounds, where to
 * scroll on open, scroll anchoring when the timeline origin moves, auto-scroll speed near the
 * edges and the render window for culling. Everything is in integer epoch days and pixels.
 */
import { tryToEpochDay } from '@/domain/dates'
import type { Milestone, Project, Task } from '@/domain/types'
import { AUTO_SCROLL_EDGE_PX, AUTO_SCROLL_MAX_SPEED } from './constants'
import type { DayRange } from './scale'

/**
 * Earliest / latest date of everything the chart can show: task dates (any span kind),
 * milestones and the project's own dates. Corrupt dates are ignored. null = nothing dated.
 */
export function dataBounds(
  tasks: readonly Pick<Task, 'startDate' | 'dueDate'>[],
  milestones: readonly Pick<Milestone, 'date'>[],
  project?: Pick<Project, 'startDate' | 'dueDate'> | null,
): DayRange | null {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  const take = (value: string | null | undefined) => {
    const day = tryToEpochDay(value)
    if (day === null) return
    if (day < start) start = day
    if (day > end) end = day
  }
  for (const task of tasks) {
    take(task.startDate)
    take(task.dueDate)
  }
  for (const milestone of milestones) take(milestone.date)
  if (project) {
    take(project.startDate)
    take(project.dueDate)
  }
  return start <= end ? { start, end } : null
}

/**
 * Where the chart opens: today at one third of the visible width (design-research §5.6) — unless
 * nothing dated would be visible around today, then the start of the data (so a project planned
 * entirely in the past or future does not open on an empty grid). Returns a fractional day and the
 * viewport fraction it should sit at.
 */
export function initialFocus(
  bounds: DayRange | null,
  today: number,
  visibleDays: number,
): { day: number; fraction: number } {
  const todayAt = { day: today + 0.5, fraction: 1 / 3 }
  if (!bounds || visibleDays <= 0) return todayAt
  const from = today - visibleDays / 3
  const to = today + (visibleDays * 2) / 3
  if (bounds.end >= from && bounds.start <= to) return todayAt
  // A little room before the first date.
  return { day: bounds.start, fraction: 0.08 }
}

/**
 * Keeps the same days on screen when the timeline origin moves (range grew to the left, or data
 * moved its first date): content shifts by (old − new origin) days.
 */
export function anchoredScrollLeft(
  scrollLeft: number,
  previousOrigin: number,
  nextOrigin: number,
  dayWidth: number,
): number {
  return Math.max(0, scrollLeft + (previousOrigin - nextOrigin) * dayWidth)
}

/**
 * Auto-scroll step (px per frame) for a pointer at `position` inside a visible band [min, max]:
 * 0 in the middle, growing linearly to `maxSpeed` at (and beyond) the band edge within `edge` px.
 * Negative = towards `min`.
 */
export function autoScrollStep(
  position: number,
  min: number,
  max: number,
  edge = AUTO_SCROLL_EDGE_PX,
  maxSpeed = AUTO_SCROLL_MAX_SPEED,
): number {
  if (max - min <= edge * 2) return 0
  const fromMin = position - min
  const fromMax = max - position
  let speed = 0
  if (fromMin < edge) speed = -maxSpeed * Math.min(1, (edge - fromMin) / edge)
  else if (fromMax < edge) speed = maxSpeed * Math.min(1, (edge - fromMax) / edge)
  if (speed === 0) return 0
  // Whole pixels, at least one, so slow speeds still move.
  const rounded = Math.round(speed)
  return rounded === 0 ? Math.sign(speed) : rounded
}

/** Scroll distance (px) from either end of the content at which the timeline range grows. */
export const EXTEND_THRESHOLD_PX = 240

/** Which side the range should grow on for this scroll position (null = neither). */
export function extendSide(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
  threshold = EXTEND_THRESHOLD_PX,
): 'start' | 'end' | null {
  if (scrollWidth <= clientWidth) return null
  if (scrollLeft < threshold) return 'start'
  if (scrollLeft + clientWidth > scrollWidth - threshold) return 'end'
  return null
}
