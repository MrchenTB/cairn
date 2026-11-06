/**
 * Outside-interaction and focus helpers shared by the Task Modal and the milestone dialog.
 *
 * A pointer-down on a toast (its Retry / Review / Open action) is not a click "outside" that
 * should close the dialog or ask "Discard changes?". While a Radix modal is open the page gets
 * `pointer-events: none`, so the event may be reported on the overlay underneath the toast:
 * the toast's rectangle decides, not the event target.
 */
import { isFocusOwnedElsewhere, restoreFocus } from '@/lib/focus'

interface OutsidePointerEvent {
  detail: { originalEvent: PointerEvent }
  preventDefault(): void
}

export function isOverToast(x: number, y: number): boolean {
  for (const toast of document.querySelectorAll('[data-sonner-toast]')) {
    const rect = toast.getBoundingClientRect()
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true
  }
  return false
}

/** `onPointerDownOutside` for dialogs: keeps them open when the pointer went down on a toast. */
export function ignorePointerDownOnToasts(event: OutsidePointerEvent): void {
  const { clientX, clientY } = event.detail.originalEvent
  if (isOverToast(clientX, clientY)) event.preventDefault()
}

const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
const ANY_DIALOG = '[role="dialog"], [role="alertdialog"]'

/**
 * Runs `callback` once no dialog other than `except` (and what it contains) is on screen any
 * more, exit animations included — checking every frame, at most `timeoutMs` later — plus one
 * task, so the closed dialog's own focus return has run. Returns a cancel function.
 */
export function afterDialogsClosed(
  callback: () => void,
  { except = null, timeoutMs = 1000 }: { except?: Element | null; timeoutMs?: number } = {},
): () => void {
  const startedAt = performance.now()
  let frame = 0
  let timer = 0
  const others = () =>
    [...document.querySelectorAll(ANY_DIALOG)].some(
      (dialog) => !except || !(dialog === except || dialog.contains(except)),
    )
  const tick = () => {
    if (others() && performance.now() - startedAt < timeoutMs) {
      frame = requestAnimationFrame(tick)
      return
    }
    frame = 0
    timer = window.setTimeout(() => {
      timer = 0
      callback()
    }, 0)
  }
  frame = requestAnimationFrame(tick)
  return () => {
    if (frame) cancelAnimationFrame(frame)
    if (timer) window.clearTimeout(timer)
  }
}

/**
 * Runs a delayed focus move into `container` (a dialog) only while no other dialog (the search
 * overlay, opened meanwhile) is on screen: that one owns focus now. Returns true when it ran.
 */
export function focusIfNotCovered(container: Element | null, focus: () => void): boolean {
  if (container && isFocusOwnedElsewhere(container)) return false
  focus()
  return true
}

/**
 * Focus after a dialog that has no trigger (opened by a shortcut, app state or the URL) closed:
 * back to `opener` when that is still right (see `restoreFocus`). When the opener is gone (its
 * row re-rendered, the page changed) and nothing else owns focus — no other dialog, no field the
 * user clicked — the main region gets it, so keyboard users stay in the page instead of <body>.
 */
export function returnFocusAfterClose(opener: HTMLElement | null): void {
  if (restoreFocus(opener)) return
  const active = document.activeElement
  if (active && active !== document.body) return
  if (document.querySelector(OPEN_DIALOG)) return
  document.getElementById('main')?.focus({ preventScroll: true })
}

/**
 * `onEscapeKeyDown` for dialogs and popovers with text fields: the Esc that cancels an IME
 * composition (Chinese / Japanese / Korean input) must not close them.
 */
export function ignoreEscapeWhileComposing(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) event.preventDefault()
}
