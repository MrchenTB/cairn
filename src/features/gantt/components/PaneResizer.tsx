/**
 * The 1px divider between the outline pane and the timeline, doubling as its resize handle
 * (drag, ←/→ in steps, Home/End, double-click or Enter = default width). Lives outside the scroll
 * container, so it never scrolls away.
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import {
  PANE_WIDTH_DEFAULT,
  PANE_WIDTH_MAX,
  PANE_WIDTH_MIN,
  PANE_WIDTH_STEP,
} from '../model/constants'

export interface PaneResizerProps {
  width: number
  /** Live update while dragging / per key press (not persisted). */
  onResize: (width: number) => void
  /** Persist the current width. */
  onCommit: () => void
  /** The pane casts a soft shadow when the timeline is scrolled underneath it. */
  scrolled: boolean
}

export function PaneResizer({ width, onResize, onCommit, scrolled }: PaneResizerProps) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width }
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    onResize(current.startWidth + event.clientX - current.startX)
  }
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    drag.current = null
    onCommit()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = width - PANE_WIDTH_STEP
    else if (event.key === 'ArrowRight') next = width + PANE_WIDTH_STEP
    else if (event.key === 'Home') next = PANE_WIDTH_MIN
    else if (event.key === 'End') next = PANE_WIDTH_MAX
    else if (event.key === 'Enter') next = PANE_WIDTH_DEFAULT
    if (next === null) return
    event.preventDefault()
    onResize(next)
    onCommit()
  }

  return (
    <>
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 z-30 w-2 bg-linear-to-r from-(--border-default) to-transparent opacity-0',
          'motion-safe:transition-opacity motion-safe:duration-fast',
          scrolled && 'opacity-100',
        )}
        style={{ left: width }}
      />
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize task list"
        aria-valuenow={width}
        aria-valuemin={PANE_WIDTH_MIN}
        aria-valuemax={PANE_WIDTH_MAX}
        title="Drag to resize · double-click to reset"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onDoubleClick={() => {
          onResize(PANE_WIDTH_DEFAULT)
          onCommit()
        }}
        onKeyDown={onKeyDown}
        className={cn(
          'group/resizer absolute inset-y-0 z-30 flex w-2 -translate-x-1/2 cursor-col-resize touch-none justify-center outline-none',
          'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
        )}
        style={{ left: width }}
      >
        <span
          aria-hidden
          className={cn(
            'h-full w-px bg-default',
            'group-hover/resizer:w-0.5 group-hover/resizer:bg-accent group-active/resizer:w-0.5 group-active/resizer:bg-accent',
          )}
        />
      </div>
    </>
  )
}
