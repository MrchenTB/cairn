/**
 * Sticky two-tier time header, the background grid (CSS gradients + a few boundary lines, no
 * per-day nodes) and the today line. Only cells inside the render window exist in the DOM.
 */
import { memo, type CSSProperties } from 'react'
import type { GanttScale } from '@/app/viewPrefs'
import { cn } from '@/lib/utils'
import { DUE_COLUMN_WIDTH, HEADER_HEIGHT } from '../model/constants'
import type { GridBackgroundStyle, GridLine, HeaderTiers } from '../model/scale'

export interface TimeHeaderProps {
  tiers: HeaderTiers
  scale: GanttScale
  paneWidth: number
  timelineWidth: number
  /** Centre of today in timeline px (null when outside the range). */
  todayX: number | null
  todayLabel: string
}

export const TimeHeader = memo(function TimeHeader({
  tiers,
  scale,
  paneWidth,
  timelineWidth,
  todayX,
  todayLabel,
}: TimeHeaderProps) {
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
          <span>Task</span>
          <span className="text-right" style={{ width: DUE_COLUMN_WIDTH }}>
            Due
          </span>
        </div>
      </div>
      <div aria-hidden className="relative shrink-0 select-none" style={{ width: timelineWidth }}>
        {tiers.top.map((cell) => (
          <div
            key={cell.key}
            title={cell.title}
            className="absolute top-0 flex h-6 items-center border-l border-(--gantt-grid-strong)"
            style={{ left: cell.x, width: cell.width }}
          >
            {/* Sticks to the pane edge so a partly scrolled-off month keeps its label. */}
            <span
              className="sticky truncate px-2 text-meta font-medium text-fg-secondary"
              style={{ left: paneWidth }}
            >
              {cell.label}
            </span>
          </div>
        ))}
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
            <span className="truncate">{cell.label}</span>
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
      className="pointer-events-none absolute top-0 z-[1] w-[1.5px] bg-(--gantt-today)"
      style={{ left: x - 0.75, height }}
    />
  )
}
