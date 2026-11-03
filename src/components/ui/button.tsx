import type { ComponentProps } from 'react'
import { Slot } from 'radix-ui'
import { cn } from '@/lib/utils'
import { buttonVariants, type ButtonVariantProps } from './button-variants'
import { Spinner } from './spinner'

export interface ButtonProps extends ComponentProps<'button'>, ButtonVariantProps {
  /** Render the single child element with button styling (e.g. a router <Link>). */
  asChild?: boolean
  /** Shows a spinner, disables the button and sets aria-busy. Ignored with asChild. */
  loading?: boolean
}

/**
 * Button. Variants: primary (accent, one per view), secondary (default), outline, ghost,
 * danger, danger-ghost, link. Sizes: xs 24 · sm 28 (default) · md 32 · icon 28 · icon-sm 24.
 * Icon-only buttons need an `aria-label`.
 */
export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  type,
  children,
  ...props
}: ButtonProps) {
  if (asChild) {
    return (
      <Slot.Root
        data-slot="button"
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      >
        {children}
      </Slot.Root>
    )
  }
  return (
    <button
      data-slot="button"
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner label={null} /> : null}
      {children}
    </button>
  )
}
