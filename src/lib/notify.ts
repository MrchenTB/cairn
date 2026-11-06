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

/** The sonner id each caller-chosen id is showing under now (or showed under last). */
const showing = new Map<string | number, string>()
let showings = 0

/**
 * The latest toast with a caller-chosen id (in practice the store's failure toast). When the server
 * refuses a change, the store reports it and then the caller, which cannot tell that refusal from
 * one of its own validations, reports the same text: one failure gets one message.
 */
let lastKeyed: { description: string | undefined; at: number; sonnerId: string } | null = null
const SAME_FAILURE_MS = 1000

export const notify = {
  success(message: string, options?: { description?: string; action?: NotifyAction }) {
    return toast.success(message, options)
  },
  /** Neutral information (with the info icon, like every other toast type). */
  info(message: string, options?: { description?: string; action?: NotifyAction }) {
    return toast.info(message, options)
  },
  warning(message: string, options?: { description?: string; action?: NotifyAction }) {
    return toast.warning(message, options)
  },
  error(
    message: string,
    options?: {
      description?: string
      action?: NotifyAction
      id?: string | number
      /** ms; default 8000 (Infinity = until dismissed) */
      duration?: number
    },
  ) {
    const { id, ...rest } = options ?? {}
    if (id === undefined) {
      if (
        lastKeyed &&
        rest.description !== undefined &&
        rest.description === lastKeyed.description &&
        performance.now() - lastKeyed.at < SAME_FAILURE_MS
      ) {
        return lastKeyed.sonnerId
      }
      return toast.error(message, { duration: 8000, ...rest })
    }
    // A toast with a caller-chosen `id` REPLACES the previous toast of that id (the store keeps a
    // single failure toast). sonner would update the old toast in place, but when that one is
    // being removed at that moment — a Retry that fails again at once, say — the new content is
    // merged into the toast that is on its way out and disappears with it: the failure is never
    // shown. So every showing gets its own sonner id and the previous one is dismissed.
    const previous = showing.get(id)
    const next = `${id}#${++showings}`
    showing.set(id, next)
    if (previous !== undefined) toast.dismiss(previous)
    lastKeyed = { description: rest.description, at: performance.now(), sonnerId: next }
    return toast.error(message, { duration: 8000, ...rest, id: next })
  },
  /** Dismisses the toast shown under `id` (or every toast). Repeating it is harmless. */
  dismiss(id?: string | number) {
    toast.dismiss(id === undefined ? undefined : (showing.get(id) ?? id))
  },
}

/**
 * True when `target` is inside the toast stack. Overlays use it so that using a toast's action
 * (Retry, Undo, Open…) never counts as a click outside that dismisses them.
 */
export function isToastTarget(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && target instanceof Element
    ? target.closest('[data-sonner-toaster]') !== null
    : false
}
