import { describe, expect, it, vi } from 'vitest'
import {
  PRELOAD_RELOAD_KEY,
  PRELOAD_RELOAD_WINDOW_MS,
  installPreloadRecovery,
} from './preloadRecovery'

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}

function setup(
  storage: () => ReturnType<typeof memoryStorage> | null,
  isOnline: () => boolean = () => true,
) {
  const target = new EventTarget()
  const reload = vi.fn()
  let clock = 1_000_000
  const uninstall = installPreloadRecovery({ target, storage, reload, now: () => clock, isOnline })
  const fire = () => {
    const event = new Event('vite:preloadError', { cancelable: true })
    target.dispatchEvent(event)
    return event
  }
  return {
    reload,
    fire,
    uninstall,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('installPreloadRecovery', () => {
  it('reloads once and takes over the error', () => {
    const storage = memoryStorage()
    const { reload, fire } = setup(() => storage)
    const event = fire()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    expect(storage.getItem(PRELOAD_RELOAD_KEY)).toBe('1000000')
  })

  it('lets a repeated failure surface instead of reloading in a loop', () => {
    const storage = memoryStorage()
    const { reload, fire, advance } = setup(() => storage)
    fire()
    advance(PRELOAD_RELOAD_WINDOW_MS - 1)
    const second = fire()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(second.defaultPrevented).toBe(false) // Vite rethrows → error boundary → "Reload"
    advance(1)
    expect(fire().defaultPrevented).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('never auto-reloads without a working sessionStorage (no loop guard)', () => {
    const blocked = setup(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(blocked.fire().defaultPrevented).toBe(false)
    expect(blocked.reload).not.toHaveBeenCalled()

    const missing = setup(() => null)
    expect(missing.fire().defaultPrevented).toBe(false)
    expect(missing.reload).not.toHaveBeenCalled()

    const full = setup(() => ({
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError')
      },
    }))
    expect(full.fire().defaultPrevented).toBe(false)
    expect(full.reload).not.toHaveBeenCalled()
  })

  it('does not reload while offline: the reload would end on the browser offline page', () => {
    // A chunk that cannot be fetched offline is not a stale deploy; the error boundary explains.
    const storage = memoryStorage()
    let online = false
    const { reload, fire } = setup(
      () => storage,
      () => online,
    )
    const event = fire()
    expect(reload).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    expect(storage.getItem(PRELOAD_RELOAD_KEY)).toBeNull() // and it does not use up the one reload
    online = true
    expect(fire().defaultPrevented).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('can be uninstalled', () => {
    const { reload, fire, uninstall } = setup(() => memoryStorage())
    uninstall()
    fire()
    expect(reload).not.toHaveBeenCalled()
  })
})
