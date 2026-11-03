/**
 * One 32px Gantt row: the sticky outline cell (left) and its timeline lane (right). Memoized
 * with a content comparison of the row model, so a drag re-renders only the dragged row.
 */
import { memo, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { CalendarOff, ChevronRight } from 'lucide-react'
import { DueLabel } from '@/components/task/DueLabel'
import { STATUS_LABELS } from '@/components/task/labels'
import { StatusIcon } from '@/components/task/StatusIcon'
import { insetFocus } from '@/components/ui/styles'
import { dueBucket } from '@/domain/buckets'
import {
  durationDays,
  formatDate,
  formatDateRange,
  formatDateSmart,
  fromEpochDay,
} from '@/domain/dates'
import type { ISODate, Task } from '@/domain/types'
import { cn } from '@/lib/utils'
import { DUE_COLUMN_WIDTH, ROW_HEIGHT, SUBTASK_INDENT } from '../model/constants'
import type { DragDates, DragMode } from '../model/dragReducer'
import {
  dayCenterX,
  daySpanOf,
  dayToX,
  rangeRect,
  type DaySpan,
  type TimelineGeometry,
} from '../model/geometry'
import type { GanttRow, TaskRow } from '../model/rows'
import type { DayRange } from '../model/scale'
import {
  DragGhost,
  DrawPreview,
  DueMarker,
  MilestoneDiamond,
  RollupBracket,
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

export interface GanttRowViewProps {
  row: GanttRow
  index: number
  geometry: TimelineGeometry
  paneWidth: number
  timelineWidth: number
  today: ISODate
  todayDay: number
  override: RowOverride | null
  conflict: string | null
  linkState: LinkTargetState
  linkSource: boolean
  upcomingMilestone: boolean
  describedBy: string
  onToggle: (key: string) => void
  onOpenTask: (taskId: string) => void
  onOpenMilestone: (milestoneId: string) => void
  onBarKeyDown: (event: ReactKeyboardEvent<HTMLElement>, row: GanttRow) => void
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function iso(day: number | null): ISODate | null {
  return day === null ? null : fromEpochDay(day)
}

function rangeTitle(label: string, range: DayRange, today: ISODate): string {
  return `${label}: ${formatDateRange(fromEpochDay(range.start), fromEpochDay(range.end), today)}`
}

/** Accessible name of a bar/marker, e.g. "Design review, Nov 2 – Nov 5, 4 days, In Progress". */
export function barAriaLabel(
  task: Task,
  span: DaySpan,
  today: ISODate,
  conflict: string | null,
  overdue: boolean,
): string {
  const start = iso(span.start)
  const end = iso(span.end)
  const parts = [task.title]
  if (span.kind === 'range' && start && end) {
    parts.push(formatDateRange(start, end, today), plural(durationDays(start, end), 'day'))
  } else if (span.kind === 'due_only') {
    parts.push(formatDateRange(null, end, today), 'no start date')
  } else if (span.kind === 'start_only') {
    parts.push(formatDateRange(start, null, today), 'no due date')
  }
  parts.push(STATUS_LABELS[task.status])
  if (overdue) parts.push('overdue')
  if (conflict) parts.push(`dependency conflict: ${conflict}`)
  return parts.join(', ')
}

function MilestoneGlyph({ past }: { past: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      aria-hidden
      className={cn('shrink-0', past ? 'text-(--gantt-milestone-past)' : 'text-(--gantt-milestone)')}
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

const cellBase = 'sticky left-0 z-[11] flex h-full shrink-0 items-center'
const chevron = (open: boolean) =>
  cn(
    'size-3.5 shrink-0 text-fg-tertiary motion-safe:transition-transform motion-safe:duration-fast',
    open && 'rotate-90',
  )

function GanttRowViewImpl(props: GanttRowViewProps) {
  const { row, index, paneWidth, timelineWidth } = props
  const header = row.kind === 'group' || row.kind === 'unscheduled'
  return (
    <div
      data-row-index={index}
      className="group/row absolute left-0 flex"
      style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT, width: paneWidth + timelineWidth }}
    >
      <LeftCell {...props} />
      <div
        data-handle="lane"
        data-row-index={index}
        className={cn(
          'relative flex h-full shrink-0 items-center',
          header ? 'bg-muted' : 'group-hover/row:bg-(--gantt-row-hover)',
          row.kind === 'task' && row.drawable && 'cursor-crosshair',
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
  onToggle,
  onOpenTask,
  onOpenMilestone,
}: GanttRowViewProps) {
  if (row.kind === 'group' || row.kind === 'unscheduled') {
    const label = row.kind === 'group' ? row.label : 'Unscheduled'
    const count = row.kind === 'group' ? row.taskCount : row.count
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
          {row.kind === 'unscheduled' ? (
            <CalendarOff className="size-3.5 shrink-0 text-fg-tertiary" aria-hidden />
          ) : null}
          <span className="truncate text-meta font-semibold text-fg-secondary">{label}</span>
          <span className="text-meta text-fg-tertiary tabular-nums">{count}</span>
        </button>
      </div>
    )
  }

  if (row.kind === 'milestone') {
    const { milestone } = row
    const past = row.day !== null && row.day < todayDay
    return (
      <div
        className={cn(cellBase, 'gap-1.5 pr-3 group-hover/row:bg-(--gantt-row-hover)')}
        style={{ width: paneWidth, paddingLeft: 12 }}
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
          className="shrink-0 truncate text-right text-meta text-fg-tertiary tabular-nums"
          style={{ width: DUE_COLUMN_WIDTH }}
          title={row.day !== null ? formatDate(milestone.date, 'medium') : undefined}
        >
          {row.day !== null ? formatDateSmart(milestone.date, today) : '—'}
        </span>
      </div>
    )
  }

  const { task } = row
  return (
    <div
      className={cn(cellBase, 'gap-1.5 pr-3 group-hover/row:bg-(--gantt-row-hover)')}
      style={{ width: paneWidth, paddingLeft: 12 + row.depth * SUBTASK_INDENT }}
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
        title={task.title}
        className={cn(
          'min-w-0 flex-1 truncate rounded-sm text-left text-ui',
          task.status === 'done' ? 'text-fg-secondary' : 'text-fg',
          insetFocus,
        )}
      >
        {task.title}
      </button>
      <span className="flex shrink-0 justify-end" style={{ width: DUE_COLUMN_WIDTH }}>
        {task.dueDate ? (
          <DueLabel dueDate={task.dueDate} status={task.status} />
        ) : task.startDate ? (
          <span className="truncate text-meta text-fg-tertiary tabular-nums">
            Starts {formatDateSmart(task.startDate, today)}
          </span>
        ) : null}
      </span>
    </div>
  )
}

function Lane(props: GanttRowViewProps) {
  const { row, geometry, paneWidth, today } = props
  if (row.kind === 'group') {
    return row.rollup ? (
      <RollupBracket
        rect={rangeRect(row.rollup.start, row.rollup.end, geometry)}
        title={rangeTitle(row.label, row.rollup, today)}
      />
    ) : null
  }
  if (row.kind === 'unscheduled') {
    return (
      <span
        className="pointer-events-none sticky text-meta whitespace-nowrap text-fg-tertiary"
        style={{ left: paneWidth + 12 }}
      >
        Drag across a row to schedule it · double-click for a one-day task
      </span>
    )
  }
  if (row.kind === 'milestone') {
    const day = props.override?.dates.start ?? row.day
    if (day === null) return null
    const dragging = props.override?.mode != null
    const origin = props.override?.origin.start ?? null
    return (
      <>
        {dragging && origin !== null && origin !== day ? (
          <span
            aria-hidden
            className="pointer-events-none absolute z-[1] h-4 w-px border-l border-dashed border-(--gantt-drag-ghost-border)"
            style={{ left: dayCenterX(origin, geometry), top: ROW_HEIGHT / 2 - 8 }}
          />
        ) : null}
        <MilestoneDiamond
          milestoneId={row.milestone.id}
          name={row.milestone.name}
          centerX={dayCenterX(day, geometry)}
          rowIndex={props.index}
          ariaLabel={`Milestone ${row.milestone.name}, ${formatDate(fromEpochDay(day), 'medium')}`}
          describedBy={props.describedBy}
          past={day < props.todayDay}
          upcoming={props.upcomingMilestone}
          dragging={dragging}
          onKeyDown={(event) => props.onBarKeyDown(event, row)}
        />
      </>
    )
  }
  return <TaskLane {...props} row={row} />
}

function TaskLane(props: GanttRowViewProps & { row: TaskRow }) {
  const { row, geometry, today, override, conflict, paneWidth } = props
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
    onKeyDown,
  }

  const origin = override?.origin
  const ghost =
    dragging && origin && origin.start !== null && origin.end !== null ? (
      <DragGhost rect={rangeRect(origin.start, origin.end, geometry)} />
    ) : null

  let visual: ReactNode = null
  if (override?.mode === 'draw' && span.start !== null && span.end !== null) {
    const days = span.end - span.start + 1
    visual = (
      <DrawPreview rect={rangeRect(span.start, span.end, geometry)} label={plural(days, 'day')} />
    )
  } else if (span.kind === 'range' && span.start !== null && span.end !== null) {
    visual = (
      <TaskBar {...common} task={task} rect={rangeRect(span.start, span.end, geometry)} overdue={overdue} />
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

  return (
    <>
      {ghost}
      {visual}
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
        a.inUnscheduledGroup === other.inUnscheduledGroup &&
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
        a.collapsed === other.collapsed &&
        sameRange(a.rollup, other.rollup)
      )
    }
    case 'milestone':
      return a.milestone === (b as typeof a).milestone
    case 'unscheduled': {
      const other = b as typeof a
      return a.count === other.count && a.collapsed === other.collapsed
    }
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
