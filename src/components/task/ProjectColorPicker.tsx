import { RadioGroup } from 'radix-ui'
import { Check } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { PROJECT_COLORS, type ProjectColor } from '@/domain/types'
import { cn } from '@/lib/utils'
import { PROJECT_COLOR_BG, PROJECT_COLOR_LABELS } from './labels'

export interface ProjectColorPickerProps {
  value: ProjectColor
  onChange: (color: ProjectColor) => void
  'aria-label'?: string
  className?: string
  disabled?: boolean
}

/** Swatch radio group (arrow keys move, Space selects). The chosen swatch shows a check mark. */
export function ProjectColorPicker({
  value,
  onChange,
  'aria-label': ariaLabel = 'Project color',
  className,
  disabled,
}: ProjectColorPickerProps) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(next) => onChange(next as ProjectColor)}
      aria-label={ariaLabel}
      orientation="horizontal"
      disabled={disabled}
      className={cn('flex flex-wrap items-center gap-1', className)}
    >
      {PROJECT_COLORS.map((color) => (
        <Tooltip key={color} content={PROJECT_COLOR_LABELS[color]}>
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
  )
}
