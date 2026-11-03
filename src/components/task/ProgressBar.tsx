import { cn } from '@/lib/utils'

export interface ProgressBarProps {
  /** 0–100, or null when the project has no tasks ("No tasks", never a fake 100%). */
  value: number | null
  /** Completed / total leaf tasks, for the accessible value text ("3 of 5 tasks done"). */
  done?: number
  total?: number
  /** Show the percentage next to the bar (default true). */
  showValue?: boolean
  'aria-label'?: string
  className?: string
  /** Width/height of the track (default 64×4px). */
  barClassName?: string
}

/** Thin progress bar: 4px track (--bg-active), accent fill, tabular percentage. */
export function ProgressBar({
  value,
  done,
  total,
  showValue = true,
  'aria-label': ariaLabel = 'Progress',
  className,
  barClassName,
}: ProgressBarProps) {
  if (value === null) {
    return (
      <span className={cn('text-meta whitespace-nowrap text-fg-tertiary', className)}>
        No tasks
      </span>
    )
  }
  const percent = Math.min(100, Math.max(0, Math.round(value)))
  const valueText =
    done !== undefined && total !== undefined
      ? `${percent}% · ${done} of ${total} tasks done`
      : `${percent}%`
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={valueText}
        className={cn('block h-1 w-16 shrink-0 overflow-hidden rounded-full bg-active', barClassName)}
      >
        <span
          className="block h-full rounded-full bg-accent transition-[width] duration-slow ease-move"
          style={{ width: `${percent}%` }}
        />
      </span>
      {showValue ? (
        <span className="text-meta text-fg-secondary tabular-nums">{percent}%</span>
      ) : null}
    </span>
  )
}
