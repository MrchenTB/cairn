/**
 * One set of menu items, two surfaces: the row "…" dropdown and the right-click context menu
 * render the same actions through a kit of matching Radix parts.
 */
import type { ComponentType, ReactNode } from 'react'
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'

export interface MenuKitItemProps {
  onSelect?: (event: Event) => void
  disabled?: boolean
  variant?: 'default' | 'destructive'
  className?: string
  children?: ReactNode
}

export interface MenuKit {
  Item: ComponentType<MenuKitItemProps>
  Separator: ComponentType<{ className?: string }>
  Label: ComponentType<{ className?: string; children?: ReactNode }>
  Shortcut: ComponentType<{ className?: string; children?: ReactNode }>
  Sub: ComponentType<{ children?: ReactNode }>
  SubTrigger: ComponentType<{ className?: string; disabled?: boolean; children?: ReactNode }>
  SubContent: ComponentType<{ className?: string; children?: ReactNode }>
}

export const dropdownKit: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Label: DropdownMenuLabel,
  Shortcut: DropdownMenuShortcut,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
}

export const contextKit: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Label: ContextMenuLabel,
  Shortcut: ContextMenuShortcut,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
}
