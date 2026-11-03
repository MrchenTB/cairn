import type { TaskPriority } from '@/domain/types'
import { cn } from '@/lib/utils'
import { PRIORITY_LABELS } from './labels'

const PRIORITY_COLOR: Record<TaskPriority, string> = {
  none: 'text-priority-none',
  low: 'text-priority-low',
  medium: 'text-priority-medium',
  high: 'text-priority-high',
  urgent: 'text-priority-urgent',
}

/** Number of solid stones per level (urgent adds a capstone on top of three). */
const SOLID_STONES: Record<TaskPriority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 3,
}
const DIM = 0.28

export interface PriorityIconProps {
  priority: TaskPriority
  size?: number
  className?: string
  decorative?: boolean
}

/**
 * "Cairn stones" priority glyph: the level is the number of solid stones (Low 1, Medium 2,
 * High 3, Urgent 3 + capstone), readable even in greyscale. Low/Medium stay neutral in colour.
 */
export function PriorityIcon({
  priority,
  size = 16,
  className,
  decorative = false,
}: PriorityIconProps) {
  const solid = SOLID_STONES[priority]
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img', 'aria-label': `Priority: ${PRIORITY_LABELS[priority]}` }
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      data-priority={priority}
      className={cn('shrink-0', PRIORITY_COLOR[priority], className)}
      {...a11y}
    >
      <rect x="2" y="11.5" width="12" height="2.5" rx="1.25" opacity={solid >= 1 ? 1 : DIM} />
      <rect x="3.5" y="8" width="9" height="2.5" rx="1.25" opacity={solid >= 2 ? 1 : DIM} />
      <rect x="5" y="4.5" width="6" height="2.5" rx="1.25" opacity={solid >= 3 ? 1 : DIM} />
      {priority === 'urgent' ? <circle cx="8" cy="2.25" r="1.25" /> : null}
    </svg>
  )
}
