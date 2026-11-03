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
 * Focuses `target` unless that would be wrong now: it left the document, something else already
 * took focus (e.g. the user clicked into a field), or another dialog that does not contain it is
 * open (it owns focus). Returns true when it moved focus.
 */
export function restoreFocus(target: HTMLElement | null, doc: Document = document): boolean {
  if (!target?.isConnected) return false
  const active = doc.activeElement
  if (active && active !== doc.body && active !== target) return false
  const openDialog = doc.querySelector(OPEN_DIALOG)
  if (openDialog && !openDialog.contains(target)) return false
  target.focus({ preventScroll: true })
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
