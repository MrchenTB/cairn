/**
 * Timeline visuals (design-research §5.6). Status is carried by shape + glyph, never colour alone:
 * To Do = plain bar, In Progress = accent edge, Done = muted bar with a check glyph; conflicts get a
 * danger edge, outline and ⚠; overdue bars a danger end cap. Interactive elements expose
 * `data-handle` (+ `data-task-id` / `data-milestone-id`) for the chart's delegated pointer handler.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { TriangleAlert } from 'lucide-react'
import { StatusIcon } from '@/components/task/StatusIcon'
import type { Task } from '@/domain/types'
import { cn } from '@/lib/utils'
import { BAR_HEIGHT, BAR_TOP, ROW_HEIGHT } from '../model/constants'
import { resizeHandleWidth, type BarRect } from '../model/geometry'
import { measureLabelWidth } from './measure'

/** Highlight while a dependency is being drawn over this task. */
export type LinkTargetState = 'valid' | 'invalid' | null

const focusRing =
  'outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus'

function linkRing(state: LinkTargetState): string | false {
  if (state === 'valid') return 'outline-2 outline-offset-1 outline-accent'
  if (state === 'invalid') return 'cursor-not-allowed outline-2 outline-offset-1 outline-danger'
  return false
}

interface InteractiveProps {
  rowIndex: number
  ariaLabel: string
  describedBy: string
  /** Conflict explanation (successor of a violated dependency), shown as tooltip. */
  conflict: string | null
  linkState: LinkTargetState
  dragging: boolean
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
}

/** Dependency handle: a 16px hot zone glued to the bar edge with an 8px dot, shown on hover. */
function Connector({
  side,
  taskId,
  rowIndex,
  visible,
}: {
  side: 'in' | 'out'
  taskId: string
  rowIndex: number
  visible: boolean
}) {
  return (
    <span
      data-handle={side === 'in' ? 'link-in' : 'link-out'}
      data-task-id={taskId}
      data-row-index={rowIndex}
      aria-hidden
      className={cn(
        'absolute top-1/2 flex h-5 w-4 -translate-y-1/2 cursor-crosshair items-center justify-center',
        'opacity-0 group-hover/bar:opacity-100 motion-safe:transition-opacity motion-safe:duration-fast',
        side === 'in' ? '-left-4' : '-right-4',
        visible && 'opacity-100',
      )}
    >
      <span className="size-2 rounded-full border-[1.5px] border-accent-text bg-main" />
    </span>
  )
}

export interface TaskBarProps extends InteractiveProps {
  task: Task
  rect: BarRect
  overdue: boolean
  /** This bar is the source of a dependency being drawn (keep its dots visible). */
  linkSource: boolean
}

/** Range bar (start and due). Body = move, ends = resize, outer dots = draw a dependency. */
export function TaskBar({
  task,
  rect,
  rowIndex,
  ariaLabel,
  describedBy,
  conflict,
  linkState,
  dragging,
  overdue,
  linkSource,
  onKeyDown,
}: TaskBarProps) {
  const done = task.status === 'done'
  const handle = resizeHandleWidth(rect.width)
  const labelInside = rect.width >= measureLabelWidth(task.title) + 24 + (conflict ? 16 : 0)
  const iconInside = !labelInside && rect.width >= 22
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        data-handle="move"
        data-task-id={task.id}
        data-row-index={rowIndex}
        data-link-target=""
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-keyshortcuts="Enter Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
        title={conflict ?? undefined}
        onKeyDown={onKeyDown}
        className={cn(
          'group/bar absolute z-[2] flex items-center rounded-sm border text-meta font-medium select-none',
          dragging ? 'cursor-grabbing shadow-drag' : 'cursor-grab',
          done
            ? 'border-(--gantt-bar-border-done) bg-(--gantt-bar-fill-done) text-(--gantt-bar-text-done)'
            : 'border-(--gantt-bar-border) text-(--gantt-bar-text)',
          task.status === 'todo' && 'bg-(--gantt-bar-fill)',
          task.status === 'in_progress' && 'bg-(--gantt-bar-fill-active)',
          conflict && 'border-(--gantt-conflict)',
          focusRing,
          linkRing(linkState),
        )}
        style={{ left: rect.left, width: rect.width, top: BAR_TOP, height: BAR_HEIGHT }}
      >
        {task.status === 'in_progress' || conflict ? (
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-y-0 left-0 w-0.5 rounded-l-[3px]',
              conflict ? 'bg-(--gantt-conflict)' : 'bg-accent',
            )}
          />
        ) : null}
        {overdue ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-0.5 rounded-r-[3px] bg-danger"
          />
        ) : null}
        {handle > 0 ? (
          <>
            <span
              data-handle="resize-start"
              aria-hidden
              className="absolute inset-y-0 left-0 z-[1] cursor-ew-resize"
              style={{ width: handle }}
            >
              <span className="absolute top-1/2 left-[2px] h-2.5 w-0.5 -translate-y-1/2 rounded-full bg-(--gantt-bar-border) opacity-0 group-hover/bar:opacity-80" />
            </span>
            <span
              data-handle="resize-end"
              aria-hidden
              className="absolute inset-y-0 right-0 z-[1] cursor-ew-resize"
              style={{ width: handle }}
            >
              <span className="absolute top-1/2 right-[2px] h-2.5 w-0.5 -translate-y-1/2 rounded-full bg-(--gantt-bar-border) opacity-0 group-hover/bar:opacity-80" />
            </span>
          </>
        ) : null}
        {labelInside ? (
          <span className="pointer-events-none flex min-w-0 flex-1 items-center gap-1 overflow-hidden px-1.5 whitespace-nowrap">
            {conflict ? (
              <TriangleAlert className="size-3 shrink-0 text-(--gantt-conflict)" aria-hidden />
            ) : null}
            <StatusIcon status={task.status} size={12} decorative />
            <span className="truncate">{task.title}</span>
          </span>
        ) : iconInside ? (
          <span className="pointer-events-none flex items-center px-1">
            <StatusIcon status={task.status} size={12} decorative />
          </span>
        ) : null}
        <Connector side="in" taskId={task.id} rowIndex={rowIndex} visible={linkSource} />
        <Connector side="out" taskId={task.id} rowIndex={rowIndex} visible={linkSource} />
      </div>
      {labelInside ? null : (
        <span
          aria-hidden
          className="pointer-events-none absolute z-[2] flex items-center gap-1 text-meta whitespace-nowrap text-fg-secondary"
          style={{ left: rect.left + rect.width + 18, top: BAR_TOP, height: BAR_HEIGHT }}
        >
          {conflict ? (
            <TriangleAlert className="size-3 shrink-0 text-(--gantt-conflict)" aria-hidden />
          ) : null}
          {iconInside ? null : <StatusIcon status={task.status} size={12} decorative />}
          <span>{task.title}</span>
        </span>
      )}
    </>
  )
}

export interface DueMarkerProps extends InteractiveProps {
  task: Task
  /** Day centre of the due date. */
  centerX: number
  /** e.g. "Due Nov 5". */
  dateLabel: string
  overdue: boolean
  linkSource: boolean
}

/**
 * Due date without a start: a flag on the due day (clearly not a milestone diamond) with a short
 * fading lead-in on the left, "no start date" in the tooltip. Drag moves the due date.
 */
export function DueMarker({
  task,
  centerX,
  dateLabel,
  rowIndex,
  ariaLabel,
  describedBy,
  conflict,
  linkState,
  dragging,
  overdue,
  linkSource,
  onKeyDown,
}: DueMarkerProps) {
  const danger = Boolean(conflict) || overdue
  return (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute z-[1] h-px bg-[repeating-linear-gradient(90deg,var(--gantt-due-marker)_0_2px,transparent_2px_4px)] opacity-70 [mask-image:linear-gradient(to_right,transparent,black)]"
        style={{ left: centerX - 19, width: 12, top: ROW_HEIGHT / 2 }}
      />
      <div
        role="button"
        tabIndex={0}
        data-handle="point"
        data-task-id={task.id}
        data-row-index={rowIndex}
        data-link-target=""
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-keyshortcuts="Enter Alt+ArrowLeft Alt+ArrowRight"
        title={conflict ?? 'No start date'}
        onKeyDown={onKeyDown}
        className={cn(
          'group/bar absolute z-[2] rounded-sm select-none',
          dragging ? 'cursor-grabbing' : 'cursor-grab',
          focusRing,
          linkRing(linkState),
        )}
        style={{ left: centerX - 7, width: 14, top: BAR_TOP, height: BAR_HEIGHT }}
      >
        <svg
          viewBox="0 0 14 20"
          width={14}
          height={20}
          aria-hidden
          className={danger ? 'text-danger' : 'text-(--gantt-due-marker)'}
        >
          <path d="M7 2.5v15.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M7.75 2.5 13 5.25 7.75 8Z" fill="currentColor" />
        </svg>
        <Connector side="in" taskId={task.id} rowIndex={rowIndex} visible={linkSource} />
        <Connector side="out" taskId={task.id} rowIndex={rowIndex} visible={linkSource} />
      </div>
      <span
        aria-hidden
        className="pointer-events-none absolute z-[2] flex items-center gap-1.5 text-meta whitespace-nowrap"
        style={{ left: centerX + 20, top: BAR_TOP, height: BAR_HEIGHT }}
      >
        {conflict ? (
          <TriangleAlert className="size-3 shrink-0 text-(--gantt-conflict)" aria-hidden />
        ) : null}
        <span className={cn('font-medium tabular-nums', overdue ? 'text-danger' : 'text-fg-secondary')}>
          {dateLabel}
        </span>
        <span className="text-fg-tertiary">{task.title}</span>
      </span>
    </>
  )
}

export interface StartMarkerProps extends InteractiveProps {
  task: Task
  /** Left edge of the start day. */
  x: number
  dayWidth: number
  /** e.g. "Starts Nov 2". */
  dateLabel: string
  linkSource: boolean
}

/** Start date without a due date: a start tick with a fade to the right (no invented end). */
export function StartMarker({
  task,
  x,
  dayWidth,
  dateLabel,
  rowIndex,
  ariaLabel,
  describedBy,
  conflict,
  linkState,
  dragging,
  linkSource,
  onKeyDown,
}: StartMarkerProps) {
  const width = Math.max(56, dayWidth * 4)
  return (
    <div
      role="button"
      tabIndex={0}
      data-handle="point"
      data-task-id={task.id}
      data-row-index={rowIndex}
      data-link-target=""
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      aria-keyshortcuts="Enter Alt+ArrowLeft Alt+ArrowRight"
      title={conflict ?? 'No due date'}
      onKeyDown={onKeyDown}
      className={cn(
        'group/bar absolute z-[2] flex items-center rounded-l-sm border-l-2 bg-linear-to-r to-transparent pl-1.5 text-meta select-none',
        task.status === 'done'
          ? 'border-(--gantt-bar-border-done) from-(--gantt-bar-fill-done)'
          : 'border-(--gantt-bar-border) from-(--gantt-bar-fill-active)',
        conflict && 'border-(--gantt-conflict)',
        dragging ? 'cursor-grabbing' : 'cursor-grab',
        focusRing,
        linkRing(linkState),
      )}
      style={{ left: x, width, top: BAR_TOP, height: BAR_HEIGHT }}
    >
      <span className="pointer-events-none flex items-center gap-1 whitespace-nowrap">
        {conflict ? (
          <TriangleAlert className="size-3 shrink-0 text-(--gantt-conflict)" aria-hidden />
        ) : null}
        <StatusIcon status={task.status} size={12} decorative />
        <span className="font-medium text-fg-secondary tabular-nums">{dateLabel}</span>
        <span className="text-fg-tertiary">{task.title}</span>
      </span>
      <Connector side="in" taskId={task.id} rowIndex={rowIndex} visible={linkSource} />
    </div>
  )
}

export interface MilestoneDiamondProps {
  milestoneId: string
  name: string
  centerX: number
  rowIndex: number
  ariaLabel: string
  describedBy: string
  past: boolean
  /** The next milestone to come (accent ring). */
  upcoming: boolean
  dragging: boolean
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
}

/** Single-day diamond: filled = upcoming, hollow = past, accent ring = the next one. */
export function MilestoneDiamond({
  milestoneId,
  name,
  centerX,
  rowIndex,
  ariaLabel,
  describedBy,
  past,
  upcoming,
  dragging,
  onKeyDown,
}: MilestoneDiamondProps) {
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        data-handle="point"
        data-milestone-id={milestoneId}
        data-row-index={rowIndex}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-keyshortcuts="Enter Alt+ArrowLeft Alt+ArrowRight"
        onKeyDown={onKeyDown}
        className={cn(
          'absolute z-[2] flex items-center justify-center rounded-sm select-none',
          dragging ? 'cursor-grabbing' : 'cursor-grab',
          focusRing,
        )}
        style={{ left: centerX - 8, width: 16, top: ROW_HEIGHT / 2 - 8, height: 16 }}
      >
        <span
          aria-hidden
          className={cn(
            'size-[9px] rotate-45 rounded-[1.5px]',
            past
              ? 'border-[1.5px] border-(--gantt-milestone-past) bg-(--gantt-bg)'
              : 'bg-(--gantt-milestone)',
            upcoming && 'outline-2 outline-offset-2 outline-accent',
          )}
        />
      </div>
      <span
        aria-hidden
        className="pointer-events-none absolute z-[2] flex items-center text-meta whitespace-nowrap text-fg-secondary"
        style={{ left: centerX + 12, top: BAR_TOP, height: BAR_HEIGHT }}
      >
        {name}
      </span>
    </>
  )
}

/** Read-only bracket over a phase's (or a date-less parent's) children. */
export function RollupBracket({ rect, title }: { rect: BarRect; title: string }) {
  return (
    <div
      className="absolute z-[2]"
      title={title}
      style={{ left: rect.left, width: rect.width, top: ROW_HEIGHT / 2 - 3, height: 7 }}
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-[3px] rounded-[1px] bg-(--gantt-summary)" />
      <span aria-hidden className="absolute top-0 left-0 h-[7px] w-0.5 rounded-b-[1px] bg-(--gantt-summary)" />
      <span aria-hidden className="absolute top-0 right-0 h-[7px] w-0.5 rounded-b-[1px] bg-(--gantt-summary)" />
    </div>
  )
}

/** Thin line under a collapsed parent that has its own dates: where its subtasks are. */
export function SubtaskRollupLine({ rect, title }: { rect: BarRect; title: string }) {
  return (
    <span
      className="absolute z-[1] h-0.5 rounded-full bg-(--gantt-summary) opacity-60"
      title={title}
      style={{ left: rect.left, width: rect.width, top: ROW_HEIGHT - 4 }}
    />
  )
}

/** Dashed outline at the original position while a bar is being dragged. */
export function DragGhost({ rect }: { rect: BarRect }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute z-[1] rounded-sm border border-dashed border-(--gantt-drag-ghost-border) bg-(--gantt-drag-ghost)"
      style={{ left: rect.left, width: rect.width, top: BAR_TOP, height: BAR_HEIGHT }}
    />
  )
}

/** A range being drawn on an empty lane (scheduling an undated task). */
export function DrawPreview({ rect, label }: { rect: BarRect; label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute z-[2] flex items-center overflow-hidden rounded-sm border border-dashed border-(--gantt-drag-ghost-border) bg-(--gantt-bar-fill) px-1.5 text-meta font-medium whitespace-nowrap text-(--gantt-bar-text)"
      style={{ left: rect.left, width: rect.width, top: BAR_TOP, height: BAR_HEIGHT }}
    >
      {label}
    </span>
  )
}
