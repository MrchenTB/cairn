import type { ReactNode } from 'react'
import { ToggleGroup } from 'radix-ui'
import { cn } from '@/lib/utils'
import { pillTab } from './styles'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  /** Needed when `label` is not text (icon-only segment). */
  ariaLabel?: string
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string> {
  value: T
  onValueChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  /** Describes the choice, e.g. "Timeline scale". */
  'aria-label': string
  className?: string
}

/**
 * Exactly-one-of choice rendered as separate pills (the active one filled), e.g. Gantt
 * Day / Week / Month. Arrow keys move between segments; it can never be deselected.
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      aria-label={ariaLabel}
      onValueChange={(next) => {
        if (next) onValueChange(next as T)
      }}
      className={cn('inline-flex items-center gap-0.5', className)}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          aria-label={option.ariaLabel}
          disabled={option.disabled}
          className={pillTab}
        >
          {option.icon}
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
