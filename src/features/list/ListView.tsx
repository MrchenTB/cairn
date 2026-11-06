/**
 * /projects/:projectId/list — the project outline as a dense list (domain buildProjectOutline):
 * flat when the project has no phases; otherwise "No phase" first (hidden when empty; while a
 * task is dragged it is offered as a drop zone) and one collapsible group per phase. Rows edit
 * status / priority / dates in place, open the Task Modal, expand subtasks and reorder by drag
 * (or the row menu).
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router'
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  type Announcements,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { ChevronsDownUp, ChevronsUpDown, ListTodo } from 'lucide-react'
import { useOpenTask } from '@/app/taskModalRoute'
import { useUIStore } from '@/app/uiStore'
import { Button } from '@/components/ui/button'
import { choose, confirm } from '@/components/ui/confirm'
import { EmptyState } from '@/components/ui/empty-state'
import {
  useActions,
  useDependencies,
  useMilestones,
  usePhases,
  useProject,
  useProjectTasks,
  useToday,
} from '@/data/hooks'
import {
  buildProjectOutline,
  subtasksOf,
  topLevelTasks,
  type OutlineTask,
} from '@/domain/hierarchy'
import {
  NAME_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  type MoveTaskInput,
  type Project,
  type Result,
  type Task,
} from '@/domain/types'
import { validateName } from '@/domain/validation'
import { planScheduleChangeDetailed } from '@/features/gantt/planner'
import {
  SCREEN_READER_INSTRUCTIONS,
  useDropAnimation,
  usePrefersReducedMotion,
} from '@/features/projects/dnd'
import { usePhaseDialog } from '@/features/projects/phaseDialogStore'
import { stepAfterId } from '@/features/projects/projectOrder'
import { deletePhaseDescription, phaseContents, plural } from '@/features/projects/projectStats'
import { ViewBarActions } from '@/features/projects/viewBar'
import { notify } from '@/lib/notify'
import { InlineCreate } from './InlineCreate'
import { inlineRowInput } from './inlineRows'
import { ListContext, addRowKey, type ListContextValue, type PhaseCommands } from './listContext'
import {
  findContainer,
  groupContainerId,
  isGroupContainerId,
  moveToGroupEnd,
  neighbours,
  phaseIdOfContainer,
  stepMove,
  type Containers,
} from './listDnd'
import { ListGroup, NoPhaseDropZone } from './ListGroup'
import {
  groupKey,
  setGroupCollapsed,
  setTasksExpanded,
  toggleTaskExpanded,
  useCollapsedGroups,
  useExpandedTasks,
} from './listPrefs'
import { TaskRowPreview, type TaskCommands } from './TaskRow'
import { useListDnd } from './useListDnd'

const NO_PHASE_CONTAINER = groupContainerId(null)
/** Stable dnd-kit config objects (dnd-kit memoises on their identity). */
const MEASURING = { droppable: { strategy: MeasuringStrategy.Always } }
const OVERLAY_MODIFIERS = [restrictToVerticalAxis]

const validateTitle = (value: string) =>
  validateName(value, TITLE_MAX_LENGTH, 'Task title')?.message ?? null
const validatePhaseName = (value: string) =>
  validateName(value, NAME_MAX_LENGTH, 'Phase name')?.message ?? null

/** Remote failures are toasted (with Retry) by the store; a rejected change is reported here. */
async function report(pending: Promise<Result<unknown>>, label = 'Couldn’t update the task') {
  const result = await pending
  if (!result.ok && result.error.kind === 'validation') {
    notify.error(label, { description: result.error.message })
  }
}

export function ListView() {
  const { projectId } = useParams()
  const project = useProject(projectId)
  // ProjectLayout shows "Project not found" for unknown ids.
  if (!project) return null
  return <ProjectList key={project.id} project={project} />
}

function ProjectList({ project }: { project: Project }) {
  const actions = useActions()
  const today = useToday()
  const phases = usePhases(project.id)
  const tasks = useProjectTasks(project.id)
  const milestones = useMilestones(project.id)
  const dependencies = useDependencies(project.id)
  const openTask = useOpenTask()
  const openMilestoneDialog = useUIStore((s) => s.openMilestoneDialog)
  const openPhaseDialog = usePhaseDialog((s) => s.open)
  const expanded = useExpandedTasks()
  const collapsedGroups = useCollapsedGroups()
  const dropAnimation = useDropAnimation()
  const reducedMotion = usePrefersReducedMotion()
  const [editingRow, setEditingRow] = useState<string | null>(null)
  /** An inline row a menu item asked for: it opens when that menu has closed. */
  const rowAfterMenu = useRef<{ rowKey: string; open: () => void } | null>(null)

  const outline = useMemo(
    () => buildProjectOutline(project, phases, tasks, milestones),
    [project, phases, tasks, milestones],
  )
  const entries = useMemo(() => {
    const map = new Map<string, OutlineTask>()
    for (const group of outline.groups)
      for (const entry of group.tasks) map.set(entry.task.id, entry)
    return map
  }, [outline])
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const baseContainers = useMemo<Containers>(
    () =>
      Object.fromEntries(
        outline.groups.map((group) => [
          groupContainerId(group.phase?.id ?? null),
          group.tasks.map((entry) => entry.task.id),
        ]),
      ),
    [outline],
  )
  const subtaskIds = useCallback(
    (parentId: string) => entries.get(parentId)?.subtasks.map((subtask) => subtask.id) ?? [],
    [entries],
  )
  const isCollapsed = useCallback(
    (containerId: string) =>
      outline.hasPhases && collapsedGroups.has(groupKey(project.id, containerId)),
    [outline.hasPhases, collapsedGroups, project.id],
  )

  // A move into an empty phase has no neighbours in the view: keep the task's current place in
  // the project order, so the Board and Gantt don't reshuffle.
  const topLevelOrder = useMemo(
    () => topLevelTasks(tasks, project.id).map((task) => task.id),
    [tasks, project.id],
  )
  const moveTask = useCallback(
    (input: MoveTaskInput) => {
      const placed =
        input.afterId === undefined && input.beforeId === undefined
          ? { ...input, ...neighbours(topLevelOrder, input.taskId) }
          : input
      void report(actions.moveTask(placed), 'Couldn’t move the task')
    },
    [actions, topLevelOrder],
  )

  // "No phase" is hidden while it is empty (unless its add row is open). While a task is dragged
  // it is offered as a drop zone over the top of the list instead, so the rows never move.
  const noPhaseGroup = outline.groups[0]
  const showNoPhase =
    !outline.hasPhases ||
    noPhaseGroup.tasks.length > 0 ||
    noPhaseGroup.milestones.length > 0 ||
    editingRow === addRowKey.group(NO_PHASE_CONTAINER)
  const isAppendOnly = useCallback(
    (containerId: string) =>
      isCollapsed(containerId) || (containerId === NO_PHASE_CONTAINER && !showNoPhase),
    [isCollapsed, showNoPhase],
  )

  const dnd = useListDnd({ containers: baseContainers, subtaskIds, isAppendOnly, onMove: moveTask })

  const siblingOrder = useCallback(
    (task: Task): readonly string[] =>
      task.parentTaskId
        ? subtaskIds(task.parentTaskId)
        : (baseContainers[findContainer(baseContainers, task.id) ?? ''] ?? []),
    [baseContainers, subtaskIds],
  )

  const removeTask = useCallback(
    async (task: Task) => {
      const subtasks = subtasksOf(tasks, task.id)
      const touching = (ids: ReadonlySet<string>) =>
        dependencies.filter((d) => ids.has(d.predecessorId) || ids.has(d.successorId)).length
      if (subtasks.length === 0) {
        const links = touching(new Set([task.id]))
        const confirmed = await confirm({
          title: `Delete “${task.title}”?`,
          description: `${links > 0 ? `Its ${plural(links, 'dependency', 'dependencies')} will be removed too. ` : ''}This can’t be undone.`,
          confirmLabel: 'Delete task',
          destructive: true,
        })
        if (confirmed)
          void report(
            actions.deleteTask(task.id, { keepSubtasks: false }),
            'Couldn’t delete the task',
          )
        return
      }
      const all = touching(new Set([task.id, ...subtasks.map((subtask) => subtask.id)]))
      const choice = await choose({
        title: `Delete “${task.title}”?`,
        description: `It has ${plural(subtasks.length, 'subtask')}. Keep them as separate tasks, or delete them too?${all > 0 ? ` Dependencies of deleted tasks are removed.` : ''} This can’t be undone.`,
        choices: [
          { value: 'keep', label: 'Keep subtasks', variant: 'secondary' },
          { value: 'all', label: `Delete all ${subtasks.length + 1}`, variant: 'danger' },
        ],
      })
      if (choice) {
        void report(
          actions.deleteTask(task.id, { keepSubtasks: choice === 'keep' }),
          'Couldn’t delete the task',
        )
      }
    },
    [actions, dependencies, tasks],
  )

  // A menu item that opens an inline row waits for its menu to close (see openRowAfterMenu): then
  // the row opens, and focus goes to its field instead of back to the menu's trigger.
  const openRowAfterMenu = useCallback((rowKey: string, open: () => void) => {
    rowAfterMenu.current = { rowKey, open }
  }, [])
  const onMenuClosed = useCallback((event: Event) => {
    const row = rowAfterMenu.current
    rowAfterMenu.current = null
    if (!row) return
    event.preventDefault()
    row.open()
    // A row that was open already mounts nothing new: give its field the cursor directly.
    inlineRowInput(row.rowKey)?.focus()
  }, [])

  // Rows are memoised on ONE commands object for the life of the view; the commands read the
  // latest outline and callbacks when they run.
  const latest = useRef({ openTask, siblingOrder, baseContainers, moveTask, removeTask })
  useLayoutEffect(() => {
    latest.current = { openTask, siblingOrder, baseContainers, moveTask, removeTask }
  })
  const commands = useMemo<TaskCommands>(
    () => ({
      open: (taskId) => latest.current.openTask(taskId),
      setStatus: (task, status) => void report(actions.updateTask(task.id, { status })),
      setPriority: (task, priority) => void report(actions.updateTask(task.id, { priority })),
      setDates: (task, dates) => {
        // Dates always go through the planner (Manual warns about conflicts, Auto previews the
        // shifts). Remote failures are toasted by the store; a rejected range is reported here.
        void planScheduleChangeDetailed({ taskId: task.id, ...dates }, { source: 'list' }).then(
          (outcome) => {
            if (outcome.status === 'invalid') {
              notify.error('Couldn’t change the dates', { description: outcome.error.message })
            }
          },
        )
      },
      toggleExpanded: (taskId) => {
        if (!toggleTaskExpanded(taskId)) {
          setEditingRow((row) => (row === addRowKey.subtask(taskId) ? null : row))
        }
      },
      addSubtask: (taskId) => {
        const rowKey = addRowKey.subtask(taskId)
        openRowAfterMenu(rowKey, () => {
          setTasksExpanded([taskId], true)
          setEditingRow(rowKey)
        })
      },
      onMenuClosed,
      move: (task, delta) => {
        const input = stepMove(latest.current.siblingOrder(task), task.id, delta)
        if (input) latest.current.moveTask(input)
      },
      moveToPhase: (task, phaseId) => {
        const input = moveToGroupEnd(latest.current.baseContainers, task.id, phaseId)
        if (input) latest.current.moveTask(input)
      },
      remove: (task) => void latest.current.removeTask(task),
    }),
    [actions, openRowAfterMenu, onMenuClosed],
  )

  const phaseCommands = useMemo<PhaseCommands>(
    () => ({
      async rename(phase, name) {
        const result = await actions.updatePhase(phase.id, { name })
        return !result.ok && result.error.kind === 'validation' ? result.error.message : null
      },
      move(phase, delta) {
        const afterId = stepAfterId(
          phases.map((p) => p.id),
          phase.id,
          delta,
        )
        if (afterId !== undefined)
          void report(actions.movePhase(phase.id, afterId), 'Couldn’t move the phase')
      },
      async remove(phase) {
        const confirmed = await confirm({
          title: `Delete phase “${phase.name}”?`,
          description: deletePhaseDescription(phaseContents(phase.id, tasks, milestones)),
          confirmLabel: 'Delete phase',
          destructive: true,
        })
        if (confirmed) void report(actions.deletePhase(phase.id), 'Couldn’t delete the phase')
      },
      addMilestone(phaseId) {
        openMilestoneDialog({ mode: 'create', projectId: project.id, phaseId })
      },
    }),
    [actions, milestones, openMilestoneDialog, phases, project.id, tasks],
  )

  const createTask = useCallback<ListContextValue['createTask']>(
    async ({ title, phaseId, parentTaskId, afterId }) => {
      const result = await actions.createTask({
        projectId: project.id,
        title,
        phaseId,
        parentTaskId,
        placement: afterId ? { afterId } : undefined,
      })
      return !result.ok && result.error.kind === 'validation' ? result.error.message : null
    },
    [actions, project.id],
  )

  const context = useMemo<ListContextValue>(
    () => ({
      project,
      today,
      phases,
      commands,
      phaseCommands,
      moveRange: (task) => {
        const order = siblingOrder(task)
        const index = order.indexOf(task.id)
        return { canMoveUp: index > 0, canMoveDown: index >= 0 && index < order.length - 1 }
      },
      expanded,
      editingRow,
      setEditingRow,
      createTask,
      openMilestone: (milestoneId) => openMilestoneDialog({ mode: 'edit', milestoneId }),
      openRowAfterMenu,
      onMenuClosed,
      drag: dnd.drag,
      reducedMotion,
    }),
    [
      project,
      today,
      phases,
      commands,
      phaseCommands,
      siblingOrder,
      expanded,
      editingRow,
      createTask,
      openMilestoneDialog,
      openRowAfterMenu,
      onMenuClosed,
      dnd.drag,
      reducedMotion,
    ],
  )

  const parentIds = useMemo(
    () =>
      [...entries.values()]
        .filter((entry) => entry.subtasks.length > 0)
        .map((entry) => entry.task.id),
    [entries],
  )
  const allExpanded = parentIds.length > 0 && parentIds.every((id) => expanded.has(id))

  const titleOf = (id: UniqueIdentifier) => taskById.get(String(id))?.title ?? 'task'
  const groupName = (containerId: string) => {
    const phaseId = phaseIdOfContainer(containerId)
    return phaseId ? (phases.find((phase) => phase.id === phaseId)?.name ?? 'phase') : 'No phase'
  }
  const placeOf = (id: UniqueIdentifier) => (isGroupContainerId(id) ? groupName(id) : titleOf(id))
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over && over.id !== active.id
        ? `${titleOf(active.id)} is over ${placeOf(over.id)}.`
        : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? `${titleOf(active.id)} was dropped.`
        : `${titleOf(active.id)} was dropped back in place.`,
    onDragCancel: ({ active }) => `Moving ${titleOf(active.id)} was cancelled.`,
  }

  const isEmpty = tasks.length === 0 && phases.length === 0 && milestones.length === 0
  const showNoPhaseDropZone =
    !showNoPhase && dnd.drag?.kind === 'task' && dnd.drag.via === 'pointer'
  const activeTask = dnd.drag ? taskById.get(dnd.drag.activeId) : undefined
  const dropDestination =
    dnd.drag?.kind === 'task' && dnd.drag.overAppendOnly && dnd.drag.overContainer
      ? groupName(dnd.drag.overContainer)
      : null

  return (
    <ListContext.Provider value={context}>
      {parentIds.length > 0 ? (
        <ViewBarActions>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTasksExpanded(parentIds, !allExpanded)}
          >
            {allExpanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
            {allExpanded ? 'Collapse subtasks' : 'Expand subtasks'}
          </Button>
        </ViewBarActions>
      ) : null}
      {isEmpty ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EmptyState
            icon={ListTodo}
            title="No tasks yet"
            description="Add your first task — a name is enough. Phases are optional: add them later if you want to group tasks."
            action={
              <div className="w-[22rem] max-w-full text-left">
                <InlineCreate
                  label="Add your first task"
                  placeholder="Task name, then Enter"
                  inputLabel="Add your first task"
                  open
                  sticky
                  hint="below"
                  onOpenChange={() => {}}
                  validate={validateTitle}
                  onSubmit={(title) => {
                    // The list replaces this empty state: keep typing in its "Add task" row.
                    setEditingRow(addRowKey.group(NO_PHASE_CONTAINER))
                    return createTask({ title, phaseId: null, parentTaskId: null, afterId: null })
                  }}
                />
              </div>
            }
            secondaryAction={
              <Button variant="link" size="sm" onClick={() => openPhaseDialog(project.id)}>
                Add a phase first
              </Button>
            }
          />
        </div>
      ) : (
        <DndContext
          sensors={dnd.sensors}
          collisionDetection={dnd.collisionDetection}
          measuring={MEASURING}
          accessibility={{ announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
          {...dnd.handlers}
        >
          <div className="min-h-0 flex-1 overflow-y-auto pt-1 pb-16" data-list-scroll>
            {showNoPhaseDropZone ? <NoPhaseDropZone containerId={NO_PHASE_CONTAINER} /> : null}
            {outline.groups.map((group, index) => {
              const containerId = groupContainerId(group.phase?.id ?? null)
              if (group.phase === null && !showNoPhase) return null
              return (
                <ListGroup
                  key={containerId}
                  group={group}
                  containerId={containerId}
                  taskIds={dnd.containers[containerId] ?? []}
                  entries={entries}
                  showHeader={outline.hasPhases}
                  collapsed={isCollapsed(containerId)}
                  onCollapsedChange={(collapsed) =>
                    setGroupCollapsed(groupKey(project.id, containerId), collapsed)
                  }
                  phaseIndex={index - 1}
                  phaseCount={phases.length}
                />
              )
            })}
            <div className="mt-3">
              <InlineCreate
                label="Add phase"
                inputLabel="New phase name"
                placeholder="Phase name"
                open={editingRow === addRowKey.phase}
                onOpenChange={(open) => setEditingRow(open ? addRowKey.phase : null)}
                validate={validatePhaseName}
                onSubmit={async (name) => {
                  const result = await actions.createPhase({ projectId: project.id, name })
                  return !result.ok && result.error.kind === 'validation'
                    ? result.error.message
                    : null
                }}
                className="pr-3 pl-6"
              />
            </div>
          </div>
          <DragOverlay dropAnimation={dropAnimation} modifiers={OVERLAY_MODIFIERS}>
            {activeTask ? (
              <TaskRowPreview
                task={activeTask}
                depth={dnd.drag?.kind === 'subtask' ? 1 : 0}
                subtaskCount={
                  dnd.drag?.kind === 'task' ? (entries.get(activeTask.id)?.subtasks.length ?? 0) : 0
                }
                destination={dropDestination}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </ListContext.Provider>
  )
}
