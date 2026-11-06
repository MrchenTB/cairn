import { describe, expect, it } from 'vitest'
import { toEpochDay } from '@/domain/dates'
import { barAriaLabel, datesLabel, deltaLabel, dragDelta, dragTooltip } from './labels'
import { nudgeFromKey, nudgeSpan } from './nudge'

const d = toEpochDay
const today = '2026-11-03'

describe('datesLabel / deltaLabel', () => {
  it('formats ranges with their inclusive length, and single dates by kind', () => {
    expect(datesLabel({ start: d('2026-11-04'), end: d('2026-11-07') }, today)).toBe(
      'Nov 4 – Nov 7 · 4 days',
    )
    expect(datesLabel({ start: d('2026-11-04'), end: d('2026-11-04') }, today)).toBe(
      'Nov 4 · 1 day',
    )
    expect(datesLabel({ start: null, end: d('2026-11-05') }, today)).toBe('Due Nov 5')
    expect(datesLabel({ start: d('2026-11-02'), end: null }, today)).toBe('Starts Nov 2')
    expect(datesLabel({ start: null, end: null }, today)).toBe('No dates')
  })

  it('shows the year when a range leaves the current one', () => {
    expect(datesLabel({ start: d('2026-12-30'), end: d('2027-01-02') }, today)).toBe(
      'Dec 30 – Jan 2, 2027 · 4 days',
    )
  })

  it('signs day deltas', () => {
    expect(deltaLabel(2)).toBe('+2 days')
    expect(deltaLabel(-1)).toBe('−1 day')
    expect(deltaLabel(0)).toBeNull()
  })
})

describe('dragDelta / dragTooltip', () => {
  const origin = { start: d('2026-11-04'), end: d('2026-11-07') }

  it('reports the moved end per mode', () => {
    expect(dragDelta('move', { start: d('2026-11-06'), end: d('2026-11-09') }, origin)).toBe(2)
    expect(dragDelta('resize-start', { start: d('2026-11-01'), end: origin.end }, origin)).toBe(-3)
    expect(dragDelta('resize-end', { start: origin.start, end: d('2026-11-10') }, origin)).toBe(3)
    // A due-only marker moves its due date.
    expect(
      dragDelta(
        'point',
        { start: null, end: d('2026-11-08') },
        { start: null, end: d('2026-11-05') },
      ),
    ).toBe(3)
    expect(
      dragDelta(
        'draw',
        { start: d('2026-11-01'), end: d('2026-11-03') },
        { start: null, end: null },
      ),
    ).toBe(0)
  })

  it('builds the live tooltip for tasks and milestones', () => {
    expect(
      dragTooltip('move', { start: d('2026-11-06'), end: d('2026-11-09') }, origin, today),
    ).toEqual({
      text: 'Nov 6 – Nov 9 · 4 days',
      detail: '+2 days',
    })
    expect(
      dragTooltip(
        'point',
        { start: d('2026-11-20'), end: null },
        { start: d('2026-11-16'), end: null },
        today,
        true,
      ),
    ).toEqual({ text: 'Nov 20', detail: '+4 days' })
  })
})

describe('barAriaLabel', () => {
  const task = { title: 'Design review', status: 'in_progress' as const }

  it('names the task, its dates, length and status', () => {
    expect(
      barAriaLabel(
        task,
        { kind: 'range', start: d('2026-11-02'), end: d('2026-11-05') },
        today,
        null,
        false,
      ),
    ).toBe('Design review, Nov 2 – Nov 5, 4 days, In Progress')
  })

  it('says which date is missing, and adds overdue and the conflict', () => {
    expect(
      barAriaLabel(
        task,
        { kind: 'due_only', start: null, end: d('2026-11-01') },
        today,
        'Should start after “A” ends',
        true,
      ),
    ).toBe(
      'Design review, Due Nov 1, no start date, In Progress, overdue, dependency conflict: Should start after “A” ends',
    )
    expect(
      barAriaLabel(
        task,
        { kind: 'start_only', start: d('2026-11-02'), end: null },
        today,
        null,
        false,
      ),
    ).toBe('Design review, Starts Nov 2, no due date, In Progress')
  })
})

describe('keyboard nudges', () => {
  const key = (
    k: string,
    mods: Partial<{ altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {},
  ) => ({
    key: k,
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    ...mods,
  })

  it('maps Alt/Option + arrows (Shift = due date) and ignores everything else', () => {
    expect(nudgeFromKey(key('ArrowRight', { altKey: true }))).toEqual({ kind: 'move', delta: 1 })
    expect(nudgeFromKey(key('ArrowLeft', { altKey: true, shiftKey: true }))).toEqual({
      kind: 'resize-end',
      delta: -1,
    })
    expect(nudgeFromKey(key('ArrowRight'))).toBeNull()
    expect(nudgeFromKey(key('ArrowRight', { altKey: true, metaKey: true }))).toBeNull()
    expect(nudgeFromKey(key('ArrowUp', { altKey: true }))).toBeNull()
  })

  const range = { kind: 'range' as const, start: d('2026-11-30'), end: d('2026-12-01') }

  it('moves every known date by one day, across month and year ends', () => {
    expect(nudgeSpan(range, { kind: 'move', delta: 1 })).toEqual({
      start: d('2026-12-01'),
      end: d('2026-12-02'),
    })
    expect(
      nudgeSpan(
        { kind: 'due_only', start: null, end: d('2026-12-31') },
        { kind: 'move', delta: 1 },
      ),
    ).toEqual({
      start: null,
      end: d('2027-01-01'),
    })
    expect(
      nudgeSpan(
        { kind: 'start_only', start: d('2027-01-01'), end: null },
        { kind: 'move', delta: -1 },
      ),
    ).toEqual({
      start: d('2026-12-31'),
      end: null,
    })
  })

  it('changes the due date but never before the start (1 day minimum)', () => {
    expect(nudgeSpan(range, { kind: 'resize-end', delta: 1 })).toEqual({
      start: range.start,
      end: d('2026-12-02'),
    })
    expect(nudgeSpan(range, { kind: 'resize-end', delta: -1 })).toEqual({
      start: range.start,
      end: range.start,
    })
    const oneDay = { kind: 'range' as const, start: d('2026-11-30'), end: d('2026-11-30') }
    expect(nudgeSpan(oneDay, { kind: 'resize-end', delta: -1 })).toBeNull()
  })

  it('does not apply to unscheduled tasks or a due change without a due date', () => {
    expect(
      nudgeSpan({ kind: 'unscheduled', start: null, end: null }, { kind: 'move', delta: 1 }),
    ).toBeNull()
    expect(
      nudgeSpan(
        { kind: 'start_only', start: d('2026-11-02'), end: null },
        { kind: 'resize-end', delta: 1 },
      ),
    ).toBeNull()
  })
})

describe('dates dragged past the ends of the supported calendar', () => {
  const pastEnd = toEpochDay('9999-12-31') + 3
  const beforeStart = toEpochDay('0001-01-01') - 3

  it('are named in the tooltip instead of throwing mid-drag', () => {
    const origin = { start: toEpochDay('9999-12-20'), end: toEpochDay('9999-12-28') }
    for (const dates of [
      { start: pastEnd - 9, end: pastEnd },
      { start: beforeStart, end: beforeStart + 2 },
      { start: pastEnd, end: null },
    ]) {
      expect(dragTooltip('move', dates, origin, '2026-11-04').text).toBe(
        'Outside the supported calendar',
      )
    }
    expect(
      dragTooltip('point', { start: pastEnd, end: null }, origin, '2026-11-04', true).text,
    ).toBe('Outside the supported calendar')
  })

  it('never break a bar’s accessible name', () => {
    const label = barAriaLabel(
      { title: 'Zeta', status: 'todo' },
      { kind: 'range', start: pastEnd - 9, end: pastEnd },
      '2026-11-04',
      null,
      false,
    )
    expect(label).toContain('Zeta')
  })
})
