import { describe, expect, it } from 'vitest'
import { anchoredPaneScroll, cubicBezier, PANE_ANIMATION_MS, paneWidthAt } from './paneAnimation'

describe('cubicBezier', () => {
  const ease = cubicBezier(0.2, 0, 0, 1)

  it('starts at 0, ends at 1 and clamps outside', () => {
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    expect(ease(-0.5)).toBe(0)
    expect(ease(1.5)).toBe(1)
  })

  it('is an ease-out: monotonic, ahead of linear in the first half, never overshooting', () => {
    let last = 0
    for (let t = 0.02; t < 1; t += 0.02) {
      const value = ease(t)
      expect(value).toBeGreaterThanOrEqual(last)
      expect(value).toBeLessThanOrEqual(1)
      last = value
    }
    expect(ease(0.25)).toBeGreaterThan(0.25)
    expect(ease(0.5)).toBeGreaterThan(0.5)
  })

  it('matches the CSS curve at known points (linear for 0,0,1,1)', () => {
    const linear = cubicBezier(0, 0, 1, 1)
    for (const t of [0.1, 0.4, 0.75]) expect(linear(t)).toBeCloseTo(t, 4)
  })
})

describe('paneWidthAt', () => {
  it('starts at the start width and lands exactly on the target', () => {
    expect(paneWidthAt(340, 0, 0)).toEqual({ width: 340, done: false })
    expect(paneWidthAt(340, 0, PANE_ANIMATION_MS)).toEqual({ width: 0, done: true })
    expect(paneWidthAt(0, 340, PANE_ANIMATION_MS + 500)).toEqual({ width: 340, done: true })
  })

  it('is strictly between the two widths in the middle, both directions', () => {
    const hide = paneWidthAt(340, 0, 60)
    expect(hide.done).toBe(false)
    expect(hide.width).toBeGreaterThan(0)
    expect(hide.width).toBeLessThan(340)
    const show = paneWidthAt(0, 340, 60)
    expect(show.width).toBeGreaterThan(0)
    expect(show.width).toBeLessThan(340)
  })

  it('turns around from any width (a retarget starts from where it is)', () => {
    const { width } = paneWidthAt(123.5, 340, 100)
    expect(width).toBeGreaterThan(123.5)
    expect(width).toBeLessThan(340)
  })
})

describe('anchoredPaneScroll', () => {
  it('takes the width change out of the scroll position, from the start', () => {
    expect(anchoredPaneScroll(900, 340, 340)).toBe(900)
    expect(anchoredPaneScroll(900, 340, 100)).toBe(660)
    expect(anchoredPaneScroll(900, 340, 0)).toBe(560)
    // Showing again from a pane of 0: the same day stays put.
    expect(anchoredPaneScroll(560, 0, 340)).toBe(900)
  })

  it('does not accumulate: any frame depends on the start only', () => {
    const start = 1000
    const widths = [340, 300.4, 211.7, 90.2, 12.9, 0]
    const direct = widths.map((width) => anchoredPaneScroll(start, 340, width))
    // The position at the end is exact whatever frames were drawn before.
    expect(direct.at(-1)).toBe(660)
    expect(anchoredPaneScroll(start, 340, 0)).toBe(660)
  })

  it('never goes below zero', () => {
    expect(anchoredPaneScroll(100, 340, 0)).toBe(0)
  })
})
