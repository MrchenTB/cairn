import { describe, expect, it } from 'vitest'
import { toEpochDay } from '@/domain/dates'
import { AUTO_SCROLL_EDGE_PX, AUTO_SCROLL_MAX_SPEED } from './constants'
import {
  EXTEND_THRESHOLD_PX,
  anchoredScrollLeft,
  autoScrollStep,
  dataBounds,
  extendSide,
  initialFocus,
} from './viewport'

const d = toEpochDay

describe('dataBounds', () => {
  it('spans task dates of every kind, milestones and the project dates', () => {
    const bounds = dataBounds(
      [
        { startDate: '2026-11-04', dueDate: '2026-11-08' },
        { startDate: null, dueDate: '2026-12-01' }, // due only
        { startDate: '2026-10-30', dueDate: null }, // start only
        { startDate: null, dueDate: null },
      ],
      [{ date: '2027-01-05' }],
      { startDate: '2026-10-01', dueDate: null },
    )
    expect(bounds).toEqual({ start: d('2026-10-01'), end: d('2027-01-05') })
  })

  it('ignores corrupt dates and returns null when nothing is dated', () => {
    expect(dataBounds([{ startDate: '2026-02-30', dueDate: null }], [])).toBeNull()
    expect(dataBounds([], [], { startDate: null, dueDate: null })).toBeNull()
  })
})

describe('initialFocus', () => {
  const today = d('2026-11-03')

  it('opens on today at one third of the width when data is around today', () => {
    const focus = initialFocus({ start: d('2026-10-20'), end: d('2026-11-30') }, today, 60)
    expect(focus).toEqual({ day: today + 0.5, fraction: 1 / 3 })
  })

  it('opens on today without data', () => {
    expect(initialFocus(null, today, 60)).toEqual({ day: today + 0.5, fraction: 1 / 3 })
  })

  it('opens at the start of the data when nothing dated is visible around today', () => {
    const future = { start: d('2027-03-01'), end: d('2027-04-01') }
    expect(initialFocus(future, today, 60)).toEqual({ day: future.start, fraction: 0.08 })
    const past = { start: d('2025-01-01'), end: d('2025-02-01') }
    expect(initialFocus(past, today, 60).day).toBe(past.start)
  })
})

describe('anchoredScrollLeft', () => {
  it('shifts by the days the origin moved, so the same days stay on screen', () => {
    // The range grew 42 days to the left on the Day scale (36px/day).
    expect(anchoredScrollLeft(100, d('2026-11-02'), d('2026-09-21'), 36)).toBe(100 + 42 * 36)
    // The first date moved later (origin moved right): content shifts left, never below 0.
    expect(anchoredScrollLeft(500, d('2026-11-02'), d('2026-11-09'), 36)).toBe(500 - 7 * 36)
    expect(anchoredScrollLeft(10, d('2026-11-02'), d('2026-11-09'), 36)).toBe(0)
  })
})

describe('autoScrollStep', () => {
  const min = 300
  const max = 1300

  it('is zero away from the edges', () => {
    expect(autoScrollStep(800, min, max)).toBe(0)
    expect(autoScrollStep(min + AUTO_SCROLL_EDGE_PX, min, max)).toBe(0)
  })

  it('grows towards each edge, capped at the max speed beyond it', () => {
    const near = autoScrollStep(max - 10, min, max)
    const closer = autoScrollStep(max - 2, min, max)
    expect(near).toBeGreaterThan(0)
    expect(closer).toBeGreaterThan(near)
    expect(autoScrollStep(max + 200, min, max)).toBe(AUTO_SCROLL_MAX_SPEED)
    expect(autoScrollStep(min + 5, min, max)).toBeLessThan(0)
    expect(autoScrollStep(min - 200, min, max)).toBe(-AUTO_SCROLL_MAX_SPEED)
  })

  it('always moves at least one pixel inside the edge band', () => {
    expect(autoScrollStep(max - AUTO_SCROLL_EDGE_PX + 0.5, min, max)).toBe(1)
    expect(autoScrollStep(min + AUTO_SCROLL_EDGE_PX - 0.5, min, max)).toBe(-1)
  })

  it('does nothing when the band is too narrow to have a middle', () => {
    expect(autoScrollStep(310, 300, 300 + AUTO_SCROLL_EDGE_PX * 2)).toBe(0)
  })
})

describe('extendSide', () => {
  it('asks for more days near either end of a scrollable timeline', () => {
    expect(extendSide(0, 1000, 5000)).toBe('start')
    expect(extendSide(EXTEND_THRESHOLD_PX - 1, 1000, 5000)).toBe('start')
    expect(extendSide(2000, 1000, 5000)).toBeNull()
    expect(extendSide(5000 - 1000 - EXTEND_THRESHOLD_PX + 1, 1000, 5000)).toBe('end')
  })

  it('never grows content that does not scroll', () => {
    expect(extendSide(0, 1000, 1000)).toBeNull()
  })
})
