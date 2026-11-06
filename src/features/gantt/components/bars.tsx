/**
 * Timeline visuals (design-research §5.6). Status is carried by shape + glyph, never colour alone:
 * To Do = plain bar, In Progress = accent edge, Done = muted bar with a check glyph; conflicts get a
 * danger edge, outline and ⚠; overdue bars a danger end cap. Interactive elements expose
 * `data-handle` (+ `data-task-id` / `data-milestone-id`) for the chart's delegated pointer handler.
 */
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { TriangleAlert } from 'lucide-react'
import { StatusIcon } from '@/components/task/StatusIcon'
import { Tooltip } from '@/components/ui/tooltip'
import type { Task } from '@/domain/types'
import { cn } from '@/lib/utils'
import { BAR_HEIGHT, BAR_TOP, ROW_HEIGHT } from '../model/constants'
import { resizeHandleWidth, startMarkerOutOffset, type BarRect } from '../model/geometry'
import { measureLabelWidth } from './measure'

/** Highlight while a dependency is being drawn over this task. */
export type LinkTargetState = 'valid' | 'invalid' | null

/*
 * Keyboard focus ring, outside the bar. No `outline-none` here: in Tailwind 4 it sets
 * --tw-outline-style: none, which `focus-visible:outline-2` then inherits (no ring at all).
 */
const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus'

/** Box-shadow ring (not an outline, which the focus styles own) on a link drop target. */
function linkRing(state: LinkTargetState): string | false {
  if (state === 'valid') return 'ring-2 ring-accent'
  if (state === 'invalid') return 'cursor-not-allowed ring-2 ring-danger'
  return false
}

/** Widest an outside-the-bar label grows; longer names are cut with an ellipsis. */
const OUTSIDE_LABEL_MAX_WIDTH = 240

/**
 * Opaque chip behind text that sits on the lane (outside a bar): the today line and dependency
 * lines pass behind it, never through the letters. Painted bottom-up: chart colour, the weekend
 * band (aligned to the grid through the `--wk-*` variables the chart body sets, `left` being the
 * chip's x on the lane), then the lane's own hover / selected tint — so on a weekend, in a hovered
 * or selected row, the chip is indistinguishable from the lane around it.
 */
function labelChip(selected: boolean | undefined, left: number) {
  return {
    className: cn(
      'rounded-sm bg-(--gantt-bg) [--lane-tint:transparent]',
      selected
        ? '[--lane-tint:var(--gantt-row-selected)]'
        : 'group-hover/row:[--lane-tint:var(--gantt-row-hover)]',
    ),
    style: {
      backgroundImage: 'linear-gradient(var(--lane-tint), var(--lane-tint)), var(--wk-image, none)',
      backgroundSize: '100% 100%, var(--wk-size, auto)',
      backgroundPosition: `0 0, calc(var(--wk-x, 0px) - ${left}px) 0`,
      backgroundRepeat: 'no-repeat, repeat-x',
    } satisfies CSSProperties,
  }
}

interface InteractiveProps {
  rowIndex: number
  ariaLabel: string
  describedBy: string
  /** Conflict explanation (successor of a violated dependency), shown as tooltip. */
  conflict: string | null
  linkState: LinkTargetState
  dragging: boolean
  /** This task's row is the one open in the modal (tints the chip behind outside labels). */
  selected?: boolean
  /** Only opens on click / Enter: no drag cursor, resize grips or dependency dots (Timeline). */
  readOnly?: boolean
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
}

/**
 * Dependency handle: a 16px hot zone glued to the bar edge with an 8px dot, shown on hover (and
 * while this bar is the source of a link being drawn). `left` places it explicitly (start marker).
 */
function Connector({
  side,
  taskId,
  rowIndex,
  visible,
  left,
}: {
  side: 'in' | 'out'
  taskId: string
  rowIndex: number
  visible: boolean
  left?: number
}) {
  return (
    <span
      data-handle={side === 'in' ? 'link-in' : 'link-out'}
      data-task-id={taskId}
      data-row-index={rowIndex}
      aria-hidden
      className={cn(
        'absolute top-1/2 flex h-5 w-4 -translate-y-1/2 cursor-crosshair touch-none items-center justify-center',
        'opacity-0 group-hover/bar:opacity-100 motion-safe:transition-opacity motion-safe:duration-fast',
        left === undefined && (side === 'in' ? '-left-4' : '-right-4'),
        visible && 'opacity-100',
      )}
      style={left === undefined ? undefined : { left }}
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
  /** Hover text: "Nov 7 – Nov 8 · 2 days". */
  dateSummary: string
  /**
   * Width of the sticky outline the timeline scrolls under. A label inside the bar sticks just
   * right of it while the bar's start is scrolled out of sight, so it stays readable.
   */
  paneWidth?: number
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
  dateSummary,
  selected,
  paneWidth = 0,
  readOnly = false,
  onKeyDown,
}: TaskBarProps) {
  const done = task.status === 'done'
  const handle = readOnly ? 0 : resizeHandleWidth(rect.width)
  const labelInside = rect.width >= measureLabelWidth(task.title) + 24 + (conflict ? 16 : 0)
  const iconInside = !labelInside && rect.width >= 22
  // Clear of the dependency dot, when there is one (the chip's 4px padding included).
  const outsideLeft = rect.left + rect.width + (readOnly ? 2 : 14)
  const outside = labelChip(selected, outsideLeft)
  return (
    <>
      <Tooltip
        passive
        // Never while this bar is being dragged, resized or used as a dependency end.
        disabled={dragging || linkSource || linkState !== null}
        content={
          <span className="flex flex-col gap-0.5 break-words">
            <span className="font-semibold">{task.title}</span>
            <span className="font-normal tabular-nums opacity-80">{dateSummary}</span>
            {conflict ? <span className="font-normal">{conflict}</span> : null}
          </span>
        }
      >
        <div
          role="button"
          tabIndex={0}
          data-handle="move"
          data-task-id={task.id}
          data-row-index={rowIndex}
          data-link-target=""
          aria-label={ariaLabel}
          aria-describedby={describedBy}
          aria-keyshortcuts={
            readOnly
              ? 'Enter'
              : 'Enter Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowLeft Alt+Shift+ArrowRight'
          }
          onKeyDown={onKeyDown}
          className={cn(
            'group/bar absolute z-[2] flex items-center rounded-sm border text-meta font-medium select-none',
            !readOnly && 'touch-none',
            dragging ? 'cursor-grabbing shadow-drag' : readOnly ? 'cursor-pointer' : 'cursor-grab',
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
                conflict ? 'bg-(--gantt-conflict)' : 'bg-(--gantt-bar-hue)',
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
            // No overflow clipping here: that would make this span the sticky container (the label
            // fits the bar anyway, labelInside checks). The inner group sticks to the outline's edge.
            <span className="pointer-events-none flex min-w-0 flex-1 items-center px-1.5 whitespace-nowrap">
              <span
                className="sticky flex max-w-full min-w-0 items-center gap-1"
                style={{ left: paneWidth + 6 }}
              >
                {conflict ? (
                  <TriangleAlert className="size-3 shrink-0 text-(--gantt-conflict)" aria-hidden />
                ) : null}
                <StatusIcon status={task.status} size={12} decorative />
                <span className="truncate">{task.title}</span>
              </span>
            </span>
          ) : iconInside ? (
            <span className="pointer-events-none flex items-center px-1">
              <StatusIcon status={task.status} size={12} decorative />
            </span>
          ) : null}
          {readOnly ? null : (
            <>
              <Connector side="in" taskId={task.id} rowIndex={rowIndex} visible={linkSource} />
              <Connector side="out" taskId={task.id} rowIndex={rowIndex} visible={linkSource} />
            </>
          )}
        </div>
      </Tooltip>
      {labelInside ? null : (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute z-[2] flex items-center gap-1 px-1 text-meta whitespace-nowrap text-fg-secondary',
            outside.className,
          )}
          style={{
            ...outside.style,
            left: outsideLeft,
            top: BAR_TOP,
            height: BAR_HEIGHT,
            maxWidth: OUTSIDE_LABEL_MAX_WIDTH,
          }}
        >
          {conflict ? (
            <TriangleAlert className="size-3 shrink-0 text-(--gantt-conflict)" aria-hidden />
          ) : null}
          {iconInside ? null : <StatusIcon status={task.status} size={12} decorative />}
          <span className="min-w-0 truncate">{task.title}</span>
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
  selected,
  readOnly = false,
  onKeyDown,
}: DueMarkerProps) {
  const danger = Boolean(conflict) || overdue
  const chip = labelChip(selected, centerX + 16)
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
        aria-keyshortcuts={readOnly ? 'Enter' : 'Enter Alt+ArrowLeft Alt+ArrowRight'}
        title={conflict ?? 'No start date'}
        onKeyDown={onKeyDown}
        className={cn(
          'group/bar absolute z-[2] rounded-sm select-none',
          !readOnly && 'touch-none',
          dragging ? 'cursor-grabbing' : readOnly ? 'cursor-pointer' : 'cursor-grab',
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
        {readOnly ? null : (
          <>
            <Connector side="in" taskId={task.id} rowIndex={rowIndex} visible={linkSource} />
            <Connector side="out" taskId={task.id} rowIndex={rowIndex} visible={linkSource} />
          </>
        )}
      </div>
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute z-[2] flex items-center gap-1.5 px-1 text-meta whitespace-nowrap',
          chip.className,
        )}
        style={{
          ...chip.style,
          left: centerX + 16,
          top: BAR_TOP,
          height: BAR_HEIGHT,
          maxWidth: OUTSIDE_LABEL_MAX_WIDTH,
        }}
      >
        {conflict ? (
          <TriangleAlert className="size-3 shrink-0 text-(--gantt-conflict)" aria-hidden />
        ) : null}
        <span
          className={cn('font-medium tabular-nums', overdue ? 'text-danger' : 'text-fg-secondary')}
        >
          {dateLabel}
        </span>
        <span className="min-w-0 truncate text-fg-tertiary">{task.title}</span>
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
  readOnly = false,
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
      aria-keyshortcuts={readOnly ? 'Enter' : 'Enter Alt+ArrowLeft Alt+ArrowRight'}
      title={conflict ?? 'No due date'}
      onKeyDown={onKeyDown}
      className={cn(
        'group/bar absolute z-[2] flex items-center rounded-l-sm border-l-2 bg-linear-to-r to-transparent pl-1.5 text-meta select-none',
        !readOnly && 'touch-none',
        task.status === 'done'
          ? 'border-(--gantt-bar-border-done) from-(--gantt-bar-fill-done)'
          : 'border-(--gantt-bar-border) from-(--gantt-bar-fill-active)',
        conflict && 'border-(--gantt-conflict)',
        dragging ? 'cursor-grabbing' : readOnly ? 'cursor-pointer' : 'cursor-grab',
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
      {readOnly ? null : (
        <>
          <Connector side="in" taskId={task.id} rowIndex={rowIndex} visible={linkSource} />
          <Connector
            side="out"
            taskId={task.id}
            rowIndex={rowIndex}
            visible={linkSource}
            left={startMarkerOutOffset(dayWidth)}
          />
        </>
      )}
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
  /** Open in the modal (tints the chip behind the name). */
  selected?: boolean
  /** Only opens on click / Enter: no drag cursor (Timeline). */
  readOnly?: boolean
  /**
   * Name as a chip on hover / keyboard focus instead of always beside the diamond (rows with
   * several diamonds). Wrap each diamond in its own parent: the chip follows it as a CSS peer.
   */
  nameOnHover?: boolean
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
  selected,
  readOnly = false,
  nameOnHover = false,
  onKeyDown,
}: MilestoneDiamondProps) {
  const chip = labelChip(selected, centerX + 8)
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
        aria-keyshortcuts={readOnly ? 'Enter' : 'Enter Alt+ArrowLeft Alt+ArrowRight'}
        onKeyDown={onKeyDown}
        className={cn(
          'absolute z-[2] flex items-center justify-center rounded-sm select-none',
          !readOnly && 'touch-none',
          nameOnHover && 'peer',
          dragging ? 'cursor-grabbing' : readOnly ? 'cursor-pointer' : 'cursor-grab',
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
        className={cn(
          'pointer-events-none absolute flex items-center text-meta whitespace-nowrap',
          nameOnHover
            ? 'z-[5] rounded-sm border border-default bg-elevated px-1.5 text-fg opacity-0 shadow-popover peer-hover:opacity-100 peer-focus-visible:opacity-100'
            : cn('z-[2] px-1 text-fg-secondary', chip.className),
        )}
        style={{
          ...(nameOnHover ? null : chip.style),
          left: nameOnHover ? centerX + 12 : centerX + 8,
          top: BAR_TOP,
          height: BAR_HEIGHT,
          maxWidth: nameOnHover ? undefined : OUTSIDE_LABEL_MAX_WIDTH,
        }}
      >
        {nameOnHover ? name : <span className="min-w-0 truncate">{name}</span>}
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
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[3px] rounded-[1px] bg-(--gantt-summary)"
      />
      <span
        aria-hidden
        className="absolute top-0 left-0 h-[7px] w-0.5 rounded-b-[1px] bg-(--gantt-summary)"
      />
      <span
        aria-hidden
        className="absolute top-0 right-0 h-[7px] w-0.5 rounded-b-[1px] bg-(--gantt-summary)"
      />
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

/** Dashed tick at the original date of a point (due flag, start tick, milestone) being moved. */
export function PointGhost({ x }: { x: number }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute z-[1] h-4 w-px border-l border-dashed border-(--gantt-drag-ghost-border)"
      style={{ left: x, top: ROW_HEIGHT / 2 - 8 }}
    />
  )
}

/**
 * Where the Auto-schedule preview would move this task (dashed accent outline + Δ days), shown
 * while the preview dialog is open — nothing is written until the user confirms.
 */
export function ScheduleGhost({ rect, label }: { rect: BarRect; label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute z-[3] flex items-center justify-end rounded-sm border border-dashed border-accent bg-(--gantt-drag-ghost) px-1 text-micro font-medium whitespace-nowrap text-accent-text tabular-nums"
      style={{ left: rect.left, width: Math.max(rect.width, 8), top: BAR_TOP, height: BAR_HEIGHT }}
    >
      {rect.width >= 34 ? label : null}
    </span>
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
