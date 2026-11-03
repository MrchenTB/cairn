/**
 * Tiny external store for the chart's horizontal scroll position, so the time header can follow
 * it (useSyncExternalStore with a derived value) without re-rendering the whole chart per frame.
 */
/** Horizontal scroll position, readable without re-rendering the whole chart. */
export interface ScrollPosition {
  get: () => number
  subscribe: (listener: () => void) => () => void
}

export function createScrollPosition(): ScrollPosition & { set: (left: number) => void } {
  let left = 0
  const listeners = new Set<() => void>()
  return {
    get: () => left,
    set(next) {
      if (next === left) return
      left = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
