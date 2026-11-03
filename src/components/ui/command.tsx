import type { ComponentProps, ReactNode } from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog'

/** cmdk root styled for the search overlay (keyboard: ↑↓ to move, ↵ to open). */
export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn('flex size-full min-h-0 flex-col overflow-hidden text-fg', className)}
      {...props}
    />
  )
}

export interface CommandInputProps extends ComponentProps<typeof CommandPrimitive.Input> {
  /** Trailing content inside the input row (e.g. a spinner or a clear button). */
  trailing?: ReactNode
}

/** 48px input row with a search glyph and a hairline below. */
export function CommandInput({ className, trailing, ...props }: CommandInputProps) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-subtle px-4">
      <Search className="size-4 shrink-0 text-fg-tertiary" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent text-heading text-fg outline-none placeholder:text-fg-tertiary',
          'focus-visible:outline-none disabled:cursor-not-allowed',
          className,
        )}
        {...props}
      />
      {trailing}
    </div>
  )
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        'max-h-[min(56vh,440px)] scroll-py-1.5 overflow-x-hidden overflow-y-auto overscroll-contain p-1.5',
        className,
      )}
      {...props}
    />
  )
}

export function CommandEmpty({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn('px-4 py-10 text-center text-ui text-fg-secondary', className)}
      {...props}
    />
  )
}

export function CommandGroup({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'overflow-hidden [&:not(:first-child)]:mt-1',
        '[&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:h-7 [&_[cmdk-group-heading]]:items-center [&_[cmdk-group-heading]]:px-2',
        '[&_[cmdk-group-heading]]:text-meta [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-fg-tertiary',
        className,
      )}
      {...props}
    />
  )
}

/** 36px result row; the keyboard-selected row gets the hover surface and primary text. */
export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        'relative flex h-9 cursor-default items-center gap-2.5 rounded-md px-2 text-ui text-fg-secondary outline-none select-none',
        'data-[selected=true]:bg-hover data-[selected=true]:text-fg',
        'data-[disabled=true]:pointer-events-none data-[disabled=true]:text-fg-disabled',
        "[&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  )
}

export function CommandSeparator({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('-mx-1.5 my-1 h-px bg-subtle', className)}
      {...props}
    />
  )
}

export function CommandLoading(props: ComponentProps<typeof CommandPrimitive.Loading>) {
  return <CommandPrimitive.Loading {...props} />
}

/** Right-aligned meta in a row (project name, due date). */
export function CommandShortcut({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn('ml-auto shrink-0 pl-3 text-meta text-fg-tertiary tabular-nums', className)}
      {...props}
    />
  )
}

/** 32px hint row: "↑↓ Navigate · ↵ Open · Esc Close". */
export function CommandFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="command-footer"
      className={cn(
        'flex h-8 shrink-0 items-center gap-4 border-t border-subtle px-3 text-meta text-fg-tertiary',
        className,
      )}
      {...props}
    />
  )
}

export interface CommandDialogProps extends ComponentProps<typeof Dialog> {
  /** Accessible title (visually hidden). */
  title?: string
  description?: string
  className?: string
  commandProps?: ComponentProps<typeof CommandPrimitive>
}

/** The search overlay shell: 640px panel 15vh from the top, above other dialogs. */
export function CommandDialog({
  title = 'Search',
  description,
  className,
  commandProps,
  children,
  ...props
}: CommandDialogProps) {
  return (
    <Dialog {...props}>
      <DialogContent
        size="lg"
        position="top"
        showClose={false}
        overlayClassName="z-(--z-command)"
        className={cn('top-[15vh] z-(--z-command) max-h-[70vh] p-0', className)}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {description ? (
          <DialogDescription className="sr-only">{description}</DialogDescription>
        ) : null}
        <Command {...commandProps}>{children}</Command>
      </DialogContent>
    </Dialog>
  )
}
