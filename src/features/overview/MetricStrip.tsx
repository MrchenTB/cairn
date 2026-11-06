import type { OverviewMetrics } from '@/domain/buckets'
import { cn } from '@/lib/utils'

/**
 * The four Overview numbers in calm, text-first cells (number 20px/600 + 12px label in a neutral
 * card): Active projects, Open tasks, Due soon (today + next 7 days), Overdue — the overdue number
 * takes the danger tone only when there is something overdue. Values from `overviewMetrics()`.
 * Labels wrap instead of truncating, so a narrow window never hides what a number means.
 */
export function MetricStrip({ metrics }: { metrics: OverviewMetrics }) {
  const items = [
    { key: 'active', label: 'Active projects', value: metrics.activeProjects },
    { key: 'open', label: 'Open tasks', value: metrics.openTasks },
    { key: 'soon', label: 'Due soon', qualifier: 'next 7 days', value: metrics.dueSoon },
    { key: 'overdue', label: 'Overdue', value: metrics.overdue, attention: metrics.overdue > 0 },
  ]
  return (
    <dl aria-label="Summary" className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.key}
          data-metric={item.key}
          className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-default bg-surface px-4 py-3"
        >
          {/* Number above label visually; the markup stays term → value for assistive tech. */}
          <dt className="order-2 text-meta text-fg-tertiary">
            {item.label}
            {item.qualifier ? <span className="whitespace-nowrap"> · {item.qualifier}</span> : null}
          </dt>
          <dd
            className={cn(
              'order-1 text-title font-semibold tabular-nums',
              item.attention ? 'text-danger' : 'text-fg',
            )}
          >
            {item.value.toLocaleString('en-US')}
          </dd>
        </div>
      ))}
    </dl>
  )
}
