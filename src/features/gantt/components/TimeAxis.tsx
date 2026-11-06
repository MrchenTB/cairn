/**
 * Sticky two-tier time header, the background grid (CSS gradients + a few boundary lines, no
 * per-day nodes) and the today line. Only cells inside the render window exist in the DOM.
 */
import { memo, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { GanttScale } from '@/app/viewPrefs'
import { cn } from '@/lib/utils'
import { DUE_COLUMN_WIDTH, HEADER_HEIGHT } from '../model/constants'
import type { TimelineGeometry } from '../model/geometry'
import { labelOverlapsPill } from '../model/scale'
import type { GridBackgroundStyle, GridLine, HeaderTiers } from '../model/scale'
import type { ScrollPosition } from '../model/scrollPosition'
import { measureLabelWidth } from './measure'

/** px-1.5 of a lower-tier cell: where its label starts. */
const CELL_PADDING = 6

export interface TimeHeaderProps {
  tiers: HeaderTiers
  scale: GanttScale
  geometry: TimelineGeometry
  paneWidth: number
  timelineWidth: number
  /** Centre of today in timeline px (null when outside the range). */
  todayX: number | null
  todayLabel: string
  scroll: ScrollPosition
  /** Column labels of the left pane (default: Task / Due). Keep it stable: the header is memoised. */
  paneHeader?: ReactNode
}

const GANTT_PANE_HEADER = (
  <>
    <span>Task</span>
    <span className="text-right" style={{ width: DUE_COLUMN_WIDTH }}>
      Due
    </span>
  </>
)

export const TimeHeader = memo(function TimeHeader({
  tiers,
  scale,
  geometry,
  paneWidth,
  timelineWidth,
  todayX,
  todayLabel,
  scroll,
  paneHeader = GANTT_PANE_HEADER,
}: TimeHeaderProps) {
  // The first visible day: a top-tier label sticks to the pane edge while its unit scrolls out,
  // and is hidden once the visible rest of the unit is too narrow to hold it.
  const firstVisibleDay = useSyncExternalStore(
    scroll.subscribe,
    () => geometry.originDay + Math.floor(scroll.get() / geometry.dayWidth),
    () => geometry.originDay,
  )
  // The today pill sits on the lower tier. On Day it replaces the day's own label; on Week and
  // Month it would cover (part of) the label of the week / month it falls in, so that label is
  // left out: the pill names the date itself, and a half-hidden "No" next to it reads as a glitch.
  const pillHalf = todayX === null ? 0 : (measureLabelWidth(todayLabel) + 12) / 2
  return (
    <div
      className="sticky top-0 z-20 flex border-b border-default bg-(--gantt-header-bg)"
      style={{ width: paneWidth + timelineWidth, height: HEADER_HEIGHT }}
    >
      <div
        className="sticky left-0 z-[2] flex shrink-0 flex-col justify-end border-r border-default bg-(--gantt-header-bg) pr-3 pl-3"
        style={{ width: paneWidth }}
      >
        <div className="flex h-6 items-center justify-between text-meta font-medium text-fg-tertiary">
          {paneHeader}
        </div>
      </div>
      <div aria-hidden className="relative shrink-0 select-none" style={{ width: timelineWidth }}>
        {tiers.top.map((cell) => {
          const visibleDays = cell.endDay - Math.max(cell.startDay, firstVisibleDay) + 1
          const fits = visibleDays * geometry.dayWidth >= measureLabelWidth(cell.label) + 16
          return (
            <div
              key={cell.key}
              title={cell.title}
              className="absolute top-0 flex h-6 items-center border-l border-(--gantt-grid-strong)"
              style={{ left: cell.x, width: cell.width }}
            >
              {/* Sticks to the pane edge so a partly scrolled-off month keeps its label (no
                  overflow clipping on the cell: that would make the cell the sticky container). */}
              {fits ? (
                <span
                  className="sticky px-2 text-meta font-medium whitespace-nowrap text-fg-secondary"
                  style={{ left: paneWidth }}
                >
                  {cell.label}
                </span>
              ) : null}
            </div>
          )
        })}
        {tiers.bottom.map((cell) => (
          <div
            key={cell.key}
            title={cell.title}
            className={cn(
              'absolute top-6 flex h-6 items-center border-l border-(--gantt-grid) text-micro whitespace-nowrap text-fg-tertiary tabular-nums',
              scale === 'day' ? 'justify-center' : 'px-1.5',
              cell.weekend && 'bg-(--gantt-weekend)',
            )}
            style={{ left: cell.x, width: cell.width }}
          >
            {cell.prefix ? <span className="mr-1 opacity-70">{cell.prefix}</span> : null}
            {scale !== 'day' &&
            todayX !== null &&
            labelOverlapsPill(
              cell.x + CELL_PADDING,
              measureLabelWidth(cell.label),
              todayX,
              pillHalf,
            ) ? null : (
              <span className="truncate">{cell.label}</span>
            )}
          </div>
        ))}
        {todayX !== null ? (
          <span
            className="pointer-events-none absolute top-6 z-[1] flex h-6 -translate-x-1/2 items-center"
            style={{ left: todayX }}
          >
            <span className="rounded-full bg-(--gantt-today-label-bg) px-1.5 text-micro leading-[18px] font-medium text-(--gantt-today-label-fg) tabular-nums">
              {todayLabel}
            </span>
          </span>
        ) : null}
      </div>
    </div>
  )
})

export interface GridBackgroundProps {
  style: GridBackgroundStyle | null
  lines: GridLine[]
  left: number
  width: number
  height: number
}

export const GridBackground = memo(function GridBackground({
  style,
  lines,
  left,
  width,
  height,
}: GridBackgroundProps) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute top-0 z-0"
      style={{ left, width, height, ...(style as CSSProperties | null) }}
    >
      {lines.map((line) => (
        <span
          key={line.key}
          className={cn(
            'absolute inset-y-0 w-px',
            line.strong ? 'bg-(--gantt-grid-strong)' : 'bg-(--gantt-grid)',
          )}
          style={{ left: line.x }}
        />
      ))}
    </div>
  )
})

export function TodayLine({ x, height }: { x: number; height: number }) {
  return (
    <span
      aria-hidden
      data-testid="gantt-today-line"
      className="pointer-events-none absolute top-0 z-[1] w-[1.5px] bg-(--gantt-today)"
      style={{ left: x - 0.75, height }}
    />
  )
}
