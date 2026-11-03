/**
 * One 36px task row of the List view: drag handle (hover/focus), subtask chevron, status menu,
 * title (opens the Task Modal) with the "2/5" subtask summary, priority menu, start date (when
 * set) and due date, plus the ⋯ menu — the same actions are on right-click.
 */
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  CircleAlert,
  Ellipsis,
  FolderInput,
  GripVertical,
  ListPlus,
  ListTree,
  SquarePen,
  Trash,
} from 'lucide-react'
import { DateField } from '@/components/task/DateField'
import { PriorityMenu } from '@/components/task/PriorityMenu'
import { StatusIcon } from '@/components/task/StatusIcon'
import { StatusMenu } from '@/components/task/StatusMenu'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { insetFocus } from '@/components/ui/styles'
import { Tooltip } from '@/components/ui/tooltip'
import { dueBucket } from '@/domain/buckets'
import type { ISODate, Phase, Task, TaskPriority, TaskStatus } from '@/domain/types'
import { cn } from '@/lib/utils'
import { contextKit, dropdownKit, type MenuKit } from '@/features/projects/menuKit'

export interface TaskCommands {
  open(taskId: string): void
  setStatus(task: Task, status: TaskStatus): void
  setPriority(task: Task, priority: TaskPriority): void
  setDates(task: Task, dates: { startDate: ISODate | null; dueDate: ISODate | null }): void
  /** Expands the parent and opens its "Add subtask" row. */
  addSubtask(taskId: string): void
  move(task: Task, delta: -1 | 1): void
  moveToPhase(task: Task, phaseId: string | null): void
  remove(task: Task): void
}

export interface TaskMenuContext {
  canMoveUp: boolean
  canMoveDown: boolean
  /** Phases of the project (empty = no "Move to phase"). */
  phases: readonly Phase[]
}

export interface DragHandleProps {
  attributes: DraggableAttributes
  listeners: DraggableSyntheticListeners
}

export interface TaskRowProps {
  task: Task
  depth: 0 | 1
  today: ISODate
  /** Done / total subtasks (parents only). */
  subtasks: { done: number; total: number } | null
  expanded: boolean
  onToggleExpanded?: () => void
  handle: DragHandleProps | null
  /** Activator element of the drag handle (dnd-kit `setActivatorNodeRef`). */
  handleRef?: (element: HTMLElement | null) => void
  /** The row is being dragged: it renders as the drop indicator. */
  placeholder?: boolean
  commands: TaskCommands
  menu: TaskMenuContext
}

const revealOnRowHover =
  'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100'

export function TaskRow({
  task,
  depth,
  today,
  subtasks,
  expanded,
  onToggleExpanded,
  handle,
  handleRef,
  placeholder = false,
  commands,
  menu,
}: TaskRowProps) {
  const done = task.status === 'done'
  const bucket = dueBucket(task, today)
  const overdue = bucket === 'overdue'
  const dueToday = bucket === 'today'
  const hasSubtasks = subtasks !== null && subtasks.total > 0

  const items = (kit: MenuKit) => <TaskMenuItems kit={kit} task={task} menu={menu} commands={commands} />

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-task-row={task.id}
          data-depth={depth}
          className={cn(
            'group/row relative flex h-9 items-center pr-3 pl-1 text-ui',
            'transition-colors duration-fast hover:bg-hover hover:duration-instant data-[state=open]:bg-hover',
          )}
        >
          {placeholder ? (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-6 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-accent"
            />
          ) : null}
          <div className={cn('flex min-w-0 flex-1 items-center', placeholder && 'opacity-0')}>
            {handle ? (
              <button
                type="button"
                ref={handleRef}
                {...handle.attributes}
                {...handle.listeners}
                aria-label={`Move ${task.title}`}
                className={cn(
                  'grid h-6 w-5 shrink-0 cursor-grab touch-none place-items-center rounded-sm text-fg-tertiary',
                  'transition-opacity duration-fast hover:bg-hover hover:text-fg active:cursor-grabbing',
                  revealOnRowHover,
                  insetFocus,
                )}
              >
                <GripVertical className="size-3.5" aria-hidden />
              </button>
            ) : (
              <span className="w-5 shrink-0" />
            )}
            {depth === 1 ? <span className="w-5 shrink-0" aria-hidden /> : null}
            {hasSubtasks && onToggleExpanded ? (
              <button
                type="button"
                onClick={onToggleExpanded}
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Hide' : 'Show'} subtasks of ${task.title}`}
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded-sm text-fg-tertiary',
                  'transition-colors duration-fast hover:bg-hover hover:text-fg hover:duration-instant',
                  insetFocus,
                )}
              >
                <ChevronRight
                  className={cn(
                    'size-3.5 transition-transform duration-fast motion-reduce:transition-none',
                    expanded && 'rotate-90',
                  )}
                  aria-hidden
                />
              </button>
            ) : (
              <span className="w-5 shrink-0" aria-hidden />
            )}
            <StatusMenu
              value={task.status}
              onChange={(status) => commands.setStatus(task, status)}
              triggerClassName={insetFocus}
            />
            <button
              type="button"
              onClick={() => commands.open(task.id)}
              className={cn(
                'flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left',
                insetFocus,
              )}
            >
              <span
                className={cn(
                  'truncate',
                  done ? 'text-fg-tertiary line-through decoration-fg-tertiary' : 'text-fg',
                )}
              >
                {task.title}
              </span>
              {hasSubtasks ? (
                <>
                  <span
                    aria-hidden
                    className="inline-flex shrink-0 items-center gap-1 text-meta text-fg-tertiary tabular-nums"
                  >
                    <ListTree className="size-3.5" />
                    {subtasks.done}/{subtasks.total}
                  </span>
                  <span className="sr-only">
                    , {subtasks.done} of {subtasks.total} subtasks done
                  </span>
                </>
              ) : null}
              {done ? <span className="sr-only">, done</span> : null}
            </button>
          </div>
          <div className={cn('flex shrink-0 items-center gap-1', placeholder && 'opacity-0')}>
            <PriorityMenu
              value={task.priority}
              onChange={(priority) => commands.setPriority(task, priority)}
              triggerClassName={cn(insetFocus, task.priority === 'none' && revealOnRowHover)}
            />
            <span className="flex w-20 justify-end">
              {task.startDate ? (
                <DateField
                  variant="ghost"
                  label="Start date"
                  value={task.startDate}
                  max={task.dueDate}
                  rangeHint="The start can’t be after the due date."
                  onChange={(startDate) => commands.setDates(task, { startDate, dueDate: task.dueDate })}
                  align="end"
                  className={cn('text-fg-tertiary', insetFocus)}
                />
              ) : null}
            </span>
            <span className="flex w-24 items-center justify-end gap-0.5">
              {overdue ? <CircleAlert className="size-3.5 shrink-0 text-danger" aria-hidden /> : null}
              <DateField
                variant="ghost"
                label="Due date"
                value={task.dueDate}
                min={task.startDate}
                rangeHint="The due date can’t be before the start."
                onChange={(dueDate) => commands.setDates(task, { startDate: task.startDate, dueDate })}
                align="end"
                className={cn(
                  insetFocus,
                  overdue && 'text-danger',
                  dueToday && 'text-warning',
                  done && 'text-fg-tertiary',
                  !task.dueDate && revealOnRowHover,
                )}
              />
              {overdue ? <span className="sr-only">Overdue</span> : null}
            </span>
            <DropdownMenu>
              <Tooltip content="Task actions">
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions for ${task.title}`}
                    className={cn(revealOnRowHover, insetFocus)}
                  >
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-52">
                {items(dropdownKit)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">{items(contextKit)}</ContextMenuContent>
    </ContextMenu>
  )
}

function TaskMenuItems({
  kit: K,
  task,
  menu,
  commands,
}: {
  kit: MenuKit
  task: Task
  menu: TaskMenuContext
  commands: TaskCommands
}) {
  const topLevel = task.parentTaskId === null
  return (
    <>
      <K.Item onSelect={() => commands.open(task.id)}>
        <SquarePen />
        Open task
      </K.Item>
      {topLevel ? (
        <K.Item onSelect={() => commands.addSubtask(task.id)}>
          <ListPlus />
          Add subtask
        </K.Item>
      ) : null}
      <K.Separator />
      <K.Item disabled={!menu.canMoveUp} onSelect={() => commands.move(task, -1)}>
        <ArrowUp />
        Move up
      </K.Item>
      <K.Item disabled={!menu.canMoveDown} onSelect={() => commands.move(task, 1)}>
        <ArrowDown />
        Move down
      </K.Item>
      {topLevel && menu.phases.length > 0 ? (
        <K.Sub>
          <K.SubTrigger>
            <FolderInput />
            Move to phase
          </K.SubTrigger>
          <K.SubContent className="w-52">
            {[null, ...menu.phases].map((phase) => {
              const phaseId = phase?.id ?? null
              const current = task.phaseId === phaseId
              return (
                <K.Item
                  key={phaseId ?? 'none'}
                  disabled={current}
                  onSelect={() => commands.moveToPhase(task, phaseId)}
                >
                  {current ? <Check /> : <span className="size-4 shrink-0" aria-hidden />}
                  <span className="truncate">{phase?.name ?? 'No phase'}</span>
                </K.Item>
              )
            })}
          </K.SubContent>
        </K.Sub>
      ) : null}
      <K.Separator />
      <K.Item variant="destructive" onSelect={() => commands.remove(task)}>
        <Trash />
        Delete task…
      </K.Item>
    </>
  )
}

/** Floating copy of a row while it is dragged (DragOverlay). */
export function TaskRowPreview({ task, subtaskCount }: { task: Task; subtaskCount: number }) {
  return (
    <div className="flex h-9 cursor-grabbing items-center gap-2 rounded-md bg-elevated pr-3 pl-1.5 text-ui shadow-drag">
      <GripVertical className="size-3.5 shrink-0 text-fg-tertiary" aria-hidden />
      <span className="w-5 shrink-0" aria-hidden />
      <StatusIcon status={task.status} decorative />
      <span
        className={cn(
          'truncate px-1.5',
          task.status === 'done' ? 'text-fg-tertiary line-through' : 'text-fg',
        )}
      >
        {task.title}
      </span>
      {subtaskCount > 0 ? (
        <span className="ml-auto shrink-0 text-meta text-fg-tertiary">
          + {subtaskCount} {subtaskCount === 1 ? 'subtask' : 'subtasks'}
        </span>
      ) : null}
    </div>
  )
}
