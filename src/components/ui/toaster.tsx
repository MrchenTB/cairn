import type { CSSProperties } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import { Spinner } from './spinner'

const ICONS: ToasterProps['icons'] = {
  success: <CircleCheck className="size-4 text-success" />,
  error: <CircleAlert className="size-4 text-danger" />,
  warning: <TriangleAlert className="size-4 text-warning" />,
  info: <Info className="size-4 text-info" />,
  loading: <Spinner size={16} label={null} className="text-fg-tertiary" />,
}

// sonner reads these variables; inline style beats its injected theme stylesheet.
const STYLE = {
  '--normal-bg': 'var(--bg-elevated)',
  '--normal-bg-hover': 'var(--bg-elevated)',
  '--normal-border': 'var(--border-default)',
  '--normal-border-hover': 'var(--border-strong)',
  '--normal-text': 'var(--fg-primary)',
  '--border-radius': 'var(--radius-lg)',
  '--width': '360px',
} as CSSProperties

/**
 * Toast stack (bottom-right, max 3 visible), themed with tokens. Mount once; trigger toasts via
 * `notify` from '@/lib/notify'. Semantic colour only on the icon — no richColors. Visible toasts
 * are always laid out in full (`expand`): a newer toast never hides a failure and its Retry.
 * Alt+T (sonner) moves keyboard focus to the stack; toasts stay clickable over modals (index.css).
 */
export function Toaster({ theme = 'light', ...props }: ToasterProps) {
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      offset={16}
      gap={8}
      expand
      visibleToasts={3}
      icons={ICONS}
      style={STYLE}
      containerAriaLabel="Notifications"
      {...props}
    />
  )
}
