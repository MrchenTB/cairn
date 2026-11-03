import type { ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import { useToday } from '@/data/hooks'
import { dueBucket } from '@/domain/buckets'
import { formatDate, formatDateSmart } from '@/domain/dates'
import type { ISODate, TaskStatus } from '@/domain/types'
import { cn } from '@/lib/utils'

export interface DueLabelProps {
  dueDate: ISODate | null
  status: TaskStatus
  /** Rendered when there is no due date (default: nothing). */
  empty?: ReactNode
  className?: string
}

/**
 * Due date in the shared bucket language: overdue = danger tone + icon + "Overdue" for AT,
 * today = warning tone ("Today"), otherwise tertiary. Done tasks are always neutral.
 */
export function DueLabel({ dueDate, status, empty = null, className }: DueLabelProps) {
  const today = useToday()
  if (!dueDate) return <>{empty}</>
  const bucket = dueBucket({ status, dueDate }, today)
  const text = formatDateSmart(dueDate, today)
  const overdue = bucket === 'overdue'
  return (
    <span
      data-bucket={bucket}
      title={`${overdue ? 'Overdue · ' : ''}Due ${formatDate(dueDate, 'medium')}`}
      className={cn(
        'inline-flex items-center gap-1 text-meta whitespace-nowrap tabular-nums',
        overdue ? 'text-danger' : bucket === 'today' ? 'text-warning' : 'text-fg-tertiary',
        className,
      )}
    >
      {overdue ? <CircleAlert className="size-3.5 shrink-0" aria-hidden /> : null}
      <span>{text}</span>
      {overdue ? <span className="sr-only">(overdue)</span> : null}
    </span>
  )
}
