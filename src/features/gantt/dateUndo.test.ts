import { describe, expect, it } from 'vitest'
import { BURST_MS, classifyDateChange, mergeRecord } from './dateUndo'
import type { ScheduleWriteRecord } from './planner'

const rec = (
  taskId: string,
  before: [string | null, string | null],
  after: [string | null, string | null],
): ScheduleWriteRecord => ({
  applied: [{ taskId, startDate: after[0], dueDate: after[1] }],
  previous: [{ taskId, startDate: before[0], dueDate: before[1] }],
})

describe('classifyDateChange', () => {
  it('tells a move from a resize from first scheduling', () => {
    expect(classifyDateChange({ start: 10, end: 12 }, { start: 13, end: 15 })).toBe('moved')
    expect(classifyDateChange({ start: 10, end: 12 }, { start: 10, end: 14 })).toBe('resized')
    expect(classifyDateChange({ start: 10, end: 12 }, { start: 9, end: 12 })).toBe('resized')
    expect(classifyDateChange({ start: null, end: null }, { start: 10, end: 12 })).toBe('scheduled')
    expect(classifyDateChange({ start: null, end: 12 }, { start: null, end: 14 })).toBe('moved')
  })
})

describe('mergeRecord (a burst on one task is one undo)', () => {
  const first = rec('A', ['2026-11-02', '2026-11-04'], ['2026-11-03', '2026-11-05'])
  const second = rec('A', ['2026-11-03', '2026-11-05'], ['2026-11-04', '2026-11-06'])

  it('keeps the dates from before the first change of the burst', () => {
    const merged = mergeRecord(second, { record: first, at: 1000 }, 1000 + BURST_MS - 1)
    expect(merged.previous).toEqual(first.previous)
    expect(merged.applied).toEqual(second.applied)
  })

  it('starts over after the window, for another task, or when the dates are not contiguous', () => {
    expect(mergeRecord(second, { record: first, at: 1000 }, 1000 + BURST_MS)).toBe(second)
    expect(
      mergeRecord(
        rec('B', ['2026-11-03', '2026-11-05'], ['2026-11-04', '2026-11-06']),
        { record: first, at: 1000 },
        1001,
      ).previous[0].taskId,
    ).toBe('B')
    const edited = rec('A', ['2026-11-09', '2026-11-10'], ['2026-11-10', '2026-11-11'])
    expect(mergeRecord(edited, { record: first, at: 1000 }, 1001)).toBe(edited)
    expect(mergeRecord(second, null, 1001)).toBe(second)
  })

  it('never merges a write that shifted other tasks (Auto), which is undone as it was', () => {
    const multi: ScheduleWriteRecord = {
      applied: [...second.applied, { taskId: 'B', startDate: 'x', dueDate: 'y' }],
      previous: [...second.previous, { taskId: 'B', startDate: 'p', dueDate: 'q' }],
    }
    expect(mergeRecord(multi, { record: first, at: 1000 }, 1001)).toBe(multi)
  })
})
