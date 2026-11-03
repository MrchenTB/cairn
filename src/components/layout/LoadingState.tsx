import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** Deterministic title widths so rows look natural without randomness during render. */
const ROW_WIDTHS = ['w-[46%]', 'w-[62%]', 'w-[38%]', 'w-[54%]', 'w-[70%]', 'w-[42%]', 'w-[58%]']

export interface LoadingStateProps {
  /** Number of 36px skeleton rows (default 8). */
  rows?: number
  /** Show a page-title placeholder above the rows (default true). */
  header?: boolean
  /** Announced to assistive tech. */
  label?: string
  className?: string
}

/**
 * Quiet skeleton list for loading pages (no full-page spinner, no shimmer). Fades in after a
 * short delay so quick loads never flash.
 */
export function LoadingState({
  rows = 8,
  header = true,
  label = 'Loading…',
  className,
}: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn(
        'flex flex-1 flex-col px-6 pt-5 motion-safe:animate-fade-in-delayed',
        className,
      )}
    >
      <span className="sr-only">{label}</span>
      {header ? (
        <div className="flex items-center gap-3 pb-6">
          <Skeleton className="h-6 w-44 rounded-md" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ) : null}
      <div className="flex flex-col">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex h-9 items-center gap-3">
            <Skeleton className="size-4 rounded-[4px]" />
            <Skeleton className={cn('h-3', ROW_WIDTHS[index % ROW_WIDTHS.length])} />
            <Skeleton className="ml-auto h-3 w-14" />
          </div>
        ))}
      </div>
    </div>
  )
}
