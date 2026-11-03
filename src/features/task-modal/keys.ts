import type { KeyboardEvent } from 'react'

/** IME composition (CJK input): Enter confirms the composition, it must never submit. */
export function isComposing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229
}

/** ⌘↵ / Ctrl+↵ — the modal's save shortcut. */
export function isSaveShortcut(event: KeyboardEvent): boolean {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isComposing(event)
}

/** Plain Enter (no modifiers, not composing). */
export function isPlainEnter(event: KeyboardEvent): boolean {
  return (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !isComposing(event)
  )
}
