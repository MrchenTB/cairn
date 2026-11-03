import type { ComponentProps } from 'react'
import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

export interface ScrollAreaProps extends ComponentProps<typeof ScrollAreaPrimitive.Root> {
  /** Class for the scrolling viewport (e.g. padding, max-height). */
  viewportClassName?: string
  orientation?: 'vertical' | 'horizontal' | 'both'
}

/** Overlay scrollbars that stay thin and quiet; native scrolling and keyboard behaviour. */
export function ScrollArea({
  className,
  viewportClassName,
  orientation = 'vertical',
  children,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        className={cn('size-full rounded-[inherit] outline-none', viewportClassName)}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {orientation !== 'horizontal' ? <ScrollBar orientation="vertical" /> : null}
      {orientation !== 'vertical' ? <ScrollBar orientation="horizontal" /> : null}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

export function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.Scrollbar>) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-bar"
      orientation={orientation}
      className={cn(
        'flex touch-none p-0.5 transition-opacity duration-base select-none',
        orientation === 'vertical' ? 'h-full w-2.5' : 'h-2.5 flex-col',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-(--scrollbar-thumb) hover:bg-(--scrollbar-thumb-hover)" />
    </ScrollAreaPrimitive.Scrollbar>
  )
}
