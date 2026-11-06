import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Plus } from 'lucide-react'
import { DueLabel } from '@/components/task/DueLabel'
import { STATUS_LABELS } from '@/components/task/labels'
import { StatusIcon } from '@/components/task/StatusIcon'
import { StatusMenu } from '@/components/task/StatusMenu'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { hoverFade, insetFocus } from '@/components/ui/styles'
import { isRetryable } from '@/data/errors'
import { useActions, useSubtasks } from '@/data/hooks'
import { computeProgress } from '@/domain/progress'
import type { Task } from '@/domain/types'
import { notify } from '@/lib/notify'
import { cn } from '@/lib/utils'
import { FieldError, SectionHeading } from './fields'
import { isComposing } from './keys'
import { currentTasks, useRetryFulfilment } from './retryFulfilment'

/** What the form does with a line typed into "Add subtask" and not added yet. */
export interface SubtaskLineControls {
  /** Leaving: the line becomes a subtask (with an Undo), so what was typed is not lost. */
  commit: () => void
  /** The parent is being deleted: the line goes with it. */
  clear: () => void
}

export interface SubtasksSectionProps {
  parent: Task
  /** Opens a subtask in the modal. */
  onOpenTask: (taskId: string) => void
  controlsRef?: RefObject<SubtaskLineControls | null>
}

/**
 * Subtasks of a top-level task. Every action here saves immediately: status changes, opening a
 * subtask, and "Add subtask".
 */
export function SubtasksSection({ parent, onOpenTask, controlsRef }: SubtasksSectionProps) {
  const subtasks = useSubtasks(parent.id)
  const { createTask, updateTask, deleteTask } = useActions()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(0)
  const headingId = useId()
  const errorId = useId()
  const progress = computeProgress(subtasks)

  const hasDraft = draft.trim() !== ''
  const composingRef = useRef(false)
  const lineRef = useRef(draft)
  useLayoutEffect(() => {
    lineRef.current = draft
  })
  const parentId = parent.id
  const projectId = parent.projectId
  useEffect(() => {
    if (!controlsRef) return
    controlsRef.current = {
      commit: () => {
        const title = lineRef.current.trim()
        // Unconfirmed IME text is not a title anyone chose.
        if (!title || composingRef.current) return
        lineRef.current = ''
        void createTask({ projectId, parentTaskId: parentId, title }).then((result) => {
          // A failure is reported by the store's toast, with Retry.
          if (!result.ok) return
          notify.success('Subtask added', {
            description: title,
            action: {
              label: 'Undo',
              onClick: () => void deleteTask(result.value.id, { keepSubtasks: false }),
            },
          })
        })
      },
      clear: () => {
        lineRef.current = ''
      },
    }
  }, [controlsRef, createTask, deleteTask, parentId, projectId])

  // A failed add gives its text back (below) while the toast offers Retry: if that Retry stores
  // the subtask, the line is cleared instead of inviting a second, duplicate add.
  const retryFulfilment = useRetryFulfilment(subtasks, currentTasks, (subtask) => {
    setDraft((current) => (current.trim() === subtask.title ? '' : current))
  })

  const add = async () => {
    const title = draft.trim()
    if (!title) return
    retryFulfilment.disarm()
    setDraft('')
    setError(null)
    setAdding((count) => count + 1)
    const result = await createTask({ projectId: parent.projectId, parentTaskId: parent.id, title })
    setAdding((count) => count - 1)
    if (!result.ok) {
      // Give the text back (unless the next one is already being typed). Remote failures are
      // reported by the store's toast; validation problems are shown here.
      setDraft((current) => (current === '' ? title : current))
      if (result.error.kind === 'validation') setError(result.error.message)
      else if (isRetryable(result.error)) retryFulfilment.arm((subtask) => subtask.title === title)
    }
  }

  return (
    <section aria-labelledby={headingId}>
      <SectionHeading
        id={headingId}
        title="Subtasks"
        meta={progress.total > 0 ? `${progress.done}/${progress.total}` : undefined}
        aside="One level of subtasks"
      />
      {subtasks.length > 0 ? (
        <ul className="-mx-1.5">
          {subtasks.map((subtask) => (
            <li
              key={subtask.id}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-md px-1 hover:bg-hover',
                hoverFade,
              )}
            >
              {/* The remote-failure toast and rollback come from the store. */}
              <StatusMenu
                value={subtask.status}
                onChange={(status) => void updateTask(subtask.id, { status })}
              >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Status of “${subtask.title}”: ${STATUS_LABELS[subtask.status]}`}
                  className={insetFocus}
                >
                  <StatusIcon status={subtask.status} decorative />
                </Button>
              </StatusMenu>
              <button
                type="button"
                onClick={() => onOpenTask(subtask.id)}
                className={cn(
                  'h-7 min-w-0 flex-1 truncate rounded-sm px-1 text-left text-ui',
                  insetFocus,
                  subtask.status === 'done' ? 'text-fg-tertiary' : 'text-fg',
                )}
              >
                {subtask.title}
              </button>
              <DueLabel dueDate={subtask.dueDate} status={subtask.status} className="pr-1" />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="-mx-1.5 flex h-8 items-center gap-1.5 rounded-md px-1 focus-within:shadow-[inset_0_0_0_1px_var(--focus-ring)]">
        <span className="flex size-6 shrink-0 items-center justify-center text-fg-tertiary">
          {adding > 0 ? (
            <Spinner label="Adding subtask" />
          ) : (
            <Plus className="size-4" aria-hidden />
          )}
        </span>
        <input
          type="text"
          aria-label="Add subtask"
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          placeholder="Add subtask…"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            retryFulfilment.disarm()
            if (error) setError(null)
          }}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={() => {
            composingRef.current = false
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.altKey || isComposing(event)) {
              return
            }
            // Nothing typed: ⌘↵ / Ctrl+↵ bubbles up and closes the modal. With a title, ↵ and ⌘↵
            // both add the subtask and stay.
            if (!hasDraft) return
            event.preventDefault()
            event.stopPropagation()
            void add()
          }}
          className="h-7 min-w-0 flex-1 bg-transparent px-1 text-ui text-fg outline-none placeholder:text-fg-tertiary focus-visible:outline-none"
        />
        {hasDraft ? (
          <span className="shrink-0 pr-1 text-micro text-fg-tertiary">Press Enter to add</span>
        ) : null}
      </div>
      <FieldError id={errorId}>{error}</FieldError>
    </section>
  )
}
