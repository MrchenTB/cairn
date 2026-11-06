/**
 * One outline group of the List view ("No phase" or a phase): sticky 32px header (collapse,
 * name, count, + add task, ⋯ phase menu, inline rename), its sortable top-level tasks (each with
 * its expandable subtasks), its milestones and the inline "Add task" row.
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Diamond,
  Ellipsis,
  Layers,
  Palette,
  Pencil,
  Plus,
  Trash,
} from 'lucide-react'
import { phaseColorLabel, PhaseColorPopover } from '@/components/task/PhaseColorPicker'
import { ProjectDot } from '@/components/task/ProjectDot'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { insetFocus } from '@/components/ui/styles'
import { Tooltip } from '@/components/ui/tooltip'
import type { OutlineGroup, OutlineTask } from '@/domain/hierarchy'
import { computeProgress } from '@/domain/progress'
import { NAME_MAX_LENGTH, resolvePhaseColor, TITLE_MAX_LENGTH, type Task } from '@/domain/types'
import { validateName } from '@/domain/validation'
import { notify } from '@/lib/notify'
import { cn } from '@/lib/utils'
import { InlineCreate } from './InlineCreate'
import { addRowKey, useListContext } from './listContext'
import { subtaskContainerId } from './listDnd'
import { MilestoneRow } from './MilestoneRow'
import { TaskRow } from './TaskRow'
import type { ListDragData } from './useListDnd'

const validateTitle = (value: string) =>
  validateName(value, TITLE_MAX_LENGTH, 'Task title')?.message ?? null

const taskCountLabel = (count: number) => `${count} ${count === 1 ? 'task' : 'tasks'}`

export interface ListGroupProps {
  group: OutlineGroup
  containerId: string
  /** Top-level task ids to render (drag preview aware). */
  taskIds: readonly string[]
  /** Every top-level task of the outline by id (a task may be previewed in another group). */
  entries: ReadonlyMap<string, OutlineTask>
  /** false in a project without phases (flat list). */
  showHeader: boolean
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  /** Position among the phases (for Move up / Move down). */
  phaseIndex: number
  phaseCount: number
}

export function ListGroup({
  group,
  containerId,
  taskIds,
  entries,
  showHeader,
  collapsed,
  onCollapsedChange,
  phaseIndex,
  phaseCount,
}: ListGroupProps) {
  const ctx = useListContext()
  const bodyId = useId()
  const { setNodeRef } = useDroppable({
    id: containerId,
    data: { type: 'group', containerId } satisfies ListDragData,
  })
  const drag = ctx.drag
  const isDropTarget =
    drag?.kind === 'task' &&
    drag.overContainer === containerId &&
    !drag.initial[containerId]?.includes(drag.activeId)
  const addKey = addRowKey.group(containerId)
  const lastTaskId = taskIds.at(-1) ?? null
  const name = group.phase?.name ?? 'No phase'

  const openAddRow = () => {
    if (collapsed) onCollapsedChange(false)
    ctx.setEditingRow(addKey)
  }

  return (
    <section
      ref={setNodeRef}
      aria-label={showHeader ? `${name}, ${taskCountLabel(group.tasks.length)}` : undefined}
      className="relative"
    >
      {showHeader ? (
        <GroupHeader
          group={group}
          name={name}
          bodyId={bodyId}
          collapsed={collapsed}
          onCollapsedChange={onCollapsedChange}
          isDropTarget={isDropTarget}
          onAddTask={openAddRow}
          onAddTaskFromMenu={() => ctx.openRowAfterMenu(addKey, openAddRow)}
          phaseIndex={phaseIndex}
          phaseCount={phaseCount}
        />
      ) : null}
      {collapsed && showHeader ? null : (
        <div id={bodyId}>
          <SortableContext
            id={containerId}
            items={taskIds as string[]}
            strategy={verticalListSortingStrategy}
          >
            <ul aria-label={showHeader ? `Tasks in ${name}` : 'Tasks'}>
              {taskIds.map((taskId) => {
                const entry = entries.get(taskId)
                return entry ? (
                  <TopLevelItem key={taskId} entry={entry} containerId={containerId} />
                ) : null
              })}
            </ul>
          </SortableContext>
          {group.milestones.length > 0 ? (
            <ul aria-label={`Milestones${showHeader ? ` in ${name}` : ''}`}>
              {group.milestones.map((milestone) => (
                <MilestoneRow
                  key={milestone.id}
                  milestone={milestone}
                  today={ctx.today}
                  onOpen={ctx.openMilestone}
                />
              ))}
            </ul>
          ) : null}
          <InlineCreate
            label="Add task"
            inputLabel={showHeader ? `New task in ${name}` : 'New task'}
            placeholder="Task name"
            open={ctx.editingRow === addKey}
            onOpenChange={(open) => ctx.setEditingRow(open ? addKey : null)}
            validate={validateTitle}
            onSubmit={(title) =>
              ctx.createTask({
                title,
                phaseId: group.phase?.id ?? null,
                parentTaskId: null,
                afterId: lastTaskId,
              })
            }
            className="pr-3 pl-12"
            rowKey={addKey}
          />
        </div>
      )}
    </section>
  )
}

/**
 * Pointer-drag target for an empty, hidden "No phase" group. It is drawn over the top of the list
 * (sticky, taking no layout space), so showing it never moves the rows under the pointer; a drop
 * takes the task out of its phase. Keyboard users use the row menu ("Move to phase").
 */
export function NoPhaseDropZone({ containerId }: { containerId: string }) {
  const ctx = useListContext()
  const { setNodeRef } = useDroppable({
    id: containerId,
    data: { type: 'group', containerId, overlay: true } satisfies ListDragData,
  })
  const isTarget = ctx.drag?.kind === 'task' && ctx.drag.overContainer === containerId
  return (
    <div
      ref={setNodeRef}
      aria-hidden
      data-drop-target={isTarget || undefined}
      className={cn(
        'sticky top-0 z-[3] -mb-8 flex h-8 items-center gap-2 bg-muted pr-3 pl-6 text-meta',
        'shadow-[0_1px_0_0_var(--border-default)] transition-colors duration-fast',
        'data-[drop-target]:bg-selected data-[drop-target]:shadow-[inset_2px_0_0_var(--accent),0_1px_0_0_var(--border-default)]',
      )}
    >
      <Layers className="size-3.5 shrink-0 text-fg-tertiary" />
      <span className="font-semibold text-fg-secondary">No phase</span>
      <span className="truncate text-fg-tertiary">Drop here to take the task out of its phase</span>
    </div>
  )
}

interface GroupHeaderProps {
  group: OutlineGroup
  name: string
  bodyId: string
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  isDropTarget: boolean
  /** The "+" button: opens the add row (its field takes focus when it mounts). */
  onAddTask: () => void
  /** The menu item: the same, once the menu has closed (the cursor then goes to the field). */
  onAddTaskFromMenu: () => void
  phaseIndex: number
  phaseCount: number
}

function GroupHeader({
  group,
  name,
  bodyId,
  collapsed,
  onCollapsedChange,
  isDropTarget,
  onAddTask,
  onAddTaskFromMenu,
  phaseIndex,
  phaseCount,
}: GroupHeaderProps) {
  const ctx = useListContext()
  const phase = group.phase
  const [renaming, setRenaming] = useState(false)
  const [colorOpen, setColorOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  /** Enter / Esc ended the rename: focus goes back to the header (a click elsewhere keeps it). */
  const refocusToggle = useRef(false)
  const count = group.tasks.length

  useEffect(() => {
    if (!renaming && refocusToggle.current) {
      refocusToggle.current = false
      toggleRef.current?.focus()
    }
  }, [renaming])

  const finishRename = (refocus: boolean) => {
    refocusToggle.current = refocus
    setRenaming(false)
  }

  return (
    <div
      data-drop-target={isDropTarget || undefined}
      className={cn(
        'group/header sticky top-0 z-[2] flex h-8 items-center gap-1 bg-muted pr-3 pl-6',
        'transition-colors duration-fast',
        'data-[drop-target]:bg-selected data-[drop-target]:shadow-[inset_2px_0_0_var(--accent)]',
      )}
    >
      {renaming && phase ? (
        <RenameInput
          initial={phase.name}
          onCancel={finishRename}
          onSave={(next, refocus) => {
            // Optimistic: the header shows the new name at once; a failed save is rolled back
            // and toasted (with Retry) by the store.
            finishRename(refocus)
            void ctx.phaseCommands.rename(phase, next).then((message) => {
              if (message) notify.error('Couldn’t rename the phase', { description: message })
            })
          }}
        />
      ) : (
        <button
          ref={toggleRef}
          type="button"
          aria-label={`${name}, ${taskCountLabel(count)}`}
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : bodyId}
          onClick={() => onCollapsedChange(!collapsed)}
          className={cn(
            '-ml-1 flex h-6 min-w-0 items-center gap-1.5 rounded-md pr-1.5 pl-1 text-meta',
            'transition-colors duration-fast hover:bg-hover hover:duration-instant',
            insetFocus,
          )}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 text-fg-tertiary transition-transform duration-fast motion-reduce:transition-none',
              !collapsed && 'rotate-90',
            )}
          />
          {phase ? <span className="w-2 shrink-0" aria-hidden /> : null}
          <span className="truncate font-semibold text-fg-secondary">{name}</span>
          <span className="text-fg-tertiary tabular-nums" aria-hidden>
            {count}
          </span>
        </button>
      )}
      {renaming || !phase ? null : (
        <PhaseColorPopover
          phaseName={name}
          value={phase.color}
          projectColor={ctx.project.color}
          onChange={(color) => ctx.phaseCommands.setColor(phase, color)}
          open={colorOpen}
          onOpenChange={setColorOpen}
        >
          <button
            type="button"
            aria-label={`Color of ${name}: ${phaseColorLabel(phase.color, ctx.project.color)}`}
            className={cn(
              'absolute top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-md hover:bg-hover',
              insetFocus,
            )}
            // pl-6 (24) + toggle -ml-1 and pl-1 (0) + chevron (14) + gap (6) − (hit area − dot) / 2
            style={{ left: 38 }}
          >
            <ProjectDot color={resolvePhaseColor(phase.color, ctx.project.color)} />
          </button>
        </PhaseColorPopover>
      )}
      {renaming ? null : (
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-fast group-hover/header:opacity-100 group-focus-within/header:opacity-100 has-[[data-state=open]]:opacity-100">
          <Tooltip content={`Add task to ${name}`}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Add task to ${name}`}
              onClick={onAddTask}
              className={insetFocus}
            >
              <Plus />
            </Button>
          </Tooltip>
          <DropdownMenu>
            <Tooltip content={phase ? 'Phase actions' : 'Group actions'}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={
                    phase ? `Actions for phase ${name}` : 'Actions for tasks without a phase'
                  }
                  className={insetFocus}
                >
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-52" onCloseAutoFocus={ctx.onMenuClosed}>
              <DropdownMenuItem onSelect={onAddTaskFromMenu}>
                <Plus />
                Add task
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => ctx.phaseCommands.addMilestone(phase?.id ?? null)}>
                <Diamond />
                Add milestone…
              </DropdownMenuItem>
              {phase ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setRenaming(true)}>
                    <Pencil />
                    Rename phase
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => ctx.openRowAfterMenu('phase-color', () => setColorOpen(true))}
                  >
                    <Palette />
                    Color…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={phaseIndex <= 0}
                    onSelect={() => ctx.phaseCommands.move(phase, -1)}
                  >
                    <ArrowUp />
                    Move phase up
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={phaseIndex >= phaseCount - 1}
                    onSelect={() => ctx.phaseCommands.move(phase, 1)}
                  >
                    <ArrowDown />
                    Move phase down
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => ctx.phaseCommands.remove(phase)}
                  >
                    <Trash />
                    Delete phase…
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  )
}

function RenameInput({
  initial,
  onSave,
  onCancel,
}: {
  initial: string
  /** `refocus`: the rename ended from the keyboard (Enter), so focus returns to the header. */
  onSave: (name: string, refocus: boolean) => void
  onCancel: (refocus: boolean) => void
}) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const done = useRef(false)
  const errorId = useId()

  /** Saves a valid change (an unchanged name just closes); an invalid one stays with its error. */
  const save = (refocus: boolean) => {
    if (done.current) return
    const next = value.trim()
    if (next === initial.trim()) {
      done.current = true
      onCancel(refocus)
      return
    }
    const invalid = validateName(next, NAME_MAX_LENGTH, 'Phase name')
    if (invalid) {
      setError(invalid.message)
      return
    }
    done.current = true
    onSave(next, refocus)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      save(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      done.current = true
      onCancel(true)
    }
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Input
        autoFocus
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          setError(null)
        }}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (done.current) return
          // Blur saves a valid change and drops an invalid one.
          if (validateName(value, NAME_MAX_LENGTH, 'Phase name')) {
            done.current = true
            onCancel(false)
          } else {
            save(false)
          }
        }}
        aria-label="Phase name"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        autoComplete="off"
        className="h-6 w-64 max-w-full px-1.5 text-meta font-semibold"
      />
      {error ? (
        <span id={errorId} role="alert" className="truncate text-meta text-danger">
          {error}
        </span>
      ) : null}
    </div>
  )
}

function TopLevelItem({ entry, containerId }: { entry: OutlineTask; containerId: string }) {
  const ctx = useListContext()
  const { task, subtasks } = entry
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { type: 'task', containerId } satisfies ListDragData,
    transition: ctx.reducedMotion ? null : undefined,
  })
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition: transition,
  }
  const progress = subtasks.length > 0 ? computeProgress(subtasks) : null
  const addingSubtask = ctx.editingRow === addRowKey.subtask(task.id)
  const expanded = ctx.expanded.has(task.id) && subtasks.length > 0
  const showChildren = !isDragging && (expanded || addingSubtask)
  const { canMoveUp, canMoveDown } = ctx.moveRange(task)

  return (
    <li ref={setNodeRef} style={style} className={cn('relative', isDragging && 'z-[1]')}>
      <TaskRow
        task={task}
        depth={0}
        today={ctx.today}
        subtaskDone={progress?.done ?? 0}
        subtaskTotal={progress?.total ?? 0}
        expanded={expanded}
        handleAttributes={attributes}
        handleListeners={listeners}
        handleRef={setActivatorNodeRef}
        placeholder={isDragging}
        dropLine={!(isDragging && ctx.drag?.kind === 'task' && ctx.drag.overAppendOnly)}
        commands={ctx.commands}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        phases={ctx.phases}
      />
      {showChildren ? <SubtaskBlock parent={task} subtasks={expanded ? subtasks : []} /> : null}
    </li>
  )
}

function SubtaskBlock({ parent, subtasks }: { parent: Task; subtasks: readonly Task[] }) {
  const ctx = useListContext()
  const containerId = subtaskContainerId(parent.id)
  const ids = subtasks.map((subtask) => subtask.id)
  const addKey = addRowKey.subtask(parent.id)
  return (
    <div>
      {subtasks.length > 0 ? (
        <SortableContext id={containerId} items={ids} strategy={verticalListSortingStrategy}>
          <ul aria-label={`Subtasks of ${parent.title}`}>
            {subtasks.map((subtask) => (
              <SubtaskItem
                key={subtask.id}
                task={subtask}
                parentId={parent.id}
                containerId={containerId}
              />
            ))}
          </ul>
        </SortableContext>
      ) : null}
      <InlineCreate
        label="Add subtask"
        inputLabel={`New subtask of ${parent.title}`}
        placeholder="Subtask name"
        open={ctx.editingRow === addKey}
        onOpenChange={(open) => ctx.setEditingRow(open ? addKey : null)}
        validate={validateTitle}
        onSubmit={(title) =>
          ctx.createTask({
            title,
            phaseId: parent.phaseId,
            parentTaskId: parent.id,
            afterId: ids.at(-1) ?? null,
          })
        }
        className="pr-3 pl-[68px]"
        rowKey={addKey}
      />
    </div>
  )
}

function SubtaskItem({
  task,
  parentId,
  containerId,
}: {
  task: Task
  parentId: string
  containerId: string
}) {
  const ctx = useListContext()
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { type: 'subtask', containerId, parentId } satisfies ListDragData,
    transition: ctx.reducedMotion ? null : undefined,
  })
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition: transition,
  }
  const { canMoveUp, canMoveDown } = ctx.moveRange(task)
  return (
    <li ref={setNodeRef} style={style} className={cn('relative', isDragging && 'z-[1]')}>
      <TaskRow
        task={task}
        depth={1}
        today={ctx.today}
        expanded={false}
        handleAttributes={attributes}
        handleListeners={listeners}
        handleRef={setActivatorNodeRef}
        placeholder={isDragging}
        commands={ctx.commands}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        phases={ctx.phases}
      />
    </li>
  )
}
