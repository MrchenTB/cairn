import { describe, expect, it } from 'vitest'
import { countRows, describeAge, describeCounts, formatMoment, plural } from './format'

const NOW = new Date(2026, 10, 2, 15, 30).getTime() // Nov 2, 2026 15:30 local time
const DAY = 86_400_000

describe('describeAge', () => {
  it('speaks in minutes-free, human units', () => {
    expect(describeAge(NOW - 30_000, NOW)).toBe('just now')
    expect(describeAge(NOW - 3 * 3_600_000, NOW)).toBe('today')
    expect(describeAge(NOW - 1.5 * DAY, NOW)).toBe('yesterday')
    expect(describeAge(NOW - 5 * DAY, NOW)).toBe('5 days ago')
    expect(describeAge(NOW - 21 * DAY, NOW)).toBe('3 weeks ago')
    expect(describeAge(NOW - 130 * DAY, NOW)).toBe('4 months ago')
    expect(describeAge(NOW + DAY, NOW)).toBe('just now') // a clock set back never goes negative
  })
})

describe('formatMoment', () => {
  it('says "Today" for the current day and shows the date otherwise', () => {
    expect(formatMoment(new Date(2026, 10, 2, 9, 5).getTime(), NOW)).toBe('Today, 9:05 AM')
    expect(formatMoment(new Date(2026, 9, 31, 21, 0).getTime(), NOW)).toBe('Oct 31, 9:00 PM')
  })
})

describe('counts', () => {
  it('counts the rows of a backup and describes them without empty tables', () => {
    const summary = countRows({
      projects: [{}, {}],
      phases: [],
      tasks: [{}],
      milestones: [],
      dependencies: [],
    } as never)
    expect(summary).toEqual({ projects: 2, phases: 0, tasks: 1, milestones: 0, dependencies: 0 })
    expect(describeCounts(summary)).toBe('2 projects and 1 task')
    expect(
      describeCounts({ projects: 1, phases: 2, tasks: 14, milestones: 1, dependencies: 0 }),
    ).toBe('1 project, 2 phases, 14 tasks and 1 milestone')
    expect(
      describeCounts({ projects: 0, phases: 0, tasks: 0, milestones: 0, dependencies: 0 }),
    ).toBe('nothing')
    expect(plural(1, 'task')).toBe('1 task')
    expect(plural(0, 'task')).toBe('0 tasks')
  })

  it('spells the plural of dependency correctly (the import toast and preview use it)', () => {
    expect(
      describeCounts({ projects: 6, phases: 2, tasks: 20, milestones: 3, dependencies: 4 }),
    ).toBe('6 projects, 2 phases, 20 tasks, 3 milestones and 4 dependencies')
    expect(
      describeCounts({ projects: 0, phases: 0, tasks: 0, milestones: 0, dependencies: 1 }),
    ).toBe('1 dependency')
    expect(plural(2, 'dependency', 'dependencies')).toBe('2 dependencies')
  })
})
