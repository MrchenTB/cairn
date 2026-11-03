import type { ComponentProps } from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/** 32×18 switch. Off track uses --border-contrast so the control stays ≥ 3:1. */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-[18px] w-8 shrink-0 items-center rounded-full p-0.5',
        'bg-(--border-contrast) transition-colors duration-fast data-[state=checked]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-3.5 rounded-full bg-(--switch-thumb) shadow-sm',
          'transition-transform duration-base ease-move data-[state=checked]:translate-x-3.5',
          'data-[state=checked]:bg-accent-fg',
        )}
      />
    </SwitchPrimitive.Root>
  )
}
