import { formatDate, formatDateSmart } from '@/domain/dates'
import type { ISODate, Milestone } from '@/domain/types'
import { insetFocus } from '@/components/ui/styles'
import { cn } from '@/lib/utils'
import { listColumn, rowDivider } from './listColumns'

/** Diamond glyph: filled for upcoming milestones, outlined once the date has passed. */
export function MilestoneGlyph({ past, className }: { past: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      aria-hidden
      className={cn('shrink-0', className)}
    >
      <rect
        x="4.25"
        y="4.25"
        width="7.5"
        height="7.5"
        rx="1.5"
        transform="rotate(45 8 8)"
        fill={past ? 'none' : 'currentColor'}
        stroke="currentColor"
        strokeWidth={past ? 1.5 : 0}
      />
    </svg>
  )
}

/** A milestone inside its group: diamond, name and date; opens the milestone dialog. */
export function MilestoneRow({
  milestone,
  today,
  onOpen,
}: {
  milestone: Milestone
  today: ISODate
  onOpen: (milestoneId: string) => void
}) {
  const past = milestone.date < today
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(milestone.id)}
        aria-label={`Milestone ${milestone.name}, ${formatDate(milestone.date, 'long')}${past ? ' (passed)' : ''}`}
        className={cn(
          'flex h-9 w-full items-center pr-3 pl-1 text-left text-ui',
          rowDivider,
          'transition-colors duration-fast hover:bg-hover hover:duration-instant',
          insetFocus,
        )}
      >
        <span className="w-10 shrink-0" aria-hidden />
        <span className="grid size-6 shrink-0 place-items-center">
          <MilestoneGlyph past={past} className={past ? 'text-fg-tertiary' : 'text-fg-secondary'} />
        </span>
        <span
          className={cn('min-w-0 flex-1 truncate px-1.5', past ? 'text-fg-secondary' : 'text-fg')}
        >
          {milestone.name}
        </span>
        {/* Same right-hand columns as a task row: priority · start · due · menu. */}
        <span className="flex shrink-0 items-center gap-1" aria-hidden>
          <span className={listColumn.priority} />
          <span className={listColumn.start} />
          <span
            className={cn(
              'pr-1.5 text-right text-meta text-fg-secondary tabular-nums',
              listColumn.due,
            )}
          >
            {formatDateSmart(milestone.date, today)}
          </span>
          <span className={listColumn.menu} />
        </span>
      </button>
    </li>
  )
}
