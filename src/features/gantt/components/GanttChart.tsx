/**
 * The project Gantt chart (gantt-evaluation §7):
 * - ONE scroll container with a sticky two-tier time header and a sticky, resizable outline
 *   column (no JS scroll sync); rows virtualised with @tanstack/react-virtual (fixed 32px rows);
 * - DOM bars over ONE SVG dependency layer whose geometry comes from row index × row height and
 *   integer epoch days × px-per-day (never from the DOM);
 * - a custom pointer-event state machine (pointer capture on the scroller) for move / resize /
 *   point / draw drags and for drawing dependencies, with auto-scroll near the edges. Drag state
 *   lives here; it is committed on release only, through the planner (task dates) or
 *   updateMilestone, and the dropped position is held until the write (or the Auto preview)
 *   settles, so a bar never flickers back — and returns when the write is cancelled or fails;
 * - keyboard alternatives on every bar (Enter, Alt+←/→, Alt+Shift+←/→).
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { CalendarOff, CalendarRange, X } from 'lucide-react'
import { useViewShortcut } from '@/app/shortcuts'
import { useOpenTask, useTaskParam } from '@/app/taskModalRoute'
import { useUIStore } from '@/app/uiStore'
import { useGanttScale, type GanttScale } from '@/app/viewPrefs'
import { Button } from '@/components/ui/button'
import { useActions, useWorkspaceData } from '@/data/hooks'
import {
  formatDate,
  formatDateRange,
  toEpochDay,
  tryFromEpochDay,
  tryToEpochDay,
} from '@/domain/dates'
import { validateNewDependency, type DependencyConflict } from '@/domain/scheduling'
import {
  resolvePhaseColor,
  type Dependency,
  type ISODate,
  type Milestone,
  type Phase,
  type PhaseColor,
  type Project,
  type ProjectColor,
  type ScheduleMode,
} from '@/domain/types'
import { ViewBarActions } from '@/features/projects/viewBar'
import { useHotkeys } from '@/lib/keyboard'
import { notify } from '@/lib/notify'
import { usePaneWidth } from '../ganttPrefs'
import { HEADER_HEIGHT, LINK_ROW_CHUNK, ROW_HEIGHT, ROW_OVERSCAN } from '../model/constants'
import { conflictMessages, liveConflicts, type DateOverrides } from '../model/conflicts'
import {
  hasDateChange,
  isClick,
  startDrag,
  toISODates,
  toScheduleChange,
  updateDrag,
  type DragDates,
  type DragMode,
  type DragOrigin,
  type DragState,
  type PointerSample,
} from '../model/dragReducer'
import {
  dayAtViewport,
  dayCenterX,
  daySpanOf,
  dayToX,
  rowCenterY,
  scrollLeftForDay,
  spanAnchors,
  type Point,
  type TimelineGeometry,
} from '../model/geometry'
import { datesLabel, dragTooltip } from '../model/labels'
import { buildLinkViews } from '../model/links'
import { nudgeFromKey, nudgeSpan } from '../model/nudge'
import {
  groupKeyForPhaseId,
  taskRowKey,
  type GanttRow,
  type GanttRowModel,
  type TaskRow,
} from '../model/rows'
import {
  SCALES,
  alignRangeEnd,
  alignRangeStart,
  buildHeaderTiers,
  extendRange,
  gridBackgroundStyle,
  weekendBandVars,
  gridLines,
  renderWindow,
  timelineRange,
  visibleDayRange,
  type DayRange,
} from '../model/scale'
import { createScrollPosition } from '../model/scrollPosition'
import { anchoredScrollLeft, autoScrollStep, extendSide, initialFocus } from '../model/viewport'
import {
  computeReschedulePlan,
  planScheduleChangeDetailed,
  reviewConflicts,
  reviewNewDependency,
  type PlanOutcome,
  type ScheduleWriteRecord,
} from '../planner'
import { announceDateChange, classifyDateChange } from '../dateUndo'
import { useRescheduleStore } from '../rescheduleStore'
import { DragTooltip } from './DragTooltip'
import { GanttRowView, type RowOverride, type RowPreview } from './GanttRow'
import { GanttToolbar } from './GanttToolbar'
import { LinkDraftLine, LinkLayer, type LinkBox } from './LinkLayer'
import { PaneResizer } from './PaneResizer'
import { GridBackground, TimeHeader, TodayLine } from './TimeAxis'

// ---------------------------------------------------------------------------
// Interaction state (kept in a ref; a render-friendly mirror lives in React state)
// ---------------------------------------------------------------------------

type Subject = { type: 'task'; id: string } | { type: 'milestone'; id: string }

interface DragInteraction {
  kind: 'drag'
  pointerId: number
  rowKey: string
  rowIndex: number
  subject: Subject
  state: DragState
  /** Scroller rect, re-read on every sample: the sidebar can collapse during a drag. */
  rect: DOMRect
  clientX: number
  clientY: number
}

interface LinkTarget {
  taskId: string
  valid: boolean
  message: string | null
}

interface LinkInteraction {
  kind: 'link'
  pointerId: number
  rowKey: string
  sourceId: string
  /** 'out' = drawn from the finish (source is the predecessor), 'in' = from the start. */
  side: 'in' | 'out'
  rect: DOMRect
  clientX: number
  clientY: number
  target: LinkTarget | null
}

type Interaction = DragInteraction | LinkInteraction

interface DragView {
  rowKey: string
  rowIndex: number
  subject: Subject
  override: RowOverride
  clientX: number
  clientY: number
}

interface LinkDraft {
  rowKey: string
  sourceId: string
  side: 'in' | 'out'
  /** Pointer in body coordinates. */
  to: Point
  target: LinkTarget | null
  clientX: number
  clientY: number
}

interface PendingOverride extends RowOverride {
  token: number
  taskId: string | null
}

/** Stable callback that always runs the latest closure (for memoised rows and listeners). */
function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function sameDates(a: DragDates, b: DragDates): boolean {
  return a.start === b.start && a.end === b.end
}

const DRAG_HANDLES = new Set(['move', 'resize-start', 'resize-end', 'point'])

/** Shown when a dependency is dropped on a task that has no bar (no dates of its own). */
const UNSCHEDULED_LINK_MESSAGE = 'Schedule this task first to link it on the chart.'

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

export interface GanttChartProps {
  project: Project
  model: GanttRowModel
  dependencies: readonly Dependency[]
  milestones: readonly Milestone[]
  /** findConflicts over the stored dates (the toolbar chip lists these). */
  conflicts: readonly DependencyConflict[]
  /** Earliest / latest dated item (tasks, milestones, project dates). */
  bounds: DayRange | null
  today: ISODate
  weekStartsOn: 0 | 1
  /** Toggles a group / parent: the persisted prefs, or the temporary set while filtering. */
  onToggleRow: (key: string, collapse?: boolean) => void
  /** Filter mode: only tasks without dates (the model is already filtered). */
  unscheduledOnly: boolean
  onUnscheduledOnlyChange: (on: boolean) => void
}

export function GanttChart({
  project,
  model,
  dependencies,
  milestones,
  conflicts,
  bounds,
  today,
  weekStartsOn,
  onToggleRow,
  unscheduledOnly,
  onUnscheduledOnlyChange,
}: GanttChartProps) {
  const data = useWorkspaceData()
  const actions = useActions()
  const openTaskRoute = useOpenTask()
  const selectedTaskId = useTaskParam()
  const openMilestoneDialog = useUIStore((s) => s.openMilestoneDialog)
  const milestoneDialog = useUIStore((s) => s.milestoneDialog)
  const [scale, storeScale] = useGanttScale(project.id)
  const [paneWidth, setPaneWidth, commitPaneWidth] = usePaneWidth()
  const activeReschedule = useRescheduleStore((s) => s.active)
  const helpId = useId()

  const scrollerRef = useRef<HTMLDivElement>(null)
  const unscheduledToggleRef = useRef<HTMLButtonElement | null>(null)
  const registerUnscheduledToggle = useCallback((element: HTMLButtonElement | null) => {
    unscheduledToggleRef.current = element
  }, [])
  const removeButtonRef = useRef<HTMLButtonElement>(null)
  const [scrollPosition] = useState(createScrollPosition)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })

  // ---- geometry ------------------------------------------------------------
  const { rows } = model
  const { dayWidth } = SCALES[scale]
  const todayDay = toEpochDay(today)
  const visibleTimelineWidth = Math.max(0, viewport.width - paneWidth)
  const minDays = Math.ceil(visibleTimelineWidth / dayWidth) + 7
  const baseRange = useMemo(
    () => timelineRange(bounds, todayDay, scale, weekStartsOn, minDays),
    [bounds, todayDay, scale, weekStartsOn, minDays],
  )
  /** Growth from scrolling near either end (per scale; never shrinks while mounted). */
  const [grown, setGrown] = useState<{ scale: GanttScale; range: DayRange } | null>(null)
  const growth = grown !== null && grown.scale === scale ? grown.range : null
  /**
   * The widest natural range seen for this scale. The data's first / last date moving INWARD (the
   * earliest task dragged later, a date edited in the Task Modal) must not shrink the timeline
   * under the user: with the old range kept, the same days stay where they are on screen.
   */
  const [seen, setSeen] = useState<{ scale: GanttScale; range: DayRange } | null>(null)
  const floor = seen !== null && seen.scale === scale ? seen.range : null
  if (floor === null || baseRange.start < floor.start || baseRange.end > floor.end) {
    setSeen({
      scale,
      range: floor
        ? { start: Math.min(floor.start, baseRange.start), end: Math.max(floor.end, baseRange.end) }
        : baseRange,
    })
  }
  const rangeStart = Math.min(baseRange.start, growth?.start ?? Infinity, floor?.start ?? Infinity)
  const rangeEnd = Math.max(baseRange.end, growth?.end ?? -Infinity, floor?.end ?? -Infinity)
  const geometry = useMemo<TimelineGeometry>(
    () => ({ originDay: rangeStart, dayWidth }),
    [rangeStart, dayWidth],
  )
  const timelineWidth = (rangeEnd - rangeStart + 1) * dayWidth
  const contentWidth = paneWidth + timelineWidth
  const bodyHeight = Math.max(rows.length * ROW_HEIGHT, viewport.height - HEADER_HEIGHT)

  /** Days for which header cells, grid lines and links are rendered (visible ± one viewport). */
  const [win, setWin] = useState<DayRange>(() => ({ start: todayDay - 120, end: todayDay + 120 }))
  const [scrolledX, setScrolledX] = useState(false)

  // ---- interaction state ---------------------------------------------------
  const interactionRef = useRef<Interaction | null>(null)
  const rafRef = useRef(0)
  const [dragView, setDragView] = useState<DragView | null>(null)
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null)
  const [pending, setPending] = useState<Record<string, PendingOverride>>({})
  const pendingSeq = useRef(0)
  const [selectedDep, setSelectedDep] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')

  // Latest values for event handlers (updated before the scroll-anchoring effect below).
  const latest = useRef({
    geometry,
    paneWidth,
    rows,
    model,
    scale,
    weekStartsOn,
    rangeEnd,
    bounds,
    todayDay,
    dependencies,
    tasksById: data.tasks,
  })
  useLayoutEffect(() => {
    latest.current = {
      geometry,
      paneWidth,
      rows,
      model,
      scale,
      weekStartsOn,
      rangeEnd,
      bounds,
      todayDay,
      dependencies,
      tasksById: data.tasks,
    }
  })

  // ---- virtual rows --------------------------------------------------------
  /** Row holding keyboard focus: kept mounted, so scrolling never drops focus to <body>. */
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null)
  const pinnedKey = [
    dragView?.rowIndex,
    linkDraft ? (model.rowIndexByKey.get(linkDraft.rowKey) ?? -1) : null,
    focusedRowKey ? (model.rowIndexByKey.get(focusedRowKey) ?? -1) : null,
  ]
    .filter((index): index is number => typeof index === 'number' && index >= 0)
    .join(',')
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range)
      if (!pinnedKey) return indexes
      // Keep the row being dragged (or linked from, or focused) mounted while it scrolls away.
      const extra = pinnedKey
        .split(',')
        .map(Number)
        .filter((index) => index < range.count && !indexes.includes(index))
      return extra.length > 0 ? [...indexes, ...extra].sort((a, b) => a - b) : indexes
    },
    [pinnedKey],
  )
  // oxlint-disable-next-line react/incompatible-library -- no React Compiler here; rows are memoised by props, not by the virtualizer's functions
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: ROW_OVERSCAN,
    scrollMargin: HEADER_HEIGHT,
    // scrollToIndex keeps a revealed row below the sticky time header, not under it.
    scrollPaddingStart: HEADER_HEIGHT,
    rangeExtractor,
  })
  const items = virtualizer.getVirtualItems()
  // Links are culled to a row window snapped to LINK_ROW_CHUNK, so the SVG layer re-renders every
  // few rows of scrolling instead of on every virtual-row change.
  // From the visible range (+ overscan), not `items`: pinned rows far away must not widen it.
  const visibleRange = virtualizer.range
  const renderedFirst = visibleRange ? Math.max(0, visibleRange.startIndex - ROW_OVERSCAN) : 0
  const renderedLast = visibleRange
    ? Math.min(rows.length - 1, visibleRange.endIndex + ROW_OVERSCAN)
    : items.length > 0
      ? items[items.length - 1].index
      : -1
  const firstRow = Math.max(0, (Math.floor(renderedFirst / LINK_ROW_CHUNK) - 1) * LINK_ROW_CHUNK)
  const lastRow =
    renderedLast < 0
      ? -1
      : Math.min(
          rows.length - 1,
          (Math.floor(renderedLast / LINK_ROW_CHUNK) + 2) * LINK_ROW_CHUNK - 1,
        )

  // ---- derived view data ---------------------------------------------------
  const dateOverrides = useMemo<DateOverrides>(() => {
    const map = new Map<string, { startDate: ISODate | null; dueDate: ISODate | null }>()
    for (const entry of Object.values(pending)) {
      const dates = entry.taskId ? toISODates(entry.dates) : null
      if (entry.taskId && dates) map.set(entry.taskId, dates)
    }
    if (dragView?.subject.type === 'task') {
      const dates = toISODates(dragView.override.dates)
      if (dates) map.set(dragView.subject.id, dates)
    }
    return map
  }, [pending, dragView])
  const shownConflicts = useMemo(
    () => liveConflicts(conflicts, dependencies, data.tasks, dateOverrides),
    [conflicts, dependencies, data.tasks, dateOverrides],
  )
  const conflictIds = useMemo(
    () => new Set(shownConflicts.map((conflict) => conflict.dependencyId)),
    [shownConflicts],
  )
  const messages = useMemo(
    () => conflictMessages(shownConflicts, data.tasks, today),
    [shownConflicts, data.tasks, today],
  )

  // Auto-schedule preview for this project: dashed ghosts where the shifted tasks would go.
  const plan = useMemo(
    () =>
      activeReschedule && activeReschedule.request.projectId === project.id
        ? computeReschedulePlan(activeReschedule.request, data)
        : null,
    [activeReschedule, data, project.id],
  )
  const previews = useMemo(() => {
    const map = new Map<string, RowPreview>()
    for (const shift of plan?.shifts ?? []) {
      map.set(shift.taskId, {
        dates: { start: tryToEpochDay(shift.to.startDate), end: tryToEpochDay(shift.to.dueDate) },
        deltaDays: shift.deltaDays,
      })
    }
    return map
  }, [plan])

  const overrideOf = (row: GanttRow): RowOverride | null =>
    dragView?.rowKey === row.key ? dragView.override : (pending[row.key] ?? null)

  const links = useMemo(() => {
    const endpoint = (taskId: string) => {
      const index = model.taskRowIndex.get(taskId)
      if (index === undefined) return null
      const row = rows[index]
      if (row?.kind !== 'task') return null
      const override = dragView?.rowKey === row.key ? dragView.override : pending[row.key]
      const anchors = spanAnchors(override ? daySpanOf(override.dates) : row.span, geometry)
      return anchors ? { rowIndex: index, anchors } : null
    }
    return buildLinkViews({
      dependencies,
      endpoint,
      conflictIds,
      firstRow,
      lastRow,
      minX: dayToX(win.start, geometry),
      maxX: dayToX(win.end + 1, geometry),
    })
  }, [dependencies, model, rows, dragView, pending, geometry, conflictIds, firstRow, lastRow, win])

  const linkBox = useMemo<LinkBox>(() => {
    const x = Math.max(0, dayToX(win.start, geometry))
    const right = Math.min(timelineWidth, dayToX(win.end + 1, geometry))
    return {
      x,
      y: firstRow * ROW_HEIGHT,
      width: Math.max(1, right - x),
      height: Math.max(1, (lastRow - firstRow + 1) * ROW_HEIGHT),
    }
  }, [win, geometry, timelineWidth, firstRow, lastRow])

  const tiers = useMemo(
    () =>
      buildHeaderTiers({
        scale,
        range: { start: rangeStart, end: rangeEnd },
        window: win,
        dayWidth,
        weekStartsOn,
        today: todayDay,
      }),
    [scale, rangeStart, rangeEnd, win, dayWidth, weekStartsOn, todayDay],
  )
  const lines = useMemo(
    () => gridLines({ scale, range: { start: rangeStart, end: rangeEnd }, window: win, dayWidth }),
    [scale, rangeStart, rangeEnd, win, dayWidth],
  )
  const bandVars = useMemo(
    () => weekendBandVars(scale, rangeStart, dayWidth, weekStartsOn) as CSSProperties,
    [scale, rangeStart, dayWidth, weekStartsOn],
  )
  const gridStyle = useMemo(
    () => gridBackgroundStyle(scale, rangeStart, dayWidth, weekStartsOn),
    [scale, rangeStart, dayWidth, weekStartsOn],
  )

  /** Phase colour of a row (tasks and phase headers), else the project's. */
  const hueOf = (row: GanttRow): ProjectColor => {
    const phaseId =
      row.kind === 'task' ? row.task.phaseId : row.kind === 'group' ? row.phase?.id : null
    const phase = phaseId && Object.hasOwn(data.phases, phaseId) ? data.phases[phaseId] : null
    return resolvePhaseColor(phase?.color, project.color)
  }
  const onPhaseColor = useEvent((phase: Phase, color: PhaseColor | null) => {
    void actions.updatePhase(phase.id, { color }).then((result) => {
      if (!result.ok && result.error.kind === 'validation') {
        notify.error('Couldn’t change the phase color', { description: result.error.message })
      }
    })
  })

  const upcomingMilestoneId = useMemo(
    () => milestones.find((milestone) => milestone.date >= today)?.id ?? null,
    [milestones, today],
  )
  const editingMilestoneId = milestoneDialog?.mode === 'edit' ? milestoneDialog.milestoneId : null
  const selectedLink = selectedDep ? (links.find((link) => link.id === selectedDep) ?? null) : null

  // ---- scrolling -----------------------------------------------------------
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

  const scrollDayIntoView = useEvent((day: number, smooth: boolean) => {
    const el = scrollerRef.current
    if (!el) return
    const { geometry: g, paneWidth: pw } = latest.current
    const visible = Math.max(0, el.clientWidth - pw)
    const x = dayToX(day, g)
    if (x >= el.scrollLeft && x + g.dayWidth <= el.scrollLeft + visible) return
    el.scrollTo({
      left: scrollLeftForDay(day, visible, g, 0.25),
      behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto',
    })
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
  useViewShortcut('t', scrollToToday, { description: 'Scroll to today' })

  /**
   * Row key to bring into view once it exists (after expanding its group / parent: the expanded
   * rows only exist after the next render, hence the pending key, retried when the model changes).
   */
  const revealKey = useRef<string | null>(null)
  const revealRow = useEvent((key: string) => {
    const index = latest.current.model.rowIndexByKey.get(key) ?? -1
    if (index < 0) {
      revealKey.current = key
      return
    }
    revealKey.current = null
    virtualizer.scrollToIndex(index)
    const row = latest.current.rows[index]
    const day =
      row?.kind === 'task'
        ? (row.span.start ?? row.span.end ?? row.rollup?.start ?? null)
        : row?.kind === 'milestone'
          ? row.day
          : null
    if (day !== null) scrollDayIntoView(day, true)
  })
  useEffect(() => {
    if (revealKey.current) revealRow(revealKey.current)
  }, [model, revealRow])

  /**
   * The filter is temporary view state: turning it on remembers the vertical scroll position and
   * jumps to the top (the horizontal position stays); turning it off restores it. Applied after
   * the render that swaps the row model, so the content height is already the new one.
   */
  const savedScrollTop = useRef(0)
  const scrollAfterFilter = useRef<'top' | 'restore' | null>(null)
  const changeUnscheduledOnly = useEvent((on: boolean) => {
    if (on === unscheduledOnly) return
    if (on) savedScrollTop.current = scrollerRef.current?.scrollTop ?? 0
    scrollAfterFilter.current = on ? 'top' : 'restore'
    onUnscheduledOnlyChange(on)
  })
  useLayoutEffect(() => {
    const mode = scrollAfterFilter.current
    scrollAfterFilter.current = null
    const el = scrollerRef.current
    if (mode && el) el.scrollTop = mode === 'top' ? 0 : savedScrollTop.current
  }, [unscheduledOnly])
  // A task that got dates while filtering leaves its row. If it held keyboard focus the browser
  // drops focus to <body>; hand it to the toggle, which is always there while filtering.
  useEffect(() => {
    if (!unscheduledOnly || !focusedRowKey || model.rowIndexByKey.has(focusedRowKey)) return
    setFocusedRowKey(null)
    const active = document.activeElement
    if (!active || active === document.body || !active.isConnected) {
      unscheduledToggleRef.current?.focus()
    }
  }, [unscheduledOnly, focusedRowKey, model])
  // "Show all tasks" in the empty-filter overlay: the overlay and (at a count of 0) the toggle
  // both go away, so focus moves to the first row in view instead of falling to <body>.
  const focusRowAfterShowAll = useRef(false)
  const showAllTasks = useEvent(() => {
    focusRowAfterShowAll.current = true
    changeUnscheduledOnly(false)
  })
  useEffect(() => {
    if (unscheduledOnly || !focusRowAfterShowAll.current) return
    focusRowAfterShowAll.current = false
    const scroller = scrollerRef.current
    if (!scroller) return
    // Below the sticky time header, i.e. a row the user can see.
    const top = scroller.getBoundingClientRect().top + HEADER_HEIGHT - 1
    const firstInView = [...scroller.querySelectorAll<HTMLElement>('[data-row-key]')]
      .map((row) => ({ row, y: row.getBoundingClientRect().top }))
      .filter(({ y }) => y >= top)
      .sort((a, b) => a.y - b.y)[0]?.row
    firstInView?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
  }, [unscheduledOnly])

  const expandAndReveal = useEvent((taskId: string) => {
    const task = Object.hasOwn(data.tasks, taskId) ? data.tasks[taskId] : undefined
    if (!task) return
    const parent =
      task.parentTaskId && Object.hasOwn(data.tasks, task.parentTaskId)
        ? data.tasks[task.parentTaskId]
        : undefined
    onToggleRow(groupKeyForPhaseId((parent ?? task).phaseId), false)
    if (parent) onToggleRow(taskRowKey(parent.id), false)
    revealRow(taskRowKey(taskId))
  })
  /** A task the filter hides: the filter goes off first, then the reveal runs on the full model. */
  const revealAfterFilterOff = useRef<string | null>(null)
  const revealTask = useEvent((taskId: string) => {
    if (unscheduledOnly && !latest.current.model.taskRowIndex.has(taskId)) {
      revealAfterFilterOff.current = taskId
      changeUnscheduledOnly(false)
      return
    }
    expandAndReveal(taskId)
  })
  useEffect(() => {
    const taskId = revealAfterFilterOff.current
    if (unscheduledOnly || !taskId) return
    revealAfterFilterOff.current = null
    expandAndReveal(taskId)
  }, [unscheduledOnly, expandAndReveal])

  /**
   * Keyboard focus must never land behind the sticky outline or time header. The browser only
   * scrolls an element into the scroll PORT, and both sticky layers cover part of it, so a bar
   * reached with Tab could sit entirely under the outline with its focus ring invisible. (CSS
   * scroll-padding would also move the sticky outline's own buttons, hence this.) Pointer focus is
   * left alone: the bar under the cursor must not jump while it is being pressed.
   */
  const keepFocusVisible = useEvent((target: Element) => {
    const scroller = scrollerRef.current
    if (!scroller || !target.isConnected || !target.matches(':focus-visible')) return
    const area = scroller.getBoundingClientRect()
    const box = target.getBoundingClientRect()
    const top = area.top + HEADER_HEIGHT
    if (box.top < top) scroller.scrollTop -= top - box.top
    if (target.closest('[data-handle="lane"]')) {
      const left = area.left + latest.current.paneWidth
      // Show the whole bar right of the outline (a very long one: its last half screen).
      const needed = Math.min(box.width + 8, (area.right - left) / 2)
      if (box.right - left < needed) scroller.scrollLeft -= left + needed - box.right
    }
  })

  // ---- opening things ------------------------------------------------------
  const openTask = useEvent((taskId: string) => openTaskRoute(taskId))
  const openMilestone = useEvent((milestoneId: string) =>
    openMilestoneDialog({ mode: 'edit', milestoneId }),
  )

  // ---- writes ----------------------------------------------------------------
  const holdPending = (rowKey: string, entry: Omit<PendingOverride, 'token'>): number => {
    pendingSeq.current += 1
    const token = pendingSeq.current
    setPending((previous) => ({ ...previous, [rowKey]: { ...entry, token } }))
    return token
  }
  const releasePending = (rowKey: string, token: number) =>
    setPending((previous) =>
      previous[rowKey]?.token === token ? omit(previous, rowKey) : previous,
    )

  /** Task dates go through the planner (Manual warns / Auto previews), like every other view. */
  const commitTaskDates = useEvent(
    async (
      taskId: string,
      rowKey: string,
      dates: DragDates,
      origin: DragDates,
      how: 'drag' | 'draw' | 'keyboard',
    ) => {
      const change = toScheduleChange(taskId, dates)
      if (!change) {
        notify.error("Couldn't change dates", {
          description: 'That date is outside the supported calendar.',
        })
        return
      }
      // Held until the planner settles: the store has the new dates in the same tick (Manual),
      // or the Auto preview is open; a cancelled or failed write lets the bar return.
      const token = holdPending(rowKey, { taskId, dates, origin, mode: null })
      let outcome: PlanOutcome
      let record: ScheduleWriteRecord | null = null
      try {
        outcome = await planScheduleChangeDetailed(change, {
          source: 'gantt',
          onWritten: (written) => {
            record = written
          },
        })
      } finally {
        releasePending(rowKey, token)
      }
      if (outcome.status === 'invalid') {
        notify.error("Couldn't change dates", { description: outcome.error.message })
      } else if (outcome.status === 'written') {
        const title = latest.current.tasksById[taskId]?.title ?? 'Task'
        const label = datesLabel(dates, today)
        setAnnouncement(`${title}: ${label}`)
        // In filter mode the drawn task leaves the list: there is no row left to reveal.
        if (how === 'draw' && !unscheduledOnly) revealRow(rowKey)
        const written = record as ScheduleWriteRecord | null // set by onWritten above
        if (written) {
          announceDateChange({
            kind: classifyDateChange(origin, dates),
            title,
            label,
            record: written,
            today,
          })
        }
      }
    },
  )

  /** Milestones are not tasks: their date changes through updateMilestone. */
  const commitMilestone = useEvent(
    async (milestoneId: string, rowKey: string, day: number, originDay: number | null) => {
      const date = tryFromEpochDay(day)
      if (!date) return
      const token = holdPending(rowKey, {
        taskId: null,
        dates: { start: day, end: null },
        origin: { start: originDay, end: null },
        mode: null,
      })
      const result = await actions.updateMilestone(milestoneId, { date })
      releasePending(rowKey, token)
      if (!result.ok) {
        // Remote failures were toasted (with Retry) and rolled back by the store.
        if (result.error.kind === 'validation') {
          notify.error("Couldn't move the milestone", { description: result.error.message })
        }
        return
      }
      const name = Object.hasOwn(data.milestones, milestoneId)
        ? data.milestones[milestoneId].name
        : 'Milestone'
      setAnnouncement(`${name}: ${formatDateRange(date, date, today)}`)
    },
  )

  const changeMode = useEvent(async (mode: ScheduleMode) => {
    if (mode === project.scheduleMode) return
    const result = await actions.updateProject(project.id, { scheduleMode: mode })
    if (!result.ok) {
      if (result.error.kind === 'validation') {
        notify.error("Couldn't change how dependencies are handled", {
          description: result.error.message,
        })
      }
      return
    }
    if (mode === 'auto' && conflicts.length > 0) {
      notify.info('Auto scheduling is on', {
        description: `${plural(conflicts.length, 'existing conflict')} ${
          conflicts.length === 1 ? 'stays until you resolve it' : 'stay until you resolve them'
        }.`,
        action: { label: 'Review', onClick: () => void reviewConflicts(project.id) },
      })
    }
  })

  // Stable toolbar callbacks (the toolbar is memoised; the chart re-renders while scrolling).
  const onScheduleModeChange = useEvent((mode: ScheduleMode) => void changeMode(mode))
  const onOpenConflict = useEvent((successorId: string) => {
    revealTask(successorId)
    openTask(successorId)
  })
  const onResolveAll = useEvent(() => void reviewConflicts(project.id))

  const removeSelected = useEvent(async () => {
    const id = selectedDep
    if (!id || !Object.hasOwn(data.dependencies, id)) return
    const dependency = data.dependencies[id]
    const title = (taskId: string) =>
      Object.hasOwn(data.tasks, taskId) ? data.tasks[taskId].title : 'Task'
    setSelectedDep(null)
    const result = await actions.removeDependency(id)
    if (!result.ok) {
      if (result.error.kind === 'validation') {
        notify.error("Couldn't remove the dependency", { description: result.error.message })
      }
      return
    }
    const label = `${title(dependency.predecessorId)} → ${title(dependency.successorId)}`
    setAnnouncement(`Dependency removed: ${label}`)
    notify.success('Dependency removed', {
      description: label,
      action: {
        label: 'Undo',
        onClick: () =>
          void actions
            .addDependency(dependency.predecessorId, dependency.successorId)
            .then((undo) => {
              if (!undo.ok && undo.error.kind === 'validation') {
                notify.error("Couldn't restore the dependency", {
                  description: undo.error.message,
                })
              }
            }),
      },
    })
    // Keep keyboard users in the chart: focus the successor's bar when it is rendered.
    scrollerRef.current
      ?.querySelector<HTMLElement>(
        `[data-link-target][data-task-id="${CSS.escape(dependency.successorId)}"]`,
      )
      ?.focus({ preventScroll: true })
  })

  useHotkeys(['delete', 'backspace'], () => void removeSelected(), {
    enabled: selectedDep !== null,
    description: 'Remove selected dependency',
    group: 'Current view',
  })
  useHotkeys('escape', () => setSelectedDep(null), { enabled: selectedDep !== null })
  useEffect(() => {
    // Deleted, collapsed away or scrolled out of the rendered rows: Delete must not remove a line
    // the user can no longer see.
    if (selectedDep && !links.some((link) => link.id === selectedDep)) setSelectedDep(null)
  }, [selectedDep, links])
  useEffect(() => {
    if (selectedDep) removeButtonRef.current?.focus({ preventScroll: true })
  }, [selectedDep])

  // ---- pointer machine -------------------------------------------------------
  const sampleAt = (clientX: number, clientY: number, rect: DOMRect): PointerSample => {
    const el = scrollerRef.current
    const { geometry: g, paneWidth: pw } = latest.current
    const x = clientX - rect.left - pw + (el?.scrollLeft ?? 0)
    return { clientX, clientY, dayFloat: g.originDay + x / g.dayWidth }
  }

  const findLinkTarget = (it: LinkInteraction) => {
    const hit = document.elementFromPoint(it.clientX, it.clientY)
    let taskId = hit?.closest('[data-link-target]')?.getAttribute('data-task-id') ?? null
    if (!taskId) {
      // Anywhere in the row's lane counts, as long as the task has a bar or marker.
      const lane = hit?.closest('[data-handle="lane"]')
      const row = lane ? latest.current.rows[Number(lane.getAttribute('data-row-index'))] : null
      if (row?.kind === 'task' && row.span.kind !== 'unscheduled') taskId = row.task.id
      else if (row?.kind === 'task' && row.task.id !== it.sourceId) {
        // No bar to land on: a task without dates cannot be linked on the chart. Say so (the Task
        // Modal's Dependencies section links it) instead of silently ignoring the drop.
        it.target = { taskId: row.task.id, valid: false, message: UNSCHEDULED_LINK_MESSAGE }
        return
      }
    }
    // Over the source's own dots (where the drag began) or its row there is nothing to say yet;
    // over its own bar the drop would link a task to itself, which `validateNewDependency` refuses
    // with a message ("A task can't depend on itself.") like every other invalid target.
    const overOwnBar =
      taskId === it.sourceId &&
      hit?.closest('[data-link-target]') != null &&
      hit.closest('[data-handle^="link-"]') === null
    if (!taskId || (taskId === it.sourceId && !overOwnBar)) {
      it.target = null
      return
    }
    if (it.target?.taskId === taskId) return
    const { tasksById, dependencies: deps } = latest.current
    const [predecessorId, successorId] =
      it.side === 'out' ? [it.sourceId, taskId] : [taskId, it.sourceId]
    const verdict = validateNewDependency(tasksById, deps, predecessorId, successorId)
    it.target = { taskId, valid: verdict.ok, message: verdict.ok ? null : verdict.message }
  }

  const publish = (it: Interaction) => {
    if (it.kind === 'drag') {
      const { state } = it
      if (state.phase !== 'dragging') return
      setDragView((previous) => {
        const unchangedDates =
          previous?.rowKey === it.rowKey && sameDates(previous.override.dates, state.preview)
        if (unchangedDates && previous.clientX === it.clientX && previous.clientY === it.clientY) {
          return previous
        }
        return {
          rowKey: it.rowKey,
          rowIndex: it.rowIndex,
          subject: it.subject,
          clientX: it.clientX,
          clientY: it.clientY,
          override: unchangedDates
            ? previous.override
            : {
                dates: state.preview,
                origin: { start: state.origin.start, end: state.origin.end },
                mode: state.origin.mode,
              },
        }
      })
      return
    }
    const el = scrollerRef.current
    if (!el) return
    const to = {
      x: it.clientX - it.rect.left + el.scrollLeft,
      y: it.clientY - it.rect.top + el.scrollTop - HEADER_HEIGHT,
    }
    setLinkDraft({
      rowKey: it.rowKey,
      sourceId: it.sourceId,
      side: it.side,
      to,
      target: it.target,
      clientX: it.clientX,
      clientY: it.clientY,
    })
  }

  /** One animation frame: auto-scroll near the edges, then re-sample and publish. */
  const tick = useEvent(() => {
    rafRef.current = 0
    const it = interactionRef.current
    const el = scrollerRef.current
    if (!it || !el) return
    if (it.kind === 'drag' && it.state.phase !== 'dragging') return
    it.rect = el.getBoundingClientRect()
    const pw = latest.current.paneWidth
    const dx = autoScrollStep(it.clientX, it.rect.left + pw, it.rect.left + el.clientWidth)
    const dy =
      it.kind === 'link'
        ? autoScrollStep(it.clientY, it.rect.top + HEADER_HEIGHT, it.rect.top + el.clientHeight)
        : 0
    if (dx !== 0) el.scrollLeft += dx
    if (dy !== 0) el.scrollTop += dy
    if (it.kind === 'drag')
      it.state = updateDrag(it.state, sampleAt(it.clientX, it.clientY, it.rect))
    else findLinkTarget(it)
    publish(it)
    if (dx !== 0 || dy !== 0) rafRef.current = requestAnimationFrame(tick)
  })
  const requestTick = () => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(tick)
  }

  const onWindowKeyDown = useEvent((event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !interactionRef.current) return
    // Esc cancels the drag (and nothing else: the event stops here).
    event.preventDefault()
    event.stopPropagation()
    endInteraction(true)
  })
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      window.removeEventListener('keydown', onWindowKeyDown, true)
    },
    [onWindowKeyDown],
  )

  const beginInteraction = (it: Interaction) => {
    interactionRef.current = it
    try {
      scrollerRef.current?.setPointerCapture(it.pointerId)
    } catch {
      // The pointer is already gone; the interaction ends with the next pointer event.
    }
    window.addEventListener('keydown', onWindowKeyDown, true)
  }

  const activate = (subject: Subject) => {
    if (subject.type === 'task') openTask(subject.id)
    else openMilestone(subject.id)
  }

  const finishLink = useEvent(async (it: LinkInteraction) => {
    const target = it.target
    if (!target) return
    if (!target.valid) {
      notify.warning("Can't add this dependency", { description: target.message ?? undefined })
      return
    }
    const [predecessorId, successorId] =
      it.side === 'out' ? [it.sourceId, target.taskId] : [target.taskId, it.sourceId]
    const result = await actions.addDependency(predecessorId, successorId)
    if (!result.ok) {
      if (result.error.kind === 'validation') {
        notify.warning("Can't add this dependency", { description: result.error.message })
      }
      return
    }
    const title = (taskId: string) => latest.current.tasksById[taskId]?.title ?? 'Task'
    setAnnouncement(`Dependency added: ${title(predecessorId)} → ${title(successorId)}`)
    // Already violated? Auto previews the shifts, Manual warns — same rule as the Task Modal.
    void reviewNewDependency(result.value.id)
  })

  const endInteraction = useEvent((cancelled: boolean) => {
    const it = interactionRef.current
    if (!it) return
    interactionRef.current = null
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
    window.removeEventListener('keydown', onWindowKeyDown, true)
    const el = scrollerRef.current
    try {
      if (el?.hasPointerCapture(it.pointerId)) el.releasePointerCapture(it.pointerId)
    } catch {
      // ignore: capture already released
    }
    if (it.kind === 'link') {
      setLinkDraft(null)
      if (!cancelled) void finishLink(it)
      return
    }
    setDragView(null)
    if (cancelled) return
    const { state } = it
    if (isClick(state)) {
      if (state.origin.mode !== 'draw') activate(it.subject)
      return
    }
    if (!hasDateChange(state)) return
    if (it.subject.type === 'milestone') {
      if (state.preview.start !== null) {
        void commitMilestone(it.subject.id, it.rowKey, state.preview.start, state.origin.start)
      }
      return
    }
    void commitTaskDates(
      it.subject.id,
      it.rowKey,
      state.preview,
      { start: state.origin.start, end: state.origin.end },
      state.origin.mode === 'draw' ? 'draw' : 'drag',
    )
  })

  const dragOriginFor = (row: GanttRow, handle: string): DragOrigin | null => {
    if (row.kind === 'milestone') {
      return handle === 'point' && row.day !== null
        ? { mode: 'point', start: row.day, end: null }
        : null
    }
    if (row.kind !== 'task') return null
    if (handle === 'lane') return row.drawable ? { mode: 'draw', start: null, end: null } : null
    if (!DRAG_HANDLES.has(handle) || row.span.kind === 'unscheduled') return null
    return { mode: handle as DragMode, start: row.span.start, end: row.span.end }
  }

  const onPointerDown = useEvent((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || interactionRef.current) return
    const el = scrollerRef.current
    if (!el) return
    const handleEl = (event.target as Element).closest('[data-handle]')
    const handle = handleEl?.getAttribute('data-handle') ?? null
    if (handle !== 'dep') setSelectedDep(null)
    // ⌃-click is the context menu on macOS; ⌘-click is not a drag.
    if (!handleEl || !handle || event.ctrlKey || event.metaKey) return
    if (handle === 'dep') {
      const id = handleEl.getAttribute('data-dep-id')
      if (id) setSelectedDep(id)
      event.preventDefault()
      return
    }
    // Handles inside a bar (resize grips) carry no index themselves: the bar / row does.
    const rowIndex = Number(handleEl.closest('[data-row-index]')?.getAttribute('data-row-index'))
    const row = Number.isInteger(rowIndex) ? latest.current.rows[rowIndex] : undefined
    if (!row) return
    const rect = el.getBoundingClientRect()
    if (handle === 'link-in' || handle === 'link-out') {
      if (row.kind !== 'task') return
      event.preventDefault()
      beginInteraction({
        kind: 'link',
        pointerId: event.pointerId,
        rowKey: row.key,
        sourceId: row.task.id,
        side: handle === 'link-out' ? 'out' : 'in',
        rect,
        clientX: event.clientX,
        clientY: event.clientY,
        target: null,
      })
      requestTick()
      return
    }
    const origin = dragOriginFor(row, handle)
    if (!origin) return
    beginInteraction({
      kind: 'drag',
      pointerId: event.pointerId,
      rowKey: row.key,
      rowIndex,
      subject:
        row.kind === 'milestone'
          ? { type: 'milestone', id: row.milestone.id }
          : { type: 'task', id: (row as TaskRow).task.id },
      state: startDrag(origin, sampleAt(event.clientX, event.clientY, rect)),
      rect,
      clientX: event.clientX,
      clientY: event.clientY,
    })
  })

  const onPointerMove = useEvent((event: ReactPointerEvent<HTMLDivElement>) => {
    const it = interactionRef.current
    if (!it || event.pointerId !== it.pointerId) return
    it.clientX = event.clientX
    it.clientY = event.clientY
    it.rect = scrollerRef.current?.getBoundingClientRect() ?? it.rect
    if (it.kind === 'drag') {
      it.state = updateDrag(it.state, sampleAt(event.clientX, event.clientY, it.rect))
      if (it.state.phase !== 'dragging') return
    }
    requestTick()
  })

  const onPointerUp = useEvent((event: ReactPointerEvent<HTMLDivElement>) => {
    const it = interactionRef.current
    if (!it || event.pointerId !== it.pointerId) return
    it.clientX = event.clientX
    it.clientY = event.clientY
    it.rect = scrollerRef.current?.getBoundingClientRect() ?? it.rect
    if (it.kind === 'drag')
      it.state = updateDrag(it.state, sampleAt(event.clientX, event.clientY, it.rect))
    else findLinkTarget(it)
    endInteraction(false)
  })

  const onPointerCancel = useEvent((event: ReactPointerEvent<HTMLDivElement>) => {
    if (interactionRef.current?.pointerId === event.pointerId) endInteraction(true)
  })

  /**
   * Double-click an empty lane of an undated task: a one-day task on that day. Listened to on the
   * scroller: with pointer capture there, the (dbl)click targets the scroller, not the lane.
   */
  const onDoubleClick = useEvent((event: ReactMouseEvent<HTMLDivElement>) => {
    const hit = document.elementFromPoint(event.clientX, event.clientY)
    const lane = hit?.closest('[data-handle="lane"]')
    const el = scrollerRef.current
    if (!lane || !el) return
    const row = latest.current.rows[Number(lane.getAttribute('data-row-index'))]
    if (row?.kind !== 'task' || !row.drawable) return
    const day = Math.floor(
      sampleAt(event.clientX, event.clientY, el.getBoundingClientRect()).dayFloat,
    )
    void commitTaskDates(
      row.task.id,
      row.key,
      { start: day, end: day },
      { start: null, end: null },
      'draw',
    )
  })

  /** A bar wider than the view, still in it after a nudge: its far edge must not pull the view. */
  const wideBarInView = (dates: DragDates): boolean => {
    const el = scrollerRef.current
    if (!el || dates.start === null || dates.end === null) return false
    const { geometry: g, paneWidth: pw } = latest.current
    const visible = Math.max(0, el.clientWidth - pw)
    const left = dayToX(dates.start, g)
    const right = dayToX(dates.end + 1, g)
    return right - left >= visible && left < el.scrollLeft + visible && right > el.scrollLeft
  }

  const onBarKeyDown = useEvent((event: ReactKeyboardEvent<HTMLElement>, row: GanttRow) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (row.kind === 'task') openTask(row.task.id)
      else if (row.kind === 'milestone') openMilestone(row.milestone.id)
      return
    }
    const nudge = nudgeFromKey(event)
    if (!nudge) return
    event.preventDefault()
    if (row.kind === 'task') {
      const next = nudgeSpan(row.span, nudge)
      if (!next) {
        setAnnouncement(
          nudge.kind === 'resize-end' && row.span.end === null
            ? `${row.task.title} has no due date to change.`
            : `${row.task.title} can't end before it starts.`,
        )
        return
      }
      // The bar must not slide under the sticky outline or off the edge while it is nudged: follow
      // the edge that moves (instant, so a held key does not queue up smooth scrolls).
      const edge =
        nudge.kind === 'resize-end' || nudge.delta > 0
          ? (next.end ?? next.start)
          : (next.start ?? next.end)
      if (edge !== null && !(nudge.kind === 'move' && wideBarInView(next))) {
        scrollDayIntoView(edge, false)
      }
      void commitTaskDates(
        row.task.id,
        row.key,
        next,
        { start: row.span.start, end: row.span.end },
        'keyboard',
      )
    } else if (row.kind === 'milestone' && row.day !== null && nudge.kind === 'move') {
      scrollDayIntoView(row.day + nudge.delta, false)
      void commitMilestone(row.milestone.id, row.key, row.day + nudge.delta, row.day)
    }
  })

  // ---- render ----------------------------------------------------------------
  const linkSourceRowIndex = linkDraft ? (model.rowIndexByKey.get(linkDraft.rowKey) ?? -1) : -1
  const linkSourceRow = linkSourceRowIndex >= 0 ? rows[linkSourceRowIndex] : null
  let linkFrom: Point | null = null
  if (linkDraft && linkSourceRow?.kind === 'task') {
    const override = overrideOf(linkSourceRow)
    const anchors = spanAnchors(override ? daySpanOf(override.dates) : linkSourceRow.span, geometry)
    if (anchors) {
      linkFrom = {
        x: paneWidth + (linkDraft.side === 'out' ? anchors.outX : anchors.inX),
        y: rowCenterY(linkSourceRowIndex),
      }
    }
  }

  const title = (taskId: string) =>
    Object.hasOwn(data.tasks, taskId) ? data.tasks[taskId].title : 'Task'
  let linkTooltip: { text: string; tone: 'default' | 'danger' } | null = null
  if (linkDraft) {
    const target = linkDraft.target
    if (!target) linkTooltip = { text: 'Drop on a task to add a dependency', tone: 'default' }
    else if (!target.valid)
      linkTooltip = { text: target.message ?? "Can't link these", tone: 'danger' }
    else {
      const [predecessorId, successorId] =
        linkDraft.side === 'out'
          ? [linkDraft.sourceId, target.taskId]
          : [target.taskId, linkDraft.sourceId]
      linkTooltip = { text: `${title(predecessorId)} → ${title(successorId)}`, tone: 'default' }
    }
  }
  const dragTip = dragView
    ? dragTooltip(
        dragView.override.mode ?? 'move',
        dragView.override.dates,
        dragView.override.origin,
        today,
        dragView.subject.type === 'milestone',
      )
    : null

  const nothingScheduled =
    !unscheduledOnly && model.scheduledTaskCount === 0 && milestones.length === 0
  const noUnscheduledTasks = unscheduledOnly && rows.length === 0

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ViewBarActions>
        <GanttToolbar
          scale={scale}
          onScaleChange={changeScale}
          onToday={scrollToToday}
          scheduleMode={project.scheduleMode}
          onScheduleModeChange={onScheduleModeChange}
          conflicts={conflicts}
          tasksById={data.tasks}
          today={today}
          onOpenConflict={onOpenConflict}
          onResolveAll={onResolveAll}
          unscheduledCount={model.unscheduledCount}
          unscheduledOnly={unscheduledOnly}
          onUnscheduledOnlyChange={changeUnscheduledOnly}
          registerUnscheduledToggle={registerUnscheduledToggle}
        />
      </ViewBarActions>

      <div
        ref={scrollerRef}
        role="region"
        aria-label="Gantt chart"
        className="relative isolate min-h-0 flex-1 overflow-auto overscroll-contain border-t border-subtle bg-(--gantt-bg)"
        onScroll={() => {
          syncScroll()
          // A wheel or Today scroll mid-drag changes the day under a still pointer.
          if (interactionRef.current) requestTick()
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        onDoubleClick={onDoubleClick}
      >
        <div
          className="relative"
          style={{ width: contentWidth, height: HEADER_HEIGHT + bodyHeight }}
        >
          <TimeHeader
            tiers={tiers}
            scale={scale}
            geometry={geometry}
            scroll={scrollPosition}
            paneWidth={paneWidth}
            timelineWidth={timelineWidth}
            todayX={dayCenterX(todayDay, geometry)}
            todayLabel={formatDate(today, 'short')}
          />
          <div
            className="relative select-none"
            style={{ width: contentWidth, height: bodyHeight, ...bandVars }}
            onPointerDown={onPointerDown}
            onFocus={(event) => {
              const target = event.target as Element
              setFocusedRowKey(
                target.closest('[data-row-key]')?.getAttribute('data-row-key') ?? null,
              )
              // After the browser's own focus scroll.
              requestAnimationFrame(() => keepFocusVisible(target))
            }}
            onBlur={(event) => {
              const next = event.relatedTarget as Element | null
              if (!next || !event.currentTarget.contains(next)) setFocusedRowKey(null)
            }}
          >
            {/* Opaque outline column below the last row (rows paint their own cells). */}
            <div
              aria-hidden
              className="sticky left-0 z-[10] bg-(--gantt-bg)"
              style={{ width: paneWidth, height: bodyHeight }}
            />
            <GridBackground
              style={gridStyle}
              lines={lines}
              left={paneWidth}
              width={timelineWidth}
              height={bodyHeight}
            />
            <TodayLine x={paneWidth + dayCenterX(todayDay, geometry)} height={bodyHeight} />
            <LinkLayer
              links={links}
              selectedId={selectedDep}
              emphasizedTaskId={dragView?.subject.type === 'task' ? dragView.subject.id : null}
              offsetLeft={paneWidth}
              box={linkBox}
            />
            {items.map((item) => {
              const row = rows[item.index]
              if (!row) return null
              const taskId = row.kind === 'task' ? row.task.id : null
              const linkTarget =
                taskId && linkDraft?.target?.taskId === taskId ? linkDraft.target : null
              return (
                <GanttRowView
                  key={row.key}
                  row={row}
                  index={item.index}
                  geometry={geometry}
                  paneWidth={paneWidth}
                  timelineWidth={timelineWidth}
                  today={today}
                  todayDay={todayDay}
                  override={overrideOf(row)}
                  preview={taskId ? (previews.get(taskId) ?? null) : null}
                  conflict={taskId ? (messages.get(taskId) ?? null) : null}
                  linkState={linkTarget ? (linkTarget.valid ? 'valid' : 'invalid') : null}
                  linkSource={taskId !== null && linkDraft?.sourceId === taskId}
                  selected={
                    taskId
                      ? taskId === selectedTaskId
                      : row.kind === 'milestone' && row.milestone.id === editingMilestoneId
                  }
                  upcomingMilestone={
                    row.kind === 'milestone' && row.milestone.id === upcomingMilestoneId
                  }
                  describedBy={helpId}
                  hue={hueOf(row)}
                  projectColor={project.color}
                  onPhaseColor={onPhaseColor}
                  onToggle={onToggleRow}
                  onOpenTask={openTask}
                  onOpenMilestone={openMilestone}
                  onBarKeyDown={onBarKeyDown}
                />
              )
            })}
            {selectedLink ? (
              <button
                ref={removeButtonRef}
                type="button"
                aria-label={`Remove dependency: ${title(selectedLink.predecessorId)} → ${title(selectedLink.successorId)}`}
                title="Remove dependency (Delete)"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => void removeSelected()}
                className="absolute z-[6] flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-default bg-elevated text-fg-secondary shadow-popover hover:border-strong hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                style={{
                  left: paneWidth + selectedLink.route.mid.x,
                  top: selectedLink.route.mid.y,
                }}
              >
                <X className="size-3" strokeWidth={2.25} aria-hidden />
              </button>
            ) : null}
            {linkDraft && linkFrom ? (
              <LinkDraftLine
                from={linkFrom}
                to={linkDraft.to}
                left={0}
                valid={linkDraft.target ? linkDraft.target.valid : null}
              />
            ) : null}
          </div>
        </div>
      </div>

      <PaneResizer
        width={paneWidth}
        onResize={setPaneWidth}
        onCommit={commitPaneWidth}
        scrolled={scrolledX}
      />

      {nothingScheduled ? (
        <div
          className="pointer-events-none absolute right-4 z-30 flex justify-center"
          style={{
            left: paneWidth + 16,
            top: Math.min(
              HEADER_HEIGHT + rows.length * ROW_HEIGHT + 24,
              Math.max(HEADER_HEIGHT + 16, viewport.height - 72),
            ),
          }}
        >
          <p className="flex items-center gap-2 rounded-lg border border-default bg-elevated px-3 py-2 text-ui text-fg-secondary shadow-popover">
            <CalendarRange className="size-4 shrink-0 text-fg-tertiary" aria-hidden />
            <span>
              <span className="font-medium text-fg">Drag across a row to schedule it</span> — or
              double-click a row for a one-day task.
            </span>
          </p>
        </div>
      ) : null}

      {noUnscheduledTasks ? (
        <div
          className="pointer-events-none absolute right-4 z-30 flex justify-center"
          style={{ left: paneWidth + 16, top: HEADER_HEIGHT + 24 }}
        >
          <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-default bg-elevated px-3 py-2 text-ui text-fg-secondary shadow-popover">
            <CalendarOff className="size-4 shrink-0 text-fg-tertiary" aria-hidden />
            <span className="font-medium text-fg">No tasks without dates</span>
            <Button size="xs" variant="secondary" onClick={showAllTasks}>
              Show all tasks
            </Button>
          </div>
        </div>
      ) : null}

      {dragView && dragTip ? (
        <DragTooltip
          clientX={dragView.clientX}
          clientY={dragView.clientY}
          text={dragTip.text}
          detail={dragTip.detail}
        />
      ) : null}
      {linkDraft && linkTooltip ? (
        <DragTooltip
          clientX={linkDraft.clientX}
          clientY={linkDraft.clientY}
          text={linkTooltip.text}
          tone={linkTooltip.tone}
        />
      ) : null}

      <p id={helpId} className="sr-only">
        Enter opens it. Alt+Left or Alt+Right moves it by one day; Alt+Shift+Left or Alt+Shift+Right
        changes its due date. Dependencies can also be edited in the task.
      </p>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  )
}
