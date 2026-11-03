/**
 * Outside-interaction guards shared by the Task Modal and the milestone dialog.
 *
 * A pointer-down on a toast (its Retry / Review / Open action) is not a click "outside" that
 * should close the dialog or ask "Discard changes?". While a Radix modal is open the page gets
 * `pointer-events: none`, so the event may be reported on the overlay underneath the toast:
 * the toast's rectangle decides, not the event target.
 */
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
