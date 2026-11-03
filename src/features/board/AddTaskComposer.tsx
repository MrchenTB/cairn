import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TITLE_MAX_LENGTH, type Result } from '@/domain/types'

export interface AddTaskComposerProps {
  /** Column name for accessible labels, e.g. "To Do". */
  columnLabel: string
  /**
   * Creates the task. The store applies it optimistically before resolving; a `validation` error
   * is shown inline (remote failures are toasted by the store with Retry).
   */
  onCreate: (title: string) => Promise<Result<unknown>>
  /** Called after each create was handed to the store (e.g. to scroll the new card into view). */
  onCreated?: () => void
}

/**
 * "+ Add task" at the bottom of a column. Opens an inline input: Enter adds the task and keeps
 * the input focused for rapid entry, Esc (or Cancel) closes it and returns focus to the button.
 * Enter is ignored while an IME is composing (CJK input).
 */
export function AddTaskComposer({ columnLabel, onCreate, onCreated }: AddTaskComposerProps) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const errorId = useId()

  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
    } else if (restoreFocus.current) {
      restoreFocus.current = false
      buttonRef.current?.focus()
    }
  }, [open])

  const close = (returnFocus: boolean) => {
    restoreFocus.current = returnFocus
    setValue('')
    setError(null)
    setOpen(false)
  }

  const submit = async () => {
    // Rapid entry: the input keeps (or, after clicking "Add task", gets back) the focus.
    inputRef.current?.focus()
    const title = value.trim()
    if (!title) return
    setValue('')
    setError(null)
    const pending = onCreate(title)
    onCreated?.()
    const result = await pending
    if (!result.ok && result.error.kind === 'validation') {
      // Nothing was saved: give the text back with the reason.
      setValue((current) => current || title)
      setError(result.error.message)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    // Leaving an empty composer closes it; typed text is kept until Esc / Cancel.
    if (!value.trim()) close(false)
  }

  if (!open) {
    return (
      <Button
        ref={buttonRef}
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Add task to ${columnLabel}`}
        className="w-full justify-start gap-1.5 px-2 font-normal text-fg-tertiary"
      >
        <Plus aria-hidden />
        Add task
      </Button>
    )
  }

  return (
    <div className="flex flex-col gap-1.5" onBlur={onBlur}>
      <Input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          if (error) setError(null)
        }}
        onKeyDown={onKeyDown}
        placeholder="Task name"
        aria-label={`New task in ${columnLabel}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        maxLength={TITLE_MAX_LENGTH}
        autoComplete="off"
        enterKeyHint="done"
      />
      {error ? (
        <p id={errorId} className="px-0.5 text-meta text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-1.5">
        <Button variant="primary" size="xs" onClick={() => void submit()}>
          Add task
        </Button>
        <Button variant="ghost" size="xs" onClick={() => close(true)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
