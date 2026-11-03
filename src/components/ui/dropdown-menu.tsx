import type { ComponentProps } from 'react'
import { DropdownMenu as MenuPrimitive } from 'radix-ui'
import { Check, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { floatingMotion, floatingSurface, menuItem, menuLabel, menuSeparator } from './styles'

export const DropdownMenu = MenuPrimitive.Root
export const DropdownMenuTrigger = MenuPrimitive.Trigger
export const DropdownMenuGroup = MenuPrimitive.Group
export const DropdownMenuPortal = MenuPrimitive.Portal
export const DropdownMenuSub = MenuPrimitive.Sub
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup

/** Menu surface (portalled). Keyboard: arrows, Home/End, typeahead, Esc (Radix). */
export function DropdownMenuContent({
  className,
  sideOffset = 4,
  align = 'start',
  ...props
}: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        align={align}
        className={cn(
          floatingSurface,
          floatingMotion,
          'max-h-(--radix-dropdown-menu-content-available-height) min-w-44 overflow-y-auto p-1',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}

export interface DropdownMenuItemProps extends ComponentProps<typeof MenuPrimitive.Item> {
  variant?: 'default' | 'destructive'
  /** Indent to align with items that have a leading icon. */
  inset?: boolean
}

export function DropdownMenuItem({
  className,
  variant = 'default',
  inset,
  ...props
}: DropdownMenuItemProps) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(
        menuItem,
        inset && 'pl-8',
        variant === 'destructive' &&
          'text-danger data-[highlighted]:bg-danger-subtle [&>svg]:text-danger',
        className,
      )}
      {...props}
    />
  )
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(menuItem, 'pr-8', className)}
      {...props}
    >
      {children}
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <Check className="size-4 text-fg" strokeWidth={2} />
        </MenuPrimitive.ItemIndicator>
      </span>
    </MenuPrimitive.CheckboxItem>
  )
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(menuItem, 'pr-8', className)}
      {...props}
    >
      {children}
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <Check className="size-4 text-fg" strokeWidth={2} />
        </MenuPrimitive.ItemIndicator>
      </span>
    </MenuPrimitive.RadioItem>
  )
}

export function DropdownMenuLabel({
  className,
  inset,
  ...props
}: ComponentProps<typeof MenuPrimitive.Label> & { inset?: boolean }) {
  return (
    <MenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn(menuLabel, inset && 'pl-8', className)}
      {...props}
    />
  )
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(menuSeparator, className)}
      {...props}
    />
  )
}

/** Right-aligned hint (shortcut or count) inside an item. */
export function DropdownMenuShortcut({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn('ml-auto pl-4 text-meta text-fg-tertiary tabular-nums', className)}
      {...props}
    />
  )
}

export function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.SubTrigger> & { inset?: boolean }) {
  return (
    <MenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(menuItem, 'data-[state=open]:bg-hover', inset && 'pl-8', className)}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-4 text-fg-tertiary" />
    </MenuPrimitive.SubTrigger>
  )
}

export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.SubContent>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent
        data-slot="dropdown-menu-sub-content"
        className={cn(floatingSurface, floatingMotion, 'min-w-40 p-1', className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}
