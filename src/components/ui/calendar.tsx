import { useEffect, useRef } from 'react'
import {
  DayPicker,
  type ChevronProps,
  type DayButtonProps,
  type DayPickerProps,
} from 'react-day-picker'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react'
import { usePreferences } from '@/data/hooks'
import { cn } from '@/lib/utils'
import { buttonVariants } from './button-variants'

function CalendarChevron({ orientation, className }: ChevronProps) {
  const Icon =
    orientation === 'left'
      ? ChevronLeft
      : orientation === 'right'
        ? ChevronRight
        : orientation === 'up'
          ? ChevronUp
          : ChevronDown
  return <Icon className={cn('size-4', className)} />
}

/** Day cell button: state classes are computed from modifiers so precedence is explicit. */
function CalendarDayButton({ day, modifiers, className, ...props }: DayButtonProps) {
  void day
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // Same as DayPicker's default DayButton: keyboard focus follows the focused day.
    if (modifiers.focused) ref.current?.focus()
  }, [modifiers.focused])
  const { selected, today, outside, disabled } = modifiers
  return (
    <button
      ref={ref}
      className={cn(
        'relative inline-flex size-8 items-center justify-center rounded-md text-ui tabular-nums text-fg',
        'transition-colors duration-fast hover:duration-instant',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        !selected && !disabled && 'hover:bg-hover',
        outside && !selected && 'text-fg-tertiary',
        today && !selected && 'font-semibold text-accent-text',
        // Today also gets a dot, so it is never conveyed by colour alone.
        today && 'after:absolute after:bottom-1 after:size-1 after:rounded-full after:bg-current',
        selected && 'bg-accent font-medium text-accent-fg hover:bg-accent-hover',
        disabled && 'cursor-not-allowed text-fg-disabled',
        className,
      )}
      {...props}
    />
  )
}

export type CalendarProps = DayPickerProps

/**
 * Month calendar (react-day-picker 10) styled with tokens. Keyboard: arrows move by day/week,
 * PageUp/PageDown by month, Home/End to week start/end, Enter selects. The week start defaults
 * to the user's preference. Work with ISO dates through toLocalDate/fromLocalDate only.
 */
export function Calendar({
  className,
  classNames,
  components,
  showOutsideDays = true,
  weekStartsOn,
  ...props
}: CalendarProps) {
  const preferences = usePreferences()
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      weekStartsOn={weekStartsOn ?? preferences.weekStartsOn}
      className={cn('relative w-fit select-none', className)}
      classNames={{
        root: '',
        months: 'relative flex flex-col gap-4',
        month: 'flex flex-col gap-1',
        nav: 'absolute top-0 right-0 z-10 flex h-8 items-center gap-0.5',
        button_previous: cn(
          buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
          'aria-disabled:opacity-40',
        ),
        button_next: cn(
          buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
          'aria-disabled:opacity-40',
        ),
        chevron: '',
        month_caption: 'flex h-8 items-center px-1.5',
        caption_label: 'text-ui font-semibold text-fg',
        dropdowns: 'flex items-center gap-1',
        month_grid: 'border-separate border-spacing-0.5',
        weekdays: '',
        weekday: 'h-7 w-8 p-0 text-center text-micro font-medium text-fg-tertiary',
        weeks: '',
        week: '',
        day: 'size-8 p-0 text-center',
        day_button: '',
        selected: '',
        today: '',
        outside: '',
        disabled: '',
        hidden: 'invisible',
        focused: '',
        footer: 'mt-2 text-meta text-fg-tertiary',
        ...classNames,
      }}
      components={{ Chevron: CalendarChevron, DayButton: CalendarDayButton, ...components }}
      {...props}
    />
  )
}
