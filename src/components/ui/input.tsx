import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { fieldBase } from './styles'

/** Single-line text field (32px). Pair with <Label> and set aria-invalid for errors. */
export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(fieldBase, 'h-8 py-0', className)}
      {...props}
    />
  )
}
