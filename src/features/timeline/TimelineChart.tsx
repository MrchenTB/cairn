/**
 * The cross-project chart, on the Gantt's engine: one scroll container with the sticky time header
 * and resizable pane, rows virtualised with @tanstack/react-virtual, the Gantt's grid, today line
 * and bars. Dates are read-only here (V1): a click or Enter opens the task or milestone, and the
 * project's Gantt is one click away.
 */
import {
  memo,
  useCallback,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { Link } from 'react-router'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { ChartGantt } from 'lucide-react'
import { useViewShortcut } from '@/app/shortcuts'
import { useOpenTask, useTaskParam } from '@/app/taskModalRoute'
import { useUIStore } from '@/app/uiStore'
import { useGanttScale, type GanttScale } from '@/app/viewPrefs'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Label } from '@/components/ui/label'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { formatDate, toEpochDay } from '@/domain/dates'
import { findConflicts } from '@/domain/scheduling'
import type { ISODate, WorkspaceData } from '@/domain/types'
import { GanttRowView } from '@/features/gantt/components/GanttRow'
import { PaneResizer } from '@/features/gantt/components/PaneResizer'
import { GridBackground, TimeHeader, TodayLine } from '@/features/gantt/components/TimeAxis'
import { usePaneWidth } from '@/features/gantt/ganttPrefs'
import { DUE_COLUMN_WIDTH, HEADER_HEIGHT, ROW_OVERSCAN } from '@/features/gantt/model/constants'
import { conflictMessages } from '@/features/gantt/model/conflicts'
import { dayCenterX, dayToX } from '@/features/gantt/model/geometry'
import type { GanttRow } from '@/features/gantt/model/rows'
import {
  SCALES,
  buildHeaderTiers,
  gridBackgroundStyle,
  weekendBandVars,
  gridLines,
} from '@/features/gantt/model/scale'
import { nextMilestoneIds, rowHeightOf, type TimelineRowModel } from './model/rows'
import { ProjectRowView, UnscheduledSection } from './ProjectRow'
import { useEvent, useTimelineViewport } from './useTimelineViewport'

/** The Gantt's scale persists per project; this page has its own scope. */
const SCALE_SCOPE = 'timeline'

const SCALE_OPTIONS = (['day', 'week', 'month'] as const).map((value) => ({
  value,
  label: SCALES[value].label,
}))

/** Child rows sit under their project's name (past its chevron). */
const CHILD_ROW_INDENT = 20

/** The today column is only worth tinting where a day is wider than the line itself. */
const TODAY_COLUMN_MIN_DAY_WIDTH = 16

/** Rows here never have a subtask chevron (see model/rows), so nothing calls this. */
const NO_SUBTASK_ROWS = () => {}

const PANE_HEADER = (
  <>
    <span>Project</span>
    <span className="text-right" style={{ width: DUE_COLUMN_WIDTH }}>
      Progress
    </span>
  </>
)

export interface TimelineChartProps {
  model: TimelineRowModel
  data: WorkspaceData
  today: ISODate
  weekStartsOn: 0 | 1
  includeCompleted: boolean
  onIncludeCompletedChange: (include: boolean) => void
  onToggleProject: (projectId: string) => void
}

export function TimelineChart({
  model,
  data,
  today,
  weekStartsOn,
  includeCompleted,
  onIncludeCompletedChange,
  onToggleProject,
}: TimelineChartProps) {
  const openTaskRoute = useOpenTask()
  const selectedTaskId = useTaskParam()
  const openMilestoneDialog = useUIStore((s) => s.openMilestoneDialog)
  const milestoneDialog = useUIStore((s) => s.milestoneDialog)
  const [scale, storeScale] = useGanttScale(SCALE_SCOPE)
  const [paneWidth, setPaneWidth, commitPaneWidth] = usePaneWidth()
  const helpId = useId()

  const { rows, bounds } = model
  const todayDay = toEpochDay(today)
  const {
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
  } = useTimelineViewport({ bounds, todayDay, scale, storeScale, weekStartsOn, paneWidth })
  const { dayWidth } = geometry
  const contentWidth = paneWidth + timelineWidth
  const bodyHeight = Math.max(model.totalHeight, viewport.height - HEADER_HEIGHT)

  useViewShortcut('t', scrollToToday, { description: 'Scroll to today' })

  // ---- virtual rows ----------------------------------------------------------
  /** Row holding keyboard focus: kept mounted, so scrolling never drops focus to <body>. */
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null)
  const focusedIndex = focusedRowKey ? rows.findIndex((row) => row.key === focusedRowKey) : -1
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range)
      if (focusedIndex < 0 || focusedIndex >= range.count || indexes.includes(focusedIndex)) {
        return indexes
      }
      return [...indexes, focusedIndex].sort((a, b) => a - b)
    },
    [focusedIndex],
  )
  // Row keys, not indexes: expanding a project changes which row (and height) an index means.
  const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows])
  // oxlint-disable-next-line react/incompatible-library -- no React Compiler here; rows are memoised by props, not by the virtualizer's functions
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (index) => rowHeightOf(rows[index]),
    getItemKey,
    overscan: ROW_OVERSCAN,
    scrollMargin: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    rangeExtractor,
  })

  // ---- derived view data -----------------------------------------------------
  const nextMilestones = useMemo(() => nextMilestoneIds(rows, today), [rows, today])
  /** Same warning as in the Gantt, for the tasks currently listed. */
  const conflicts = useMemo(() => {
    const expanded = new Set<string>()
    for (const row of rows) if (row.kind === 'project' && row.expanded) expanded.add(row.project.id)
    if (expanded.size === 0) return new Map<string, string>()
    const dependencies = Object.values(data.dependencies).filter((d) => expanded.has(d.projectId))
    return conflictMessages(findConflicts(data.tasks, dependencies), data.tasks, today)
  }, [rows, data.dependencies, data.tasks, today])

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
    () => weekendBandVars(scale, rangeStart, dayWidth) as CSSProperties,
    [scale, rangeStart, dayWidth],
  )
  const gridStyle = useMemo(
    () => gridBackgroundStyle(scale, rangeStart, dayWidth, weekStartsOn),
    [scale, rangeStart, dayWidth, weekStartsOn],
  )
  const editingMilestoneId = milestoneDialog?.mode === 'edit' ? milestoneDialog.milestoneId : null

  // ---- opening things ----------------------------------------------------------
  const openTask = useEvent((taskId: string) => openTaskRoute(taskId))
  const openMilestone = useEvent((milestoneId: string) =>
    openMilestoneDialog({ mode: 'edit', milestoneId }),
  )

  /** Bars carry their ids (the Gantt's convention); one listener handles them all. */
  const onBodyClick = useEvent((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as Element
    const bar = target.closest('[data-task-id], [data-milestone-id], [data-project-bar]')
    if (!bar) return
    const taskId = bar.getAttribute('data-task-id')
    const milestoneId = bar.getAttribute('data-milestone-id')
    const projectId = bar.getAttribute('data-project-bar')
    if (taskId) openTask(taskId)
    else if (milestoneId) openMilestone(milestoneId)
    else if (projectId) {
      // The chevron in the pane is the keyboard path to the same toggle.
      const expandable = rows.some(
        (row) => row.kind === 'project' && row.project.id === projectId && row.childCount > 0,
      )
      if (expandable) onToggleProject(projectId)
    }
  })

  const onBarKeyDown = useEvent((event: ReactKeyboardEvent<HTMLElement>, row: GanttRow) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    if (row.kind === 'task') openTask(row.task.id)
    else if (row.kind === 'milestone') openMilestone(row.milestone.id)
  })

  const onMilestoneKeyDown = useEvent(
    (event: ReactKeyboardEvent<HTMLElement>, milestoneId: string) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      openMilestone(milestoneId)
    },
  )

  return (
    <>
      <PageHeader
        title="Timeline"
        viewActions={
          <TimelineToolbar
            scale={scale}
            onScaleChange={changeScale}
            onToday={scrollToToday}
            completedCount={model.completedCount}
            includeCompleted={includeCompleted}
            onIncludeCompletedChange={onIncludeCompletedChange}
          />
        }
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollerRef}
          role="region"
          aria-label="Timeline of all projects"
          className="relative isolate min-h-0 flex-1 overflow-auto overscroll-contain border-t border-subtle bg-(--gantt-bg)"
          onScroll={onScroll}
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
              paneHeader={PANE_HEADER}
            />
            <div
              className="relative select-none"
              style={{ width: contentWidth, height: bodyHeight, ...bandVars }}
              onClick={onBodyClick}
              onFocus={(event) => {
                const key = (event.target as Element)
                  .closest('[data-row-key]')
                  ?.getAttribute('data-row-key')
                setFocusedRowKey(key ?? null)
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
              {dayWidth >= TODAY_COLUMN_MIN_DAY_WIDTH ? (
                <span
                  aria-hidden
                  data-today-column=""
                  className="pointer-events-none absolute top-0 z-0 bg-(--gantt-row-selected)"
                  style={{
                    left: paneWidth + dayToX(todayDay, geometry),
                    width: dayWidth,
                    height: bodyHeight,
                  }}
                />
              ) : null}
              <TodayLine x={paneWidth + dayCenterX(todayDay, geometry)} height={bodyHeight} />
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index]
                if (!row) return null
                const top = item.start - HEADER_HEIGHT
                if (row.kind === 'project') {
                  return (
                    <ProjectRowView
                      key={row.key}
                      row={row}
                      index={item.index}
                      top={top}
                      geometry={geometry}
                      paneWidth={paneWidth}
                      timelineWidth={timelineWidth}
                      scroll={scrollPosition}
                      today={today}
                      todayDay={todayDay}
                      nextMilestoneIds={nextMilestones}
                      describedBy={helpId}
                      onToggle={onToggleProject}
                      onMilestoneKeyDown={onMilestoneKeyDown}
                    />
                  )
                }
                if (row.kind === 'section') {
                  return (
                    <UnscheduledSection
                      key={row.key}
                      index={item.index}
                      top={top}
                      count={row.count}
                      paneWidth={paneWidth}
                      timelineWidth={timelineWidth}
                    />
                  )
                }
                const taskId = row.kind === 'task' ? row.task.id : null
                return (
                  <GanttRowView
                    key={row.key}
                    row={row}
                    index={item.index}
                    top={top}
                    indent={CHILD_ROW_INDENT}
                    readOnly
                    geometry={geometry}
                    paneWidth={paneWidth}
                    timelineWidth={timelineWidth}
                    today={today}
                    todayDay={todayDay}
                    override={null}
                    preview={null}
                    conflict={taskId ? (conflicts.get(taskId) ?? null) : null}
                    linkState={null}
                    linkSource={false}
                    selected={
                      taskId
                        ? taskId === selectedTaskId
                        : row.kind === 'milestone' && row.milestone.id === editingMilestoneId
                    }
                    upcomingMilestone={
                      row.kind === 'milestone' && nextMilestones.has(row.milestone.id)
                    }
                    describedBy={helpId}
                    onToggle={NO_SUBTASK_ROWS}
                    onOpenTask={openTask}
                    onOpenMilestone={openMilestone}
                    onBarKeyDown={onBarKeyDown}
                  />
                )
              })}
            </div>
          </div>
        </div>

        <PaneResizer
          width={paneWidth}
          onResize={setPaneWidth}
          onCommit={commitPaneWidth}
          scrolled={scrolledX}
          label="Resize project list"
        />

        {model.scheduledCount === 0 && model.firstProject ? (
          // Over the empty grid, on a solid surface so the today line never crosses the text.
          <div
            className="pointer-events-none absolute right-0 bottom-0 z-[15] flex justify-center overflow-hidden"
            style={{ left: paneWidth, top: HEADER_HEIGHT }}
          >
            <div className="mt-[12vh] h-fit rounded-xl border border-subtle bg-(--gantt-bg)">
              <EmptyState
                variant="inline"
                icon={ChartGantt}
                title="Nothing scheduled yet"
                description="Give a task or milestone a date and its project moves onto the timeline."
                action={
                  <Button
                    asChild
                    variant="secondary"
                    size="md"
                    className="pointer-events-auto max-w-[280px]"
                  >
                    <Link to={`/projects/${encodeURIComponent(model.firstProject.id)}/gantt`}>
                      <span className="truncate">Plan {model.firstProject.name}</span>
                    </Link>
                  </Button>
                }
              />
            </div>
          </div>
        ) : null}

        <p id={helpId} className="sr-only">
          Dates are read-only here. Press Enter to open it and edit its dates, or use the project's
          Gantt.
        </p>
      </div>
    </>
  )
}

interface TimelineToolbarProps {
  scale: GanttScale
  onScaleChange: (scale: GanttScale) => void
  onToday: () => void
  completedCount: number
  includeCompleted: boolean
  onIncludeCompletedChange: (include: boolean) => void
}

/** Controls in the view bar. Memoised: the chart re-renders on every virtual-row change. */
const TimelineToolbar = memo(function TimelineToolbar({
  scale,
  onScaleChange,
  onToday,
  completedCount,
  includeCompleted,
  onIncludeCompletedChange,
}: TimelineToolbarProps) {
  const switchId = useId()
  return (
    <>
      {/* Without completed projects the switch would do nothing. */}
      {completedCount > 0 ? (
        <div className="flex items-center gap-2 pr-1">
          <Switch
            id={switchId}
            checked={includeCompleted}
            onCheckedChange={onIncludeCompletedChange}
          />
          <Label htmlFor={switchId} className="text-ui">
            Include completed
            <span className="font-normal text-fg-tertiary tabular-nums">{completedCount}</span>
          </Label>
        </div>
      ) : null}
      <Tooltip content="Scroll to today" shortcut="t">
        <Button variant="ghost" size="sm" onClick={onToday}>
          Today
        </Button>
      </Tooltip>
      <SegmentedControl
        aria-label="Timeline scale"
        value={scale}
        onValueChange={onScaleChange}
        options={SCALE_OPTIONS}
      />
    </>
  )
})
