/**
 * Integer epoch-day ↔ pixel geometry (gantt-evaluation §7.3). Timeline pixels start at the
 * timeline origin (the left edge of `originDay`); the outline pane is NOT included. Rows are
 * placed by index × ROW_HEIGHT, so link geometry never needs to read the DOM.
 */
import { tryFromEpochDay, tryToEpochDay } from '@/domain/dates'
import { taskSpan, type TaskSpan } from '@/domain/scheduling'
import {
  ARROW_HALF_HEIGHT,
  ARROW_LENGTH,
  LINK_GAP,
  LINK_RADIUS,
  MARKER_HALF_WIDTH,
  MIN_BAR_WIDTH,
  RESIZE_HANDLE_WIDTH,
  ROW_HEIGHT,
} from './constants'

export interface TimelineGeometry {
  /** Epoch day at timeline x = 0. */
  originDay: number
  /** Pixels per day. */
  dayWidth: number
}

/** Left edge of `day`. */
export function dayToX(day: number, geometry: TimelineGeometry): number {
  return (day - geometry.originDay) * geometry.dayWidth
}

/** Horizontal centre of `day` (milestones, due markers, today line). */
export function dayCenterX(day: number, geometry: TimelineGeometry): number {
  return dayToX(day, geometry) + geometry.dayWidth / 2
}

/** The day under timeline pixel `x`. */
export function xToDay(x: number, geometry: TimelineGeometry): number {
  return geometry.originDay + Math.floor(x / geometry.dayWidth)
}

/** Fractional day under timeline pixel `x` (absolute, so it survives origin shifts). */
export function xToDayFloat(x: number, geometry: TimelineGeometry): number {
  return geometry.originDay + x / geometry.dayWidth
}

/** Whole days for a pointer travel of `days` (fractional): nearest day, never -0. */
export function snapDays(days: number): number {
  const snapped = Math.round(days)
  return snapped === 0 ? 0 : snapped
}

export interface BarRect {
  left: number
  width: number
}

/**
 * Inclusive range bar: from the left edge of `start` to the right edge of `end`. Bars narrower
 * than MIN_BAR_WIDTH are widened symmetrically. Arguments may be in either order.
 */
export function rangeRect(start: number, end: number, geometry: TimelineGeometry): BarRect {
  const lo = Math.min(start, end)
  const hi = Math.max(start, end)
  const left = dayToX(lo, geometry)
  const width = (hi - lo + 1) * geometry.dayWidth
  if (width >= MIN_BAR_WIDTH) return { left, width }
  return { left: left - (MIN_BAR_WIDTH - width) / 2, width: MIN_BAR_WIDTH }
}

/** Resize hot zone per end: 8px, less on narrow bars, none below 12px (move only). */
export function resizeHandleWidth(barWidth: number): number {
  if (barWidth < 12) return 0
  return Math.min(RESIZE_HANDLE_WIDTH, Math.floor(barWidth / 4))
}

export function rowTop(index: number): number {
  return index * ROW_HEIGHT
}

export function rowCenterY(index: number): number {
  return index * ROW_HEIGHT + ROW_HEIGHT / 2
}

/** Epoch-day form of a task's dates (`null` = missing), derived from the domain `TaskSpan`. */
export interface DaySpan {
  kind: TaskSpan['kind']
  start: number | null
  end: number | null
}

export function toDaySpan(span: TaskSpan): DaySpan {
  return { kind: span.kind, start: tryToEpochDay(span.start), end: tryToEpochDay(span.end) }
}

/** The span for dates given as epoch days (a drag preview), classified by the domain `taskSpan`. */
export function daySpanOf(dates: { start: number | null; end: number | null }): DaySpan {
  return toDaySpan(
    taskSpan({
      startDate: dates.start === null ? null : tryFromEpochDay(dates.start),
      dueDate: dates.end === null ? null : tryFromEpochDay(dates.end),
    }),
  )
}

/** Where incoming links end (`inX`) and outgoing links start (`outX`) on a task's visual. */
export interface SpanAnchors {
  inX: number
  outX: number
}

/**
 * Link anchors per span kind: range → bar edges; due-only → either side of the due flag;
 * start-only → either side of the start tick; unscheduled → none (no link is drawn).
 */
export function spanAnchors(span: DaySpan, geometry: TimelineGeometry): SpanAnchors | null {
  if (span.kind === 'range' && span.start !== null && span.end !== null) {
    const rect = rangeRect(span.start, span.end, geometry)
    return { inX: rect.left, outX: rect.left + rect.width }
  }
  if (span.kind === 'due_only' && span.end !== null) {
    const center = dayCenterX(span.end, geometry)
    return { inX: center - MARKER_HALF_WIDTH, outX: center + MARKER_HALF_WIDTH }
  }
  if (span.kind === 'start_only' && span.start !== null) {
    const x = dayToX(span.start, geometry)
    return { inX: x - 1, outX: x + MARKER_HALF_WIDTH }
  }
  return null
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export interface Point {
  x: number
  y: number
}

/**
 * Orthogonal polyline with rounded corners. The radius shrinks on short segments so corners
 * never overshoot.
 */
export function roundedPath(points: readonly Point[], radius: number): string {
  if (points.length === 0) return ''
  const fmt = (n: number) => String(Math.round(n * 100) / 100)
  let d = `M${fmt(points[0].x)} ${fmt(points[0].y)}`
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]
    const corner = points[i]
    const next = points[i + 1]
    const inLength = Math.hypot(corner.x - prev.x, corner.y - prev.y)
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y)
    const r = Math.min(radius, inLength / 2, outLength / 2)
    if (r <= 0) {
      d += ` L${fmt(corner.x)} ${fmt(corner.y)}`
      continue
    }
    const before = {
      x: corner.x - ((corner.x - prev.x) / inLength) * r,
      y: corner.y - ((corner.y - prev.y) / inLength) * r,
    }
    const after = {
      x: corner.x + ((next.x - corner.x) / outLength) * r,
      y: corner.y + ((next.y - corner.y) / outLength) * r,
    }
    d += ` L${fmt(before.x)} ${fmt(before.y)} Q${fmt(corner.x)} ${fmt(corner.y)} ${fmt(after.x)} ${fmt(after.y)}`
  }
  const last = points[points.length - 1]
  return `${d} L${fmt(last.x)} ${fmt(last.y)}`
}

export interface LinkRoute {
  /** Line path (ends at the arrow tip). */
  d: string
  /** Filled arrowhead pointing right into the successor. */
  arrow: string
  /** Where the "remove" button goes when the link is selected. */
  mid: Point
  /** Vertical extent (for culling). */
  top: number
  bottom: number
  /** true when the link had to loop back (successor starts before the predecessor ends). */
  backward: boolean
}

/**
 * Finish-to-Start route from `from` (predecessor's out anchor) to `to` (successor's in anchor):
 * - enough room: out → down/up → in (one elbow, gantt-evaluation §7.7);
 * - otherwise: out, drop to the row boundary next to the predecessor, run back left past the
 *   successor's start, then in — an S-shape that never crosses either bar.
 */
export function linkRoute(from: Point, to: Point, gap = LINK_GAP, radius = LINK_RADIUS): LinkRoute {
  const direction = to.y >= from.y ? 1 : -1
  let points: Point[]
  let mid: Point
  const backward = to.x - from.x < 2 * gap
  if (!backward) {
    const elbowX = from.x + gap
    points = [from, { x: elbowX, y: from.y }, { x: elbowX, y: to.y }, to]
    mid = { x: elbowX, y: (from.y + to.y) / 2 }
  } else {
    const laneY = from.y + (direction * ROW_HEIGHT) / 2
    const outX = from.x + gap
    const inX = to.x - gap
    points = [
      from,
      { x: outX, y: from.y },
      { x: outX, y: laneY },
      { x: inX, y: laneY },
      { x: inX, y: to.y },
      to,
    ]
    mid = { x: (outX + inX) / 2, y: laneY }
  }
  const arrow = `M${to.x - ARROW_LENGTH} ${to.y - ARROW_HALF_HEIGHT} L${to.x} ${to.y} L${to.x - ARROW_LENGTH} ${to.y + ARROW_HALF_HEIGHT} Z`
  return {
    d: roundedPath(points, radius),
    arrow,
    mid,
    top: Math.min(from.y, to.y) - ROW_HEIGHT / 2,
    bottom: Math.max(from.y, to.y) + ROW_HEIGHT / 2,
    backward,
  }
}

// ---------------------------------------------------------------------------
// Scrolling helpers
// ---------------------------------------------------------------------------

/** Fractional day at `fraction` (0 = left edge, 0.5 = centre) of the visible timeline. */
export function dayAtViewport(
  scrollLeft: number,
  visibleWidth: number,
  geometry: TimelineGeometry,
  fraction = 0.5,
): number {
  return xToDayFloat(scrollLeft + visibleWidth * fraction, geometry)
}

/** scrollLeft that puts fractional `day` at `fraction` of the visible timeline width. */
export function scrollLeftForDay(
  day: number,
  visibleWidth: number,
  geometry: TimelineGeometry,
  fraction = 0.5,
): number {
  return Math.max(0, (day - geometry.originDay) * geometry.dayWidth - visibleWidth * fraction)
}
