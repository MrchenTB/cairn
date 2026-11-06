/**
 * Everything the edit form saves, field by field:
 * - status, priority, phase: `updateTask` the moment they are picked;
 * - dates: always as a pair, through the planner (Manual warns in the banner, Auto previews);
 * - title, description: `TextDraft` (see there).
 *
 * All of it goes through the store's existing write queue, optimistic update, rollback and Retry;
 * this hook only keeps track of what this modal sent, for the footer. The store still reports every
 * failure in its toast and sidebar indicator, also after the modal is gone.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CompositionEvent,
  type FocusEvent,
} from 'react'
import { useActions, useDataMode, useSyncState } from '@/data/hooks'
import type { ISODate, Task, TaskPatch, TaskPriority, TaskStatus } from '@/domain/types'
import { announceDateChange, rangeText } from '@/features/gantt/dateUndo'
import { planScheduleChangeDetailed } from '@/features/gantt/planner'
import { useRescheduleStore } from '@/features/gantt/rescheduleStore'
import { notify } from '@/lib/notify'
import { useSaveIndicator, type SaveState } from './saveIndicator'
import { taskDrafts, taskWriteOptions } from './taskDrafts'
import type { CommitOutcome, DraftSnapshot, TextDraft, TextField } from './textDraft'

export type PropertyField = 'status' | 'priority' | 'phase' | 'dates'

/** What to send again, and how to tell it arrived anyway (a toast's Retry, a refresh). */
type PropertyFailure = { holds: (task: Task) => boolean } & (
  { patch: TaskPatch } | { dates: { startDate: ISODate | null; dueDate: ISODate | null } }
)

export interface TextBinding {
  field: TextField
  /** What the field shows. */
  value: string
  snapshot: DraftSnapshot
  draft: TextDraft
  onChange: (value: string) => void
  onFocus: () => void
  onBlur: (event: FocusEvent<HTMLTextAreaElement>) => void
  onCompositionStart: (event: CompositionEvent<HTMLTextAreaElement>) => void
  onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => void
}

function useTextBinding(
  task: Task,
  field: TextField,
  sanitize: (value: string) => string,
): TextBinding {
  const taskId = task.id
  const draft = taskDrafts.get(taskId, field)
  // Through the manager, not `draft`: this field's draft may be replaced (a new account's recovery).
  const snapshot = useSyncExternalStore(taskDrafts.subscribe, () =>
    taskDrafts.get(taskId, field).getSnapshot(),
  )

  useEffect(() => {
    taskDrafts.attach(taskId, field, draft)
    return () => {
      const outcome: CommitOutcome = taskDrafts.detach(taskId, field, draft)
      // Left another way than closing (Back, a link): nothing asks, so say where the text went.
      if (outcome === 'invalid' || outcome === 'composing') {
        notify.info('Unsaved text kept', {
          description: `The ${field} wasn’t saved. Reopen the task to finish it.`,
        })
      }
    }
  }, [taskId, field, draft])

  const saved = field === 'title' ? task.title : (task.description ?? '')
  return useMemo(
    () => ({
      field,
      value: snapshot.text ?? saved,
      snapshot,
      draft,
      onChange: (value: string) => draft.input(value),
      onFocus: () => draft.focus(),
      onBlur: (event) => {
        // The window losing focus also blurs the field, which stays the active element: the user
        // has not left it.
        draft.blur({ windowOnly: document.activeElement === event.currentTarget })
      },
      onCompositionStart: (event) => {
        draft.compositionStart(sanitize(event.currentTarget.value))
        // A click anywhere ends the composition with whatever is pre-edited at that moment.
        const interrupt = () => draft.interruptComposition()
        document.addEventListener('pointerdown', interrupt, { capture: true })
        event.currentTarget.addEventListener(
          'compositionend',
          () => document.removeEventListener('pointerdown', interrupt, { capture: true }),
          { once: true },
        )
      },
      onCompositionEnd: (event) => draft.compositionEnd(sanitize(event.currentTarget.value)),
    }),
    [field, snapshot, saved, draft, sanitize],
  )
}

const FIELD_NAMES: Record<PropertyField, string> = {
  status: 'status',
  priority: 'priority',
  phase: 'phase',
  dates: 'dates',
}

export interface TaskAutosave {
  title: TextBinding
  description: TextBinding
  /** Dates shown while a change waits for the preview's answer (null otherwise). */
  pendingDates: { startDate: ISODate | null; dueDate: ISODate | null } | null
  /** "Dates not changed" after a cancelled preview. */
  datesNote: string | null
  /** A change was refused before it was sent (shown in the form). */
  formError: string | null
  setStatus: (status: TaskStatus) => void
  setPriority: (priority: TaskPriority) => void
  setPhase: (phaseId: string | null) => void
  setDates: (startDate: ISODate | null, dueDate: ISODate | null) => void
  saveState: SaveState
  /** "title", "dates", "2 changes"… while something failed. */
  failedWhat: string | null
  retryFailed: () => void
  retrying: boolean
}

export function useTaskAutosave(task: Task, today: ISODate): TaskAutosave {
  const { updateTask } = useActions()
  const mode = useDataMode()
  const sync = useSyncState()
  const previewOpen = useRescheduleStore((state) => state.active !== null)

  const title = useTextBinding(task, 'title', sanitizeTitleText)
  const description = useTextBinding(task, 'description', keepText)

  const [failures, setFailures] = useState<Partial<Record<PropertyField, PropertyFailure>>>({})
  const [writing, setWriting] = useState(0)
  const [saves, setSaves] = useState(0)
  const [pendingDates, setPendingDates] = useState<TaskAutosave['pendingDates']>(null)
  const [datesNote, setDatesNote] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  const taskRef = useRef(task)
  useEffect(() => {
    taskRef.current = task
  })
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  /** The newest change per field: an older one's answer must not report over it. */
  const latest = useRef<Partial<Record<PropertyField, number>>>({})
  const sequence = useRef(0)

  const clearFailure = useCallback((field: PropertyField) => {
    setFailures((current) => {
      if (!current[field]) return current
      const next = { ...current }
      delete next[field]
      return next
    })
  }, [])

  const begin = useCallback(
    (field: PropertyField): number => {
      sequence.current += 1
      latest.current[field] = sequence.current
      clearFailure(field)
      setFormError(null)
      setWriting((count) => count + 1)
      return sequence.current
    },
    [clearFailure],
  )

  const writeProperty = useCallback(
    (field: PropertyField, patch: TaskPatch, holds: (task: Task) => boolean) => {
      const seq = begin(field)
      const current = taskRef.current
      void updateTask(
        current.id,
        patch,
        taskWriteOptions(current.id, current.title, FIELD_NAMES[field]),
      ).then((result) => {
        if (!mountedRef.current) return
        setWriting((count) => count - 1)
        if (result.ok) {
          setSaves((count) => count + 1)
          return
        }
        if (latest.current[field] !== seq) return
        if (result.error.kind === 'validation') {
          setFormError(result.error.message)
          return
        }
        setFailures((existing) => ({ ...existing, [field]: { patch, holds } }))
      })
    },
    [begin, updateTask],
  )

  const setStatus = useCallback(
    (status: TaskStatus) => writeProperty('status', { status }, (t) => t.status === status),
    [writeProperty],
  )
  const setPriority = useCallback(
    (priority: TaskPriority) =>
      writeProperty('priority', { priority }, (t) => t.priority === priority),
    [writeProperty],
  )
  const setPhase = useCallback(
    (phaseId: string | null) => writeProperty('phase', { phaseId }, (t) => t.phaseId === phaseId),
    [writeProperty],
  )

  const setDates = useCallback(
    (startDate: ISODate | null, dueDate: ISODate | null) => {
      const seq = begin('dates')
      const current = taskRef.current
      setDatesNote(null)
      setPendingDates({ startDate, dueDate })
      const holds = (t: Task) => t.startDate === startDate && t.dueDate === dueDate
      void planScheduleChangeDetailed(
        { taskId: current.id, startDate, dueDate },
        {
          source: 'modal',
          writeOptions: taskWriteOptions(current.id, current.title, FIELD_NAMES.dates),
          onWritten: (record) =>
            announceDateChange({
              kind: 'updated',
              title: current.title,
              label: rangeText({ taskId: current.id, startDate, dueDate }, today),
              record,
              today,
            }),
        },
      ).then((outcome) => {
        if (!mountedRef.current) return
        setWriting((count) => count - 1)
        if (latest.current.dates === seq) setPendingDates(null)
        if (outcome.status === 'written') {
          setSaves((count) => count + 1)
          return
        }
        if (latest.current.dates !== seq) return
        if (outcome.status === 'cancelled') setDatesNote('Dates not changed.')
        else if (outcome.status === 'invalid') setFormError(outcome.error.message)
        else if (outcome.status === 'failed') {
          if (outcome.error.kind === 'validation') setFormError(outcome.error.message)
          else {
            setFailures((existing) => ({
              ...existing,
              dates: { dates: { startDate, dueDate }, holds },
            }))
          }
        }
      })
    },
    [begin, today],
  )

  // A failed property that the store now holds (its toast's Retry, a refresh) is over.
  const failedProperties = Object.keys(failures) as PropertyField[]
  const overFailures = failedProperties.filter((field) => failures[field]?.holds(task))
  if (overFailures.length > 0) {
    const remaining = { ...failures }
    for (const field of overFailures) delete remaining[field]
    setFailures(remaining)
  }

  const textFailed = [title, description].filter((binding) => binding.snapshot.phase === 'failed')
  const failedFields: string[] = [
    ...textFailed.map((binding) => binding.field),
    ...failedProperties.map((field) => FIELD_NAMES[field]),
  ]
  const failedWhat =
    failedFields.length === 0
      ? null
      : failedFields.length === 1
        ? failedFields[0]
        : `${failedFields.length} changes`

  const retryFailed = useCallback(() => {
    setRetrying(true)
    for (const field of Object.keys(failures) as PropertyField[]) {
      const failure = failures[field]
      if (!failure) continue
      if ('dates' in failure) setDates(failure.dates.startDate, failure.dates.dueDate)
      else writeProperty(field, failure.patch, failure.holds)
    }
    for (const binding of [title, description]) {
      if (binding.snapshot.phase === 'failed') binding.draft.retry()
    }
    // The footer shows the outcome of the writes themselves; this only guards double clicks.
    setTimeout(() => {
      if (mountedRef.current) setRetrying(false)
    }, 300)
  }, [failures, title, description, setDates, writeProperty])

  const phases = [title.snapshot.phase, description.snapshot.phase]
  const saveState = useSaveIndicator({
    failed: failedFields.length > 0,
    invalid: phases.includes('invalid'),
    restored: phases.includes('restored') || phases.includes('conflict'),
    offline: phases.includes('held') || (mode === 'supabase' && !sync.online),
    saving: phases.includes('saving') || (writing > 0 && !previewOpen),
    pending: phases.includes('pending'),
    saves: saves + title.snapshot.saves + description.snapshot.saves,
  })

  return {
    title,
    description,
    pendingDates,
    datesNote,
    formError,
    setStatus,
    setPriority,
    setPhase,
    setDates,
    saveState,
    failedWhat,
    retryFailed,
    retrying,
  }
}

function sanitizeTitleText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ')
}

function keepText(value: string): string {
  return value
}
