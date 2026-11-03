import type { ReactNode } from 'react'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface ErrorStateProps {
  /** Default "Something went wrong". */
  title?: ReactNode
  /** What failed, in user terms. */
  message?: ReactNode
  onRetry?: () => void
  retrying?: boolean
  retryLabel?: string
  /** `page` = centred block for a whole view; `banner` = inline strip above content. */
  variant?: 'page' | 'banner'
  /** Heading element for the page variant's title (default h2; h1 when it is the whole page). */
  titleAs?: 'h1' | 'h2' | 'h3'
  className?: string
}

/** Visible failure with a way out (Retry). Never fail silently. */
export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  retrying = false,
  retryLabel = 'Retry',
  variant = 'page',
  titleAs: Title = 'h2',
  className,
}: ErrorStateProps) {
  if (variant === 'banner') {
    return (
      <div
        role="alert"
        className={cn(
          'flex items-center gap-2.5 rounded-lg bg-danger-subtle px-3 py-2 text-ui text-danger',
          className,
        )}
      >
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1">
          <span className="font-medium">{title}</span>
          {message ? <span className="text-fg-secondary"> · {message}</span> : null}
        </p>
        {onRetry ? (
          <Button variant="ghost" size="xs" onClick={onRetry} loading={retrying}>
            {retrying ? null : <RefreshCw aria-hidden />}
            {retryLabel}
          </Button>
        ) : null}
      </div>
    )
  }
  return (
    <div
      role="alert"
      className={cn(
        'mx-auto flex w-full max-w-[400px] flex-col items-center px-4 pt-[12vh] pb-12 text-center',
        className,
      )}
    >
      <TriangleAlert className="mb-3 size-6 text-danger" strokeWidth={1.5} aria-hidden />
      <Title className="text-heading font-semibold text-fg">{title}</Title>
      {message ? <p className="mt-1 text-ui text-fg-secondary">{message}</p> : null}
      {onRetry ? (
        <Button variant="secondary" size="md" className="mt-4" onClick={onRetry} loading={retrying}>
          {retrying ? null : <RefreshCw aria-hidden />}
          {retryLabel}
        </Button>
      ) : null}
    </div>
  )
}
