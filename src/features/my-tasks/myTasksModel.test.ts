import { describe, expect, it } from 'vitest'
import { myTasks } from '@/domain/buckets'
import { makeProject, makeTask, makeWorkspace } from '@/domain/testFactories'
import {
  DUE_SOON_HREF,
  dueSoonGroups,
  groupAllTasks,
  isDueSoonFilter,
  myTasksCounts,
  parseMyTasksTab,
  staysInList,
} from './myTasksModel'

const TODAY = '2026-11-03'

function workspace() {
  const project = makeProject({ id: 'p' })
  const archived = makeProject({ id: 'x', status: 'archived', sortOrder: 'b0' })
  const task = (id: string, dueDate: string | null, extra = {}) =>
    makeTask({ id, title: id, projectId: 'p', dueDate, ...extra })
  return makeWorkspace({
    projects: [project, archived],
    tasks: [
      task('later', '2026-11-30'),
      task('overdue', '2026-11-01'),
      task('no-date', null),
      task('today', TODAY),
      task('upcoming', '2026-11-10'),
      task('done', '2026-11-01', { status: 'done', completedAt: '2026-11-02T00:00:00.000Z' }),
      makeTask({ id: 'archived', projectId: 'x', dueDate: '2026-11-01' }),
    ],
  })
}

describe('parseMyTasksTab', () => {
  it('accepts the four tabs and falls back to today', () => {
    expect(parseMyTasksTab('upcoming')).toBe('upcoming')
    expect(parseMyTasksTab('all')).toBe('all')
    expect(parseMyTasksTab('someday')).toBe('today')
    expect(parseMyTasksTab(undefined)).toBe('today')
    expect(parseMyTasksTab('constructor')).toBe('today')
  })
})

describe('myTasksCounts', () => {
  it('counts the bucket lists; All counts open tasks, done separately', () => {
    expect(myTasksCounts(myTasks(workspace(), TODAY))).toEqual({
      today: 1,
      upcoming: 1,
      overdue: 1,
      dueSoon: 2,
      all: 5,
      done: 1,
    })
  })
})

describe('myTasksCounts with scheduled tasks', () => {
  const task = (id: string, startDate: string | null, dueDate: string | null, extra = {}) =>
    makeTask({ id, title: id, projectId: 'p', startDate, dueDate, ...extra })
  const data = makeWorkspace({
    projects: [makeProject({ id: 'p' })],
    tasks: [
      task('due-today', null, TODAY),
      task('span-due-today', '2026-11-01', TODAY),
      task('scheduled', '2026-11-01', '2026-11-20'), // later by due date, scheduled across today
      task('scheduled-soon', '2026-11-02', '2026-11-06'), // upcoming and scheduled
      task('start-only', '2026-11-01', null),
      task('future', '2026-11-05', '2026-11-20'),
      task('overdue', '2026-10-01', '2026-11-01'),
      task('done', '2026-11-01', '2026-11-20', { status: 'done' }),
    ],
  })
  const buckets = myTasks(data, TODAY)

  it('counts Today as the union of due-today and scheduled-today, with no task twice', () => {
    const counts = myTasksCounts(buckets)
    expect(counts.today).toBe(4)
    expect(counts.today).toBe(
      new Set([...buckets.today, ...buckets.scheduledToday].map((t) => t.id)).size,
    )
  })

  it('keeps Due soon, Upcoming and Overdue on the due date', () => {
    const counts = myTasksCounts(buckets)
    expect(counts.upcoming).toBe(1)
    expect(counts.overdue).toBe(1)
    // Due soon is the Overview's number: due today + upcoming, never the Today tab count.
    expect(counts.dueSoon).toBe(buckets.today.length + buckets.upcoming.length)
    expect(counts.dueSoon).toBe(3)
    expect(counts.dueSoon).not.toBe(counts.today + counts.upcoming)
    expect(counts.all).toBe(7)
  })
})

describe('groupAllTasks', () => {
  it('sections the All list by due bucket, in order, without empty sections', () => {
    const groups = groupAllTasks(myTasks(workspace(), TODAY).all, TODAY, false)
    expect(groups.map((group) => [group.bucket, group.tasks.map((task) => task.id)])).toEqual([
      ['overdue', ['overdue']],
      ['today', ['today']],
      ['upcoming', ['upcoming']],
      ['later', ['later']],
      ['no_date', ['no-date']],
    ])
  })

  it('adds the Completed section only when completed tasks are shown', () => {
    const groups = groupAllTasks(myTasks(workspace(), TODAY).all, TODAY, true)
    expect(groups.at(-1)).toMatchObject({ bucket: 'done', tasks: [{ id: 'done' }] })
  })
})

describe('staysInList', () => {
  it('drops a done task unless the list shows done tasks', () => {
    expect(staysInList('done', false)).toBe(false)
    expect(staysInList('done', true)).toBe(true)
    expect(staysInList('in_progress', false)).toBe(true)
  })
})

describe('Due soon filter', () => {
  it("keeps exactly the Today and Upcoming groups — the Overview's Due soon population", () => {
    const buckets = myTasks(workspace(), TODAY)
    const groups = groupAllTasks(buckets.all, TODAY, true)
    const soon = dueSoonGroups(groups)
    expect(soon.map((group) => group.bucket)).toEqual(['today', 'upcoming'])
    expect(soon.flatMap((group) => group.tasks.map((task) => task.id))).toEqual([
      'today',
      'upcoming',
    ])
    expect(soon.flatMap((group) => group.tasks)).toHaveLength(
      buckets.today.length + buckets.upcoming.length,
    )
  })

  it('is only switched on by ?due=soon', () => {
    expect(isDueSoonFilter('soon')).toBe(true)
    expect(isDueSoonFilter('later')).toBe(false)
    expect(isDueSoonFilter(null)).toBe(false)
    expect(DUE_SOON_HREF).toBe('/my-tasks/all?due=soon')
  })
})
