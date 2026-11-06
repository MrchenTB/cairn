/**
 * The Timeline's scroll container, on the Gantt's pure viewport math (features/gantt/model): range
 * = data ∪ today + padding, growing as the user scrolls near either end; opens on today (or on the
 * data when none is near); the same days stay on screen when the range or the scale changes.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { GanttScale } from '@/app/viewPrefs'
import {
  dayAtViewport,
  scrollLeftForDay,
  type TimelineGeometry,
} from '@/features/gantt/model/geometry'
import {
  SCALES,
  alignRangeEnd,
  alignRangeStart,
  extendRange,
  renderWindow,
  timelineRange,
  visibleDayRange,
  type DayRange,
} from '@/features/gantt/model/scale'
import { createScrollPosition } from '@/features/gantt/model/scrollPosition'
import { anchoredScrollLeft, extendSide, initialFocus } from '@/features/gantt/model/viewport'

/** Stable callback that always runs the latest closure (for memoised rows and listeners). */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export interface TimelineViewportOptions {
  bounds: DayRange | null
  todayDay: number
  scale: GanttScale
  storeScale: (scale: GanttScale) => void
  weekStartsOn: 0 | 1
  paneWidth: number
}

export function useTimelineViewport({
  bounds,
  todayDay,
  scale,
  storeScale,
  weekStartsOn,
  paneWidth,
}: TimelineViewportOptions) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [scrollPosition] = useState(createScrollPosition)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })

  const { dayWidth } = SCALES[scale]
  const visibleWidth = Math.max(0, viewport.width - paneWidth)
  const minDays = Math.ceil(visibleWidth / dayWidth) + 7
  const baseRange = useMemo(
    () => timelineRange(bounds, todayDay, scale, weekStartsOn, minDays),
    [bounds, todayDay, scale, weekStartsOn, minDays],
  )
  /** Growth from scrolling near either end (per scale; never shrinks while mounted). */
  const [grown, setGrown] = useState<{ scale: GanttScale; range: DayRange } | null>(null)
  const growth = grown !== null && grown.scale === scale ? grown.range : null
  const rangeStart = growth ? Math.min(baseRange.start, growth.start) : baseRange.start
  const rangeEnd = growth ? Math.max(baseRange.end, growth.end) : baseRange.end
  const geometry = useMemo<TimelineGeometry>(
    () => ({ originDay: rangeStart, dayWidth }),
    [rangeStart, dayWidth],
  )
  const timelineWidth = (rangeEnd - rangeStart + 1) * dayWidth

  /** Days for which header cells and grid lines are rendered (visible ± one viewport). */
  const [win, setWin] = useState<DayRange>(() => ({ start: todayDay - 120, end: todayDay + 120 }))
  const [scrolledX, setScrolledX] = useState(false)

  // Latest values for event handlers (updated before the scroll-anchoring effect below).
  const latest = useRef({ geometry, paneWidth, scale, weekStartsOn, rangeEnd, bounds, todayDay })
  useLayoutEffect(() => {
    latest.current = { geometry, paneWidth, scale, weekStartsOn, rangeEnd, bounds, todayDay }
  })

  const prevGeometry = useRef<TimelineGeometry | null>(null)
  const initialized = useRef(false)
  const centerDay = useRef(todayDay + 0.5)
  const pendingCenter = useRef<number | null>(null)
  const growing = useRef(false)

  const grow = useEvent((side: 'start' | 'end') => {
    const { geometry: g, rangeEnd: end, scale: s, weekStartsOn: w } = latest.current
    const current = { start: g.originDay, end }
    const next = extendRange(current, side, SCALES[s].extendDays, s, w)
    if (next.start === current.start && next.end === current.end) return
    growing.current = true
    setGrown({ scale: s, range: next })
  })

  /** Reads the scroll position: render window, centre day, pane shadow, range growth. */
  const syncScroll = useEvent((resetWindow: boolean = false) => {
    const el = scrollerRef.current
    if (!el) return
    const { geometry: g, paneWidth: pw } = latest.current
    const visible = Math.max(1, el.clientWidth - pw)
    const days = visibleDayRange(el.scrollLeft, visible, g.originDay, g.dayWidth)
    centerDay.current = dayAtViewport(el.scrollLeft, visible, g, 0.5)
    scrollPosition.set(el.scrollLeft)
    setWin((previous) => renderWindow(days, resetWindow ? null : previous))
    setScrolledX(el.scrollLeft > 0)
    if (initialized.current && !growing.current) {
      const side = extendSide(el.scrollLeft, el.clientWidth, el.scrollWidth)
      if (side) grow(side)
    }
  })

  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return undefined
    const measure = () =>
      setViewport((previous) =>
        previous.width === el.clientWidth && previous.height === el.clientHeight
          ? previous
          : { width: el.clientWidth, height: el.clientHeight },
      )
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Keep the same days on screen whenever the geometry changes; open on today (or the data).
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const visible = Math.max(0, el.clientWidth - paneWidth)
    const previous = prevGeometry.current
    prevGeometry.current = geometry
    let resetWindow = false
    if (!initialized.current) {
      if (visible <= 0) return
      initialized.current = true
      const focus = initialFocus(latest.current.bounds, latest.current.todayDay, visible / dayWidth)
      el.scrollLeft = scrollLeftForDay(focus.day, visible, geometry, focus.fraction)
      resetWindow = true
    } else if (previous && previous.dayWidth !== geometry.dayWidth) {
      // Scale switch: the centre date stays in the centre.
      const center = pendingCenter.current ?? centerDay.current
      pendingCenter.current = null
      el.scrollLeft = scrollLeftForDay(center, visible, geometry, 0.5)
      resetWindow = true
    } else if (previous && previous.originDay !== geometry.originDay) {
      // The range grew (or data moved its first date): shift by the same days, no jump.
      el.scrollLeft = anchoredScrollLeft(
        el.scrollLeft,
        previous.originDay,
        geometry.originDay,
        geometry.dayWidth,
      )
    }
    growing.current = false
    syncScroll(resetWindow)
  }, [geometry, dayWidth, timelineWidth, paneWidth, viewport.width, syncScroll])

  const changeScale = useEvent((next: GanttScale) => {
    if (next === scale) return
    const el = scrollerRef.current
    const center = centerDay.current
    pendingCenter.current = center
    if (el) {
      // Make sure the days around the current centre exist on the new scale too.
      const half = Math.ceil(Math.max(1, el.clientWidth - paneWidth) / SCALES[next].dayWidth)
      setGrown({
        scale: next,
        range: {
          start: alignRangeStart(Math.floor(center) - half, next, weekStartsOn),
          end: alignRangeEnd(Math.ceil(center) + half, next, weekStartsOn),
        },
      })
    }
    storeScale(next)
  })

  const scrollToToday = useEvent(() => {
    const el = scrollerRef.current
    if (!el) return
    const { geometry: g, paneWidth: pw, todayDay: t } = latest.current
    const visible = Math.max(0, el.clientWidth - pw)
    el.scrollTo({
      left: scrollLeftForDay(t + 0.5, visible, g, 1 / 3),
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  })

  const onScroll = useEvent(() => syncScroll())

  return {
    scrollerRef,
    scrollPosition,
    viewport,
    geometry,
    rangeStart,
    rangeEnd,
    timelineWidth,
    win,
    scrolledX,
    onScroll,
    changeScale,
    scrollToToday,
  }
}
