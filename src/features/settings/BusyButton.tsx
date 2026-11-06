/**
 * A button that shows work in progress WITHOUT becoming `disabled`. The shared `<Button loading>`
 * disables itself, and a disabled button drops keyboard focus to the page: someone who pressed
 * Enter on "Sync now" or "Import backup…" would land back at the top of the document. This one
 * keeps focus, announces `aria-busy`, swaps its icon for the spinner and ignores clicks meanwhile.
 */
import type { ReactNode } from 'react'
import { Button, type ButtonProps } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

export function BusyButton({
  busy = false,
  icon,
  onClick,
  children,
  ...props
}: Omit<ButtonProps, 'loading' | 'asChild'> & {
  busy?: boolean
  /** Shown before the label while idle (replaced by the spinner while busy). */
  icon?: ReactNode
}) {
  return (
    <Button
      {...props}
      aria-busy={busy || undefined}
      onClick={(event) => {
        if (busy) event.preventDefault()
        else onClick?.(event)
      }}
    >
      {busy ? <Spinner label={null} /> : icon}
      {children}
    </Button>
  )
}
