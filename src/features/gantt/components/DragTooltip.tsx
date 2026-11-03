/**
 * Live feedback next to the pointer while dragging: the new dates (e.g. "Nov 4 – Nov 7 · 4 days")
 * or, while drawing a dependency, what dropping would do. Portalled and fixed-positioned, never
 * hit-testable (so `elementFromPoint` keeps finding the bar underneath).
 */
import { createPortal } from 'react-dom'
import { TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface DragTooltipProps {
  clientX: number
  clientY: number
  text: string
  detail?: string | null
  tone?: 'default' | 'danger'
}

export function DragTooltip({ clientX, clientY, text, detail, tone = 'default' }: DragTooltipProps) {
  if (typeof document === 'undefined') return null
  // Above-right of the pointer, flipped below near the top of the window.
  const top = clientY < 64 ? clientY + 20 : clientY - 40
  return createPortal(
    <div
      aria-hidden
      className={cn(
        'pointer-events-none fixed z-(--z-tooltip) flex max-w-xs items-center gap-1.5 rounded-md bg-inverse px-2 py-1',
        'text-meta font-medium whitespace-nowrap text-fg-inverse shadow-popover tabular-nums',
      )}
      style={{ left: clientX + 12, top }}
    >
      {tone === 'danger' ? <TriangleAlert className="size-3.5 shrink-0" aria-hidden /> : null}
      <span>{text}</span>
      {detail ? <span className="opacity-70">{detail}</span> : null}
    </div>,
    document.body,
  )
}
