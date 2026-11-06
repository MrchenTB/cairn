/**
 * Create / edit project dialog. Mounted once by the app shell; open state is
 * `useUIStore().projectDialog` ({ mode: 'create' } | { mode: 'edit', projectId }).
 * Create → navigates to the new project's List view once the server confirmed it.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { useNavigate } from 'react-router'
import { useUIStore, type ProjectDialogState } from '@/app/uiStore'
import { ErrorState } from '@/components/layout/ErrorState'
import { DateField } from '@/components/task/DateField'
import { PROJECT_STATUS_LABELS } from '@/components/task/labels'
import { ProjectColorPicker } from '@/components/task/ProjectColorPicker'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useActions, useProject, useProjects, useSyncState } from '@/data/hooks'
import {
  NAME_MAX_LENGTH,
  PROJECT_COLORS,
  PROJECT_STATUSES,
  type AppError,
  type ISODate,
  type Project,
  type ProjectColor,
  type ProjectStatus,
} from '@/domain/types'
import { validateDateRange, validateDescription, validateName } from '@/domain/validation'
import { isMac } from '@/lib/keyboard'
import { dismissSyncErrorToast } from './syncToast'

interface FormValues {
  name: string
  description: string
  color: ProjectColor
  status: ProjectStatus
  startDate: ISODate | null
  dueDate: ISODate | null
}

interface FormErrors {
  name?: string
  description?: string
  dates?: string
  /** Validation the store reported that has no single field. */
  form?: string
}

function valuesOf(project: Project): FormValues {
  return {
    name: project.name,
    description: project.description ?? '',
    color: project.color,
    status: project.status,
    startDate: project.startDate,
    dueDate: project.dueDate,
  }
}

/** The least used colour (gray last), so new projects are easy to tell apart. */
function suggestColor(projects: readonly Project[]): ProjectColor {
  const usage = new Map<ProjectColor, number>(PROJECT_COLORS.map((color) => [color, 0]))
  for (const project of projects) usage.set(project.color, (usage.get(project.color) ?? 0) + 1)
  const candidates = [...PROJECT_COLORS.filter((color) => color !== 'gray'), 'gray' as const]
  let best = candidates[0]
  for (const color of candidates) {
    if ((usage.get(color) ?? 0) < (usage.get(best) ?? 0)) best = color
  }
  return best
}

function sameValues(a: FormValues, b: FormValues): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.color === b.color &&
    a.status === b.status &&
    a.startDate === b.startDate &&
    a.dueDate === b.dueDate
  )
}

const dialogKeys = new WeakMap<ProjectDialogState, string>()
let dialogSequence = 0

/**
 * One key per open request (every openProjectDialog call passes a new state object), so each
 * opening starts a fresh form: re-opening the same project must not reuse the previous values or
 * its "unsaved changes" state.
 */
function dialogKey(state: ProjectDialogState): string {
  let key = dialogKeys.get(state)
  if (!key) {
    dialogSequence += 1
    key = `${state.mode}:${dialogSequence}`
    dialogKeys.set(state, key)
  }
  return key
}

export function ProjectDialogHost() {
  const dialog = useUIStore((s) => s.projectDialog)
  const closeDialog = useUIStore((s) => s.closeProjectDialog)
  // Keep rendering the last dialog while it animates out.
  const [shown, setShown] = useState<ProjectDialogState | null>(dialog)
  if (dialog !== null && dialog !== shown) setShown(dialog)
  const dirtyRef = useRef(false)

  const requestClose = useCallback(async () => {
    if (dirtyRef.current) {
      const discard = await confirm({
        title: 'Discard changes?',
        description: 'Your changes to this project haven’t been saved.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        destructive: true,
      })
      if (!discard) return
    }
    dirtyRef.current = false
    closeDialog()
  }, [closeDialog])
  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty
  }, [])
  const onCancel = useCallback(() => void requestClose(), [requestClose])
  const onDone = useCallback(() => {
    dirtyRef.current = false
    closeDialog()
  }, [closeDialog])

  return (
    <Dialog
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open) void requestClose()
      }}
    >
      {shown ? (
        <ProjectForm
          key={dialogKey(shown)}
          state={shown}
          onDirtyChange={onDirtyChange}
          onCancel={onCancel}
          onDone={onDone}
        />
      ) : null}
    </Dialog>
  )
}

interface ProjectFormProps {
  state: ProjectDialogState
  onDirtyChange: (dirty: boolean) => void
  onCancel: () => void
  onDone: () => void
}

function ProjectForm({ state, onDirtyChange, onCancel, onDone }: ProjectFormProps) {
  const actions = useActions()
  const navigate = useNavigate()
  const projects = useProjects({ includeArchived: true })
  const project = useProject(state.mode === 'edit' ? state.projectId : null)
  const isEdit = state.mode === 'edit'

  const [initial] = useState<FormValues>(() =>
    project
      ? valuesOf(project)
      : {
          name: '',
          description: '',
          color: suggestColor(projects),
          status: 'active',
          startDate: null,
          dueDate: null,
        },
  )
  const [values, setValues] = useState<FormValues>(initial)
  const [errors, setErrors] = useState<FormErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitFailed, setSubmitFailed] = useState(false)
  const sync = useSyncState()
  // A failed create can still be sent by a Retry from outside the form (the toast's, the sidebar's)
  // while the form is open. The project that shows up that way, under the name this form tried to
  // create, is this form's project: the form then finishes instead of creating a second one.
  const [openedWith] = useState<ReadonlySet<string>>(() => new Set(projects.map((p) => p.id)))
  const [attemptedName, setAttemptedName] = useState<string | null>(null)
  const retriedProject =
    !isEdit && submitFailed && attemptedName !== null
      ? projects.find((p) => !openedWith.has(p.id) && p.name === attemptedName)
      : undefined

  const nameRef = useRef<HTMLInputElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const ids = {
    name: useId(),
    nameError: useId(),
    description: useId(),
    descriptionError: useId(),
    status: useId(),
    start: useId(),
    due: useId(),
    datesError: useId(),
    color: useId(),
  }

  const dirty = useMemo(() => !sameValues(values, initial), [values, initial])
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  // The project was deleted (here or on another device) while its dialog was open.
  const missing = isEdit && !project
  useEffect(() => {
    if (missing) onDone()
  }, [missing, onDone])

  const retriedId = retriedProject?.id
  const savingElsewhere = sync.pending > 0
  useEffect(() => {
    // Once the Retry is saved (not while it may still fail again).
    if (retriedId && !submitting && !savingElsewhere) {
      onDone()
      navigate(`/projects/${retriedId}/list`)
    }
  }, [retriedId, submitting, savingElsewhere, onDone, navigate])

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }))
    setSubmitFailed(false)
    setErrors((current) => {
      if (key === 'name' && current.name) return { ...current, name: undefined, form: undefined }
      if ((key === 'startDate' || key === 'dueDate') && current.dates)
        return { ...current, dates: undefined, form: undefined }
      if (key === 'description' && current.description)
        return { ...current, description: undefined, form: undefined }
      return current
    })
  }

  const submit = async () => {
    if (submitting) return
    // A Retry already created the project: the effect above opens it as soon as it is saved.
    if (retriedProject) return
    const next: FormErrors = {
      name: validateName(values.name, NAME_MAX_LENGTH, 'Project name')?.message,
      description: validateDescription(values.description)?.message,
      dates: validateDateRange(values.startDate, values.dueDate)?.message,
    }
    if (next.name || next.description || next.dates) {
      setErrors(next)
      if (next.name) nameRef.current?.focus()
      else if (next.description) descriptionRef.current?.focus()
      return
    }
    setErrors({})
    setSubmitFailed(false)
    setSubmitting(true)
    const input = {
      name: values.name.trim(),
      description: values.description.trim() === '' ? null : values.description,
      color: values.color,
      status: values.status,
      startDate: values.startDate,
      dueDate: values.dueDate,
    }
    const fail = (error: AppError) => {
      if (error.kind === 'validation') {
        setErrors({ form: error.message })
        return
      }
      // The store rolled the change back and toasted it. While this form is open it owns the
      // retry ("Try again" re-sends the form), so the toast with its own Retry is taken away.
      dismissSyncErrorToast()
      setSubmitFailed(true)
    }
    if (state.mode === 'create') {
      setAttemptedName(input.name)
      const result = await actions.createProject(input)
      setSubmitting(false)
      if (!result.ok) return fail(result.error)
      onDone()
      navigate(`/projects/${result.value.id}/list`)
      return
    }
    const result = await actions.updateProject(state.projectId, input)
    setSubmitting(false)
    if (!result.ok) return fail(result.error)
    onDone()
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void submit()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (
      event.key === 'Enter' &&
      (event.metaKey || event.ctrlKey) &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      void submit()
    }
  }

  const title = isEdit ? 'Edit project' : 'New project'
  const submitLabel = isEdit ? 'Save changes' : 'Create project'

  return (
    <DialogContent
      size="md"
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        nameRef.current?.focus()
        nameRef.current?.select()
      }}
    >
      <form noValidate onSubmit={onSubmit} onKeyDown={onKeyDown} className="flex min-h-0 flex-col">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update the name, details and dates of this project.'
              : 'Phases are optional — you can add tasks right away.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 pt-1 pb-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.name}>Name</Label>
            <Input
              ref={nameRef}
              id={ids.name}
              value={values.name}
              onChange={(event) => set('name', event.target.value)}
              placeholder="e.g. Research project"
              autoComplete="off"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? ids.nameError : undefined}
              aria-required
            />
            {errors.name ? (
              <p id={ids.nameError} className="text-meta text-danger">
                {errors.name}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.description}>
              Description <span className="font-normal text-fg-tertiary">(optional)</span>
            </Label>
            <Textarea
              ref={descriptionRef}
              id={ids.description}
              value={values.description}
              onChange={(event) => set('description', event.target.value)}
              placeholder="What is this project about?"
              minRows={2}
              maxRows={8}
              aria-invalid={errors.description ? true : undefined}
              aria-describedby={errors.description ? ids.descriptionError : undefined}
            />
            {errors.description ? (
              <p id={ids.descriptionError} className="text-meta text-danger">
                {errors.description}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <span id={ids.color} className="text-meta font-medium text-fg-secondary">
              Color
            </span>
            <ProjectColorPicker
              value={values.color}
              onChange={(color) => set('color', color)}
              aria-label="Project color"
              className="-ml-1.5"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={ids.status}>Status</Label>
              <Select
                value={values.status}
                onValueChange={(next) => set('status', next as ProjectStatus)}
              >
                <SelectTrigger id={ids.status}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROJECT_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {PROJECT_STATUS_LABELS[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={ids.start}>Start date</Label>
              <DateField
                id={ids.start}
                variant="field"
                format="medium"
                label="Start date"
                placeholder="No start date"
                value={values.startDate}
                max={values.dueDate}
                rangeHint="The start can’t be after the due date."
                onChange={(date) => set('startDate', date)}
                aria-invalid={errors.dates ? true : undefined}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={ids.due}>Due date</Label>
              <DateField
                id={ids.due}
                variant="field"
                format="medium"
                label="Due date"
                placeholder="No due date"
                value={values.dueDate}
                min={values.startDate}
                rangeHint="The due date can’t be before the start."
                onChange={(date) => set('dueDate', date)}
                aria-invalid={errors.dates ? true : undefined}
              />
            </div>
          </div>
          {errors.dates ? (
            <p id={ids.datesError} role="alert" className="-mt-2 text-meta text-danger">
              {errors.dates}
            </p>
          ) : null}

          {errors.form ? (
            <p role="alert" className="text-meta text-danger">
              {errors.form}
            </p>
          ) : null}
          {submitFailed ? (
            <ErrorState
              variant="banner"
              title={isEdit ? 'Couldn’t save the project' : 'Couldn’t create the project'}
              message="Your changes are still here."
              retryLabel="Try again"
              onRetry={() => void submit()}
              retrying={submitting || retriedProject !== undefined}
            />
          ) : null}
        </DialogBody>
        <DialogFooter>
          <span className="mr-auto hidden text-meta text-fg-tertiary sm:inline">
            {isMac ? '⌘' : 'Ctrl'}+Enter to {isEdit ? 'save' : 'create'}
          </span>
          <Button variant="secondary" size="md" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="md" loading={submitting}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
