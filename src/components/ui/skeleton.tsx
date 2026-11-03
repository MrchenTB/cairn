import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/** Placeholder block with a quiet 1.2s "breathing" fade (off with reduced motion). */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn('rounded-sm bg-active motion-safe:animate-breathe', className)}
      {...props}
    />
  )
}
