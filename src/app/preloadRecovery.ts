/**
 * Stale-deploy recovery. After a deploy, an open tab may request route chunks that no longer
 * exist; Vite then fires `vite:preloadError`. We reload once to pick up the new build. A
 * timestamp in sessionStorage stops a reload loop when a chunk is genuinely broken: the error
 * then surfaces and the route error boundary offers "Reload". When sessionStorage is
 * unavailable the guard cannot work, so we never auto-reload (a loop is worse than a button).
 * Offline there is no new build to pick up (the chunk just cannot be fetched) and a reload would
 * replace the app with the browser's offline page: the error surfaces instead and its boundary
 * says the page needs a connection.
 */

export const PRELOAD_RELOAD_KEY = 'cairn:preload-reload-at'
/** A second failure within this window is not auto-reloaded. */
export const PRELOAD_RELOAD_WINDOW_MS = 10_000

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export interface PreloadRecoveryOptions {
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  /** Storage for the timestamp; may throw or return null (blocked / private mode). */
  storage?: () => StorageLike | null
  reload?: () => void
  now?: () => number
  /** Whether the browser has a connection (default: `navigator.onLine`). */
  isOnline?: () => boolean
}

/** Listens for `vite:preloadError` and reloads at most once per window. Returns an uninstaller. */
export function installPreloadRecovery(options: PreloadRecoveryOptions = {}): () => void {
  const target = options.target ?? window
  const getStorage = options.storage ?? (() => window.sessionStorage)
  const reload = options.reload ?? (() => window.location.reload())
  const now = options.now ?? Date.now
  const isOnline = options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine)

  const onPreloadError = (event: Event) => {
    if (!isOnline()) return // offline: not a stale deploy, and a reload would lose the app
    try {
      const storage = getStorage()
      if (!storage) return
      const last = Number(storage.getItem(PRELOAD_RELOAD_KEY) ?? 0)
      if (now() - last < PRELOAD_RELOAD_WINDOW_MS) return // reloaded just now: let it surface
      storage.setItem(PRELOAD_RELOAD_KEY, String(now()))
    } catch {
      return // storage blocked: no guard, so no automatic reload
    }
    event.preventDefault() // Vite: don't throw, we are reloading
    reload()
  }

  target.addEventListener('vite:preloadError', onPreloadError)
  return () => target.removeEventListener('vite:preloadError', onPreloadError)
}
