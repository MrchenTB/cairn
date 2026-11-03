import { useState, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'
import { Shortcut } from './kbd'

/** Mounted once at the app root. Delay ≈ 400 ms; moving between triggers is instant. */
export function TooltipProvider({
  delayDuration = 400,
  skipDelayDuration = 300,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  )
}

export const TooltipRoot = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

/** Inverse (dark-on-light / light-on-dark) 12px bubble. */
export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip"
        sideOffset={sideOffset}
        className={cn(
          'z-(--z-tooltip) max-w-xs rounded-md bg-inverse px-2 py-1 text-meta font-medium text-fg-inverse shadow-popover',
          'origin-(--radix-tooltip-content-transform-origin) animate-in fade-in-0 zoom-in-[0.98] duration-fast ease-enter',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98]',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export interface TooltipProps {
  /** Tooltip text (a short label, not essential information). */
  content: ReactNode
  /** Optional keyboard binding shown as key caps, e.g. 'mod+k'. */
  shortcut?: string
  side?: ComponentProps<typeof TooltipPrimitive.Content>['side']
  align?: ComponentProps<typeof TooltipPrimitive.Content>['align']
  delayDuration?: number
  /** Render the trigger without a tooltip. */
  disabled?: boolean
  /** A single focusable element (Button, link…). */
  children: ReactElement
}

/**
 * Convenience tooltip: `<Tooltip content="Search" shortcut="mod+k"><Button …/></Tooltip>`.
 * Tooltips describe; icon-only buttons still need their own aria-label. `disabled` keeps the
 * same element tree (the trigger never remounts when it toggles).
 */
export function Tooltip({
  content,
  shortcut,
  side = 'top',
  align = 'center',
  delayDuration,
  disabled,
  children,
}: TooltipProps) {
  const [open, setOpen] = useState(false)
  const inactive = disabled || (!content && !shortcut)
  return (
    <TooltipPrimitive.Root
      open={!inactive && open}
      onOpenChange={setOpen}
      delayDuration={delayDuration}
    >
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      {inactive ? null : (
        <TooltipContent side={side} align={align}>
          <span className="flex items-center gap-2">
            {content}
            {shortcut ? <Shortcut keys={shortcut} variant="inverse" /> : null}
          </span>
        </TooltipContent>
      )}
    </TooltipPrimitive.Root>
  )
}
