import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBrowserStorage } from './localRepository'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getBrowserStorage', () => {
  it('uses localStorage when it works', () => {
    expect(getBrowserStorage()).toBe(window.localStorage)
  })

  it('still uses a FULL localStorage (the saved workspace is in it; saves then report the error)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })
    expect(getBrowserStorage()).toBe(window.localStorage)
  })

  it('gives up when the browser blocks storage for the site', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })
    expect(getBrowserStorage()).toBeNull()
  })
})
