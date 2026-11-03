import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { useNavigate } from 'react-router'
import { CornerDownRight, Ellipsis, Link2, Trash2 } from 'lucide-react'
import { useOpenTask } from '@/app/taskModalRoute'
import { DateField } from '@/components/task/DateField'
import { PriorityMenu } from '@/components/task/PriorityMenu'
import { StatusMenu } from '@/components/task/StatusMenu'
import { Button } from '@/components/ui/button'
import { choose, confirm } from '@/components/ui/confirm'
import { DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip } from '@/components/ui/tooltip'
import {
  useActions,
  useDependencies,
  usePhases,
  usePreferences,
  useProject,
  useProjectTasks,
  useSubtasks,
  useTask,
  useToday,
} from '@/data/hooks'
import { findConflicts } from '@/domain/scheduling'
import type { Task } from '@/domain/types'
import { planScheduleChangeDetailed } from '@/features/gantt/planner'
import { notify } from '@/lib/notify'
import { ConflictBanner } from './ConflictBanner'
import { DependenciesSection } from './DependenciesSection'
import { confirmDiscard } from './discard'
import {
  CrumbSeparator,
  DateArrow,
  DescriptionField,
  FieldError,
  LockedChip,
  PhaseGlyph,
  PhasePicker,
  TitleField,
} from './fields'
import {
  diffTask,
  hasErrors,
  isUnchanged,
  mergeEdits,
  validateTaskForm,
  type TaskFormEdits,
  type TaskFormValues,
} from './formModel'
import { ModalBody, ModalFooter, ModalHeader } from './modalParts'
import { plural, type ModalControls } from './modalControls'
import { NavigationGuard } from './NavigationGuard'
import { ProjectLink } from './ProjectPicker'
import { SubtasksSection } from './SubtasksSection'
import { formatTimestamp, formatTimestampFull } from './timestamps'

const crumbButton =
  'inline-flex h-7 max-w-72 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-ui text-fg-secondary transition-colors duration-fast hover:bg-hover hover:text-fg hover:duration-instant'

export interface EditTaskFormProps {
  taskId: string
  controlsRef: RefObject<ModalControls | null>
  /** Closes the modal right away (the form already asked whatever it had to ask). */
  onClose: () => void
  /** Called right before the form deletes the task (so the host does not report it missing). */
  onDeleting: (taskId: string) => void
}

/**
 * Edit mode. Renders the live task; if the task disappears while the modal animates out (e.g. it
 * was just deleted) the last known version stays on screen.
 */
export function EditTaskForm(props: EditTaskFormProps) {
  const live = useTask(props.taskId)
  const [last, setLast] = useState(live)
  if (live && live !== last) setLast(live)
  const task = live ?? last
  return task ? <EditTaskFormBody {...props} task={task} exists={live !== undefined} /> : null
}

function EditTaskFormBody({
  task,
  exists,
  controlsRef,
  onClose,
  onDeleting,
}: EditTaskFormProps & { task: Task; exists: boolean }) {
  const project = useProject(task.projectId)
  const parent = useTask(task.parentTaskId)
  const phases = usePhases(task.projectId)
  const projectTasks = useProjectTasks(task.projectId)
  const dependencies = useDependencies(task.projectId)
  const subtasks = useSubtasks(task.id)
  const { updateTask, deleteTask } = useActions()
  const { timezone } = usePreferences()
  const today = useToday()
  const openTask = useOpenTask()
  const navigate = useNavigate()

  const [edits, setEdits] = useState<TaskFormEdits>({})
  const [saving, setSaving] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [subtaskDraft, setSubtaskDraft] = useState(false)

  const values = useMemo(() => mergeEdits(task, edits), [task, edits])
  const errors = validateTaskForm(values)
  const formDirty = !isUnchanged(diffTask(task, edits))
  const dirty = formDirty || subtaskDraft
  const canSave = formDirty && !hasErrors(errors) && !saving

  const titleRef = useRef<HTMLTextAreaElement>(null)
  const subtaskInputRef = useRef<HTMLInputElement>(null)
  /** Set right before a navigation this form confirmed itself (the guard lets it through). */
  const allowNavigationRef = useRef(false)
  const savingRef = useRef(false)
  const latest = useRef({ task, edits, dirty, subtaskDraft })
  // The latest onClose: a write that resolves later must not close with an old location.
  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => {
    latest.current = { task, edits, dirty, subtaskDraft }
    onCloseRef.current = onClose
  })
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Focus the title with the caret at the end whenever this form appears.
  useEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const setField = <K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) => {
    setEdits((current) => ({ ...current, [key]: value }))
    setFormError(null)
  }

  const closeNow = useCallback(() => {
    allowNavigationRef.current = true
    onCloseRef.current()
  }, [])

  /** True when it is fine to leave this task (nothing unsaved, or the user chose Discard). */
  const confirmLeave = useCallback(async (): Promise<boolean> => {
    if (!latest.current.dirty || savingRef.current) return true
    return confirmDiscard()
  }, [])

  const requestClose = useCallback(async () => {
    if (await confirmLeave()) closeNow()
  }, [confirmLeave, closeNow])

  const submitRef = useRef<() => void>(() => {})
  useEffect(() => {
    const controls: ModalControls = {
      requestClose: () => void requestClose(),
      submit: () => submitRef.current(),
    }
    controlsRef.current = controls
    return () => {
      if (controlsRef.current === controls) controlsRef.current = null
    }
  }, [controlsRef, requestClose])

  /** Leaves this task for another place (another task, the project page) after the guard. */
  const leave = async (go: () => void) => {
    if (!(await confirmLeave())) return
    allowNavigationRef.current = true
    go()
  }
  const openOther = (taskId: string) => void leave(() => openTask(taskId))

  const save = async () => {
    if (savingRef.current) return
    const current = latest.current
    const { schedule, patch } = diffTask(current.task, current.edits)
    if (schedule === null && Object.keys(patch).length === 0) return
    const currentErrors = validateTaskForm(mergeEdits(current.task, current.edits))
    if (hasErrors(currentErrors)) {
      setShowErrors(true)
      if (currentErrors.title) titleRef.current?.focus()
      return
    }
    savingRef.current = true
    setSaving(true)
    setFormError(null)
    try {
      // Dates first, through the planner (Manual warns, Auto previews). Cancelled, rejected or
      // failed: keep the modal open and save nothing else.
      if (schedule) {
        const outcome = await planScheduleChangeDetailed(schedule, { source: 'modal' })
        if (outcome.status === 'invalid') setFormError(outcome.error.message)
        if (outcome.status !== 'written' && outcome.status !== 'unchanged') return
      }
      if (Object.keys(patch).length > 0) {
        const result = await updateTask(current.task.id, patch)
        if (!result.ok) {
          // Remote failures were toasted (with Retry) and rolled back by the store.
          if (result.error.kind === 'validation' || result.error.kind === 'not_found') {
            setFormError(result.error.message)
          }
          return
        }
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
    // Closed (and maybe replaced by another task) while the write was in flight: nothing to do.
    if (!mountedRef.current) return
    // Close unless more was typed while the write was in flight.
    const after = latest.current
    if (!isUnchanged(diffTask(after.task, after.edits))) return
    if (after.subtaskDraft) {
      // An "Add subtask" line that was never added would be lost: stay and point at it.
      subtaskInputRef.current?.focus()
      return
    }
    closeNow()
  }
  useLayoutEffect(() => {
    submitRef.current = () => void save()
  })

  const remove = async () => {
    const current = latest.current.task
    let keepSubtasks = false
    if (subtasks.length > 0) {
      const choice = await choose({
        title: `Delete “${current.title}”?`,
        description: `It has ${plural(subtasks.length, 'subtask')}. Keep them as top-level tasks, or delete them too. This can’t be undone.`,
        choices: [
          { value: 'keep', label: 'Keep subtasks (move to top level)', variant: 'secondary' },
          { value: 'delete', label: 'Delete subtasks too', variant: 'danger' },
        ],
      })
      if (choice === null) return
      keepSubtasks = choice === 'keep'
    } else {
      const linked = dependencies.filter(
        (d) => d.predecessorId === current.id || d.successorId === current.id,
      ).length
      const ok = await confirm({
        title: 'Delete task?',
        description:
          linked > 0
            ? `“${current.title}” and its ${plural(linked, 'dependency', 'dependencies')} will be deleted. This can’t be undone.`
            : `“${current.title}” will be deleted. This can’t be undone.`,
        confirmLabel: 'Delete',
        destructive: true,
      })
      if (!ok) return
    }
    onDeleting(current.id)
    closeNow()
    const result = await deleteTask(current.id, { keepSubtasks })
    if (result.ok) {
      notify.success(keepSubtasks ? 'Task deleted · subtasks kept' : 'Task deleted')
    }
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      notify.success('Link copied')
    } catch {
      notify.error('Couldn’t copy the link')
    }
  }

  // Conflicts as they would be with the dates in the form (updates live while editing); a range
  // that can't be saved (due before start) falls back to the saved dates.
  const tasksById = useMemo(
    () => Object.fromEntries(projectTasks.map((t) => [t.id, t])) as Record<string, Task>,
    [projectTasks],
  )
  const datesEdited =
    errors.dates === null &&
    (values.startDate !== task.startDate || values.dueDate !== task.dueDate)
  const plannedStart = datesEdited ? values.startDate : task.startDate
  const plannedDue = datesEdited ? values.dueDate : task.dueDate
  const conflicts = useMemo(() => {
    const planned = projectTasks.map((t) =>
      t.id === task.id ? { ...t, startDate: plannedStart, dueDate: plannedDue } : t,
    )
    return findConflicts(planned, dependencies).filter(
      (c) => c.successorId === task.id || c.predecessorId === task.id,
    )
  }, [projectTasks, dependencies, task.id, plannedStart, plannedDue])

  const isSubtask = task.parentTaskId !== null
  const currentPhase = phases.find((phase) => phase.id === values.phaseId) ?? null
  const showPhase = phases.length > 0 || task.phaseId !== null
  const showTitleError = showErrors || edits.title !== undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DialogTitle className="sr-only">{`Edit task: ${task.title}`}</DialogTitle>
      <ModalHeader
        onClose={() => void requestClose()}
        actions={
          <DropdownMenu>
            <Tooltip content="More actions">
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="More actions">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => void copyLink()}>
                <Link2 />
                Copy link
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
                <Trash2 />
                Delete task…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      >
        <nav aria-label="Task location" className="flex min-w-0 items-center gap-0.5">
          {project ? (
            <ProjectLink
              project={project}
              onOpen={() =>
                void leave(() => navigate(`/projects/${encodeURIComponent(project.id)}`))
              }
            />
          ) : null}
          {parent ? (
            <>
              <CrumbSeparator />
              <button
                type="button"
                className={crumbButton}
                onClick={() => openOther(parent.id)}
                aria-label={`Subtask of ${parent.title}. Open parent task`}
              >
                <CornerDownRight className="size-3.5 shrink-0 text-fg-tertiary" aria-hidden />
                <span className="truncate">Subtask of {parent.title}</span>
              </button>
            </>
          ) : null}
        </nav>
      </ModalHeader>

      <ModalBody>
        <TitleField
          ref={titleRef}
          value={values.title}
          onChange={(title) => setField('title', title)}
          error={showTitleError ? errors.title : null}
        />
        <div className="mt-2">
          <DescriptionField
            value={values.description}
            onChange={(description) => setField('description', description)}
            error={errors.description}
          />
        </div>

        <div
          role="group"
          aria-label="Properties"
          className="mt-4 flex flex-wrap items-center gap-1.5"
        >
          <StatusMenu
            trigger="chip"
            value={values.status}
            onChange={(status) => setField('status', status)}
          />
          <PriorityMenu
            trigger="chip"
            value={values.priority}
            onChange={(priority) => setField('priority', priority)}
          />
          <DateField
            label="Start date"
            value={values.startDate}
            onChange={(startDate) => setField('startDate', startDate)}
          />
          <DateArrow />
          <DateField
            label="Due date"
            value={values.dueDate}
            min={values.startDate}
            rangeHint="Due date can’t be before the start date."
            aria-invalid={errors.dates !== null}
            onChange={(dueDate) => setField('dueDate', dueDate)}
          />
          {showPhase ? (
            isSubtask ? (
              <LockedChip
                label={`Phase: ${currentPhase?.name ?? 'No phase'}`}
                reason="Subtasks follow their parent’s phase"
                icon={<PhaseGlyph className="text-fg-tertiary" />}
              >
                {currentPhase?.name ?? 'No phase'}
              </LockedChip>
            ) : (
              <PhasePicker
                phases={phases}
                value={values.phaseId}
                onChange={(phaseId) => setField('phaseId', phaseId)}
              />
            )
          ) : null}
        </div>
        <FieldError>{errors.dates}</FieldError>
        <FieldError>{formError}</FieldError>

        {conflicts.length > 0 ? (
          <div className="mt-4">
            <ConflictBanner
              task={task}
              conflicts={conflicts}
              tasksById={tasksById}
              today={today}
              pending={datesEdited}
            />
          </div>
        ) : null}

        {/* Not part of the Save form: every change below is written immediately. */}
        <div className="mt-6 border-t border-subtle pt-3">
          <p className="mb-2 text-meta text-fg-tertiary">
            {isSubtask
              ? 'Dependencies save right away.'
              : 'Subtasks and dependencies save right away.'}
          </p>
          <div className="flex flex-col gap-5">
            {!isSubtask ? (
              <SubtasksSection
                parent={task}
                onOpenTask={openOther}
                onDraftChange={setSubtaskDraft}
                inputRef={subtaskInputRef}
              />
            ) : null}
            <DependenciesSection task={task} onOpenTask={openOther} />
          </div>
        </div>
      </ModalBody>

      <ModalFooter meta={<Timestamps task={task} timeZone={timezone} today={today} />}>
        <Button variant="secondary" size="md" onClick={() => void requestClose()}>
          Cancel
        </Button>
        <Tooltip content="Save changes" shortcut="mod+enter" disabled={!canSave}>
          <Button
            variant="primary"
            size="md"
            disabled={!canSave}
            loading={saving}
            onClick={() => void save()}
          >
            Save
          </Button>
        </Tooltip>
      </ModalFooter>

      {dirty && exists ? <NavigationGuard taskId={task.id} allowRef={allowNavigationRef} /> : null}
    </div>
  )
}

function Timestamps({
  task,
  timeZone,
  today,
}: {
  task: Pick<Task, 'createdAt' | 'updatedAt' | 'completedAt' | 'status'>
  timeZone: string
  today: string
}) {
  const parts: Array<{ label: string; at: string }> = [{ label: 'Created', at: task.createdAt }]
  if (task.updatedAt !== task.createdAt) parts.push({ label: 'Updated', at: task.updatedAt })
  if (task.status === 'done' && task.completedAt) {
    parts.push({ label: 'Completed', at: task.completedAt })
  }
  return (
    <span className="tabular-nums">
      {parts.map(({ label, at }, index) => {
        const text = formatTimestamp(at, timeZone, today)
        if (!text) return null
        return (
          <span key={label}>
            {index > 0 ? ' · ' : null}
            {label}{' '}
            <time dateTime={at} title={formatTimestampFull(at, timeZone)}>
              {text}
            </time>
          </span>
        )
      })}
    </span>
  )
}
