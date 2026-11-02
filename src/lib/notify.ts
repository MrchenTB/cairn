/**
 * App-wide toast notifications (wraps sonner). The <Toaster /> is mounted once in the app shell.
 * Use for feedback that is not tied to a form field: failed saves (with Retry), confirmations of
 * destructive actions, import/export results.
 */
import { toast } from 'sonner'

export interface NotifyAction {
  label: string
  onClick: () => void
}

export const notify = {
  success(message: string, options?: { description?: string; action?: NotifyAction }) {
    return toast.success(message, options)
  },
  info(message: string, options?: { description?: string; action?: NotifyAction }) {
    return toast(message, options)
  },
  warning(message: string, options?: { description?: string; action?: NotifyAction }) {
    return toast.warning(message, options)
  },
  error(
    message: string,
    options?: { description?: string; action?: NotifyAction; id?: string | number },
  ) {
    return toast.error(message, { duration: 8000, ...options })
  },
  dismiss(id?: string | number) {
    toast.dismiss(id)
  },
}
