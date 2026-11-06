/**
 * "Add phase" dialog, opened from the project header menu (any view). The List view also adds
 * phases inline; both go through actions.createPhase.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ErrorState } from '@/components/layout/ErrorState'
import { Button } from '@/components/ui/button'
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
import { useActions, usePhases, useSyncState } from '@/data/hooks'
import { NAME_MAX_LENGTH } from '@/domain/types'
import { validateName } from '@/domain/validation'
import { usePhaseDialog } from './phaseDialogStore'
import { dismissSyncErrorToast } from './syncToast'

export function PhaseDialogHost() {
  const projectId = usePhaseDialog((s) => s.projectId)
  const session = usePhaseDialog((s) => s.session)
  const close = usePhaseDialog((s) => s.close)
  // Keep rendering the last form while the dialog animates out.
  const [shown, setShown] = useState(projectId ? { projectId, session } : null)
  if (projectId !== null && (shown?.projectId !== projectId || shown.session !== session)) {
    setShown({ projectId, session })
  }

  return (
    <Dialog
      open={projectId !== null}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      {shown ? (
        <PhaseForm
          key={`${shown.projectId}:${shown.session}`}
          projectId={shown.projectId}
          onDone={close}
        />
      ) : null}
    </Dialog>
  )
}

function PhaseForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const actions = useActions()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const phases = usePhases(projectId)
  const sync = useSyncState()
  // A failed save can still be sent by a Retry from outside the form (the toast's, the sidebar's):
  // the phase that shows up that way under the attempted name is this form's, so the form finishes
  // instead of adding a second one.
  const [openedWith] = useState<ReadonlySet<string>>(() => new Set(phases.map((p) => p.id)))
  const [attemptedName, setAttemptedName] = useState<string | null>(null)
  const retried =
    failed && attemptedName !== null
      ? phases.find((p) => !openedWith.has(p.id) && p.name === attemptedName)
      : undefined
  const savingElsewhere = sync.pending > 0
  useEffect(() => {
    // Once the Retry is saved (not while it may still fail again).
    if (retried && !submitting && !savingElsewhere) onDone()
  }, [retried, submitting, savingElsewhere, onDone])
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const errorId = useId()

  const submit = async () => {
    if (submitting || retried) return
    const invalid = validateName(name, NAME_MAX_LENGTH, 'Phase name')
    if (invalid) {
      setError(invalid.message)
      inputRef.current?.focus()
      return
    }
    setSubmitting(true)
    setFailed(false)
    setAttemptedName(name.trim())
    const result = await actions.createPhase({ projectId, name: name.trim() })
    setSubmitting(false)
    if (result.ok) onDone()
    else if (result.error.kind === 'validation') setError(result.error.message)
    else {
      // Rolled back and toasted by the store; the form keeps the name and owns the retry.
      dismissSyncErrorToast()
      setFailed(true)
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void submit()
  }

  return (
    <DialogContent size="sm">
      <form noValidate onSubmit={onSubmit}>
        <DialogHeader>
          <DialogTitle>New phase</DialogTitle>
          <DialogDescription>
            Phases group a project’s tasks and milestones, e.g. “Research” or “Launch”.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-1.5 pt-1 pb-3">
          <Label htmlFor={inputId}>Name</Label>
          <Input
            ref={inputRef}
            id={inputId}
            autoFocus
            autoComplete="off"
            value={name}
            placeholder="Phase name"
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
              setFailed(false)
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            aria-required
          />
          {error ? (
            <p id={errorId} className="text-meta text-danger">
              {error}
            </p>
          ) : null}
          {failed ? (
            <ErrorState
              variant="banner"
              className="mt-2"
              title="Couldn’t add the phase"
              retryLabel="Try again"
              onRetry={() => void submit()}
              retrying={submitting || retried !== undefined}
            />
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" size="md" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="md" loading={submitting}>
            Add phase
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
