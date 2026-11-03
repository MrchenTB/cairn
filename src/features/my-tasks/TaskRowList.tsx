/**
 * A list of cross-project task rows (My Tasks tabs, Overview "Upcoming tasks"): resolves each
 * row's project and parent, changes statuses in place (useTaskStatusChange) and opens the Task
 * Modal through the URL. Arrow Up / Down move between rows.
 */
import { useMemo } from 'react'
import { useOpenTask } from '@/app/taskModalRoute'
import { useWorkspaceData } from '@/data/hooks'
import type { Task, WorkspaceData } from '@/domain/types'
import { cn } from '@/lib/utils'
import { onRowListKeyDown } from './rowFocus'
import { TaskListRow } from './TaskListRow'
import { useTaskStatusChange } from './useTaskStatusChange'

function own<T>(table: Record<string, T>, id: string | null): T | undefined {
  return id && Object.hasOwn(table, id) ? table[id] : undefined
}

export interface TaskRowSection {
  /** Stable key (e.g. the bucket). */
  key: string
  /** Visible section heading; omit for a plain list. */
  title?: string
  tasks: readonly Task[]
}

export interface TaskRowListProps {
  /** One plain list, or several headed sections (All tab). */
  sections: readonly TaskRowSection[]
  /** Accessible name of the list (or of the region holding the sections). */
  label: string
  /** The list keeps done tasks (All with "Show completed"). */
  showsDone: boolean
  showPriority?: boolean
  /** Width class of the project column. */
  projectClassName?: string
  /** Classes for every row (padding / rounding differ between a page and a card-less section). */
  rowClassName?: string
  /** Classes for section headings (sticky offset, padding). */
  headingClassName?: string
  className?: string
}

export function TaskRowList({
  sections,
  label,
  showsDone,
  showPriority,
  projectClassName,
  rowClassName,
  headingClassName,
  className,
}: TaskRowListProps) {
  const data = useWorkspaceData()
  const openTask = useOpenTask()
  const visibleIds = useMemo(
    () => sections.flatMap((section) => section.tasks.map((task) => task.id)),
    [sections],
  )
  const changeStatus = useTaskStatusChange({ visibleIds, showsDone })

  const rows = (tasks: readonly Task[], data: WorkspaceData) =>
    tasks.map((task) => (
      <TaskListRow
        key={task.id}
        task={task}
        parent={own(data.tasks, task.parentTaskId)}
        project={own(data.projects, task.projectId)}
        onOpen={openTask}
        onStatusChange={changeStatus}
        showPriority={showPriority}
        projectClassName={projectClassName}
        className={rowClassName}
      />
    ))

  const headed = sections.some((section) => section.title)
  if (!headed) {
    return (
      <ul aria-label={label} onKeyDown={onRowListKeyDown} className={cn('flex flex-col', className)}>
        {sections.map((section) => rows(section.tasks, data))}
      </ul>
    )
  }
  return (
    <div role="region" aria-label={label} onKeyDown={onRowListKeyDown} className={className}>
      {sections.map((section) => {
        const headingId = `task-section-${section.key}`
        return (
          <section key={section.key} aria-labelledby={headingId}>
            <h2
              id={headingId}
              className={cn(
                'flex h-8 items-center gap-2 bg-muted text-meta font-semibold text-fg-secondary',
                headingClassName,
              )}
            >
              {section.title}
              <span className="font-normal text-fg-tertiary tabular-nums">
                <span aria-hidden>{section.tasks.length}</span>
                <span className="sr-only">
                  , {section.tasks.length} {section.tasks.length === 1 ? 'task' : 'tasks'}
                </span>
              </span>
            </h2>
            <ul className="flex flex-col py-1">{rows(section.tasks, data)}</ul>
          </section>
        )
      })}
    </div>
  )
}
