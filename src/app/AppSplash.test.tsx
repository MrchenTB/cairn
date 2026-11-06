import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppSplash, SLOW_SPLASH_AFTER_MS } from './AppSplash'

describe('AppSplash', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is quiet at first and says so when it takes long', () => {
    render(<AppSplash />)
    const splash = screen.getByRole('status', { name: 'Loading Cairn' })
    expect(splash).not.toHaveTextContent('longer than usual')
    act(() => {
      vi.advanceTimersByTime(SLOW_SPLASH_AFTER_MS - 1)
    })
    expect(splash).not.toHaveTextContent('longer than usual')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(splash).toHaveTextContent('longer than usual')
  })
})
