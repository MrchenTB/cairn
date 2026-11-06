import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { FolderPlus } from 'lucide-react'
import type { NewTaskDefaults } from '@/app/uiStore'
import { DateField } from '@/components/task/DateField'
import { PriorityMenu } from '@/components/task/PriorityMenu'
import { StatusMenu } from '@/components/task/StatusMenu'
import { Button } from '@/components/ui/button'
import { DialogTitle } from '@/components/ui/dialog'
import { Tooltip } from '@/components/ui/tooltip'
import { useActions, usePhases, useProject, useProjectTasks, useProjects } from '@/data/hooks'
import { isRetryable } from '@/data/errors'
import type { Project, Task } from '@/domain/types'
import { draftFor, getLastProjectId, setLastProjectId } from './createSupport'
import { confirmDiscard } from './discard'
import {
  CrumbSeparator,
  DateArrow,
  DescriptionField,
  FieldError,
  PhasePicker,
  TitleField,
} from './fields'
import {
  buildNewTaskInput,
  hasErrors,
  initialCreateValues,
  isCreateDirty,
  validateTaskForm,
  type TaskFormValues,
} from './formModel'
import { ModalBody, ModalFooter, ModalHeader } from './modalParts'
import type { ModalControls } from './modalControls'
import { ProjectPicker } from './ProjectPicker'
import { currentTasks, useRetryFulfilment } from './retryFulfilment'
import { useUnloadPrompt } from './useUnloadPrompt'

export interface CreateTaskFormProps {
  defaults: NewTaskDefaults
  controlsRef: RefObject<ModalControls | null>
  /** Closes the modal right away. */
  onClose: () => void
  /** The task was stored (the host closes the modal and offers "Open"). */
  onCreated: (task: Task) => void
  /** No project exists yet: close this modal and create one (the draft comes back after). */
  onCreateProject: (draft: TaskFormValues) => void
  /** Whether the form holds unsaved work (so the host asks before replacing it). */
  onDirtyChange?: (dirty: boolean) => void
}

/** Global "New task" default: the last project used on this device, or the only project. */
function defaultProjectId(projects: readonly Project[]): string | null {
  const last = getLastProjectId()
  if (last && projects.some((project) => project.id === last)) return last
  return projects.length === 1 ? projects[0].id : null
}

/** Create mode: only the title is required; everything else has a default. */
export function CreateTaskForm({
  defaults,
  controlsRef,
  onClose,
  onCreated,
  onCreateProject,
  onDirtyChange,
}: CreateTaskFormProps) {
  const activeProjects = useProjects()
  const preset = useProject(defaults.projectId)
  const { createTask } = useActions()

  // An explicitly requested project is offered even when it is archived.
  const options = useMemo(
    () =>
      preset && !activeProjects.some((project) => project.id === preset.id)
        ? [...activeProjects, preset]
        : activeProjects,
    [activeProjects, preset],
  )

  const [initial] = useState(() => ({
    values: initialCreateValues(defaults),
    projectId: defaults.projectId ? (preset?.id ?? null) : defaultProjectId(activeProjects),
  }))
  const [values, setValues] = useState<TaskFormValues>(() => draftFor(defaults) ?? initial.values)
  const [projectId, setProjectId] = useState<string | null>(initial.projectId)
  const [titleTouched, setTitleTouched] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const project = options.find((p) => p.id === projectId) ?? null
  const phases = usePhases(project?.id)
  const errors = validateTaskForm(values)
  const projectError = project ? null : 'Choose a project for this task.'
  const dirty = isCreateDirty(values, initial.values) || projectId !== initial.projectId
  const canCreate = !hasErrors(errors) && project !== null && !saving
  const noProjects = options.length === 0

  // A typed task is not lost to an accidental reload or closed tab.
  useUnloadPrompt(dirty && !saving)
  useEffect(() => {
    onDirtyChange?.(dirty && !saving)
    return () => onDirtyChange?.(false)
  }, [dirty, saving, onDirtyChange])

  const titleRef = useRef<HTMLTextAreaElement>(null)
  const savingRef = useRef(false)
  const latest = useRef({ values, projectId, dirty })
  useLayoutEffect(() => {
    latest.current = { values, projectId, dirty }
  })
  const mountedRef = useRef(true)
  /** The task exists (created here, or by the toast's Retry): never create it a second time. */
  const doneRef = useRef(false)

  // A failed create leaves this form open (nothing is lost) while the toast offers Retry. If that
  // Retry stores the task, this form is done: it closes instead of inviting a duplicate.
  const projectTasks = useProjectTasks(project?.id)
  const retryFulfilment = useRetryFulfilment(projectTasks, currentTasks, (task) => {
    if (doneRef.current) return
    doneRef.current = true
    setLastProjectId(task.projectId)
    if (mountedRef.current) onClose()
    onCreated(task)
  })

  useEffect(() => {
    mountedRef.current = true
    titleRef.current?.focus({ preventScroll: true })
    return () => {
      mountedRef.current = false
    }
  }, [])

  const setField = <K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }))
    setFormError(null)
    retryFulfilment.disarm()
  }

  const requestClose = useCallback(async () => {
    if (latest.current.dirty && !savingRef.current && !(await confirmDiscard())) return
    onClose()
  }, [onClose])

  const submitRef = useRef<() => void>(() => {})
  useEffect(() => {
    const controls: ModalControls = {
      requestClose: () => void requestClose(),
      submit: () => submitRef.current(),
      focus: () => titleRef.current?.focus({ preventScroll: true }),
    }
    controlsRef.current = controls
    return () => {
      if (controlsRef.current === controls) controlsRef.current = null
    }
  }, [controlsRef, requestClose])

  const create = async () => {
    if (savingRef.current || doneRef.current) return
    const current = latest.current
    setShowErrors(true)
    const currentErrors = validateTaskForm(current.values)
    if (currentErrors.title) titleRef.current?.focus()
    if (!current.projectId || hasErrors(currentErrors)) return
    savingRef.current = true
    setSaving(true)
    setFormError(null)
    retryFulfilment.disarm()
    const input = buildNewTaskInput(current.values, {
      projectId: current.projectId,
      placement: defaults.placement,
    })
    const result = await createTask(input)
    savingRef.current = false
    setSaving(false)
    if (!result.ok) {
      // Remote failures were toasted (with Retry) and rolled back by the store; the form keeps
      // everything so the user can try again (or use the toast's Retry: see retryFulfilment).
      // Validation problems are explained here.
      if (result.error.kind === 'validation') setFormError(result.error.message)
      else if (isRetryable(result.error)) {
        retryFulfilment.arm((task) => task.title === input.title && task.parentTaskId === null)
      }
      return
    }
    doneRef.current = true
    setLastProjectId(current.projectId)
    // Closed meanwhile (perhaps a new "New task" is open now): leave the modal alone, still
    // confirm the task was created.
    if (mountedRef.current) onClose()
    onCreated(result.value)
  }
  useLayoutEffect(() => {
    submitRef.current = () => void create()
  })

  const changeProject = (nextId: string) => {
    if (nextId === projectId) return
    retryFulfilment.disarm()
    setProjectId(nextId)
    // Phases belong to one project.
    setValues((current) => ({ ...current, phaseId: null }))
    setFormError(null)
  }

  const showTitleError = showErrors || titleTouched
  // Says why "Create" is unavailable before the user runs into the error (then the error says it).
  const footerNote =
    !noProjects && !project && !showErrors
      ? 'Choose a project to create this task.'
      : project?.status === 'archived'
        ? 'This project is archived.'
        : null
  const showPhase = project !== null && (phases.length > 0 || values.phaseId !== null)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ModalHeader onClose={() => void requestClose()}>
        {!noProjects ? (
          <>
            <ProjectPicker
              projects={options}
              value={projectId}
              onChange={changeProject}
              invalid={showErrors && !project}
            />
            <CrumbSeparator />
          </>
        ) : null}
        <DialogTitle className="shrink-0 px-1.5 text-ui font-medium text-fg">New task</DialogTitle>
      </ModalHeader>

      <ModalBody>
        <TitleField
          ref={titleRef}
          value={values.title}
          placeholder="Task name"
          onChange={(title) => {
            setField('title', title)
            setTitleTouched(true)
          }}
          onEnter={() => void create()}
          error={showTitleError ? errors.title : null}
        />
        <div className="mt-2">
          <DescriptionField
            value={values.description}
            onChange={(description) => setField('description', description)}
            error={errors.description}
          />
        </div>

        {noProjects ? (
          <div className="mt-4 rounded-lg border border-dashed border-default px-4 py-3.5">
            <p className="text-ui font-medium text-fg">Create a project first</p>
            <p className="mt-0.5 text-ui text-fg-secondary">
              Every task belongs to a project. Create one and this task will be waiting for you,
              with what you’ve typed so far.
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => onCreateProject(latest.current.values)}
            >
              <FolderPlus aria-hidden />
              Create project
            </Button>
          </div>
        ) : (
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
              <PhasePicker
                phases={phases}
                value={values.phaseId}
                onChange={(phaseId) => setField('phaseId', phaseId)}
              />
            ) : null}
          </div>
        )}
        <FieldError>{errors.dates}</FieldError>
        <FieldError>{showErrors && !noProjects ? projectError : null}</FieldError>
        <FieldError>{formError}</FieldError>
      </ModalBody>

      <ModalFooter meta={footerNote}>
        <Button variant="secondary" size="md" onClick={() => void requestClose()}>
          Cancel
        </Button>
        <Tooltip content="Create" shortcut="mod+enter" disabled={!canCreate}>
          <Button
            variant="primary"
            size="md"
            disabled={!canCreate}
            loading={saving}
            onClick={() => void create()}
          >
            Create task
          </Button>
        </Tooltip>
      </ModalFooter>
    </div>
  )
}
