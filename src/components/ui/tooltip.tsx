import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react'
import { Slot, Tooltip as TooltipPrimitive } from 'radix-ui'
import { getInputModality, installInputModality } from '@/lib/inputModality'
import { cn } from '@/lib/utils'
import { Shortcut } from './kbd'

/**
 * Mounted once at the app root. Delay ≈ 400 ms; moving between triggers is instant. Also starts
 * input-modality tracking (keyboard vs pointer) used by tooltips and focus rings.
 */
export function TooltipProvider({
  delayDuration = 400,
  skipDelayDuration = 300,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  useEffect(() => installInputModality(), [])
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

/**
 * Radix's tooltip trigger stamps its own `data-state` (closed / delayed-open) on the child. When
 * the child is a menu or popover trigger, that overwrites its `data-state="open"` and breaks
 * `data-[state=open]:` styles. This slot forwards every other prop (handlers, ref, aria).
 */
function TooltipTriggerSlot({
  'data-state': _tooltipState,
  ...props
}: ComponentProps<typeof Slot.Root> & { 'data-state'?: string }) {
  return <Slot.Root {...props} />
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
  /**
   * For triggers that sit in a dense, interactive surface (Gantt bars): the bubble never takes
   * the pointer. It closes as soon as the pointer leaves the trigger and does not intercept
   * clicks on whatever lies under it.
   */
  passive?: boolean
  /** A single focusable element (Button, link…). */
  children: ReactElement
}

/**
 * Convenience tooltip: `<Tooltip content="Search" shortcut="mod+k"><Button …/></Tooltip>`.
 * Tooltips describe; icon-only buttons still need their own aria-label. `disabled` keeps the
 * same element tree (the trigger never remounts when it toggles). Opens on hover and on
 * keyboard focus — not when focus merely returns to the trigger after a pointer interaction
 * (e.g. a menu closed by clicking an item), so no tooltip lingers away from the pointer.
 */
export function Tooltip({
  content,
  shortcut,
  side = 'top',
  align = 'center',
  delayDuration,
  disabled,
  passive = false,
  children,
}: TooltipProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pointerInside = useRef(false)
  const inactive = disabled || (!content && !shortcut)
  const onOpenChange = (next: boolean) => {
    if (next && getInputModality() === 'pointer') {
      const hovered = pointerInside.current || (triggerRef.current?.matches(':hover') ?? false)
      if (!hovered) return // focus came back after a click elsewhere: not a reason to show
    }
    setOpen(next)
  }
  return (
    <TooltipPrimitive.Root
      open={!inactive && open}
      onOpenChange={onOpenChange}
      delayDuration={delayDuration}
      disableHoverableContent={passive}
    >
      <TooltipPrimitive.Trigger
        asChild
        ref={triggerRef}
        onPointerEnter={() => {
          pointerInside.current = true
        }}
        onPointerLeave={() => {
          pointerInside.current = false
        }}
      >
        <TooltipTriggerSlot>{children}</TooltipTriggerSlot>
      </TooltipPrimitive.Trigger>
      {inactive ? null : (
        <TooltipContent
          side={side}
          align={align}
          className={passive ? 'pointer-events-none' : undefined}
        >
          <span className="flex items-center gap-2">
            {content}
            {shortcut ? <Shortcut keys={shortcut} variant="inverse" /> : null}
          </span>
        </TooltipContent>
      )}
    </TooltipPrimitive.Root>
  )
}
