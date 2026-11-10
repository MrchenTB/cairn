import { cn } from '@/lib/utils'
import { listColumn, listHeaderHeight } from './listColumns'

/**
 * Quiet, sticky row naming the right-hand columns ("Priority", "Start", "Due"), aligned to the
 * controls of the rows below through the shared `listColumn` widths. The priority column is only
 * an icon wide, so its label is centred over the icon and may reach past the column's edges into
 * the empty header space beside it. Decorative: every control already has its own accessible name.
 */
export function ListColumnHeader() {
  return (
    <div
      aria-hidden
      data-list-column-header
      className={cn(
        'sticky top-0 z-[4] flex items-center bg-main pr-3 text-meta text-fg-tertiary select-none',
        listHeaderHeight,
      )}
    >
      <span className="min-w-0 flex-1" />
      <span className="flex shrink-0 items-center gap-1">
        <span className={cn('flex justify-center', listColumn.priority)}>
          <span className="shrink-0">Priority</span>
        </span>
        <span className={cn('flex justify-end px-1.5', listColumn.start)}>Start</span>
        <span className={cn('flex justify-end px-1.5', listColumn.due)}>Due</span>
        <span className={listColumn.menu} />
      </span>
    </div>
  )
}
