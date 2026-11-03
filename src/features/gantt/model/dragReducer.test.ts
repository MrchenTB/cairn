import { describe, expect, it } from 'vitest'
import { fromEpochDay, toEpochDay } from '@/domain/dates'
import {
  hasDateChange,
  isClick,
  previewDates,
  startDrag,
  toScheduleChange,
  updateDrag,
  type DragOrigin,
  type PointerSample,
} from './dragReducer'

const d = toEpochDay
const iso = (day: number | null) => (day === null ? null : fromEpochDay(day))

/** Pointer sample `days` (fractional) away from day `base` + 0.5, at a matching screen x. */
function at(base: number, days: number, dayWidth = 36, y = 0): PointerSample {
  return { clientX: 500 + days * dayWidth, clientY: 300 + y, dayFloat: base + 0.5 + days }
}

function dragBy(origin: DragOrigin, days: number, dayWidth = 36) {
  const base = origin.start ?? origin.end ?? 0
  const state = startDrag(origin, at(base, 0, dayWidth))
  return updateDrag(state, at(base, days, dayWidth))
}

describe('pending → dragging', () => {
  const origin: DragOrigin = { mode: 'move', start: d('2026-11-02'), end: d('2026-11-04') }

  it('stays a click below the 3px threshold', () => {
    const base = origin.start as number
    let state = startDrag(origin, at(base, 0))
    state = updateDrag(state, { ...at(base, 0), clientX: 502, clientY: 301 })
    expect(state.phase).toBe('pending')
    expect(isClick(state)).toBe(true)
    expect(hasDateChange(state)).toBe(false)
    expect(state.preview).toEqual({ start: origin.start, end: origin.end })
  })

  it('becomes a drag at 3px and stays one even when moving back', () => {
    const base = origin.start as number
    let state = startDrag(origin, at(base, 0))
    state = updateDrag(state, { ...at(base, 0), clientX: 503 })
    expect(state.phase).toBe('dragging')
    state = updateDrag(state, at(base, 0))
    expect(state.phase).toBe('dragging')
    expect(isClick(state)).toBe(false)
    expect(hasDateChange(state)).toBe(false) // dropped where it started: nothing to write
  })

  it('needs half a day of travel per day of snap (Week scale: 8px)', () => {
    const base = origin.start as number
    const start = startDrag(origin, at(base, 0, 16))
    expect(updateDrag(start, at(base, 0.45, 16)).deltaDays).toBe(0)
    expect(updateDrag(start, at(base, 0.5, 16)).deltaDays).toBe(1)
    expect(updateDrag(start, at(base, -1.6, 16)).deltaDays).toBe(-2)
  })
})

describe('move', () => {
  it('preserves the duration across a month boundary', () => {
    const state = dragBy({ mode: 'move', start: d('2026-01-29'), end: d('2026-01-31') }, 3)
    expect([iso(state.preview.start), iso(state.preview.end)]).toEqual(['2026-02-01', '2026-02-03'])
    expect(hasDateChange(state)).toBe(true)
  })

  it('crosses the year boundary', () => {
    const state = dragBy({ mode: 'move', start: d('2026-12-30'), end: d('2026-12-31') }, 2)
    expect([iso(state.preview.start), iso(state.preview.end)]).toEqual(['2027-01-01', '2027-01-02'])
  })

  it('moves backwards through a leap day', () => {
    const state = dragBy({ mode: 'move', start: d('2028-03-01'), end: d('2028-03-01') }, -1)
    expect(iso(state.preview.start)).toBe('2028-02-29')
  })

  it('includes scroll travel (auto-scroll moves the timeline under a still pointer)', () => {
    const origin: DragOrigin = { mode: 'move', start: d('2026-11-02'), end: d('2026-11-04') }
    const state = startDrag(origin, { clientX: 500, clientY: 0, dayFloat: d('2026-11-03') + 0.5 })
    // Same screen x, but the content scrolled 5 days to the right underneath.
    const next = updateDrag(
      updateDrag(state, { clientX: 510, clientY: 0, dayFloat: d('2026-11-03') + 0.78 }),
      { clientX: 510, clientY: 0, dayFloat: d('2026-11-08') + 0.78 },
    )
    expect(next.deltaDays).toBe(5)
    expect(iso(next.preview.start)).toBe('2026-11-07')
  })
})

describe('resize', () => {
  const origin = { start: d('2026-11-02'), end: d('2026-11-05') }

  it('end: grows and shrinks, never before the start (min 1 day)', () => {
    expect(iso(dragBy({ mode: 'resize-end', ...origin }, 2).preview.end)).toBe('2026-11-07')
    const shrunk = dragBy({ mode: 'resize-end', ...origin }, -10)
    expect([iso(shrunk.preview.start), iso(shrunk.preview.end)]).toEqual([
      '2026-11-02',
      '2026-11-02',
    ])
  })

  it('start: moves, never after the end', () => {
    expect(iso(dragBy({ mode: 'resize-start', ...origin }, -3).preview.start)).toBe('2026-10-30')
    const clamped = dragBy({ mode: 'resize-start', ...origin }, 10)
    expect([iso(clamped.preview.start), iso(clamped.preview.end)]).toEqual([
      '2026-11-05',
      '2026-11-05',
    ])
  })

  it('resizing across a month end keeps the other end fixed', () => {
    const state = dragBy({ mode: 'resize-end', start: d('2026-11-28'), end: d('2026-11-30') }, 3)
    expect([iso(state.preview.start), iso(state.preview.end)]).toEqual(['2026-11-28', '2026-12-03'])
  })
})

describe('point (due flag, start tick, milestone)', () => {
  it('moves only the date that exists', () => {
    const due = dragBy({ mode: 'point', start: null, end: d('2026-11-05') }, 4)
    expect(due.preview).toEqual({ start: null, end: d('2026-11-09') })
    const start = dragBy({ mode: 'point', start: d('2026-11-05'), end: null }, -2)
    expect(start.preview).toEqual({ start: d('2026-11-03'), end: null })
  })
})

describe('draw (schedule an undated task)', () => {
  const origin: DragOrigin = { mode: 'draw', start: null, end: null }

  it('start = day under pointer-down, end = day under the pointer', () => {
    let state = startDrag(origin, { clientX: 100, clientY: 0, dayFloat: d('2026-11-10') + 0.2 })
    expect(state.preview).toEqual({ start: d('2026-11-10'), end: d('2026-11-10') })
    state = updateDrag(state, { clientX: 220, clientY: 0, dayFloat: d('2026-11-13') + 0.9 })
    expect([iso(state.preview.start), iso(state.preview.end)]).toEqual(['2026-11-10', '2026-11-13'])
  })

  it('normalises a leftward draw so start ≤ due', () => {
    let state = startDrag(origin, { clientX: 300, clientY: 0, dayFloat: d('2026-11-10') + 0.5 })
    state = updateDrag(state, { clientX: 100, clientY: 0, dayFloat: d('2026-11-06') + 0.1 })
    expect([iso(state.preview.start), iso(state.preview.end)]).toEqual(['2026-11-06', '2026-11-10'])
    expect(hasDateChange(state)).toBe(true)
  })
})

describe('previewDates / toScheduleChange', () => {
  it('maps a preview to the planner input', () => {
    expect(toScheduleChange('t1', { start: d('2026-11-02'), end: null })).toEqual({
      taskId: 't1',
      startDate: '2026-11-02',
      dueDate: null,
    })
  })

  it('refuses dates outside the supported calendar', () => {
    expect(toScheduleChange('t1', { start: d('9999-12-31') + 1, end: null })).toBeNull()
  })

  it('keeps missing dates missing', () => {
    expect(previewDates({ mode: 'move', start: null, end: null }, 3)).toEqual({
      start: null,
      end: null,
    })
    expect(previewDates({ mode: 'resize-end', start: d('2026-11-02'), end: null }, 3)).toEqual({
      start: d('2026-11-02'),
      end: null,
    })
  })
})
