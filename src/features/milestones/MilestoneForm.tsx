import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react'
import { Trash2 } from 'lucide-react'
import type { MilestoneDialogState } from '@/app/uiStore'
import { DateField } from '@/components/task/DateField'
import { ProjectDot } from '@/components/task/ProjectDot'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useActions, useMilestone, usePhases, useProject } from '@/data/hooks'
import { formatDate } from '@/domain/dates'
import {
  NAME_MAX_LENGTH,
  type ISODate,
  type Milestone,
  type MilestonePatch,
  type Result,
} from '@/domain/types'
import { validateName } from '@/domain/validation'
import { notify } from '@/lib/notify'

export interface MilestoneFormControls {
  requestClose: () => void
}

export interface MilestoneFormProps {
  state: MilestoneDialogState
  controlsRef: RefObject<MilestoneFormControls | null>
  onClose: () => void
  onDeleting: (milestoneId: string) => void
}

interface Values {
  name: string
  date: ISODate | null
  phaseId: string | null
}

const NO_PHASE = '__none__'

/** Milestone diamond (design §5.12). */
function MilestoneGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className}>
      <rect
        x="4"
        y="4"
        width="8"
        height="8"
        rx="1.5"
        transform="rotate(45 8 8)"
        fill="currentColor"
      />
    </svg>
  )
}

export function MilestoneForm({ state, controlsRef, onClose, onDeleting }: MilestoneFormProps) {
  const live = useMilestone(state.mode === 'edit' ? state.milestoneId : null)
  // Keep showing the last version while the dialog animates out after a delete.
  const [lastMilestone, setLastMilestone] = useState(live)
  if (live && live !== lastMilestone) setLastMilestone(live)
  const milestone: Milestone | undefined = live ?? lastMilestone

  const projectId = state.mode === 'create' ? state.projectId : (milestone?.projectId ?? null)
  const project = useProject(projectId)
  const phases = usePhases(projectId)
  const { createMilestone, updateMilestone, deleteMilestone } = useActions()

  const [initial] = useState<Values>(() =>
    state.mode === 'create'
      ? { name: '', date: state.date ?? null, phaseId: state.phaseId ?? null }
      : {
          name: milestone?.name ?? '',
          date: milestone?.date ?? null,
          phaseId: milestone?.phaseId ?? null,
        },
  )
  const [values, setValues] = useState<Values>(initial)
  const [touched, setTouched] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const nameError = validateName(values.name, NAME_MAX_LENGTH, 'Milestone name')?.message ?? null
  const dateError = values.date ? null : 'Choose a date for this milestone.'
  const dirty =
    values.name.trim() !== initial.name.trim() ||
    values.date !== initial.date ||
    values.phaseId !== initial.phaseId
  const valid = nameError === null && dateError === null
  const canSubmit = valid && !saving && (state.mode === 'create' || dirty)

  const savingRef = useRef(false)
  const latest = useRef({ values, dirty })
  useLayoutEffect(() => {
    latest.current = { values, dirty }
  })

  const nameId = useId()
  const dateId = useId()
  const phaseId = useId()
  const nameErrorId = useId()
  const dateErrorId = useId()

  const requestClose = useCallback(async () => {
    if (latest.current.dirty && !savingRef.current) {
      const discard = await confirm({
        title: 'Discard changes?',
        description: 'Your changes to this milestone haven’t been saved.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        destructive: true,
      })
      if (!discard) return
    }
    onClose()
  }, [onClose])

  useEffect(() => {
    const controls: MilestoneFormControls = { requestClose: () => void requestClose() }
    controlsRef.current = controls
    return () => {
      if (controlsRef.current === controls) controlsRef.current = null
    }
  }, [controlsRef, requestClose])

  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    setValues((current) => ({ ...current, [key]: value }))
    setFormError(null)
  }

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (savingRef.current) return
    setShowErrors(true)
    const current = latest.current.values
    if (!current.date || validateName(current.name, NAME_MAX_LENGTH, 'Milestone name')) return
    if (state.mode === 'edit' && !latest.current.dirty) {
      onClose()
      return
    }
    savingRef.current = true
    setSaving(true)
    setFormError(null)
    let result: Result<unknown>
    if (state.mode === 'create') {
      result = await createMilestone({
        projectId: state.projectId,
        name: current.name,
        date: current.date,
        phaseId: current.phaseId,
      })
    } else {
      const patch: MilestonePatch = {}
      if (current.name.trim() !== initial.name.trim()) patch.name = current.name
      if (current.date !== initial.date) patch.date = current.date
      if (current.phaseId !== initial.phaseId) patch.phaseId = current.phaseId
      result = await updateMilestone(state.milestoneId, patch)
    }
    savingRef.current = false
    setSaving(false)
    if (!result.ok) {
      // Remote failures were toasted (with Retry) by the store; keep the dialog and its data.
      if (result.error.kind === 'validation' || result.error.kind === 'not_found') {
        setFormError(result.error.message)
      }
      return
    }
    onClose()
    if (state.mode === 'create') notify.success('Milestone created')
  }

  const remove = async () => {
    if (state.mode !== 'edit' || !milestone) return
    const ok = await confirm({
      title: 'Delete milestone?',
      description: `“${milestone.name}” on ${formatDate(milestone.date, 'medium')} will be deleted. This can’t be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    onDeleting(milestone.id)
    onClose()
    const result = await deleteMilestone(milestone.id)
    if (result.ok) notify.success('Milestone deleted')
  }

  const showNameError = (touched || showErrors) && nameError !== null
  const showDateError = showErrors && dateError !== null
  const showPhase = phases.length > 0 || values.phaseId !== null
  const currentPhase = phases.find((phase) => phase.id === values.phaseId) ?? null

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          void submit()
        }
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <DialogHeader>
        <DialogTitle>{state.mode === 'create' ? 'New milestone' : 'Edit milestone'}</DialogTitle>
        <DialogDescription className="flex min-w-0 items-center gap-1.5">
          {project ? (
            <>
              <ProjectDot color={project.color} />
              <span className="truncate">{project.name}</span>
            </>
          ) : (
            'This project no longer exists.'
          )}
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pt-2 pb-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={nameId}>Name</Label>
          <Input
            id={nameId}
            autoFocus
            value={values.name}
            placeholder="e.g. Submission deadline"
            aria-invalid={showNameError || undefined}
            aria-describedby={showNameError ? nameErrorId : undefined}
            aria-required
            onChange={(event) => {
              set('name', event.target.value.replace(/[\r\n]+/g, ' '))
              setTouched(true)
            }}
          />
          {showNameError ? (
            <p id={nameErrorId} role="alert" className="text-meta text-danger">
              {nameError}
            </p>
          ) : null}
        </div>

        <div className={showPhase ? 'grid grid-cols-2 gap-3' : 'flex flex-col'}>
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={dateId}>Date</Label>
            <DateField
              id={dateId}
              label="Date"
              placeholder="Pick a date"
              variant="field"
              format="medium"
              clearable={false}
              value={values.date}
              aria-invalid={showDateError || undefined}
              onChange={(date) => set('date', date)}
            />
            {showDateError ? (
              <p id={dateErrorId} role="alert" className="text-meta text-danger">
                {dateError}
              </p>
            ) : null}
          </div>
          {showPhase ? (
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={phaseId}>Phase</Label>
              <Select
                value={currentPhase ? currentPhase.id : NO_PHASE}
                onValueChange={(next) => set('phaseId', next === NO_PHASE ? null : next)}
              >
                <SelectTrigger id={phaseId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PHASE}>No phase</SelectItem>
                  {phases.map((phase) => (
                    <SelectItem key={phase.id} value={phase.id}>
                      {phase.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>

        <p className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-meta text-fg-secondary">
          <MilestoneGlyph className="mt-0.5 size-3.5 shrink-0 text-fg-tertiary" />
          <span>
            A milestone is a single-day marker on the Gantt and Timeline. Milestones never count
            toward project progress.
          </span>
        </p>

        {formError ? (
          <p role="alert" className="text-meta text-danger">
            {formError}
          </p>
        ) : null}
      </div>

      <DialogFooter bordered className="justify-between">
        {state.mode === 'edit' ? (
          <Button
            type="button"
            variant="danger-ghost"
            size="md"
            onClick={() => void remove()}
            className="-ml-2"
          >
            <Trash2 aria-hidden />
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="md" onClick={() => void requestClose()}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="md" disabled={!canSubmit} loading={saving}>
            {state.mode === 'create' ? 'Create milestone' : 'Save'}
          </Button>
        </div>
      </DialogFooter>
    </form>
  )
}
