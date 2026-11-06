import { useMemo } from 'react'
import { Link } from 'react-router'
import { Plus } from 'lucide-react'
import { useUIStore } from '@/app/uiStore'
import { Button } from '@/components/ui/button'
import { TaskRowList } from '@/features/my-tasks/TaskRowList'
import { cn } from '@/lib/utils'
import type { UpcomingTasks as UpcomingTasksModel } from './overviewModel'
import { OverviewSection, SectionEmpty, SectionLink } from './OverviewSection'

export interface UpcomingTasksProps {
  upcoming: UpcomingTasksModel
  /** Tasks in the bucket population at all (any status). */
  hasTasks: boolean
}

/**
 * Overdue tasks first (danger due labels), then today's, then the next 7 days — the same rows
 * and rules as My Tasks, at most UPCOMING_TASKS_LIMIT. Status changes in place; a row opens the
 * Task Modal.
 */
export function UpcomingTasks({ upcoming, hasTasks }: UpcomingTasksProps) {
  const openNewTask = useUIStore((s) => s.openNewTask)
  const sections = useMemo(() => [{ key: 'upcoming', tasks: upcoming.tasks }], [upcoming.tasks])
  return (
    <OverviewSection
      title="Upcoming tasks"
      count={upcoming.total}
      hint="Overdue, today and next 7 days"
    >
      {upcoming.total === 0 ? (
        hasTasks ? (
          <SectionEmpty
            title="Nothing due in the next 7 days"
            description="Tasks due within a week — and anything overdue — show up here."
            action={
              <Button variant="link" size="sm" asChild>
                <Link to="/my-tasks/all">View all tasks</Link>
              </Button>
            }
          />
        ) : (
          <SectionEmpty
            title="No tasks yet"
            description="Add a task with a due date to see what’s coming up."
            action={
              <Button variant="secondary" size="xs" onClick={() => openNewTask()}>
                <Plus strokeWidth={2} />
                New task
              </Button>
            }
          />
        )
      ) : (
        <>
          <TaskRowList
            sections={sections}
            label="Upcoming tasks"
            showsDone={false}
            showPriority={false}
            projectClassName="w-32"
            rowClassName="-mx-3 rounded-md pr-1.5 pl-1"
          />
          <div
            className={cn(
              'mt-1 flex items-center gap-3 text-meta text-fg-tertiary',
              upcoming.total > upcoming.tasks.length ? 'justify-between' : 'justify-end',
            )}
          >
            {upcoming.total > upcoming.tasks.length ? (
              <span className="tabular-nums">
                Showing {upcoming.tasks.length} of {upcoming.total}
              </span>
            ) : null}
            <SectionLink to="/my-tasks/all">View all in My Tasks</SectionLink>
          </div>
        </>
      )}
    </OverviewSection>
  )
}
