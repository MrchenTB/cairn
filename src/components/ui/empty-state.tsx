import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface EmptyStateProps {
  /** 24px line icon (lucide component), shown in tertiary text colour. */
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>
  title: ReactNode
  description?: ReactNode
  /** Primary action (one Button). */
  action?: ReactNode
  /** Optional secondary text link / button. */
  secondaryAction?: ReactNode
  /** `page` adds the 12vh top offset used for whole-view empty states; `inline` is compact. */
  variant?: 'page' | 'inline'
  className?: string
}

/** Calm empty state: icon, title, at most two lines of copy, one action. No illustrations. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  variant = 'page',
  className,
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'mx-auto flex w-full max-w-[360px] flex-col items-center px-4 text-center',
        variant === 'page' ? 'pt-[12vh] pb-12' : 'py-10',
        className,
      )}
    >
      {Icon ? <Icon className="mb-3 size-6 text-fg-tertiary" strokeWidth={1.5} /> : null}
      <h2 className="text-heading font-semibold text-fg">{title}</h2>
      {description ? (
        <p className="mt-1 line-clamp-2 text-ui text-fg-secondary">{description}</p>
      ) : null}
      {action || secondaryAction ? (
        <div className="mt-4 flex flex-col items-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  )
}
