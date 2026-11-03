import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export interface PageContainerProps extends ComponentProps<'div'> {
  /** `reading` centres the page at --content-max-width (Overview, Settings…); `full` spans the panel. */
  width?: 'reading' | 'full'
  /** The page scrolls vertically inside the main panel (default true). */
  scroll?: boolean
}

/**
 * Page frame inside the main panel: fills the remaining height, owns the vertical scroll, and
 * keeps PageHeader's view bar sticky while the page scrolls.
 */
export function PageContainer({
  width = 'reading',
  scroll = true,
  className,
  children,
  ...props
}: PageContainerProps) {
  return (
    <div
      data-slot="page"
      className={cn('flex min-h-0 flex-1 flex-col', scroll ? 'overflow-y-auto' : 'overflow-hidden')}
      {...props}
    >
      <div
        className={cn(
          'flex w-full flex-1 flex-col',
          width === 'reading' && 'mx-auto max-w-(--content-max-width)',
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}

/** Standard page body padding (24px sides, generous bottom). */
export function PageBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-1 flex-col px-6 pb-10', className)} {...props} />
}
