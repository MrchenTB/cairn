/**
 * A form that keeps the user's input after a failed save shows its own "Try again", so the store's
 * "Couldn't …" toast (whose Retry would send the same write a second time) is taken away.
 */
import { SYNC_ERROR_TOAST_ID } from '@/data/store'
import { notify } from '@/lib/notify'

/** Delay of the repeated dismissal (ms). */
export const REDISMISS_DELAY = 150

/**
 * Dismisses the store's failure toast. sonner puts a new toast on screen from a timer but applies
 * a dismissal on animation frames, and on a busy main thread the dismissal can overtake the toast,
 * which then stays on screen. So the dismissal is repeated once the toast is certainly there.
 */
export function dismissSyncErrorToast(): void {
  notify.dismiss(SYNC_ERROR_TOAST_ID)
  setTimeout(() => notify.dismiss(SYNC_ERROR_TOAST_ID), REDISMISS_DELAY)
}
