import { cn } from '@/lib/utils'

export interface SpinnerProps {
  /** Pixel size (default 14 — the in-button size from the design doc). */
  size?: number
  className?: string
  /** Accessible label; pass `null` when a parent already announces the busy state. */
  label?: string | null
}

/** Small circular activity indicator. Inherits currentColor. */
export function Spinner({ size = 14, className, label = 'Loading' }: SpinnerProps) {
  const a11y = label ? { role: 'status' as const, 'aria-label': label } : { 'aria-hidden': true }
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      className={cn('shrink-0 animate-spin [animation-duration:0.8s]', className)}
      {...a11y}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path
        d="M14.25 8A6.25 6.25 0 0 0 8 1.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}
