/** Layout pieces shared by the create and edit forms (header, scrolling body, footer). */
import type { ComponentProps, ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** 48px header: location breadcrumb on the left, actions + close on the right. */
export function ModalHeader({
  children,
  actions,
  onClose,
}: {
  children: ReactNode
  actions?: ReactNode
  onClose: () => void
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 pr-3 pl-3.5">
      <div className="flex min-w-0 flex-1 items-center gap-0.5">{children}</div>
      {actions}
      <Tooltip content="Close" shortcut="esc">
        <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </Tooltip>
    </header>
  )
}

/** The scrolling middle of the modal. */
export function ModalBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-1 pb-6', className)}
      {...props}
    />
  )
}

/** Footer: quiet meta line on the left, Cancel + primary action on the right. */
export function ModalFooter({ meta, children }: { meta?: ReactNode; children: ReactNode }) {
  return (
    <footer className="flex min-h-[3.25rem] shrink-0 items-center gap-2 border-t border-subtle px-5 py-2.5">
      <div className="mr-auto min-w-0 truncate text-meta text-fg-tertiary">{meta}</div>
      {children}
    </footer>
  )
}
