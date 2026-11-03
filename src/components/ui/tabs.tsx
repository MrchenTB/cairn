import type { ComponentProps } from 'react'
import { NavLink, type NavLinkProps } from 'react-router'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'
import { pillTab } from './styles'

/** In-page tabs (Radix: arrow keys move between tabs). Pills, never underlines. */
export const Tabs = TabsPrimitive.Root

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    />
  )
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger data-slot="tabs-trigger" className={cn(pillTab, className)} {...props} />
  )
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('outline-none', className)}
      {...props}
    />
  )
}

/** Route-driven tabs (each tab is a link; the active one gets aria-current="page"). */
export function NavTabs({ className, ...props }: ComponentProps<'nav'>) {
  return <nav className={cn('flex items-center gap-1', className)} {...props} />
}

export function NavTab({
  className,
  ...props
}: Omit<NavLinkProps, 'className'> & { className?: string }) {
  return <NavLink className={cn(pillTab, className)} {...props} />
}
