import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNC_ERROR_TOAST_ID } from '@/data/store'
import { notify } from '@/lib/notify'
import { dismissSyncErrorToast, REDISMISS_DELAY } from './syncToast'

describe('dismissSyncErrorToast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('dismisses the failure toast now and once more after sonner had time to show it', () => {
    const dismiss = vi.spyOn(notify, 'dismiss').mockImplementation(() => {})
    dismissSyncErrorToast()
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(dismiss).toHaveBeenLastCalledWith(SYNC_ERROR_TOAST_ID)
    vi.advanceTimersByTime(REDISMISS_DELAY)
    expect(dismiss).toHaveBeenCalledTimes(2)
    expect(dismiss).toHaveBeenLastCalledWith(SYNC_ERROR_TOAST_ID)
  })
})
