/**
 * ONE SVG for every visible Finish-to-Start line (design-research §5.6): grey solid when fine,
 * danger + dashed when violated, accent when hovered / selected / attached to the bar being
 * dragged. Each line has a transparent 10px hit path (`data-handle="dep"`) for selection.
 * The SVG is decorative for assistive tech: conflicts are announced on the successor bars and
 * listed in the conflicts popover; dependencies are edited in the Task Modal.
 */
import { memo } from 'react'
import { cn } from '@/lib/utils'
import type { Point } from '../model/geometry'
import type { LinkView } from '../model/links'

/** The region of the timeline (timeline px, body px) the SVG covers: the rendered rows × days. */
export interface LinkBox {
  x: number
  y: number
  width: number
  height: number
}

export interface LinkLayerProps {
  links: LinkView[]
  selectedId: string | null
  /** Task whose links are emphasised (being dragged). */
  emphasizedTaskId: string | null
  /** Left edge of the timeline inside the body (the outline pane width). */
  offsetLeft: number
  /**
   * The SVG only spans the rendered window (a full-width SVG on a long Day timeline would be
   * hundreds of thousands of px wide); paths keep timeline coordinates through the viewBox, and
   * parts outside the box (off screen anyway) still paint thanks to overflow: visible.
   */
  box: LinkBox
}

export const LinkLayer = memo(function LinkLayer({
  links,
  selectedId,
  emphasizedTaskId,
  offsetLeft,
  box,
}: LinkLayerProps) {
  const width = Math.max(1, box.width)
  const height = Math.max(1, box.height)
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute z-[1] overflow-visible"
      style={{ left: offsetLeft + box.x, top: box.y, width, height }}
      width={width}
      height={height}
      viewBox={`${box.x} ${box.y} ${width} ${height}`}
    >
      {links.map((link) => {
        const selected = link.id === selectedId
        const emphasized =
          emphasizedTaskId !== null &&
          (link.predecessorId === emphasizedTaskId || link.successorId === emphasizedTaskId)
        const tone = selected ? 'active' : link.conflict ? 'conflict' : emphasized ? 'active' : 'normal'
        return (
          <g key={link.id} className="group/link" data-conflict={link.conflict || undefined}>
            <path
              d={link.route.d}
              fill="none"
              strokeWidth={selected ? 2 : 1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={link.conflict ? '4 3' : undefined}
              className={cn(
                tone === 'active' && 'stroke-(--gantt-dependency-active)',
                tone === 'conflict' && 'stroke-(--gantt-conflict)',
                tone === 'normal' &&
                  'stroke-(--gantt-dependency) group-hover/link:stroke-(--gantt-dependency-active)',
              )}
            />
            <path
              d={link.route.arrow}
              className={cn(
                tone === 'active' && 'fill-(--gantt-dependency-active)',
                tone === 'conflict' && 'fill-(--gantt-conflict)',
                tone === 'normal' &&
                  'fill-(--gantt-dependency) group-hover/link:fill-(--gantt-dependency-active)',
              )}
            />
            <path
              d={link.route.d}
              data-handle="dep"
              data-dep-id={link.id}
              fill="none"
              stroke="transparent"
              strokeWidth={10}
              // Hit-testable along the (invisible, 10px) stroke only; the SVG itself is not.
              style={{ pointerEvents: 'stroke' }}
              className="cursor-pointer"
            />
          </g>
        )
      })}
    </svg>
  )
})

/** The line that follows the pointer while a dependency is being drawn. */
export function LinkDraftLine({
  from,
  to,
  left,
  valid,
}: {
  from: Point
  to: Point
  left: number
  valid: boolean | null
}) {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute top-0 z-[4] overflow-visible"
      style={{ left, width: 1, height: 1 }}
    >
      <path
        d={`M${from.x} ${from.y} L${to.x} ${to.y}`}
        fill="none"
        strokeWidth={1.5}
        strokeDasharray="4 3"
        className={valid === false ? 'stroke-danger' : 'stroke-accent'}
      />
      <circle
        cx={to.x}
        cy={to.y}
        r={3}
        className={valid === false ? 'fill-danger' : 'fill-accent'}
      />
    </svg>
  )
}
