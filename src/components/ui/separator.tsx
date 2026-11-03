import type { ComponentProps } from 'react'
import { Separator as SeparatorPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/**
 * Hairline divider. Use sparingly — structure comes from spacing and surfaces first
 * (design §3.2); reserve lines for functional boundaries.
 */
export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-subtle',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  )
}
