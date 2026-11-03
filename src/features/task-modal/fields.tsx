/**
 * Task Modal form fields: borderless title + description, the phase picker chip, and small
 * presentational helpers shared by the create and edit forms.
 */
import { useId, type ComponentProps, type ReactNode, type Ref } from 'react'
import { Lock } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button-variants'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip } from '@/components/ui/tooltip'
import { DESCRIPTION_MAX_LENGTH, type Phase } from '@/domain/types'
import { cn } from '@/lib/utils'
import { characterCount, DESCRIPTION_COUNTER_FROM, sanitizeTitle } from './formModel'
import { isComposing, isPlainEnter } from './keys'

/** Inline error line (12px danger) announced politely. */
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  if (!children) return null
  return (
    <p id={id} role="alert" className="mt-1 text-meta text-danger">
      {children}
    </p>
  )
}

const borderless =
  'border-0 bg-transparent px-0 shadow-none hover:border-0 focus-visible:outline-none disabled:bg-transparent'

export interface TitleFieldProps {
  value: string
  onChange: (value: string) => void
  /** Plain Enter (create mode saves; edit mode only blocks the line break). */
  onEnter?: () => void
  error?: string | null
  ref?: Ref<HTMLTextAreaElement>
  placeholder?: string
}

/** 20px / 600 borderless title that wraps (single logical line: Enter never inserts a newline). */
export function TitleField({
  value,
  onChange,
  onEnter,
  error,
  ref,
  placeholder = 'Task name',
}: TitleFieldProps) {
  const errorId = useId()
  return (
    <div>
      <Textarea
        ref={ref}
        aria-label="Task title"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        aria-required
        placeholder={placeholder}
        value={value}
        minRows={1}
        maxRows={6}
        spellCheck
        onChange={(event) => onChange(sanitizeTitle(event.target.value))}
        onKeyDown={(event) => {
          // ⌘↵ bubbles to the modal (save); Enter that confirms an IME composition is left alone.
          if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || isComposing(event)) return
          // Never a line break in a title; plain Enter may submit (create mode).
          event.preventDefault()
          if (isPlainEnter(event)) onEnter?.()
        }}
        className={cn(
          borderless,
          'py-0 text-title leading-(--line-height-title) font-semibold tracking-normal text-fg',
          'placeholder:font-semibold',
        )}
      />
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  )
}

export interface DescriptionFieldProps {
  value: string
  onChange: (value: string) => void
  error?: string | null
}

/** Optional plain-text description: grows with its content; counter near the limit. */
export function DescriptionField({ value, onChange, error }: DescriptionFieldProps) {
  const counterId = useId()
  const errorId = useId()
  // Only count code points when it can matter (the UTF-16 length is an upper bound).
  const count = value.length >= DESCRIPTION_COUNTER_FROM ? characterCount(value) : 0
  const showCounter = count >= DESCRIPTION_COUNTER_FROM
  const over = count > DESCRIPTION_MAX_LENGTH
  const describedBy = [showCounter ? counterId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ')
  return (
    <div>
      <Textarea
        aria-label="Description"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        placeholder="Add description…"
        value={value}
        minRows={2}
        maxRows={14}
        onChange={(event) => onChange(event.target.value)}
        className={cn(borderless, 'py-0 text-body leading-(--line-height-body) text-fg')}
      />
      {showCounter ? (
        <p
          id={counterId}
          className={cn(
            'mt-1 text-right text-micro tabular-nums',
            over ? 'text-danger' : 'text-fg-tertiary',
          )}
        >
          {count.toLocaleString('en-US')} / {DESCRIPTION_MAX_LENGTH.toLocaleString('en-US')}
        </p>
      ) : null}
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  )
}

/** Phase glyph (summary bracket, design §5.12). */
export function PhaseGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden
      className={cn('size-3.5 shrink-0', className)}
    >
      <path d="M2.75 5.5v5M13.25 5.5v5M2.75 8h10.5" />
    </svg>
  )
}

const chip = cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5 px-2 font-normal')

/**
 * A property that cannot be changed here: looks like a chip, stays focusable so the tooltip
 * (the reason) is reachable by keyboard and pointer, and does nothing when activated.
 */
export function LockedChip({
  label,
  reason,
  icon,
  children,
  className,
}: {
  /** Accessible name, e.g. "Phase: Design". */
  label: string
  reason: string
  icon?: ReactNode
  children: ReactNode
  className?: string
}) {
  const reasonId = useId()
  return (
    <Tooltip content={reason}>
      <button
        type="button"
        aria-label={label}
        aria-disabled="true"
        aria-describedby={reasonId}
        onClick={(event) => event.preventDefault()}
        className={cn(
          'inline-flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md border border-dashed border-default px-2 text-ui text-fg-secondary',
          className,
        )}
      >
        {icon}
        <span className="truncate">{children}</span>
        <Lock className="size-3 text-fg-tertiary" aria-hidden />
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      </button>
    </Tooltip>
  )
}

const NO_PHASE = '__none__'

export interface PhasePickerProps {
  phases: readonly Phase[]
  value: string | null
  onChange: (phaseId: string | null) => void
  disabled?: boolean
}

/** "No phase" + the project's phases, as a chip with a radio menu. */
export function PhasePicker({ phases, value, onChange, disabled }: PhasePickerProps) {
  const current = phases.find((phase) => phase.id === value) ?? null
  const label = current?.name ?? 'No phase'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button type="button" aria-label={`Phase: ${label}`} className={cn(chip, 'max-w-56')}>
          <PhaseGlyph className="text-fg-tertiary" />
          <span className={cn('truncate', !current && 'text-fg-tertiary')}>{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Phase</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current ? current.id : NO_PHASE}
          onValueChange={(next) => onChange(next === NO_PHASE ? null : next)}
        >
          <DropdownMenuRadioItem value={NO_PHASE}>
            <span className="text-fg-secondary">No phase</span>
          </DropdownMenuRadioItem>
          {phases.length > 0 ? <DropdownMenuSeparator /> : null}
          {phases.map((phase) => (
            <DropdownMenuRadioItem key={phase.id} value={phase.id}>
              <PhaseGlyph />
              <span className="truncate">{phase.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Small uppercase-free section heading row (12px / 600, tertiary). */
export function SectionHeading({
  title,
  meta,
  aside,
  id,
}: {
  title: string
  meta?: ReactNode
  aside?: ReactNode
  id?: string
}) {
  return (
    <div className="flex h-7 items-center gap-2">
      <h3 id={id} className="text-meta font-semibold text-fg-tertiary">
        {title}
      </h3>
      {meta ? <span className="text-meta text-fg-tertiary tabular-nums">{meta}</span> : null}
      {aside ? <span className="ml-auto text-meta text-fg-tertiary">{aside}</span> : null}
    </div>
  )
}

/** Start → due pairing between the two date chips (the chips' names say which is which). */
export function DateArrow() {
  return (
    <span aria-hidden className="-mx-0.5 text-fg-disabled">
      →
    </span>
  )
}

/** Breadcrumb separator in the modal header. */
export function CrumbSeparator(props: ComponentProps<'span'>) {
  return (
    <span aria-hidden className="shrink-0 px-0.5 text-fg-disabled" {...props}>
      /
    </span>
  )
}
