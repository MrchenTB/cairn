/**
 * Calm settings building blocks: a titled group (hairline-bordered panel, rows divided by
 * hairlines), a row (label + help on the left, the control on the right) and a quiet notice.
 */
import { useId, type ComponentType, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function SettingsGroup({
  title,
  description,
  children,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
}) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className={cn('flex min-w-0 flex-col', className)}>
      <h2 id={titleId} className="text-heading font-semibold text-fg">
        {title}
      </h2>
      {description ? <p className="mt-0.5 text-ui text-fg-secondary">{description}</p> : null}
      <div className="mt-3 divide-y divide-subtle overflow-hidden rounded-lg border border-default bg-surface">
        {children}
      </div>
    </section>
  )
}

export function SettingRow({
  title,
  description,
  children,
  stacked = false,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  /** The control, on the right (or below the text when `stacked`). */
  children?: ReactNode
  /** Wide controls (pickers, forms): put them under the text instead of beside it. */
  stacked?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 px-4 py-3.5',
        !stacked && '@lg:flex-row @lg:items-center @lg:justify-between @lg:gap-6',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-ui font-medium text-fg">{title}</div>
        {description ? (
          <div className="mt-0.5 text-meta text-fg-secondary">{description}</div>
        ) : null}
      </div>
      {children ? (
        <div
          className={cn('flex min-w-0 flex-wrap items-center gap-2', !stacked && '@lg:shrink-0')}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** One label/value line of a read-only list (`<dl>` row). */
export function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-2.5 @md:flex-row @md:items-baseline @md:justify-between @md:gap-6">
      <dt className="shrink-0 text-ui text-fg-secondary">{label}</dt>
      <dd className="min-w-0 text-ui text-fg @md:text-right">{children}</dd>
    </div>
  )
}

/** Informational note (icon + text) inside a group. */
export function SettingsNotice({
  icon: Icon,
  children,
}: {
  icon: ComponentType<{ className?: string }>
  children: ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5 bg-muted/60 px-4 py-3 text-meta text-fg-secondary">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-fg-tertiary" aria-hidden />
      <p className="min-w-0">{children}</p>
    </div>
  )
}
