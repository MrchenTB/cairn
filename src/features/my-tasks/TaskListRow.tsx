/**
 * One 36px cross-project task row (My Tasks, Overview "Upcoming tasks"): status menu (changes the
 * status in place), the title — prefixed with "Parent ›" for subtasks — which opens the Task
 * Modal and covers the whole row as its click target, the project (dot + name, a link to the
 * project), the priority glyph and the due date in the shared bucket language.
 */
import { memo } from 'react'
import { Link } from 'react-router'
import { DueLabel } from '@/components/task/DueLabel'
import { PriorityIcon } from '@/components/task/PriorityIcon'
import { ProjectDot } from '@/components/task/ProjectDot'
import { StatusMenu } from '@/components/task/StatusMenu'
import { insetFocus } from '@/components/ui/styles'
import type { Project, Task, TaskStatus } from '@/domain/types'
import { cn } from '@/lib/utils'

export interface TaskListRowProps {
  task: Task
  /** The parent of a subtask (shown as a "Parent ›" prefix). */
  parent?: Task
  project: Project | undefined
  onOpen: (taskId: string) => void
  onStatusChange: (task: Task, status: TaskStatus) => void
  /** Show the priority glyph column (default true). */
  showPriority?: boolean
  /** Width of the project column (default w-44). */
  projectClassName?: string
  className?: string
}

/**
 * Memoised: every prop is a stable reference (store rows are structurally shared, the callbacks
 * are `useCallback`s), so changing one task re-renders its row only — not a list of hundreds.
 */
export const TaskListRow = memo(function TaskListRow({
  task,
  parent,
  project,
  onOpen,
  onStatusChange,
  showPriority = true,
  projectClassName = 'w-44',
  className,
}: TaskListRowProps) {
  const done = task.status === 'done'
  const ids = {
    due: `task-row-${task.id}-due`,
    priority: `task-row-${task.id}-priority`,
    project: `task-row-${task.id}-project`,
  }
  const hasPriority = showPriority && task.priority !== 'none'
  const describedBy = [
    task.dueDate ? ids.due : null,
    hasPriority ? ids.priority : null,
    project ? ids.project : null,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li
      data-task-row={task.id}
      className={cn(
        'group/row relative flex h-9 items-center gap-1 text-ui',
        // Fixed 36px rows: off-screen rows skip style and layout work (see list/TaskRow).
        '[contain-intrinsic-size:auto_36px] [content-visibility:auto]',
        'transition-colors duration-fast hover:bg-hover hover:duration-instant',
        // The status menu of this row is open: keep the row marked.
        'has-[[data-state=open]]:bg-hover',
        className,
      )}
    >
      <StatusMenu
        value={task.status}
        onChange={(status) => onStatusChange(task, status)}
        triggerClassName={cn('relative z-[1]', insetFocus)}
      />
      <button
        type="button"
        data-row-open=""
        onClick={() => onOpen(task.id)}
        aria-describedby={describedBy || undefined}
        className={cn(
          'flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left',
          // The button covers the row (one click target); its focus ring outlines the row.
          'after:absolute after:inset-0 after:content-[""] focus-visible:outline-none',
          'focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus',
        )}
      >
        {parent ? (
          <>
            <span className="sr-only">Subtask of </span>
            <span className="max-w-[40%] shrink-0 truncate text-fg-tertiary">{parent.title}</span>
            <span aria-hidden className="shrink-0 text-fg-tertiary">
              ›
            </span>
            <span className="sr-only">: </span>
          </>
        ) : null}
        <span
          className={cn(
            'min-w-0 truncate',
            done ? 'text-fg-tertiary line-through decoration-fg-tertiary' : 'text-fg',
          )}
        >
          {task.title}
        </span>
      </button>
      {project ? (
        <Link
          id={ids.project}
          to={`/projects/${project.id}`}
          className={cn(
            'relative z-[1] flex h-7 shrink-0 items-center gap-2 rounded-md px-1.5 text-meta text-fg-secondary',
            'transition-colors duration-fast hover:bg-hover hover:text-fg hover:duration-instant',
            insetFocus,
            projectClassName,
          )}
        >
          <ProjectDot color={project.color} />
          <span className="min-w-0 truncate">{project.name}</span>
        </Link>
      ) : (
        <span className={cn('shrink-0', projectClassName)} aria-hidden />
      )}
      {showPriority ? (
        <span id={ids.priority} className="grid w-6 shrink-0 place-items-center">
          {hasPriority ? <PriorityIcon priority={task.priority} size={14} /> : null}
        </span>
      ) : null}
      <span id={ids.due} className="flex w-24 shrink-0 justify-end pr-1.5">
        <DueLabel dueDate={task.dueDate} status={task.status} />
      </span>
    </li>
  )
})
