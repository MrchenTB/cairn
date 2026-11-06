import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ mode: 'supabase', pending: 0 }))
vi.mock('@/data/hooks', () => ({
  useDataMode: () => state.mode,
  useSyncState: () => ({ pending: state.pending }),
}))

import { UnsavedWritesGuard } from './UnsavedWritesGuard'

function tryUnload(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

describe('UnsavedWritesGuard', () => {
  beforeEach(() => {
    state.mode = 'supabase'
    state.pending = 0
  })

  it('asks before leaving while cloud writes are pending', () => {
    state.pending = 2
    const { unmount } = render(<UnsavedWritesGuard />)
    expect(tryUnload()).toBe(true)
    unmount()
    expect(tryUnload()).toBe(false)
  })

  it('does not ask when nothing is pending', () => {
    render(<UnsavedWritesGuard />)
    expect(tryUnload()).toBe(false)
  })

  it('never asks in local mode', () => {
    state.mode = 'local'
    state.pending = 3
    render(<UnsavedWritesGuard />)
    expect(tryUnload()).toBe(false)
  })
})
