import type { ComponentProps } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { X } from 'lucide-react'
import { useFocusReturn } from '@/lib/focus'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { FocusReturnRecorder } from './focus-return'
import { dialogMotion, overlayClass } from './styles'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close
export const DialogPortal = DialogPrimitive.Portal

export function DialogOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(overlayClass, className)}
      {...props}
    />
  )
}

const SIZES = {
  sm: 'max-w-[420px]',
  md: 'max-w-[540px]',
  lg: 'max-w-[640px]',
  xl: 'max-w-[800px]',
} as const

export interface DialogContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  /** sm 420 · md 540 (default) · lg 640 · xl 800 px; always ≤ viewport − 32px. */
  size?: keyof typeof SIZES
  /**
   * `center` (default) = vertically centred. `top` = 12vh from the top, so the panel does not
   * jump when its content grows (Task Modal, search).
   */
  position?: 'center' | 'top'
  /** Top-right close button (default true). */
  showClose?: boolean
  overlayClassName?: string
}

/**
 * Centred modal panel: overlay, focus trap, Esc / outside click to close are handled by Radix.
 * On close, focus returns to the Trigger — or, for dialogs opened without one (a shortcut, app
 * state, the URL), to the element that had focus when it opened. A custom `onCloseAutoFocus`
 * runs first and can take over with `event.preventDefault()`. Always render a <DialogTitle>
 * (visually hidden if needed).
 */
export function DialogContent({
  className,
  size = 'md',
  position = 'center',
  showClose = true,
  overlayClassName,
  onCloseAutoFocus,
  children,
  ...props
}: DialogContentProps) {
  const focusReturn = useFocusReturn(onCloseAutoFocus)
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'fixed left-1/2 z-(--z-modal) flex max-h-[84vh] w-[calc(100vw-2rem)] -translate-x-1/2 flex-col',
          'overflow-hidden rounded-xl border border-default bg-elevated text-fg shadow-modal outline-none',
          position === 'center' ? 'top-1/2 -translate-y-1/2' : 'top-[12vh]',
          SIZES[size],
          dialogMotion,
          className,
        )}
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        {...props}
      >
        <FocusReturnRecorder targetRef={focusReturn.targetRef} />
        {children}
        {showClose ? (
          <DialogPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              className="absolute top-4 right-4"
            >
              <X />
            </Button>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

/** Title + optional description. Leaves room for the close button. */
export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-1 px-5 pt-4 pb-3 pr-14', className)}
      {...props}
    />
  )
}

/** Scrollable middle section. */
export function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-body"
      className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-2', className)}
      {...props}
    />
  )
}

export interface DialogFooterProps extends ComponentProps<'div'> {
  /** Hairline above the footer (for long bodies). */
  bordered?: boolean
}

/** Actions row, right-aligned (secondary before primary). */
export function DialogFooter({ className, bordered = false, ...props }: DialogFooterProps) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'flex shrink-0 items-center justify-end gap-2 px-5 pt-3 pb-4',
        bordered && 'mt-1 border-t border-subtle py-3',
        className,
      )}
      {...props}
    />
  )
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-heading font-semibold text-fg', className)}
      {...props}
    />
  )
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-ui text-fg-secondary', className)}
      {...props}
    />
  )
}
