import { useState } from 'react'
import { CalendarDays, X } from 'lucide-react'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { buttonVariants } from '@/components/ui/button-variants'
import { fieldBase, hoverFade } from '@/components/ui/styles'
import { usePreferences, useToday } from '@/data/hooks'
import {
  addDays,
  formatDate,
  formatDateSmart,
  fromLocalDate,
  startOfWeek,
  toLocalDate,
} from '@/domain/dates'
import type { ISODate } from '@/domain/types'
import { cn } from '@/lib/utils'

export interface DateFieldProps {
  value: ISODate | null
  onChange: (value: ISODate | null) => void
  /** Field name, e.g. "Due date": accessible name, popover label and empty text. */
  label: string
  /** Empty-state text (defaults to `label`). */
  placeholder?: string
  /** Earliest / latest selectable date (inclusive). Other days are disabled. */
  min?: ISODate | null
  max?: ISODate | null
  /** Shown under the calendar when min/max apply, e.g. "Due date can't be before the start". */
  rangeHint?: string
  /** Offer "Clear" (default true). */
  clearable?: boolean
  disabled?: boolean
  /** `chip` (Task Modal properties) · `ghost` (dense rows) · `field` (forms, full width). */
  variant?: 'chip' | 'ghost' | 'field'
  /** `smart` = Today / Tomorrow / Nov 2 (default) · `medium` = Nov 2, 2026. */
  format?: 'smart' | 'medium'
  align?: 'start' | 'center' | 'end'
  className?: string
  id?: string
  'aria-invalid'?: boolean
}

const TRIGGER: Record<NonNullable<DateFieldProps['variant']>, string> = {
  chip: cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'px-2 font-normal'),
  ghost: cn(
    'inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-meta tabular-nums text-fg-secondary hover:bg-hover',
    hoverFade,
  ),
  field: cn(fieldBase, 'inline-flex h-8 items-center gap-2 text-left'),
}

/**
 * Date picker button → popover with quick picks (Today / Tomorrow / Next week / Clear) and a
 * calendar. Values are ISO dates; conversion to/from the widget's Date happens only through
 * toLocalDate/fromLocalDate, so the chosen day never shifts with the browser time zone.
 */
export function DateField({
  value,
  onChange,
  label,
  placeholder,
  min = null,
  max = null,
  rangeHint,
  clearable = true,
  disabled,
  variant = 'chip',
  format = 'smart',
  align = 'start',
  className,
  id,
  'aria-invalid': ariaInvalid,
}: DateFieldProps) {
  const today = useToday()
  const { weekStartsOn } = usePreferences()
  const [open, setOpen] = useState(false)

  const commit = (next: ISODate | null) => {
    setOpen(false)
    if (next !== value) onChange(next)
  }
  const inRange = (date: ISODate) => (!min || date >= min) && (!max || date <= max)

  const quickPicks: Array<{ label: string; date: ISODate }> = [
    { label: 'Today', date: today },
    { label: 'Tomorrow', date: addDays(today, 1) },
    { label: 'Next week', date: addDays(startOfWeek(today, weekStartsOn), 7) },
  ]

  const display = value
    ? format === 'medium'
      ? formatDate(value, 'medium')
      : formatDateSmart(value, today)
    : null
  const disabledDays = [
    ...(min ? [{ before: toLocalDate(min) }] : []),
    ...(max ? [{ after: toLocalDate(max) }] : []),
  ]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          id={id}
          aria-label={`${label}: ${value ? formatDate(value, 'long') : 'not set'}`}
          // The text is the short form ("Today", "Nov 13"): the title spells the whole date out.
          title={value ? formatDate(value, 'long') : undefined}
          aria-invalid={ariaInvalid || undefined}
          // No stopPropagation here: Radix treats a click that never reaches the document as
          // "handled elsewhere", so another open popover (e.g. the neighbouring date chip's)
          // would stay open and two calendars would stack.
          className={cn(
            TRIGGER[variant],
            'disabled:pointer-events-none disabled:opacity-50',
            className,
          )}
        >
          {variant !== 'ghost' ? (
            <CalendarDays className="size-3.5 shrink-0 text-fg-tertiary" aria-hidden />
          ) : null}
          <span className={cn('truncate tabular-nums', !value && 'text-fg-tertiary')}>
            {display ?? placeholder ?? label}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        aria-label={label}
        className="w-auto p-0"
        // Let the calendar focus the selected day (or today) instead of the first button.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex">
          <div className="flex w-40 flex-col gap-0.5 rounded-l-lg bg-muted p-1.5">
            {quickPicks.map((pick) => (
              <button
                key={pick.label}
                type="button"
                disabled={!inRange(pick.date)}
                onClick={() => commit(pick.date)}
                className={cn(
                  'flex h-8 items-center justify-between gap-2 rounded-md px-2 text-left text-ui text-fg',
                  'hover:bg-hover disabled:pointer-events-none disabled:text-fg-disabled',
                  hoverFade,
                )}
              >
                <span>{pick.label}</span>{' '}
                <span className="text-meta text-fg-tertiary tabular-nums">
                  {formatDate(pick.date, 'short')}
                </span>
              </button>
            ))}
            {clearable && value ? (
              <button
                type="button"
                onClick={() => commit(null)}
                className={cn(
                  'mt-auto flex h-8 items-center gap-2 rounded-md px-2 text-left text-ui text-fg-secondary hover:bg-hover hover:text-fg',
                  hoverFade,
                )}
              >
                <X className="size-3.5 text-fg-tertiary" aria-hidden />
                Clear
              </button>
            ) : null}
          </div>
          <div className="p-2">
            <Calendar
              mode="single"
              required
              autoFocus
              selected={value ? toLocalDate(value) : undefined}
              onSelect={(date) => commit(fromLocalDate(date))}
              defaultMonth={toLocalDate(value ?? today)}
              today={toLocalDate(today)}
              weekStartsOn={weekStartsOn}
              disabled={disabledDays}
              startMonth={min ? toLocalDate(min) : undefined}
              endMonth={max ? toLocalDate(max) : undefined}
              footer={rangeHint && (min || max) ? rangeHint : undefined}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
