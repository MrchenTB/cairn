import { describe, expect, it } from 'vitest'
import { myTasks } from '@/domain/buckets'
import { makeMilestone, makeProject, makeTask, makeWorkspace } from '@/domain/testFactories'
import {
  dayCenter,
  miniTimeline,
  placeSpan,
  projectSpan,
  timelineWindow,
  upcomingMilestones,
  upcomingTasks,
} from './overviewModel'

const TODAY = '2026-11-03' // a Tuesday

describe('upcomingTasks', () => {
  const project = makeProject({ id: 'p' })
  const task = (title: string, dueDate: string | null, extra = {}) =>
    makeTask({ id: title, title, projectId: 'p', dueDate, ...extra })

  it('lists overdue, then today, then the next 7 days — capped, with the full total', () => {
    const data = makeWorkspace({
      projects: [project],
      tasks: [
        task('up-1', '2026-11-04'),
        task('today', TODAY),
        task('late', '2026-10-30'),
        task('later', '2026-11-20'),
        task('no-date', null),
        task('done-late', '2026-10-01', { status: 'done' }),
        task('up-2', '2026-11-10'),
      ],
    })
    const result = upcomingTasks(myTasks(data, TODAY), 3)
    expect(result.tasks.map((t) => t.id)).toEqual(['late', 'today', 'up-1'])
    expect(result.total).toBe(4)
  })

  it('is empty without tasks in those buckets', () => {
    const none = upcomingTasks(myTasks(makeWorkspace({ projects: [project] }), TODAY))
    expect(none).toEqual({ tasks: [], total: 0 })
    const laterOnly = makeWorkspace({ projects: [project], tasks: [task('a', '2026-12-30')] })
    expect(upcomingTasks(myTasks(laterOnly, TODAY))).toEqual({ tasks: [], total: 0 })
  })

  it('lists exactly the My Tasks overdue, today and upcoming tasks (same counts as the tabs)', () => {
    const data = makeWorkspace({
      projects: [project],
      tasks: [task('late', '2026-10-30'), task('today', TODAY), task('soon', '2026-11-08')],
    })
    const buckets = myTasks(data, TODAY)
    const result = upcomingTasks(buckets)
    expect(result.total).toBe(
      buckets.overdue.length + buckets.today.length + buckets.upcoming.length,
    )
  })
})

describe('upcomingMilestones', () => {
  it('keeps today … today + 30 days of non-archived projects, by date then name', () => {
    const active = makeProject({ id: 'a' })
    const completed = makeProject({ id: 'c', status: 'completed' })
    const archived = makeProject({ id: 'x', status: 'archived' })
    const data = makeWorkspace({
      projects: [active, completed, archived],
      milestones: [
        makeMilestone({ id: 'past', projectId: 'a', date: '2026-11-02' }),
        makeMilestone({ id: 'today', projectId: 'a', date: TODAY, name: 'B' }),
        makeMilestone({ id: 'today-a', projectId: 'c', date: TODAY, name: 'A' }),
        makeMilestone({ id: 'edge', projectId: 'a', date: '2026-12-03' }),
        makeMilestone({ id: 'beyond', projectId: 'a', date: '2026-12-04' }),
        makeMilestone({ id: 'archived', projectId: 'x', date: '2026-11-05' }),
        makeMilestone({ id: 'orphan', projectId: 'gone', date: '2026-11-05' }),
      ],
    })
    expect(upcomingMilestones(data, TODAY).map((m) => m.id)).toEqual(['today-a', 'today', 'edge'])
  })
})

describe('projectSpan', () => {
  const tasks = [
    { startDate: '2026-11-10', dueDate: '2026-11-12' },
    { startDate: null, dueDate: '2026-11-20' },
  ]
  const milestones = [{ date: '2026-11-25' }]

  it('prefers the project’s own dates, end by end', () => {
    expect(
      projectSpan({ startDate: '2026-11-01', dueDate: '2026-12-01' }, tasks, milestones),
    ).toEqual({ start: '2026-11-01', end: '2026-12-01' })
    expect(projectSpan({ startDate: '2026-11-01', dueDate: null }, tasks, milestones)).toEqual({
      start: '2026-11-01',
      end: '2026-11-25',
    })
    expect(projectSpan({ startDate: null, dueDate: '2026-12-01' }, tasks, milestones)).toEqual({
      start: '2026-11-10',
      end: '2026-12-01',
    })
  })

  it('falls back to the roll-up of tasks and milestones', () => {
    expect(projectSpan({ startDate: null, dueDate: null }, tasks, milestones)).toEqual({
      start: '2026-11-10',
      end: '2026-11-25',
    })
  })

  it('uses the union when own dates and the roll-up disagree', () => {
    // Due before the first task starts.
    expect(projectSpan({ startDate: null, dueDate: '2026-11-05' }, tasks, [])).toEqual({
      start: '2026-11-05',
      end: '2026-11-20',
    })
  })

  it('is one day for a single date and null without any date', () => {
    expect(projectSpan({ startDate: null, dueDate: '2026-11-30' }, [], [])).toEqual({
      start: '2026-11-30',
      end: '2026-11-30',
    })
    expect(
      projectSpan({ startDate: null, dueDate: null }, [{ startDate: null, dueDate: null }], []),
    ).toBe(null)
    expect(projectSpan({ startDate: 'not-a-date', dueDate: null }, [], [])).toBe(null)
  })
})

describe('timeline geometry', () => {
  it('starts on the first day of the current week and spans six weeks', () => {
    const monday = timelineWindow(TODAY, 1)
    expect(monday.start).toBe('2026-11-02')
    expect(monday.end).toBe('2026-12-13')
    expect(monday.days).toBe(42)
    expect(monday.weeks).toEqual([
      '2026-11-02',
      '2026-11-09',
      '2026-11-16',
      '2026-11-23',
      '2026-11-30',
      '2026-12-07',
    ])
    expect(timelineWindow(TODAY, 0).start).toBe('2026-11-01')
  })

  it('places spans in percent and marks clipped ends', () => {
    const window = timelineWindow(TODAY, 1)
    expect(placeSpan({ start: '2026-11-02', end: '2026-11-08' }, window)).toEqual({
      left: 0,
      width: (7 / 42) * 100,
      clippedStart: false,
      clippedEnd: false,
    })
    expect(placeSpan({ start: '2026-10-01', end: '2027-01-01' }, window)).toEqual({
      left: 0,
      width: 100,
      clippedStart: true,
      clippedEnd: true,
    })
    const single = placeSpan({ start: '2026-12-13', end: '2026-12-13' }, window)
    expect(single?.left).toBeCloseTo((41 / 42) * 100)
    expect(single?.width).toBeCloseTo((1 / 42) * 100)
    expect(placeSpan({ start: '2026-10-01', end: '2026-11-01' }, window)).toBeNull()
    expect(placeSpan({ start: '2026-12-14', end: '2026-12-20' }, window)).toBeNull()
  })

  it('centres a day in its column', () => {
    const window = timelineWindow(TODAY, 1)
    expect(dayCenter('2026-11-02', window)).toBeCloseTo((0.5 / 42) * 100)
    expect(dayCenter(TODAY, window)).toBeCloseTo((1.5 / 42) * 100)
    expect(dayCenter('2026-11-01', window)).toBeNull()
    expect(dayCenter('2026-12-14', window)).toBeNull()
  })
})

describe('miniTimeline', () => {
  it('shows active projects with a span or milestone in the window, in project order', () => {
    const projects = [
      makeProject({ id: 'a', sortOrder: 'a0', startDate: '2026-11-04', dueDate: '2026-11-20' }),
      makeProject({ id: 'b', sortOrder: 'a1' }), // nothing dated
      makeProject({ id: 'c', sortOrder: 'a2' }), // only a milestone in the window
      makeProject({ id: 'd', sortOrder: 'a3', startDate: '2027-02-01', dueDate: '2027-03-01' }),
    ]
    const data = makeWorkspace({
      projects,
      tasks: [makeTask({ projectId: 'b' })],
      milestones: [
        makeMilestone({ id: 'm-c', projectId: 'c', date: '2026-11-25' }),
        makeMilestone({ id: 'm-out', projectId: 'a', date: '2027-01-10' }),
      ],
    })
    const result = miniTimeline(data, projects, timelineWindow(TODAY, 1))
    expect(result.rows.map((row) => row.project.id)).toEqual(['a', 'c'])
    expect(result.rows[0].placed).not.toBeNull()
    expect(result.rows[0].milestones).toEqual([]) // m-out is outside the window
    // c: one-day span from its milestone, drawn as a diamond on the row.
    expect(result.rows[1].milestones.map((m) => m.id)).toEqual(['m-c'])
    expect(result.idle).toBe(2)
    expect(result.more).toBe(0)
  })

  it('keeps a project whose own dates ended before its open work does (a slipped deadline)', () => {
    const projects = [
      makeProject({
        id: 'slipped',
        sortOrder: 'a0',
        startDate: '2026-09-01',
        dueDate: '2026-10-30',
      }),
      makeProject({
        id: 'finished',
        sortOrder: 'a1',
        startDate: '2026-09-01',
        dueDate: '2026-10-30',
      }),
      makeProject({ id: 'idle', sortOrder: 'a2', startDate: '2026-09-01', dueDate: '2026-10-30' }),
    ]
    const data = makeWorkspace({
      projects,
      tasks: [
        makeTask({
          id: 't-open',
          projectId: 'slipped',
          startDate: '2026-11-04',
          dueDate: '2026-11-06',
        }),
        // Open work outside the window does not stretch the bar.
        makeTask({ id: 't-ancient', projectId: 'slipped', dueDate: '2026-01-05' }),
        makeTask({ id: 't-far', projectId: 'slipped', dueDate: '2027-06-01' }),
        // Done work and work far beyond the window do not bring a project back.
        makeTask({ id: 't-done', projectId: 'finished', dueDate: '2026-11-05', status: 'done' }),
        makeTask({ id: 't-later', projectId: 'idle', dueDate: '2027-03-01' }),
      ],
    })
    const result = miniTimeline(data, projects, timelineWindow(TODAY, 1))
    expect(result.rows.map((row) => row.project.id)).toEqual(['slipped'])
    // The bar follows the work that is still open, and says so for assistive technology.
    expect(result.rows[0].span).toEqual({ start: '2026-11-04', end: '2026-11-06' })
    expect(result.rows[0].placed).not.toBeNull()
    expect(result.idle).toBe(2)
  })

  it('keeps the project’s own dates when they reach into the window', () => {
    const projects = [
      makeProject({ id: 'a', sortOrder: 'a0', startDate: '2026-10-01', dueDate: '2026-11-10' }),
    ]
    const data = makeWorkspace({
      projects,
      tasks: [makeTask({ projectId: 'a', dueDate: '2026-12-01' })],
    })
    const result = miniTimeline(data, projects, timelineWindow(TODAY, 1))
    expect(result.rows[0].span).toEqual({ start: '2026-10-01', end: '2026-11-10' })
  })

  it('caps the rows and counts the rest', () => {
    const projects = ['a', 'b', 'c'].map((id, index) =>
      makeProject({ id, sortOrder: `a${index}`, dueDate: '2026-11-10' }),
    )
    const result = miniTimeline(makeWorkspace({ projects }), projects, timelineWindow(TODAY, 1), 2)
    expect(result.rows.map((row) => row.project.id)).toEqual(['a', 'b'])
    expect(result.more).toBe(1)
    expect(result.idle).toBe(0)
  })
})
