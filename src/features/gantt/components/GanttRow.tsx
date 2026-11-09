/**
 * One 32px Gantt row: the sticky outline cell (left) and its timeline lane (right). Memoized
 * with a content comparison of the row model, so a drag re-renders only the dragged row.
 */
import {
  memo,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { ChevronRight } from 'lucide-react'
import { DueLabel } from '@/components/task/DueLabel'
import { phaseColorLabel, PROJECT_COLOR_VAR } from '@/components/task/labels'
import { PhaseColorPopover } from '@/components/task/PhaseColorPicker'
import { ProjectDot } from '@/components/task/ProjectDot'
import { StatusIcon } from '@/components/task/StatusIcon'
import { insetFocus } from '@/components/ui/styles'
import { dueBucket } from '@/domain/buckets'
import {
  formatDate,
  formatDateRange,
  formatDateSmart,
  fromEpochDay,
  tryFromEpochDay,
} from '@/domain/dates'
import {
  resolvePhaseColor,
  type ISODate,
  type Phase,
  type PhaseColor,
  type ProjectColor,
} from '@/domain/types'
import { cn } from '@/lib/utils'
import { DUE_COLUMN_WIDTH, ROW_HEIGHT, SUBTASK_INDENT } from '../model/constants'
import type { DragDates, DragMode } from '../model/dragReducer'
import { dayCenterX, daySpanOf, dayToX, rangeRect, type TimelineGeometry } from '../model/geometry'
import { barAriaLabel, datesLabel } from '../model/labels'
import type { GanttRow, TaskRow } from '../model/rows'
import type { DayRange } from '../model/scale'
import {
  DragGhost,
  DrawPreview,
  DueMarker,
  MilestoneDiamond,
  PointGhost,
  RollupBracket,
  ScheduleGhost,
  StartMarker,
  SubtaskRollupLine,
  TaskBar,
  type LinkTargetState,
} from './bars'

/** Dates a row shows instead of the store's: a live drag, or a drop awaiting the planner. */
export interface RowOverride {
  dates: DragDates
  /** The drag in progress (null = dropped, waiting for the write / the preview dialog). */
  mode: DragMode | null
  /** Dates before the drag (for the dashed ghost). */
  origin: DragDates
}

/** Auto-schedule preview: where the open preview dialog would move this task. */
export interface RowPreview {
  dates: DragDates
  deltaDays: number
}

export interface GanttRowViewProps {
  row: GanttRow
  index: number
  geometry: TimelineGeometry
  paneWidth: number
  timelineWidth: number
  today: ISODate
  todayDay: number
  override: RowOverride | null
  preview: RowPreview | null
  conflict: string | null
  linkState: LinkTargetState
  linkSource: boolean
  /** The task / milestone open in the modal (row highlight). */
  selected: boolean
  upcomingMilestone: boolean
  describedBy: string
  onToggle: (key: string) => void
  onOpenTask: (taskId: string) => void
  onOpenMilestone: (milestoneId: string) => void
  onBarKeyDown: (event: ReactKeyboardEvent<HTMLElement>, row: GanttRow) => void
  /** Bars only open their task / milestone: no drag cursors, grips or dependency dots (Timeline). */
  readOnly?: boolean
  /** Vertical position when rows differ in height (default: index × ROW_HEIGHT). */
  top?: number
  /** Extra left padding of the outline cell, for rows nested under a parent row (Timeline). */
  indent?: number
  /**
   * The colour this row is drawn in (its phase's, else the project's). Unset = the default accent
   * tokens (Timeline rows).
   */
  hue?: ProjectColor
  /** Phase header rows: the project's colour (what "Use project color" shows) and the setter. */
  projectColor?: ProjectColor
  onPhaseColor?: (phase: Phase, color: PhaseColor | null) => void
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function iso(day: number | null): ISODate | null {
  return day === null ? null : tryFromEpochDay(day)
}

function rangeTitle(label: string, range: DayRange, today: ISODate): string {
  return `${label}: ${formatDateRange(fromEpochDay(range.start), fromEpochDay(range.end), today)}`
}

function MilestoneGlyph({ past }: { past: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      aria-hidden
      className={cn(
        'shrink-0',
        past ? 'text-(--gantt-milestone-past)' : 'text-(--gantt-milestone)',
      )}
    >
      <rect
        x="4"
        y="4"
        width="8"
        height="8"
        rx="1.5"
        transform="rotate(45 8 8)"
        fill={past ? 'none' : 'currentColor'}
        stroke={past ? 'currentColor' : 'none'}
        strokeWidth={1.5}
      />
    </svg>
  )
}

/*
 * The outline cell sticks to the left edge over the timeline, so its base is opaque; hover and
 * selection tint it with a background-image layer (under the content, never over the text).
 */
export const cellBase = 'sticky left-0 z-[11] flex h-full shrink-0 items-center'
export const cellSurface =
  'bg-(--gantt-bg) group-hover/row:bg-[linear-gradient(var(--gantt-row-hover),var(--gantt-row-hover))]'
const cellSelected =
  'bg-[linear-gradient(var(--gantt-row-selected),var(--gantt-row-selected))] shadow-[inset_2px_0_0_var(--accent)] group-hover/row:bg-[linear-gradient(var(--gantt-row-selected),var(--gantt-row-selected))]'
const chevron = (open: boolean) =>
  cn(
    'size-3.5 shrink-0 text-fg-tertiary motion-safe:transition-transform motion-safe:duration-fast',
    open && 'rotate-90',
  )

function GanttRowViewImpl(props: GanttRowViewProps) {
  const { row, index, paneWidth, timelineWidth, selected, top = index * ROW_HEIGHT } = props
  const header = row.kind === 'group'
  return (
    <div
      data-row-index={index}
      data-row-key={row.key}
      data-hue={props.hue}
      className={cn('group/row absolute left-0 flex', props.hue && 'gantt-tint')}
      style={{
        top,
        height: ROW_HEIGHT,
        width: paneWidth + timelineWidth,
        ...(props.hue
          ? ({ '--gantt-bar-hue': PROJECT_COLOR_VAR[props.hue] } as CSSProperties)
          : null),
      }}
    >
      <LeftCell {...props} />
      <div
        data-handle="lane"
        data-row-index={index}
        className={cn(
          'relative flex h-full shrink-0 items-center',
          // Phase header lanes are transparent: only the outline cell carries the
          // header tint, so the time grid runs unbroken through the whole chart.
          header
            ? null
            : selected
              ? 'bg-(--gantt-row-selected)'
              : 'group-hover/row:bg-(--gantt-row-hover)',
          row.kind === 'task' && row.drawable && 'cursor-crosshair touch-none',
        )}
        style={{ width: timelineWidth }}
      >
        <Lane {...props} />
      </div>
    </div>
  )
}

function LeftCell({
  row,
  paneWidth,
  today,
  todayDay,
  selected,
  indent = 0,
  onToggle,
  onOpenTask,
  onOpenMilestone,
  projectColor,
  onPhaseColor,
}: GanttRowViewProps) {
  if (row.kind === 'group') {
    const { label, phase } = row
    const count = row.taskCount
    // A phase's dot sits over the gap the toggle button leaves for it (pl-2 + px-1 + chevron + gap).
    const canColor = phase !== null && projectColor !== undefined && onPhaseColor !== undefined
    return (
      <div className={cn(cellBase, 'bg-muted pr-3 pl-2')} style={{ width: paneWidth }}>
        <button
          type="button"
          aria-expanded={!row.collapsed}
          aria-label={`${label}, ${plural(count, 'task')}`}
          onClick={() => onToggle(row.key)}
          className={cn(
            'flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left hover:bg-hover',
            insetFocus,
          )}
        >
          <ChevronRight className={chevron(!row.collapsed)} aria-hidden />
          {canColor ? <span className="w-2 shrink-0" aria-hidden /> : null}
          <span className="truncate text-meta font-semibold text-fg-secondary">{label}</span>
          <span
            className="text-meta text-fg-tertiary tabular-nums"
            title={`${plural(count, 'task')}${row.unscheduledOnly ? ' without dates' : ''}, subtasks included`}
          >
            {count}
          </span>
        </button>
        {canColor ? (
          <PhaseColorPopover
            phaseName={label}
            value={phase.color}
            projectColor={projectColor}
            onChange={(color) => onPhaseColor(phase, color)}
          >
            <button
              type="button"
              aria-label={`Color of ${label}: ${phaseColorLabel(phase.color, projectColor)}`}
              className={cn(
                'absolute top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-md hover:bg-hover',
                insetFocus,
              )}
              // pl-2 (8) + toggle px-1 (4) + chevron (14) + gap (6) − (hit area − dot) / 2
              style={{ left: 26 }}
            >
              <ProjectDot color={resolvePhaseColor(phase.color, projectColor)} />
            </button>
          </PhaseColorPopover>
        ) : null}
      </div>
    )
  }

  if (row.kind === 'milestone') {
    const { milestone } = row
    const past = row.day !== null && row.day < todayDay
    return (
      <div
        className={cn(cellBase, 'gap-1.5 pr-3', selected ? cellSelected : cellSurface)}
        style={{ width: paneWidth, paddingLeft: 12 + indent }}
      >
        <span className="w-4 shrink-0" aria-hidden />
        <MilestoneGlyph past={past} />
        <button
          type="button"
          onClick={() => onOpenMilestone(milestone.id)}
          title={milestone.name}
          className={cn('min-w-0 flex-1 truncate rounded-sm text-left text-ui text-fg', insetFocus)}
        >
          <span className="sr-only">Milestone: </span>
          {milestone.name}
        </button>
        <span
          className="flex shrink-0 justify-end text-meta whitespace-nowrap text-fg-tertiary tabular-nums"
          style={{ width: DUE_COLUMN_WIDTH }}
          title={row.day !== null ? formatDate(milestone.date, 'long') : undefined}
        >
          {row.day !== null ? formatDateSmart(milestone.date, today) : '—'}
        </span>
      </div>
    )
  }

  const { task } = row
  return (
    <div
      className={cn(cellBase, 'gap-1.5 pr-3', selected ? cellSelected : cellSurface)}
      style={{ width: paneWidth, paddingLeft: 12 + indent + row.depth * SUBTASK_INDENT }}
    >
      {row.subtaskCount > 0 ? (
        <button
          type="button"
          aria-expanded={!row.collapsed}
          aria-label={`${row.collapsed ? 'Show' : 'Hide'} ${plural(row.subtaskCount, 'subtask')} of ${task.title}`}
          onClick={() => onToggle(row.key)}
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-hover',
            insetFocus,
          )}
        >
          <ChevronRight className={chevron(!row.collapsed)} aria-hidden />
        </button>
      ) : (
        <span className="w-4 shrink-0" aria-hidden />
      )}
      <StatusIcon status={task.status} size={14} />
      <button
        type="button"
        onClick={() => onOpenTask(task.id)}
        title={row.context ? `${task.title} (has dates, shown for its subtasks)` : task.title}
        aria-label={row.context ? `${task.title}, has dates, shown for its subtasks` : undefined}
        className={cn(
          'min-w-0 flex-1 truncate rounded-sm text-left text-ui',
          row.context
            ? 'text-fg-tertiary'
            : task.status === 'done'
              ? 'text-fg-secondary'
              : 'text-fg',
          insetFocus,
        )}
      >
        {task.title}
      </button>
      <span className="flex shrink-0 justify-end" style={{ width: DUE_COLUMN_WIDTH }}>
        <DueLabel dueDate={task.dueDate} status={task.status} />
      </span>
    </div>
  )
}

function Lane(props: GanttRowViewProps) {
  const { row, geometry, today } = props
  if (row.kind === 'group') {
    return row.rollup ? (
      <RollupBracket
        rect={rangeRect(row.rollup.start, row.rollup.end, geometry)}
        title={rangeTitle(row.label, row.rollup, today)}
      />
    ) : null
  }
  if (row.kind === 'milestone') {
    const day = props.override?.dates.start ?? row.day
    if (day === null) return null
    const moving = props.override !== null
    const origin = props.override?.origin.start ?? null
    const date = iso(day)
    return (
      <>
        {moving && origin !== null && origin !== day ? (
          <PointGhost x={dayCenterX(origin, geometry)} />
        ) : null}
        <MilestoneDiamond
          milestoneId={row.milestone.id}
          name={row.milestone.name}
          centerX={dayCenterX(day, geometry)}
          rowIndex={props.index}
          ariaLabel={`Milestone ${row.milestone.name}${date ? `, ${formatDate(date, 'medium')}` : ''}`}
          describedBy={props.describedBy}
          past={day < props.todayDay}
          upcoming={props.upcomingMilestone}
          dragging={props.override?.mode != null}
          selected={props.selected}
          readOnly={props.readOnly}
          onKeyDown={(event) => props.onBarKeyDown(event, row)}
        />
      </>
    )
  }
  return <TaskLane {...props} row={row} />
}

function sameDates(a: DragDates, b: DragDates): boolean {
  return a.start === b.start && a.end === b.end
}

/** Dashed outline where the task was before a drag (or a drop that awaits the planner). */
function OriginGhost({ origin, geometry }: { origin: DragDates; geometry: TimelineGeometry }) {
  if (origin.start !== null && origin.end !== null) {
    return <DragGhost rect={rangeRect(origin.start, origin.end, geometry)} />
  }
  if (origin.end !== null) return <PointGhost x={dayCenterX(origin.end, geometry)} />
  if (origin.start !== null) return <PointGhost x={dayToX(origin.start, geometry)} />
  return null
}

function TaskLane(props: GanttRowViewProps & { row: TaskRow }) {
  const { row, geometry, today, override, preview, conflict, paneWidth } = props
  const { task } = row
  const span = override ? daySpanOf(override.dates) : row.span
  const dragging = override?.mode != null
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => props.onBarKeyDown(event, row)
  const end = iso(span.end)
  const overdue = dueBucket({ status: task.status, dueDate: end }, today) === 'overdue'
  const ariaLabel = barAriaLabel(task, span, today, conflict, overdue)
  const common = {
    rowIndex: props.index,
    ariaLabel,
    describedBy: props.describedBy,
    conflict,
    linkState: props.linkState,
    dragging,
    linkSource: props.linkSource,
    selected: props.selected,
    readOnly: props.readOnly,
    onKeyDown,
  }

  const ghost =
    override && override.mode !== 'draw' && !sameDates(override.origin, override.dates) ? (
      <OriginGhost origin={override.origin} geometry={geometry} />
    ) : null

  let visual: ReactNode = null
  if (override?.mode === 'draw' && span.start !== null && span.end !== null) {
    const days = span.end - span.start + 1
    visual = (
      <DrawPreview rect={rangeRect(span.start, span.end, geometry)} label={plural(days, 'day')} />
    )
  } else if (span.kind === 'range' && span.start !== null && span.end !== null) {
    visual = (
      <TaskBar
        {...common}
        task={task}
        rect={rangeRect(span.start, span.end, geometry)}
        overdue={overdue}
        dateSummary={datesLabel({ start: span.start, end: span.end }, today)}
        paneWidth={paneWidth}
      />
    )
  } else if (span.kind === 'due_only' && span.end !== null) {
    visual = (
      <DueMarker
        {...common}
        task={task}
        centerX={dayCenterX(span.end, geometry)}
        dateLabel={formatDateRange(null, end, today)}
        overdue={overdue}
      />
    )
  } else if (span.kind === 'start_only' && span.start !== null) {
    visual = (
      <StartMarker
        {...common}
        task={task}
        x={dayToX(span.start, geometry)}
        dayWidth={geometry.dayWidth}
        dateLabel={formatDateRange(iso(span.start), null, today)}
      />
    )
  } else if (row.rollup) {
    visual = (
      <RollupBracket
        rect={rangeRect(row.rollup.start, row.rollup.end, geometry)}
        title={rangeTitle(`${task.title} (subtasks)`, row.rollup, today)}
      />
    )
  } else if (row.drawable) {
    visual = (
      <span
        className="pointer-events-none sticky hidden text-meta whitespace-nowrap text-fg-tertiary group-hover/row:inline"
        style={{ left: paneWidth + 12 }}
      >
        Drag across to set dates
      </span>
    )
  }

  let scheduleGhost: ReactNode = null
  if (preview) {
    const { start, end: previewEnd } = preview.dates
    const label = `+${preview.deltaDays}d`
    if (start !== null && previewEnd !== null) {
      scheduleGhost = <ScheduleGhost rect={rangeRect(start, previewEnd, geometry)} label={label} />
    } else if (start !== null || previewEnd !== null) {
      const day = (previewEnd ?? start) as number
      scheduleGhost = <ScheduleGhost rect={rangeRect(day, day, geometry)} label={label} />
    }
  }

  return (
    <>
      {ghost}
      {visual}
      {scheduleGhost}
      {row.subtaskRollup && span.kind !== 'unscheduled' ? (
        <SubtaskRollupLine
          rect={rangeRect(row.subtaskRollup.start, row.subtaskRollup.end, geometry)}
          title={rangeTitle('Subtasks', row.subtaskRollup, today)}
        />
      ) : null}
    </>
  )
}

function sameRange(a: DayRange | null, b: DayRange | null): boolean {
  return a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end)
}

/** Row models are rebuilt on every data change; compare what the row actually renders. */
function sameRow(a: GanttRow, b: GanttRow): boolean {
  if (a === b) return true
  if (a.kind !== b.kind || a.key !== b.key) return false
  switch (a.kind) {
    case 'task': {
      const other = b as TaskRow
      return (
        a.task === other.task &&
        a.depth === other.depth &&
        a.subtaskCount === other.subtaskCount &&
        a.collapsed === other.collapsed &&
        a.drawable === other.drawable &&
        a.context === other.context &&
        sameRange(a.rollup, other.rollup) &&
        sameRange(a.subtaskRollup, other.subtaskRollup)
      )
    }
    case 'group': {
      const other = b as typeof a
      return (
        a.phase === other.phase &&
        a.label === other.label &&
        a.taskCount === other.taskCount &&
        a.unscheduledOnly === other.unscheduledOnly &&
        a.collapsed === other.collapsed &&
        sameRange(a.rollup, other.rollup)
      )
    }
    case 'milestone':
      return a.milestone === (b as typeof a).milestone
  }
}

function propsEqual(prev: GanttRowViewProps, next: GanttRowViewProps): boolean {
  for (const key of Object.keys(next) as Array<keyof GanttRowViewProps>) {
    if (key === 'row') continue
    if (!Object.is(prev[key], next[key])) return false
  }
  return sameRow(prev.row, next.row)
}

export const GanttRowView = memo(GanttRowViewImpl, propsEqual)
