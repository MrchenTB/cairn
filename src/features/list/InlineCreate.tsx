import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { insetFocus } from '@/components/ui/styles'
import { cn } from '@/lib/utils'

export interface InlineCreateProps {
  /** Collapsed button text, e.g. "Add task". */
  label: string
  /** Input placeholder, e.g. "Task name". */
  placeholder: string
  /** Accessible name of the input (defaults to `label`). */
  inputLabel?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Synchronous check (domain validator); returns the message to show, or null. */
  validate: (value: string) => string | null
  /**
   * Creates the item. Resolves null when done (or when the store already reported a remote
   * failure), or a message to show inline (validation the store rejected).
   */
  onSubmit: (value: string) => Promise<string | null>
  /** Classes for the row (indentation). */
  className?: string
  /** Leading glyph when open (default: a plus). */
  icon?: ReactNode
  /** Keep the input open even when it is empty and loses focus (empty-state usage). */
  sticky?: boolean
  /** Where the "Enter to add · Esc to cancel" hint goes (default: after the input). */
  hint?: 'inline' | 'below'
}

/**
 * Quiet "+ Add …" row that turns into an input. Enter creates and keeps focus for rapid entry
 * (IME composition is respected) — the input stays in view while new rows push it down —, Esc
 * cancels, blurring an empty input closes it.
 */
export function InlineCreate({
  label,
  placeholder,
  inputLabel,
  open,
  onOpenChange,
  validate,
  onSubmit,
  className,
  icon,
  sticky = false,
  hint = 'inline',
}: InlineCreateProps) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** Bumped on every submit: the new row lands above the input, which then scrolls into view. */
  const [submits, setSubmits] = useState(0)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const restoreFocus = useRef(false)
  const errorId = useId()
  const hintId = useId()

  useEffect(() => {
    if (!open && restoreFocus.current) {
      restoreFocus.current = false
      buttonRef.current?.focus()
    }
  }, [open])

  useLayoutEffect(() => {
    if (submits > 0) inputRef.current?.scrollIntoView({ block: 'nearest' })
  }, [submits])

  const close = (refocus: boolean) => {
    restoreFocus.current = refocus
    setDraft('')
    setError(null)
    onOpenChange(false)
  }

  const submit = async () => {
    const value = draft.trim()
    if (value === '') return
    const invalid = validate(value)
    if (invalid) {
      setError(invalid)
      return
    }
    setDraft('')
    setError(null)
    // The optimistic row renders in this same tick; keep the input visible below it.
    setSubmits((count) => count + 1)
    const message = await onSubmit(value)
    if (message) {
      setError(message)
      setDraft((current) => (current === '' ? value : current))
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
      if (sticky) {
        setDraft('')
        setError(null)
      } else {
        close(true)
      }
    }
  }

  if (!open) {
    return (
      <button
        ref={buttonRef}
        type="button"
        onClick={() => onOpenChange(true)}
        className={cn(
          'flex h-9 w-full items-center gap-2 text-left text-ui text-fg-tertiary',
          'transition-colors duration-fast hover:bg-hover hover:text-fg-secondary hover:duration-instant',
          insetFocus,
          className,
        )}
      >
        <Plus className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
        {label}
      </button>
    )
  }

  const hintText = `Enter to add · Esc to ${sticky ? 'clear' : 'cancel'}`
  return (
    <div>
      <div className={cn('flex h-9 items-center gap-2', className)}>
        <span
          className="flex size-4 shrink-0 items-center justify-center text-fg-tertiary"
          aria-hidden
        >
          {icon ?? <Plus className="size-4" strokeWidth={1.75} />}
        </span>
        <Input
          ref={inputRef}
          autoFocus
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            if (error) setError(null)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (!sticky && draft.trim() === '') close(false)
          }}
          placeholder={placeholder}
          aria-label={inputLabel ?? label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hint === 'below' ? hintId : undefined}
          autoComplete="off"
          className="h-7 flex-1 px-2"
        />
        {hint === 'inline' ? (
          <span className="hidden shrink-0 text-meta text-fg-tertiary sm:inline" aria-hidden>
            {hintText}
          </span>
        ) : null}
      </div>
      {error ? (
        <p id={errorId} role="alert" className={cn('pb-1.5 text-meta text-danger', className)}>
          <span className="pl-6">{error}</span>
        </p>
      ) : hint === 'below' ? (
        <p id={hintId} className={cn('pb-1 text-meta text-fg-tertiary', className)}>
          <span className="pl-6">{hintText}</span>
        </p>
      ) : null}
    </div>
  )
}
