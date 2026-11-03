import { useEffect, useId, useState, type Ref } from 'react'
import { Plus } from 'lucide-react'
import { DueLabel } from '@/components/task/DueLabel'
import { STATUS_LABELS } from '@/components/task/labels'
import { StatusIcon } from '@/components/task/StatusIcon'
import { StatusMenu } from '@/components/task/StatusMenu'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { hoverFade, insetFocus } from '@/components/ui/styles'
import { useActions, useSubtasks } from '@/data/hooks'
import { computeProgress } from '@/domain/progress'
import type { Task } from '@/domain/types'
import { cn } from '@/lib/utils'
import { FieldError, SectionHeading } from './fields'
import { isComposing } from './keys'

export interface SubtasksSectionProps {
  parent: Task
  /** Opens a subtask in the modal (goes through the unsaved-changes guard). */
  onOpenTask: (taskId: string) => void
  /** Text typed into "Add subtask" but not added yet (counts as unsaved). Must be stable. */
  onDraftChange: (hasDraft: boolean) => void
  /** The "Add subtask" input (the modal focuses it when Save leaves an unsent line behind). */
  inputRef?: Ref<HTMLInputElement>
}

/**
 * Subtasks of a top-level task. Every action here saves immediately (it is not part of the
 * Save form): status changes, opening a subtask, and "Add subtask".
 */
export function SubtasksSection({
  parent,
  onOpenTask,
  onDraftChange,
  inputRef,
}: SubtasksSectionProps) {
  const subtasks = useSubtasks(parent.id)
  const { createTask, updateTask } = useActions()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(0)
  const headingId = useId()
  const errorId = useId()
  const progress = computeProgress(subtasks)

  const hasDraft = draft.trim() !== ''
  useEffect(() => {
    onDraftChange(hasDraft)
  }, [hasDraft, onDraftChange])

  const add = async () => {
    const title = draft.trim()
    if (!title) return
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
              {/* Saves right away (not part of the Save form). The remote-failure toast and
                  rollback come from the store. */}
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
          ref={inputRef}
          type="text"
          aria-label="Add subtask"
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          placeholder="Add subtask…"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.altKey || isComposing(event)) {
              return
            }
            // Nothing typed: ⌘↵ / Ctrl+↵ bubbles up and saves the modal. With a title, ↵ and
            // ⌘↵ both add the subtask (the line is never lost to a save that closes the modal).
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
