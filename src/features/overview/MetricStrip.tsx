import { useId } from 'react'
import { Link } from 'react-router'
import type { OverviewMetrics } from '@/domain/buckets'
import { DUE_SOON_HREF } from '@/features/my-tasks/myTasksModel'
import { cn } from '@/lib/utils'

/**
 * Where each number leads — a page that shows exactly the tasks / projects the number counts:
 * Active projects → the Projects page (Active filter); Open tasks → My Tasks › All; Due soon →
 * My Tasks › All narrowed to Today + Upcoming (`?due=soon`; no single tab holds both); Overdue →
 * My Tasks › Overdue.
 */
const METRIC_HREFS = {
  active: '/projects?status=active',
  open: '/my-tasks/all',
  soon: DUE_SOON_HREF,
  overdue: '/my-tasks/overdue',
} as const

interface MetricItem {
  key: keyof typeof METRIC_HREFS
  label: string
  qualifier?: string
  value: number
  attention?: boolean
}

/**
 * The four Overview numbers in calm, text-first cells (number 20px/600 + 12px label in a neutral
 * card): Active projects, Open tasks, Due soon (today + next 7 days), Overdue. Each card is one
 * link (its label, stretched over the card) to the matching list. The overdue number takes the
 * danger tone only when there is something overdue; a zero reads as tertiary, not as a result.
 * Values from `overviewMetrics()`. Labels wrap instead of truncating.
 */
export function MetricStrip({ metrics }: { metrics: OverviewMetrics }) {
  const items: MetricItem[] = [
    { key: 'active', label: 'Active projects', value: metrics.activeProjects },
    { key: 'open', label: 'Open tasks', value: metrics.openTasks },
    { key: 'soon', label: 'Due soon', qualifier: 'next 7 days', value: metrics.dueSoon },
    { key: 'overdue', label: 'Overdue', value: metrics.overdue, attention: metrics.overdue > 0 },
  ]
  return (
    <dl aria-label="Summary" className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
      {items.map(({ key, ...item }) => (
        <Metric key={key} metricKey={key} {...item} />
      ))}
    </dl>
  )
}

function Metric({
  metricKey,
  label,
  qualifier,
  value,
  attention,
}: Omit<MetricItem, 'key'> & { metricKey: MetricItem['key'] }) {
  const valueId = useId()
  return (
    <div
      data-metric={metricKey}
      className={cn(
        'relative flex min-w-0 flex-col gap-0.5 rounded-lg border border-default bg-surface px-4 py-3',
        'transition-colors duration-fast hover:border-strong hover:bg-hover hover:duration-instant',
      )}
    >
      {/* Number above label visually; the markup stays term → value for assistive tech. */}
      <dt className="order-2 text-meta text-fg-tertiary">
        <Link
          to={METRIC_HREFS[metricKey]}
          aria-describedby={valueId}
          className={cn(
            'rounded-sm',
            // The link covers the card: one tab stop, the whole card is the click target.
            'after:absolute after:-inset-px after:rounded-lg after:content-[""] focus-visible:outline-none',
            'focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus',
          )}
        >
          {label}
          {qualifier ? <span className="whitespace-nowrap"> · {qualifier}</span> : null}
        </Link>
      </dt>
      <dd
        id={valueId}
        className={cn(
          'order-1 text-title font-semibold tabular-nums',
          attention ? 'text-danger' : value === 0 ? 'text-fg-tertiary' : 'text-fg',
        )}
      >
        {value.toLocaleString('en-US')}
      </dd>
    </div>
  )
}
