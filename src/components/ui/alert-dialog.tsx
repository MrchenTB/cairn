import type { ComponentProps } from 'react'
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'
import { buttonVariants, type ButtonVariantProps } from './button-variants'
import { dialogMotion, overlayClass } from './styles'

export const AlertDialog = AlertDialogPrimitive.Root
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger

/**
 * Confirmation panel (420px, centred). Unlike Dialog it does not close on outside click and
 * focuses Cancel first. Prefer the `confirm()` helper from ./confirm for simple yes/no flows.
 */
export function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className={overlayClass} />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-(--z-modal) flex w-[calc(100vw-2rem)] max-w-[420px] -translate-x-1/2 -translate-y-1/2 flex-col',
          'rounded-xl border border-default bg-elevated text-fg shadow-modal outline-none',
          dialogMotion,
          className,
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  )
}

export function AlertDialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 px-5 pt-5 pb-2', className)} {...props} />
}

export function AlertDialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center justify-end gap-2 px-5 pt-3 pb-4', className)}
      {...props}
    />
  )
}

export function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      className={cn('text-heading font-semibold text-fg', className)}
      {...props}
    />
  )
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      className={cn('text-body text-fg-secondary', className)}
      {...props}
    />
  )
}

export function AlertDialogAction({
  className,
  variant = 'primary',
  size = 'md',
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Action> & ButtonVariantProps) {
  return (
    <AlertDialogPrimitive.Action
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export function AlertDialogCancel({
  className,
  variant = 'secondary',
  size = 'md',
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Cancel> & ButtonVariantProps) {
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}
