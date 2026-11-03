import { useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface OptionMenuProps<T extends string> {
  /** Field name, e.g. "Status" (menu heading, tooltip and accessible names). */
  field: string
  value: T
  options: readonly T[]
  onChange: (value: T) => void
  getLabel: (value: T) => string
  renderIcon: (value: T) => ReactNode
  /** Digit shown/accepted for the first option (1 → keys 1,2,3…; 0 → keys 0,1,2…). */
  firstDigit?: number
  /** Custom trigger element (rendered with asChild). */
  children?: ReactElement
  /** Default trigger look when no children: icon-only (rows) or a chip with text (modal). */
  trigger?: 'icon' | 'chip'
  disabled?: boolean
  align?: 'start' | 'center' | 'end'
  triggerClassName?: string
}

/**
 * Single-choice dropdown shared by StatusMenu and PriorityMenu: radio items with glyph + label,
 * digit shortcuts while open, arrows/Enter/typeahead/Esc from Radix. The default trigger stops
 * click propagation so it can live inside clickable rows.
 */
export function OptionMenu<T extends string>({
  field,
  value,
  options,
  onChange,
  getLabel,
  renderIcon,
  firstDigit = 1,
  children,
  trigger = 'icon',
  disabled,
  align = 'start',
  triggerClassName,
}: OptionMenuProps<T>) {
  const [open, setOpen] = useState(false)
  const current = getLabel(value)

  const select = (next: T) => {
    setOpen(false)
    if (next !== value) onChange(next)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || !/^\d$/.test(event.key)) return
    const option = options[Number(event.key) - firstDigit]
    if (option === undefined) return
    event.preventDefault()
    select(option)
  }

  const defaultTrigger =
    trigger === 'chip' ? (
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-label={`${field}: ${current}`}
        onClick={(event) => event.stopPropagation()}
        className={cn('gap-1.5 px-2 font-normal', triggerClassName)}
      >
        {renderIcon(value)}
        <span>{current}</span>
      </Button>
    ) : (
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        aria-label={`${field}: ${current}`}
        onClick={(event) => event.stopPropagation()}
        className={triggerClassName}
      >
        {renderIcon(value)}
      </Button>
    )

  const triggerElement = (
    <DropdownMenuTrigger asChild disabled={disabled}>
      {children ?? defaultTrigger}
    </DropdownMenuTrigger>
  )

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {children || trigger === 'chip' ? (
        triggerElement
      ) : (
        <Tooltip content={`${field}: ${current}`}>{triggerElement}</Tooltip>
      )}
      <DropdownMenuContent align={align} className="w-52" onKeyDown={onKeyDown}>
        <DropdownMenuLabel>{field}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => select(next as T)}>
          {options.map((option, index) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {renderIcon(option)}
              <span>{getLabel(option)}</span>
              <DropdownMenuShortcut aria-hidden>{index + firstDigit}</DropdownMenuShortcut>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
