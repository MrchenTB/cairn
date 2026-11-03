/** Building blocks shared by the Overview sections: heading row, quiet links, empty notes. */
import { useId, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface OverviewSectionProps {
  title: string
  /** Shown next to the title (tabular, tertiary). */
  count?: number
  /** Short muted qualifier after the title, e.g. "Next 7 days". */
  hint?: ReactNode
  /** Right side of the heading row (a SectionLink). */
  action?: ReactNode
  children: ReactNode
  className?: string
}

/** A titled block of the Overview: 13px/600 heading, optional count and hint, one quiet link. */
export function OverviewSection({
  title,
  count,
  hint,
  action,
  children,
  className,
}: OverviewSectionProps) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className={cn('flex min-w-0 flex-col', className)}>
      <div className="flex h-8 items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 id={headingId} className="shrink-0 text-ui font-semibold text-fg">
            {title}
          </h2>
          {count !== undefined ? (
            <span className="text-meta text-fg-tertiary tabular-nums">{count}</span>
          ) : null}
          {hint ? <span className="truncate text-meta text-fg-tertiary">{hint}</span> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center">{action}</div> : null}
      </div>
      <div className="mt-1 flex min-w-0 flex-col">{children}</div>
    </section>
  )
}

/** Quiet "View all"-style link (ghost button look, trailing arrow). */
export function SectionLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Button variant="ghost" size="xs" asChild className="-mr-2 text-fg-tertiary">
      <Link to={to}>
        {children}
        <ArrowRight aria-hidden strokeWidth={1.75} />
      </Link>
    </Button>
  )
}

/** Compact empty note inside a section (the page-level EmptyState is too large here). */
export function SectionEmpty({
  title,
  description,
  action,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-start gap-1 rounded-lg bg-muted px-4 py-3.5">
      <p className="text-ui font-medium text-fg-secondary">{title}</p>
      {description ? <p className="text-meta text-fg-tertiary">{description}</p> : null}
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  )
}
