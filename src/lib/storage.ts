/**
 * localStorage helpers that never throw (private mode, quota, disabled storage, SSR/tests).
 * Use for UI conveniences only — workspace data goes through the data layer.
 */

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** Parsed JSON value for `key`, or null when missing/unreadable/invalid. */
export function readJSON(key: string): unknown {
  try {
    const raw = storage()?.getItem(key)
    return raw ? (JSON.parse(raw) as unknown) : null
  } catch {
    return null
  }
}

/** Stores `value` as JSON; returns false when storage is unavailable or full. */
export function writeJSON(key: string, value: unknown): boolean {
  try {
    const store = storage()
    if (!store) return false
    store.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function removeKey(key: string): void {
  try {
    storage()?.removeItem(key)
  } catch {
    // ignore
  }
}

/** Calls `callback` when another tab changes `key` (the 'storage' event). Returns unsubscribe. */
export function onStorageKey(key: string, callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (event: StorageEvent) => {
    if (event.key === key || event.key === null) callback()
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
