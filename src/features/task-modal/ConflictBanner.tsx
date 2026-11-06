import { Link } from 'react-router'
import { ChartGantt, History, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { withTaskParam } from '@/app/taskModalRoute'
import { formatDateSmart } from '@/domain/dates'
import type { DependencyConflict } from '@/domain/scheduling'
import type { ISODate, Task } from '@/domain/types'

const MAX_LISTED = 3

export interface ConflictBannerProps {
  task: Pick<Task, 'id' | 'projectId'>
  /** Conflicts involving this task (as predecessor or successor), from `findConflicts`. */
  conflicts: readonly DependencyConflict[]
  tasksById: Record<string, Task>
  today: ISODate
  /** The conflicts come from dates the user has not saved yet. */
  pending?: boolean
}

/**
 * Dependency conflicts of this task with the date it (or its successor) should start, and a
 * link to the project Gantt where they can be reviewed and auto-scheduled.
 */
export function ConflictBanner({
  task,
  conflicts,
  tasksById,
  today,
  pending = false,
}: ConflictBannerProps) {
  if (conflicts.length === 0) return null
  const listed = conflicts.slice(0, MAX_LISTED)
  const hidden = conflicts.length - listed.length
  const gantt = {
    pathname: `/projects/${encodeURIComponent(task.projectId)}/gantt`,
    search: withTaskParam('', task.id),
  }

  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-lg bg-warning-subtle px-3 py-2.5 text-ui"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg">
          {conflicts.length === 1
            ? 'Dependency conflict'
            : `${conflicts.length} dependency conflicts`}
          {pending ? ' with these dates' : null}
        </p>
        <ul className="mt-0.5 space-y-0.5 text-fg-secondary">
          {listed.map((conflict) => {
            const required = formatDateSmart(conflict.requiredStart, today)
            if (conflict.successorId === task.id) {
              const predecessor = tasksById[conflict.predecessorId]
              return (
                <li key={conflict.dependencyId}>
                  Starts before “{predecessor?.title ?? 'a blocking task'}” finishes. Start on or
                  after <span className="font-medium whitespace-nowrap text-fg">{required}</span>.
                </li>
              )
            }
            const successor = tasksById[conflict.successorId]
            return (
              <li key={conflict.dependencyId}>
                “{successor?.title ?? 'A blocked task'}” starts before this task finishes. It should
                start on or after{' '}
                <span className="font-medium whitespace-nowrap text-fg">{required}</span>.
              </li>
            )
          })}
          {hidden > 0 ? <li>…and {hidden} more.</li> : null}
        </ul>
      </div>
      <Button asChild variant="ghost" size="xs" className="shrink-0 text-fg">
        <Link to={gantt}>
          <ChartGantt aria-hidden />
          Open Gantt
        </Link>
      </Button>
    </div>
  )
}

export interface HistoricalNoteProps {
  task: Pick<Task, 'id'>
  /** Violated dependencies whose successor is done, involving this task. */
  inconsistencies: readonly DependencyConflict[]
  tasksById: Record<string, Task>
  today: ISODate
}

/**
 * A quiet note (not a warning) for dependencies that were violated when the successor was
 * completed: the dates are what actually happened, so nothing is flagged red and Auto-schedule
 * never changes them. Shown so the information is not lost.
 */
export function HistoricalNote({ task, inconsistencies, tasksById, today }: HistoricalNoteProps) {
  if (inconsistencies.length === 0) return null
  const listed = inconsistencies.slice(0, MAX_LISTED)
  const hidden = inconsistencies.length - listed.length
  return (
    <div
      role="note"
      className="flex items-start gap-2.5 rounded-lg bg-muted px-3 py-2.5 text-ui text-fg-secondary"
    >
      <History className="mt-0.5 size-4 shrink-0 text-fg-tertiary" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg">Completed out of order</p>
        <ul className="mt-0.5 space-y-0.5">
          {listed.map((item) =>
            item.successorId === task.id ? (
              <li key={item.dependencyId}>
                Started on {formatDateSmart(item.actualStart, today)}, before “
                {tasksById[item.predecessorId]?.title ?? 'a blocking task'}” finished.
              </li>
            ) : (
              <li key={item.dependencyId}>
                “{tasksById[item.successorId]?.title ?? 'A later task'}” was completed before this
                task finished.
              </li>
            ),
          )}
          {hidden > 0 ? <li>…and {hidden} more.</li> : null}
        </ul>
        <p className="mt-1 text-meta text-fg-tertiary">
          Kept as it was: completed tasks are never rescheduled automatically.
        </p>
      </div>
    </div>
  )
}
