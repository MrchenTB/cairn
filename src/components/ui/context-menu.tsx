import type { ComponentProps } from 'react'
import { ContextMenu as MenuPrimitive } from 'radix-ui'
import { Check, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { floatingMotion, floatingSurface, menuItem, menuLabel, menuSeparator } from './styles'

export const ContextMenu = MenuPrimitive.Root
export const ContextMenuTrigger = MenuPrimitive.Trigger
export const ContextMenuGroup = MenuPrimitive.Group
export const ContextMenuSub = MenuPrimitive.Sub
export const ContextMenuRadioGroup = MenuPrimitive.RadioGroup

/** Right-click menu surface; same look as DropdownMenuContent. */
export function ContextMenuContent({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(
          floatingSurface,
          floatingMotion,
          'max-h-(--radix-context-menu-content-available-height) min-w-44 overflow-y-auto p-1',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}

export interface ContextMenuItemProps extends ComponentProps<typeof MenuPrimitive.Item> {
  variant?: 'default' | 'destructive'
  inset?: boolean
}

export function ContextMenuItem({
  className,
  variant = 'default',
  inset,
  ...props
}: ContextMenuItemProps) {
  return (
    <MenuPrimitive.Item
      data-slot="context-menu-item"
      data-variant={variant}
      className={cn(
        menuItem,
        inset && 'pl-8',
        variant === 'destructive' &&
          'text-danger data-[highlighted]:bg-danger-subtle [&:not([data-disabled])>svg]:text-danger',
        className,
      )}
      {...props}
    />
  )
}

export function ContextMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem className={cn(menuItem, 'pr-8', className)} {...props}>
      {children}
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <Check className="size-4 text-fg" strokeWidth={2} />
        </MenuPrimitive.ItemIndicator>
      </span>
    </MenuPrimitive.CheckboxItem>
  )
}

export function ContextMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(menuItem, 'pr-8', className)} {...props}>
      {children}
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <Check className="size-4 text-fg" strokeWidth={2} />
        </MenuPrimitive.ItemIndicator>
      </span>
    </MenuPrimitive.RadioItem>
  )
}

export function ContextMenuLabel({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn(menuLabel, className)} {...props} />
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn(menuSeparator, className)} {...props} />
}

export function ContextMenuShortcut({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn('ml-auto pl-4 text-meta text-fg-tertiary tabular-nums', className)}
      {...props}
    />
  )
}

export function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.SubTrigger>) {
  return (
    <MenuPrimitive.SubTrigger
      className={cn(menuItem, 'data-[state=open]:bg-hover', className)}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-4 text-fg-tertiary" />
    </MenuPrimitive.SubTrigger>
  )
}

export function ContextMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.SubContent>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent
        className={cn(floatingSurface, floatingMotion, 'min-w-40 p-1', className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}
