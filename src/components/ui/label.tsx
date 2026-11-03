import type { ComponentProps } from 'react'
import { Label as LabelPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/** Form field label (12px / 500, secondary text). */
export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'inline-flex items-center gap-1.5 text-meta font-medium text-fg-secondary select-none',
        'peer-disabled:cursor-not-allowed peer-disabled:text-fg-disabled',
        className,
      )}
      {...props}
    />
  )
}
