import { useState, type ReactElement } from 'react'
import { RadioGroup } from 'radix-ui'
import { Check } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { insetFocus } from '@/components/ui/styles'
import { Tooltip } from '@/components/ui/tooltip'
import { PHASE_COLORS, type PhaseColor, type ProjectColor } from '@/domain/types'
import { cn } from '@/lib/utils'
import { PROJECT_COLOR_BG, PROJECT_COLOR_LABELS } from './labels'
import { ProjectDot } from './ProjectDot'

export interface PhaseColorPickerProps {
  /** The phase's own colour; null = it uses the project's. */
  value: PhaseColor | null
  projectColor: ProjectColor
  onChange: (color: PhaseColor | null) => void
  'aria-label'?: string
  className?: string
  disabled?: boolean
}

/**
 * The phase palette (the project colours without red, which is kept for conflicts and overdue
 * work) plus "Use project color". Swatches are a radio group like the project colour picker
 * (arrow keys move, Space selects); the chosen swatch shows a check. With no colour of its own
 * the phase shows "Use project color" checked and no swatch.
 */
export function PhaseColorPicker({
  value,
  projectColor,
  onChange,
  'aria-label': ariaLabel = 'Phase color',
  className,
  disabled,
}: PhaseColorPickerProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <RadioGroup.Root
        value={value ?? ''}
        onValueChange={(next) => onChange(next as PhaseColor)}
        aria-label={ariaLabel}
        orientation="horizontal"
        disabled={disabled}
        className="flex flex-wrap items-center gap-1"
      >
        {PHASE_COLORS.map((color) => (
          <Tooltip key={color} content={PROJECT_COLOR_LABELS[color]} hoverOnly>
            <RadioGroup.Item
              value={color}
              aria-label={PROJECT_COLOR_LABELS[color]}
              className={cn(
                'grid size-7 place-items-center rounded-md transition-colors duration-fast',
                'hover:bg-hover hover:duration-instant data-[state=checked]:bg-active',
                'disabled:pointer-events-none disabled:opacity-50',
              )}
            >
              <span
                className={cn(
                  'grid size-4 place-items-center rounded-full text-fg-inverse',
                  PROJECT_COLOR_BG[color],
                )}
              >
                <RadioGroup.Indicator>
                  <Check className="size-2.5" strokeWidth={3.5} aria-hidden />
                </RadioGroup.Indicator>
              </span>
            </RadioGroup.Item>
          </Tooltip>
        ))}
      </RadioGroup.Root>
      <button
        type="button"
        aria-pressed={value === null}
        disabled={disabled}
        onClick={() => onChange(null)}
        className={cn(
          'flex h-7 items-center gap-2 rounded-md px-2 text-left text-ui text-fg',
          'transition-colors duration-fast hover:bg-hover hover:duration-instant',
          'disabled:pointer-events-none disabled:opacity-50',
          insetFocus,
        )}
      >
        <ProjectDot color={projectColor} />
        <span className="flex-1">Use project color</span>
        {value === null ? <Check className="size-3.5 text-fg-secondary" aria-hidden /> : null}
      </button>
    </div>
  )
}

export interface PhaseColorPopoverProps {
  phaseName: string
  value: PhaseColor | null
  projectColor: ProjectColor
  /** Called with the pick; the popover closes after it. */
  onChange: (color: PhaseColor | null) => void
  /** Controlled open state (the phase menu's "Color…" opens it from outside). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** The element that opens the popover (one focusable element, e.g. the colour dot button). */
  children: ReactElement
}

/** The colour picker in a popover anchored to its trigger. */
export function PhaseColorPopover({
  phaseName,
  value,
  projectColor,
  onChange,
  open: openProp,
  onOpenChange,
  children,
}: PhaseColorPopoverProps) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = (next: boolean) => {
    setOpenState(next)
    onOpenChange?.(next)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content="Phase color" disabled={open}>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
      </Tooltip>
      <PopoverContent className="w-[17.5rem] p-2" aria-label={`Color of ${phaseName}`}>
        <p className="px-2 pt-0.5 pb-1.5 text-meta font-medium text-fg-secondary">Phase color</p>
        <PhaseColorPicker
          value={value}
          projectColor={projectColor}
          aria-label={`Color of ${phaseName}`}
          onChange={(color) => {
            onChange(color)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
