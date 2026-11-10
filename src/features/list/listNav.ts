/**
 * Keyboard navigation of the List view (UX-05): ArrowUp / ArrowDown move focus between the items
 * on screen — phase headers ("No phase" included), tasks, subtasks and milestones — in the order
 * they are drawn, across groups, stopping at the first and the last item (no wrap-around).
 *
 * - The stops are the existing buttons (a phase header's toggle, a task's title, a milestone row),
 *   marked with `data-list-nav`. No tab stop is added, and Enter keeps each button's own action
 *   (toggle the phase, open the Task Modal, open the milestone dialog).
 * - The order is read from the DOM when a key is pressed: a collapsed phase or a parent whose
 *   subtasks are hidden renders no rows, so hidden items are skipped and nothing is expanded.
 * - One keydown handler on the list's scroll container. It acts only when the key comes from a
 *   stop itself, so text fields, IME composition, Radix menus / popovers (their portals bubble
 *   through React), the drag handle and dnd-kit's keyboard drag (focus stays on the handle; the
 *   drag state is checked too) keep their arrow keys. No global shortcut is registered.
 * - Moving focus selects nothing and writes nothing.
 * - When the focused item disappears (deleted, moved, collapsed, a sync), focus goes to the same
 *   item re-rendered (same `data-focus-key`), else to the item that took its place.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'
import { FOCUS_KEY_ATTRIBUTE } from '@/lib/focus'
import { isEditableTarget, isImeKeyEvent, isOverlayActive } from '@/lib/keyboard'

export const LIST_NAV_ATTRIBUTE = 'data-list-nav'
/** The sticky column header and the sticky group headers (auto-scroll keeps rows below them). */
export const LIST_COLUMN_HEADER_ATTRIBUTE = 'data-list-column-header'
export const LIST_GROUP_HEADER_ATTRIBUTE = 'data-list-group-header'

export type ListNavKind = 'group' | 'task' | 'milestone'

/** Stable identity of a stop; also its `data-focus-key`, so a dialog's focus return finds it. */
export const listNavKey = {
  group: (containerId: string) => `list:group:${containerId}`,
  task: (taskId: string) => `list:task:${taskId}`,
  milestone: (milestoneId: string) => `list:milestone:${milestoneId}`,
}

/** Spread on the element that is the stop. */
export function listNavProps(kind: ListNavKind, key: string) {
  return { [LIST_NAV_ATTRIBUTE]: kind, [FOCUS_KEY_ATTRIBUTE]: key }
}

type NavKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'defaultPrevented' | 'isComposing'
> & { keyCode?: number }

/** True when `target` is a navigation stop. */
export function isListNavItem(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement && target.hasAttribute(LIST_NAV_ATTRIBUTE)
}

/**
 * The step a keydown asks for (+1 down, −1 up), or null when it is not list navigation: another
 * key, a modifier, a key handled already, IME composition, a drag in progress, or a target that
 * is not a stop (a field, a menu item, the drag handle, a control inside a row).
 */
export function navStep(
  event: NavKeyEvent,
  target: EventTarget | null,
  dragging: boolean,
): -1 | 1 | null {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return null
  if (event.defaultPrevented || dragging) return null
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null
  if (isImeKeyEvent(event)) return null
  if (!isListNavItem(target)) return null
  if (isEditableTarget(target) || isOverlayActive(target)) return null
  return event.key === 'ArrowDown' ? 1 : -1
}

/** The index one step away, or null past either end (navigation stops there). */
export function stepIndex(count: number, index: number, step: -1 | 1): number | null {
  if (index < 0) return null
  const next = index + step
  return next < 0 || next >= count ? null : next
}

/**
 * Where focus goes when the focused stop left the list: the same item re-rendered (same key),
 * else the item now at its place (the one that followed it), else the last one; null when the
 * list has no stops.
 */
export function restoreIndex(
  keys: readonly string[],
  lostKey: string,
  lostIndex: number,
): number | null {
  if (keys.length === 0) return null
  const same = keys.indexOf(lostKey)
  if (same >= 0) return same
  return Math.min(Math.max(lostIndex, 0), keys.length - 1)
}

/** The stops of the list, in the order they are drawn. */
export function navItems(scroller: HTMLElement): HTMLElement[] {
  return Array.from(scroller.querySelectorAll<HTMLElement>(`[${LIST_NAV_ATTRIBUTE}]`))
}

/**
 * Scrolls the list just enough to show `item`'s row below the sticky column header and, for a
 * row inside a phase, below that phase's sticky header (native scrollIntoView ignores both).
 */
export function revealListItem(scroller: HTMLElement, item: HTMLElement): void {
  const header = item.closest<HTMLElement>(`[${LIST_GROUP_HEADER_ATTRIBUTE}]`)
  const row = header ?? item.closest<HTMLElement>('[data-task-row]') ?? item
  let inset =
    scroller.querySelector<HTMLElement>(`[${LIST_COLUMN_HEADER_ATTRIBUTE}]`)?.offsetHeight ?? 0
  if (!header) {
    const groupHeader = row
      .closest('section')
      ?.querySelector<HTMLElement>(`[${LIST_GROUP_HEADER_ATTRIBUTE}]`)
    if (groupHeader && scroller.contains(groupHeader)) inset += groupHeader.offsetHeight
  }
  const view = scroller.getBoundingClientRect()
  const box = row.getBoundingClientRect()
  const top = view.top + inset
  if (box.top < top) scroller.scrollTop -= top - box.top
  else if (box.bottom > view.bottom) scroller.scrollTop += box.bottom - view.bottom
}

function focusListItem(scroller: HTMLElement, item: HTMLElement): void {
  item.focus({ preventScroll: true })
  revealListItem(scroller, item)
}

const OVERLAY_SELECTOR =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]'

interface LostItem {
  key: string
  index: number
  element: HTMLElement
}

export interface ListKeyboardNavOptions {
  scrollerRef: RefObject<HTMLElement | null>
  /** True while a task is dragged (pointer or keyboard): dnd-kit owns the arrow keys then. */
  isDragging: () => boolean
}

/**
 * Wires the navigation: returns the scroll container's onKeyDown. Also remembers the stop that
 * has (or last had) focus, to put focus back when that stop disappears.
 */
export function useListKeyboardNav({ scrollerRef, isDragging }: ListKeyboardNavOptions) {
  /** The stop focus is on — or, for a control inside a row (status, ⋯), that row's stop. */
  const current = useRef<LostItem | null>(null)

  const remember = useCallback(
    (item: HTMLElement) => {
      const scroller = scrollerRef.current
      if (!scroller) return
      current.current = {
        key: item.getAttribute(FOCUS_KEY_ATTRIBUTE) ?? '',
        index: navItems(scroller).indexOf(item),
        element: item,
      }
    },
    [scrollerRef],
  )

  /** Puts focus back on the list when the remembered stop is gone; true when it did. */
  const restore = useCallback((): boolean => {
    const scroller = scrollerRef.current
    const lost = current.current
    // Still on the page: focus left it on purpose (a click elsewhere), leave it alone.
    if (!scroller || !lost || lost.element.isConnected) return false
    const items = navItems(scroller)
    const index = restoreIndex(
      items.map((item) => item.getAttribute(FOCUS_KEY_ATTRIBUTE) ?? ''),
      lost.key,
      lost.index,
    )
    if (index === null) {
      current.current = null
      return false
    }
    focusListItem(scroller, items[index])
    remember(items[index])
    return true
  }, [remember, scrollerRef])

  // Track where focus is. Focus inside a dialog / menu / popover (opened from the list) keeps the
  // memory, so the list can take focus back when that overlay closes onto a stop that is gone
  // (the Task Modal then falls back to <main>); focus anywhere else forgets it.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const scroller = scrollerRef.current
      const target = event.target
      if (!scroller || !(target instanceof Element)) return
      if (scroller.contains(target)) {
        const item = isListNavItem(target)
          ? target
          : target
              .closest(`[data-task-row],[${LIST_GROUP_HEADER_ATTRIBUTE}]`)
              ?.querySelector<HTMLElement>(`[${LIST_NAV_ATTRIBUTE}]`)
        if (item) remember(item)
        return
      }
      if (target.id === 'main') {
        restore()
        return
      }
      if (target.closest(OVERLAY_SELECTOR)) return
      current.current = null
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [remember, restore, scrollerRef])

  // After every render: the focused stop was removed (focus fell to <body>) — put it back.
  useLayoutEffect(() => {
    const active = document.activeElement
    if (active === null || active === document.body) restore()
  })

  return useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const step = navStep(event.nativeEvent, event.target, isDragging())
      const scroller = scrollerRef.current
      if (step === null || !scroller) return
      // Handled even at either end: the container must not scroll instead.
      event.preventDefault()
      const items = navItems(scroller)
      const next = stepIndex(items.length, items.indexOf(event.target as HTMLElement), step)
      if (next !== null) focusListItem(scroller, items[next])
    },
    [isDragging, scrollerRef],
  )
}
