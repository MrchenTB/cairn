import type { ReactNode, Ref } from 'react'
import { cn } from '@/lib/utils'

export interface PageHeaderProps {
  title: ReactNode
  /** Leading glyph (e.g. a ProjectDot or a 16px icon). */
  icon?: ReactNode
  /** Small line above the title. */
  breadcrumb?: ReactNode
  /** One line of secondary text under the title. */
  description?: ReactNode
  /** Inline after the title: status chip, compact progress… */
  meta?: ReactNode
  /** Right side of the title row: ⋯ menu, primary action. */
  actions?: ReactNode
  /** Left side of the 40px view bar (List / Board / Gantt tabs). Omit for pages without tabs. */
  tabs?: ReactNode
  /** Right side of the view bar (view-specific controls). */
  viewActions?: ReactNode
  /** Ref to the view bar's right-hand slot element (for portalled view controls; needs `tabs`). */
  viewActionsRef?: Ref<HTMLDivElement>
  className?: string
}

/**
 * Page title area (20px/600, padding 20/24/12) plus an optional 40px view bar. The view bar is
 * a sibling of the title block, so inside a scrolling PageContainer it stays sticky.
 */
export function PageHeader({
  title,
  icon,
  breadcrumb,
  description,
  meta,
  actions,
  tabs,
  viewActions,
  viewActionsRef,
  className,
}: PageHeaderProps) {
  const hasViewBar = Boolean(tabs || viewActions)
  return (
    <>
      <header
        data-slot="page-header"
        className={cn('flex shrink-0 items-start justify-between gap-4 px-6 pt-5 pb-3', className)}
      >
        <div className="min-w-0 flex-1">
          {breadcrumb ? <div className="mb-1 text-meta text-fg-tertiary">{breadcrumb}</div> : null}
          <div className="flex min-w-0 items-center gap-2.5">
            {icon ? <span className="flex shrink-0 items-center">{icon}</span> : null}
            <h1 className="truncate text-title font-semibold tracking-(--letter-spacing-title) text-fg">
              {title}
            </h1>
            {meta ? <div className="flex shrink-0 items-center gap-2.5">{meta}</div> : null}
          </div>
          {description ? <p className="mt-1 text-ui text-fg-secondary">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      {hasViewBar ? (
        <div
          data-slot="view-bar"
          className="sticky top-0 z-(--z-sticky) flex h-(--viewbar-height) shrink-0 items-center justify-between gap-3 bg-main px-6"
        >
          <div className="flex min-w-0 items-center gap-1">{tabs}</div>
          <div ref={viewActionsRef} className="flex shrink-0 items-center gap-1.5">
            {viewActions}
          </div>
        </div>
      ) : null}
    </>
  )
}
