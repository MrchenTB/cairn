import type { TaskStatus } from '@/domain/types'
import { cn } from '@/lib/utils'
import { STATUS_LABELS } from './labels'

const STATUS_COLOR: Record<TaskStatus, string> = {
  todo: 'text-status-todo',
  in_progress: 'text-status-in-progress',
  done: 'text-status-done',
}

export interface StatusIconProps {
  status: TaskStatus
  /** 16 (default) or 14 in dense meta rows. */
  size?: number
  className?: string
  /** Hide from assistive tech when a visible label sits next to it. */
  decorative?: boolean
}

/**
 * Original rounded-square status glyphs (shape + colour, never colour alone):
 * To Do = hollow square · In Progress = square with a "water level" · Done = filled square + check.
 */
export function StatusIcon({ status, size = 16, className, decorative = false }: StatusIconProps) {
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img', 'aria-label': `Status: ${STATUS_LABELS[status]}` }
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      data-status={status}
      className={cn('shrink-0', STATUS_COLOR[status], className)}
      {...a11y}
    >
      {status === 'done' ? (
        <>
          <rect x="2" y="2" width="12" height="12" rx="3.5" fill="currentColor" />
          <path
            d="M5.25 8.25 7.1 10.1 10.75 6.25"
            stroke="var(--fg-inverse)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <rect
            x="2.75"
            y="2.75"
            width="10.5"
            height="10.5"
            rx="3"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          {status === 'in_progress' ? (
            <rect x="5" y="8" width="6" height="3" rx="1" fill="currentColor" />
          ) : null}
        </>
      )}
    </svg>
  )
}
