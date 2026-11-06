import { describe, expect, it } from 'vitest'
import {
  FULL_LABEL,
  MIN_LABEL_WIDTH,
  NO_LABEL,
  insideLabelLeft,
  insideLabelRoom,
  outsideLabelLeft,
} from './barLabel'

/** A 1,000px bar starting at x = 200, with a 100px name. */
const bar = { barLeft: 200, barWidth: 1000, labelWidth: 100 }

describe('insideLabelLeft', () => {
  it('starts inside the bar, past its border and inset, while the bar start is on screen', () => {
    expect(insideLabelLeft({ ...bar, scrollLeft: 0 })).toBe(209)
    expect(insideLabelLeft({ ...bar, scrollLeft: 150 })).toBe(209)
  })

  it('sticks to the visible edge once the bar starts off screen', () => {
    expect(insideLabelLeft({ ...bar, scrollLeft: 400 })).toBe(408)
  })

  it('never leaves the bar: near its end the name stops against it', () => {
    // Bar ends at 1200: the name's right edge may not pass 1199.
    expect(insideLabelLeft({ ...bar, scrollLeft: 1150 })).toBe(1099)
    expect(insideLabelLeft({ ...bar, scrollLeft: 5000 })).toBe(1099)
  })
})

describe('insideLabelRoom', () => {
  it('is the whole name when the row has no diamonds, or none is in its way', () => {
    expect(insideLabelRoom({ ...bar, scrollLeft: 0, diamondXs: [] })).toBe(FULL_LABEL)
    // The name spans 209 … 309; this diamond starts at 392.
    expect(insideLabelRoom({ ...bar, scrollLeft: 0, diamondXs: [400] })).toBe(FULL_LABEL)
  })

  it('ends the name before the first diamond it would run under', () => {
    // The name spans 209 … 309. A diamond at 330 starts at 322, after the name: no cut.
    // A diamond at 290 starts at 282: 282 - 4 (air) - 209 leaves 69px.
    expect(insideLabelRoom({ ...bar, scrollLeft: 0, diamondXs: [330] })).toBe(FULL_LABEL)
    expect(insideLabelRoom({ ...bar, scrollLeft: 0, diamondXs: [290] })).toBe(69)
    // Only the first diamond in the way counts.
    expect(insideLabelRoom({ ...bar, scrollLeft: 0, diamondXs: [290, 300, 800] })).toBe(69)
  })

  it('leaves the name out when a diamond covers its start or leaves too little of it', () => {
    expect(insideLabelRoom({ ...bar, scrollLeft: 0, diamondXs: [215] })).toBe(NO_LABEL)
    expect(insideLabelRoom({ ...bar, scrollLeft: 0, diamondXs: [202] })).toBe(NO_LABEL)
    // A diamond on the bar's first day ends at 208, just before the name starts at 209.
    expect(insideLabelRoom({ ...bar, scrollLeft: 0, diamondXs: [200] })).toBe(FULL_LABEL)
    // Room of exactly MIN_LABEL_WIDTH is enough; one px less is not.
    const start = 209 + MIN_LABEL_WIDTH + 4
    expect(insideLabelRoom({ ...bar, scrollLeft: 0, diamondXs: [start + 8] })).toBe(MIN_LABEL_WIDTH)
    expect(insideLabelRoom({ ...bar, scrollLeft: 0, diamondXs: [start + 7] })).toBe(NO_LABEL)
  })

  it('ignores diamonds the name has already moved past', () => {
    // Stuck at 508: a diamond whose right edge is at 508 or less is behind the name.
    expect(insideLabelRoom({ ...bar, scrollLeft: 500, diamondXs: [500] })).toBe(FULL_LABEL)
    expect(insideLabelRoom({ ...bar, scrollLeft: 500, diamondXs: [501] })).toBe(NO_LABEL)
  })

  it('follows the scroll: a diamond clear of the name at the bar start runs under it later', () => {
    const diamondXs = [520]
    expect(insideLabelRoom({ ...bar, scrollLeft: 0, diamondXs })).toBe(FULL_LABEL)
    // Scrolled 440px: the name is stuck at 448 … 548, the diamond (512 … 528) is under its end.
    expect(insideLabelRoom({ ...bar, scrollLeft: 440, diamondXs })).toBe(60)
    // Scrolled 500px: the diamond now covers the name's start.
    expect(insideLabelRoom({ ...bar, scrollLeft: 500, diamondXs })).toBe(NO_LABEL)
    // Scrolled past it: the whole name is back.
    expect(insideLabelRoom({ ...bar, scrollLeft: 530, diamondXs })).toBe(FULL_LABEL)
  })

  it('is stable for equal inputs (a scroll store snapshot)', () => {
    const input = { ...bar, scrollLeft: 440, diamondXs: [520] }
    expect(insideLabelRoom(input)).toBe(insideLabelRoom({ ...input }))
  })
})

describe('outsideLabelLeft', () => {
  it('goes right after the bar when nothing is in the way', () => {
    // Week scale: a one-day bar is 16px wide and its diamond (centre +8) ends 8px into the gap.
    expect(outsideLabelLeft(300, 16, 40, [])).toBe(322)
    expect(outsideLabelLeft(300, 16, 40, [308])).toBe(322)
  })

  it('moves past a diamond that touches the name (Month scale: a one-day bar is 5px)', () => {
    // Bar 300 … 305, diamond centred at 302.5 ends at 310.5; the name starts after it, with air.
    expect(outsideLabelLeft(300, 5, 40, [302.5])).toBe(314.5)
  })

  it('moves past every diamond it would run under, and ignores those beyond the name', () => {
    expect(outsideLabelLeft(300, 16, 60, [330, 346])).toBe(358)
    expect(outsideLabelLeft(300, 16, 40, [400])).toBe(322)
  })

  it('ignores diamonds behind the bar', () => {
    expect(outsideLabelLeft(300, 16, 40, [100, 250])).toBe(322)
  })
})
