/**
 * Edit mode: every field saves by itself, so there is no Save and no Cancel.
 * - Status, priority, phase and dates save when picked; subtasks and dependencies as before.
 * - The title saves on Enter and blur, the description after a pause and on blur (useTaskAutosave).
 * - Every way out (Esc, X, Done, a click outside, ⌘↵) keeps what was typed: closing hands valid text
 *   to the store without waiting for the network. A later failure stays findable (the draft
 *   registry, the store's toast and the sidebar).
 * - Only text that can't be saved stops the way out, because leaving must not throw it away.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
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
import { findConflicts, findHistoricalInconsistencies } from '@/domain/scheduling'
import type { Task } from '@/domain/types'
import { notify } from '@/lib/notify'
import { SaveStatus } from './autosave/SaveStatus'
import { taskDrafts } from './autosave/taskDrafts'
import { useTaskAutosave, type TextBinding } from './autosave/useTaskAutosave'
import { ConflictBanner, HistoricalNote } from './ConflictBanner'
import { DependenciesSection } from './DependenciesSection'
import { afterDialogsClosed, focusIfNotCovered } from './dialogGuards'
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
import { ModalBody, ModalFooter, ModalHeader } from './modalParts'
import { plural, type ModalControls } from './modalControls'
import { ProjectLink } from './ProjectPicker'
import { SubtasksSection, type SubtaskLineControls } from './SubtasksSection'
import { formatTimestamp, formatTimestampFull } from './timestamps'

const crumbButton =
  'inline-flex h-7 max-w-72 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-ui text-fg-secondary transition-colors duration-fast hover:bg-hover hover:text-fg hover:duration-instant'

/** How long an unfinished IME composition may take to end before closing gives up and says so. */
const COMPOSITION_GRACE_MS = 300
/** How long "the title was kept" stays under the field. */
const REVERT_NOTICE_MS = 6000

export interface EditTaskFormProps {
  taskId: string
  controlsRef: RefObject<ModalControls | null>
  /**
   * Leaves this task. With a parent id: a subtask that was opened from that parent goes back to it
   * instead of closing the modal.
   */
  onClose: (toParent: string | null) => void
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
  return task ? <EditTaskFormBody {...props} task={task} /> : null
}

const FIELD_LABEL = { title: 'title', description: 'description' } as const

/** What to do with recovered text, and why a failed text is still in the field. */
function DraftNote({ binding }: { binding: TextBinding }) {
  const { snapshot, draft, field } = binding
  const action = (label: string, onClick: () => void) => (
    <Button
      variant="link"
      size="xs"
      className="h-auto p-0 text-meta"
      aria-label={`${label}: ${FIELD_LABEL[field]}`}
      onClick={onClick}
    >
      {label}
    </Button>
  )
  let content: ReactNode = null
  if (snapshot.phase === 'failed') {
    content = <span className="text-danger">Couldn’t save this. Your text is kept here.</span>
  } else if (snapshot.phase === 'restored') {
    content = (
      <>
        <span>
          {snapshot.unconfirmed
            ? 'Your input was interrupted before you confirmed it, so this wasn’t saved.'
            : 'Recovered text that wasn’t saved.'}
        </span>
        {action('Save', () => draft.saveRestored())}
        {action('Discard', () => draft.discard())}
      </>
    )
  } else if (snapshot.phase === 'conflict') {
    content = (
      <>
        <span>You have unsaved text from earlier, but this {field} has changed since.</span>
        {action('Show my text', () => draft.useRecovered())}
        {action('Discard', () => draft.discard())}
      </>
    )
  } else if (snapshot.revertedTo !== null) {
    content = <span>A task needs a title, so “{snapshot.revertedTo}” was kept.</span>
  }
  if (!content) return null
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-meta text-fg-secondary">
      {content}
    </p>
  )
}

function EditTaskFormBody({
  task,
  controlsRef,
  onClose,
  onDeleting,
}: EditTaskFormProps & { task: Task }) {
  const project = useProject(task.projectId)
  const parent = useTask(task.parentTaskId)
  const phases = usePhases(task.projectId)
  const projectTasks = useProjectTasks(task.projectId)
  const dependencies = useDependencies(task.projectId)
  const subtasks = useSubtasks(task.id)
  const { deleteTask } = useActions()
  const { timezone } = usePreferences()
  const today = useToday()
  const openTask = useOpenTask()
  const navigate = useNavigate()
  const autosave = useTaskAutosave(task, today)
  const { title, description } = autosave
  const [leaveNotice, setLeaveNotice] = useState<string | null>(null)

  const titleRef = useRef<HTMLTextAreaElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const subtaskLine = useRef<SubtaskLineControls | null>(null)
  const latest = useRef({ task, title, description })
  // The latest onClose: a close that resolves later must not use an old location.
  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => {
    latest.current = { task, title, description }
    onCloseRef.current = onClose
  })

  // Focus the title with the caret at the end whenever this form appears.
  useEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // Leaving any other way (Back, a link, a search result): what was typed in "Add subtask" is kept.
  useEffect(
    () => () => {
      subtaskLine.current?.commit()
    },
    [],
  )

  const { revertedTo } = title.snapshot
  const titleDraft = title.draft
  useEffect(() => {
    if (revertedTo === null) return undefined
    const timer = setTimeout(() => titleDraft.clearRevertedNotice(), REVERT_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [revertedTo, titleDraft])

  /** IME compositions in progress anywhere in this form. */
  const composingRef = useRef(false)
  const compositionWaiters = useRef<(() => void)[]>([])
  const onCompositionStartCapture = () => {
    composingRef.current = true
  }
  const onCompositionEndCapture = () => {
    composingRef.current = false
    setLeaveNotice(null)
    // Fields handle compositionend while it bubbles: let them finish first.
    queueMicrotask(() => {
      for (const resolve of compositionWaiters.current.splice(0)) resolve()
    })
  }

  /** Resolves once no composition is in progress, or after the grace period. */
  const compositionEnded = useCallback(async (): Promise<boolean> => {
    if (!composingRef.current) return true
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, COMPOSITION_GRACE_MS)
      compositionWaiters.current.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    return !composingRef.current
  }, [])

  /**
   * Hands everything valid to the store. False: the form must stay, because some text can neither
   * be saved nor silently dropped (the user decided to keep editing, or is still composing).
   */
  const prepareToLeave = useCallback(async (): Promise<boolean> => {
    if (!(await compositionEnded())) {
      setLeaveNotice('Finish or cancel the text you’re composing first.')
      return false
    }
    setLeaveNotice(null)
    const current = latest.current
    const invalid: TextBinding[] = []
    for (const binding of [current.title, current.description]) {
      // Interrupted input on screen, with its Save and Discard right there: the user decides first.
      if (binding.draft.getSnapshot().unconfirmed) {
        setLeaveNotice('Save or discard the interrupted text first.')
        return false
      }
      const outcome = binding.draft.commit({ revertEmpty: true })
      if (outcome === 'invalid') invalid.push(binding)
      if (outcome === 'reverted') {
        notify.info('Title not changed', {
          description: `A task needs a title, so “${current.task.title}” was kept.`,
        })
      }
    }
    if (invalid.length > 0) {
      const names = invalid.map((binding) => FIELD_LABEL[binding.field]).join(' and ')
      const discard = await confirm({
        title: `Can’t save this ${names}`,
        description: `${invalid[0].draft.getSnapshot().error ?? 'It can’t be stored as it is.'} Keep editing to fix it, or discard the text you changed.`,
        confirmLabel: 'Discard text',
        cancelLabel: 'Keep editing',
        destructive: true,
      })
      if (!discard) {
        const first = invalid[0].field === 'title' ? titleRef.current : descriptionRef.current
        // After the prompt has returned focus to what opened it.
        const modal = document.querySelector('[data-slot="dialog-content"]')
        afterDialogsClosed(() => focusIfNotCovered(modal, () => first?.focus()), { except: modal })
        return false
      }
      for (const binding of invalid) binding.draft.discard()
    }
    subtaskLine.current?.commit()
    return true
  }, [compositionEnded])

  const closingRef = useRef(false)
  const requestClose = useCallback(async () => {
    if (closingRef.current) return
    closingRef.current = true
    try {
      if (await prepareToLeave()) onCloseRef.current(latest.current.task.parentTaskId)
    } finally {
      closingRef.current = false
    }
  }, [prepareToLeave])

  useEffect(() => {
    const controls: ModalControls = {
      requestClose: () => void requestClose(),
      // ⌘↵: everything is saved by now, so "save" and "close" are the same thing.
      submit: () => void requestClose(),
      focus: () => titleRef.current?.focus({ preventScroll: true }),
    }
    controlsRef.current = controls
    return () => {
      if (controlsRef.current === controls) controlsRef.current = null
    }
  }, [controlsRef, requestClose])

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
    // Text not sent yet goes with the task (never an update of a deleted task).
    taskDrafts.discardTask(current.id)
    subtaskLine.current?.clear()
    onDeleting(current.id)
    onCloseRef.current(null)
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

  const shownStart = autosave.pendingDates ? autosave.pendingDates.startDate : task.startDate
  const shownDue = autosave.pendingDates ? autosave.pendingDates.dueDate : task.dueDate

  // Conflicts as they are with the dates shown (a pick waiting for its preview included).
  const tasksById = useMemo(
    () => Object.fromEntries(projectTasks.map((t) => [t.id, t])) as Record<string, Task>,
    [projectTasks],
  )
  const { conflicts, historical } = useMemo(() => {
    const planned = projectTasks.map((t) =>
      t.id === task.id ? { ...t, startDate: shownStart, dueDate: shownDue } : t,
    )
    const involvesThisTask = (c: { successorId: string; predecessorId: string }) =>
      c.successorId === task.id || c.predecessorId === task.id
    return {
      conflicts: findConflicts(planned, dependencies).filter(involvesThisTask),
      // Done tasks that finished before their predecessor did: kept as history, not a to-do.
      historical: findHistoricalInconsistencies(planned, dependencies).filter(involvesThisTask),
    }
  }, [projectTasks, dependencies, task.id, shownStart, shownDue])

  const isSubtask = task.parentTaskId !== null
  const currentPhase = phases.find((phase) => phase.id === task.phaseId) ?? null
  const showPhase = phases.length > 0 || task.phaseId !== null
  const shownError = (binding: TextBinding) =>
    binding.snapshot.phase === 'failed' ? null : binding.snapshot.error

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onCompositionStartCapture={onCompositionStartCapture}
      onCompositionEndCapture={onCompositionEndCapture}
    >
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
              onOpen={() => navigate(`/projects/${encodeURIComponent(project.id)}`)}
            />
          ) : null}
          {parent ? (
            <>
              <CrumbSeparator />
              <button
                type="button"
                className={crumbButton}
                onClick={() => openTask(parent.id)}
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
          value={title.value}
          onChange={title.onChange}
          onEnter={() => title.draft.commit({ revertEmpty: true })}
          onFocus={title.onFocus}
          onBlur={title.onBlur}
          onCompositionStart={title.onCompositionStart}
          onCompositionEnd={title.onCompositionEnd}
          error={shownError(title)}
          note={<DraftNote binding={title} />}
        />
        <div className="mt-2">
          <DescriptionField
            ref={descriptionRef}
            value={description.value}
            onChange={description.onChange}
            onFocus={description.onFocus}
            onBlur={description.onBlur}
            onCompositionStart={description.onCompositionStart}
            onCompositionEnd={description.onCompositionEnd}
            error={shownError(description)}
            note={<DraftNote binding={description} />}
          />
        </div>
        <FieldError>{leaveNotice}</FieldError>

        <div
          role="group"
          aria-label="Properties"
          className="mt-4 flex flex-wrap items-center gap-1.5"
        >
          <StatusMenu trigger="chip" value={task.status} onChange={autosave.setStatus} />
          <PriorityMenu trigger="chip" value={task.priority} onChange={autosave.setPriority} />
          <DateField
            label="Start date"
            value={shownStart}
            max={shownDue}
            rangeHint="The start can’t be after the due date."
            onChange={(startDate) => autosave.setDates(startDate, shownDue)}
          />
          <DateArrow />
          <DateField
            label="Due date"
            value={shownDue}
            min={shownStart}
            rangeHint="Due date can’t be before the start date."
            onChange={(dueDate) => autosave.setDates(shownStart, dueDate)}
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
              <PhasePicker phases={phases} value={task.phaseId} onChange={autosave.setPhase} />
            )
          ) : null}
        </div>
        {autosave.datesNote ? (
          <p className="mt-1 text-meta text-fg-secondary">{autosave.datesNote}</p>
        ) : null}
        <FieldError>{autosave.formError}</FieldError>

        {conflicts.length > 0 ? (
          <div className="mt-4">
            <ConflictBanner
              task={task}
              conflicts={conflicts}
              tasksById={tasksById}
              today={today}
              pending={autosave.pendingDates !== null}
            />
          </div>
        ) : null}

        {historical.length > 0 ? (
          <div className="mt-4">
            <HistoricalNote
              task={task}
              inconsistencies={historical}
              tasksById={tasksById}
              today={today}
            />
          </div>
        ) : null}

        <div className="mt-6 border-t border-subtle pt-3">
          {isSubtask ? (
            <p className="mb-2 text-meta text-fg-tertiary">
              A subtask can’t have subtasks of its own (one level only).
            </p>
          ) : null}
          <div className="flex flex-col gap-5">
            {!isSubtask ? (
              <SubtasksSection parent={task} onOpenTask={openTask} controlsRef={subtaskLine} />
            ) : null}
            <DependenciesSection task={task} onOpenTask={openTask} />
          </div>
        </div>
      </ModalBody>

      <ModalFooter meta={<Timestamps task={task} timeZone={timezone} today={today} />}>
        <SaveStatus
          state={autosave.saveState}
          failedWhat={autosave.failedWhat}
          onRetry={autosave.retryFailed}
          retrying={autosave.retrying}
        />
        <Tooltip content={parent ? `Back to “${parent.title}”` : 'Close'} shortcut="mod+enter">
          <Button variant="secondary" size="md" onClick={() => void requestClose()}>
            Done
          </Button>
        </Tooltip>
      </ModalFooter>
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
