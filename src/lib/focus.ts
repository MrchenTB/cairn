/**
 * Focus return for overlays that open without a trigger element (a shortcut, app state, the URL).
 * Radix dialogs give focus back to their Trigger; without one it falls to <body>, and keyboard
 * users lose their place (WCAG 2.4.3). Record the focused element when the overlay opens and
 * restore it when the overlay closes.
 */
import { useRef, type RefObject } from 'react'

/**
 * The element to give focus back to later: the focused element, or — when that is an item of a
 * menu that is about to close — the menu's trigger. Null when nothing (or <body>) has focus.
 */
export function getFocusReturnTarget(doc: Document = document): HTMLElement | null {
  const active = doc.activeElement
  if (!(active instanceof HTMLElement) || active === doc.body) return null
  const menu = active.closest('[role="menu"]')
  const triggerId = menu?.getAttribute('aria-labelledby')
  const trigger = triggerId ? doc.getElementById(triggerId) : null
  return trigger ?? active
}

const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'

/**
 * An element that is re-created when its data changes (a board card that moves to another column
 * is unmounted and mounted again) can carry `data-focus-key="<stable key>"`: when focus has to go
 * back to the old element and it is gone, `restoreFocus` finds the element with the same key.
 */
export const FOCUS_KEY_ATTRIBUTE = 'data-focus-key'

/** `target` when it is still in the document, else the element that took its place (same key). */
function resolveFocusTarget(target: HTMLElement | null, doc: Document): HTMLElement | null {
  if (!target) return null
  if (target.isConnected) return target
  const key = target.getAttribute(FOCUS_KEY_ATTRIBUTE)
  if (!key) return null
  for (const candidate of doc.querySelectorAll<HTMLElement>(`[${FOCUS_KEY_ATTRIBUTE}]`)) {
    if (candidate.getAttribute(FOCUS_KEY_ATTRIBUTE) === key) return candidate
  }
  return null
}

/**
 * True when an open dialog that does not contain `target` is on screen: that dialog owns focus
 * now (a search overlay opened while the dialog `target` belongs to was still closing), and a
 * delayed focus return to `target` must not pull focus out of it. Checks every open dialog, not
 * just the first one in the document.
 */
export function isFocusOwnedElsewhere(target: Element, doc: Document = document): boolean {
  for (const dialog of doc.querySelectorAll(OPEN_DIALOG)) {
    if (!dialog.contains(target)) return true
  }
  return false
}

/**
 * Focuses `target` unless that would be wrong now: it left the document (and nothing with its
 * `data-focus-key` replaced it), something else already took focus (e.g. the user clicked into a
 * field), or another dialog that does not contain it is open (it owns focus). Returns true when it
 * moved focus. A replacement may sit elsewhere on the page, so it is scrolled into view; the
 * original element has not moved, so it is not.
 */
export function restoreFocus(target: HTMLElement | null, doc: Document = document): boolean {
  const live = resolveFocusTarget(target, doc)
  if (!live) return false
  const active = doc.activeElement
  if (active && active !== doc.body && active !== live) return false
  if (isFocusOwnedElsewhere(live, doc)) return false
  live.focus({ preventScroll: live === target })
  return true
}

export interface FocusReturn {
  /** Pass to <FocusReturnRecorder> rendered inside the overlay content. */
  targetRef: RefObject<HTMLElement | null>
  /** Pass as the Radix content's onCloseAutoFocus. */
  onCloseAutoFocus: (event: Event) => void
}

/**
 * Focus return for Radix dialog content. The consumer's own onCloseAutoFocus runs first; calling
 * `event.preventDefault()` there opts out. Otherwise focus goes back to the recorded element
 * when that is appropriate (see restoreFocus), else Radix's default (its Trigger) applies.
 */
export function useFocusReturn(onCloseAutoFocus?: (event: Event) => void): FocusReturn {
  const targetRef = useRef<HTMLElement | null>(null)
  return {
    targetRef,
    onCloseAutoFocus(event) {
      onCloseAutoFocus?.(event)
      const target = targetRef.current
      targetRef.current = null
      if (!event.defaultPrevented && restoreFocus(target)) event.preventDefault()
    },
  }
}
