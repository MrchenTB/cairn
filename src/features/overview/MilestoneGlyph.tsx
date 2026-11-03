import { cn } from '@/lib/utils'

/** Milestone diamond (design §5.12): filled for upcoming, outlined once the date has passed. */
export function MilestoneGlyph({
  past = false,
  size = 16,
  className,
}: {
  past?: boolean
  size?: number
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      className={cn('shrink-0', className)}
    >
      <rect
        x="4.25"
        y="4.25"
        width="7.5"
        height="7.5"
        rx="1.5"
        transform="rotate(45 8 8)"
        fill={past ? 'none' : 'currentColor'}
        stroke="currentColor"
        strokeWidth={past ? 1.5 : 0}
      />
    </svg>
  )
}
