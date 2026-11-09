import { describe, expect, it } from 'vitest'
import {
  bucketPopulation,
  dueBucket,
  isOpenTask,
  isScheduledToday,
  myTasks,
  overviewMetrics,
  UPCOMING_WINDOW_DAYS,
} from './buckets'
import { addDays } from './dates'
import { buildProjectOutline } from './hierarchy'
import { keyForPlacement } from './ordering'
import { progressByProject } from './progress'
import { makeProject, makeTask, makeWorkspace } from './testFactories'
import type { Task } from './types'

const today = '2026-11-02'

describe('dueBucket', () => {
  const open = (dueDate: string | null) => ({ status: 'todo' as const, dueDate })

  it('isOpenTask', () => {
    expect(isOpenTask({ status: 'todo' })).toBe(true)
    expect(isOpenTask({ status: 'in_progress' })).toBe(true)
    expect(isOpenTask({ status: 'done' })).toBe(false)
  })

  it('classifies around today and the window edges', () => {
    expect(UPCOMING_WINDOW_DAYS).toBe(7)
    expect(dueBucket(open('2026-10-01'), today)).toBe('overdue')
    expect(dueBucket(open('2026-11-01'), today)).toBe('overdue')
    expect(dueBucket(open('2026-11-02'), today)).toBe('today')
    expect(dueBucket(open('2026-11-03'), today)).toBe('upcoming')
    expect(dueBucket(open('2026-11-09'), today)).toBe('upcoming') // today + 7
    expect(dueBucket(open('2026-11-10'), today)).toBe('later') // today + 8
    expect(dueBucket(open(null), today)).toBe('no_date')
  })

  it('done tasks are never overdue', () => {
    expect(dueBucket({ status: 'done', dueDate: '2020-01-01' }, today)).toBe('done')
    expect(dueBucket({ status: 'done', dueDate: null }, today)).toBe('done')
    expect(dueBucket({ status: 'in_progress', dueDate: '2026-11-01' }, today)).toBe('overdue')
  })

  it('crosses month, year and leap-day boundaries', () => {
    expect(dueBucket(open('2027-01-04'), '2026-12-28')).toBe('upcoming')
    expect(dueBucket(open('2027-01-05'), '2026-12-28')).toBe('later')
    expect(dueBucket(open('2026-12-31'), '2027-01-01')).toBe('overdue')
    expect(dueBucket(open('2024-03-03'), '2024-02-25')).toBe('upcoming')
    expect(dueBucket(open('2024-03-04'), '2024-02-25')).toBe('later')
    expect(dueBucket(open('2024-02-29'), '2024-02-28')).toBe('upcoming')
  })

  it('accepts a custom window', () => {
    expect(dueBucket(open('2026-11-03'), today, 0)).toBe('later')
    expect(dueBucket(open('2026-11-16'), today, 14)).toBe('upcoming')
  })
})

describe('myTasks / overviewMetrics', () => {
  const research = makeProject({ id: 'research', sortOrder: 'a1' })
  const community = makeProject({ id: 'community', sortOrder: 'a2' })
  const finished = makeProject({ id: 'finished', sortOrder: 'a3', status: 'completed' })
  const archived = makeProject({ id: 'archived', sortOrder: 'a0', status: 'archived' })

  const t = (id: string, overrides: Partial<Task> & Pick<Task, 'projectId'>) =>
    makeTask({ id, title: id, ...overrides })

  const tasks = [
    // today
    t('today-low', { projectId: 'research', dueDate: today, priority: 'low', sortOrder: 'a1' }),
    t('today-urgent', { projectId: 'community', dueDate: today, priority: 'urgent' }),
    t('today-high-community', { projectId: 'community', dueDate: today, priority: 'high' }),
    t('today-high-research', { projectId: 'research', dueDate: today, priority: 'high' }),
    // upcoming (tomorrow .. today+7)
    t('up-edge', { projectId: 'research', dueDate: '2026-11-09' }),
    t('up-tomorrow', { projectId: 'finished', dueDate: '2026-11-03' }),
    // overdue
    t('overdue-old', { projectId: 'research', dueDate: '2026-10-01', status: 'in_progress' }),
    t('overdue-new', { projectId: 'research', dueDate: '2026-11-01' }),
    // later / no date
    t('later', { projectId: 'research', dueDate: '2026-11-10' }),
    t('no-date', { projectId: 'research' }),
    // subtasks count too (ordered after their parent on ties)
    t('parent', { projectId: 'research', dueDate: '2026-11-05', sortOrder: 'a5' }),
    t('sub', {
      projectId: 'research',
      parentTaskId: 'parent',
      dueDate: '2026-11-05',
      sortOrder: 'a0',
    }),
    t('sibling-before-parent', { projectId: 'research', dueDate: '2026-11-05', sortOrder: 'a4' }),
    // done
    t('done-recent', {
      projectId: 'research',
      status: 'done',
      dueDate: '2026-10-01',
      completedAt: '2026-11-02T08:00:00.000Z',
    }),
    t('done-older', {
      projectId: 'community',
      status: 'done',
      completedAt: '2026-11-01T08:00:00+08:00',
    }),
    t('done-unknown', { projectId: 'community', status: 'done', completedAt: null }),
    // excluded: archived project, missing project
    t('archived-overdue', { projectId: 'archived', dueDate: '2026-10-01' }),
    t('no-project', { projectId: 'deleted', dueDate: today }),
  ]
  const data = makeWorkspace({ projects: [research, community, finished, archived], tasks })

  it('population excludes archived and missing projects but keeps subtasks', () => {
    const population = bucketPopulation(data).map((task) => task.id)
    expect(population).toContain('sub')
    expect(population).toContain('up-tomorrow') // completed (not archived) project
    expect(population).not.toContain('archived-overdue')
    expect(population).not.toContain('no-project')
  })

  it('sorts today by priority, then project order', () => {
    expect(myTasks(data, today).today.map((task) => task.id)).toEqual([
      'today-urgent',
      'today-high-research',
      'today-high-community',
      'today-low',
    ])
  })

  it('sorts upcoming and overdue by due date and keeps subtasks after their parent', () => {
    const buckets = myTasks(data, today)
    expect(buckets.upcoming.map((task) => task.id)).toEqual([
      'up-tomorrow',
      'sibling-before-parent',
      'parent',
      'sub',
      'up-edge',
    ])
    expect(buckets.overdue.map((task) => task.id)).toEqual(['overdue-old', 'overdue-new'])
  })

  it('all = open by due date (no date last), then done by completion (recent first)', () => {
    const all = myTasks(data, today).all.map((task) => task.id)
    expect(all).toEqual([
      'overdue-old',
      'overdue-new',
      'today-urgent',
      'today-high-research',
      'today-high-community',
      'today-low',
      'up-tomorrow',
      'sibling-before-parent',
      'parent',
      'sub',
      'up-edge',
      'later',
      'no-date',
      'done-recent',
      'done-older',
      'done-unknown',
    ])
  })

  it('overview metrics agree with My Tasks', () => {
    const buckets = myTasks(data, today)
    const metrics = overviewMetrics(data, today)
    expect(metrics).toEqual({ activeProjects: 2, openTasks: 13, dueSoon: 9, overdue: 2 })
    expect(metrics.dueSoon).toBe(buckets.today.length + buckets.upcoming.length)
    expect(metrics.overdue).toBe(buckets.overdue.length)
    expect(metrics.openTasks).toBe(buckets.all.filter(isOpenTask).length)
  })

  it('computes My Tasks, Overview, progress, outlines and placements for 5,000 tasks quickly', () => {
    const projects = Array.from({ length: 10 }, (_, i) =>
      makeProject({ id: `p${i}`, sortOrder: `a${i}` }),
    )
    const many: Task[] = []
    for (let i = 0; i < 5_000; i++) {
      const parent = i % 5 === 0 ? null : many[i - (i % 5)] // four subtasks per parent
      many.push(
        makeTask({
          id: `t${i}`,
          projectId: parent?.projectId ?? `p${i % 10}`,
          parentTaskId: parent?.id ?? null,
          dueDate: i % 7 === 0 ? null : addDays(today, (i % 40) - 20),
          status: i % 3 === 0 ? 'done' : 'todo',
          sortOrder: `a${i}`,
        }),
      )
    }
    const big = makeWorkspace({ projects, tasks: many })
    const started = performance.now()
    const buckets = myTasks(big, today)
    const metrics = overviewMetrics(big, today)
    const progress = progressByProject(big)
    for (const project of projects) buildProjectOutline(project, [], many, [])
    keyForPlacement(many, { afterId: 't2500' })
    expect(performance.now() - started).toBeLessThan(500)
    expect(buckets.all).toHaveLength(5_000)
    expect(metrics.overdue).toBe(buckets.overdue.length)
    expect(Object.keys(progress)).toHaveLength(10)
  })

  it('handles an empty workspace', () => {
    const empty = makeWorkspace({})
    expect(myTasks(empty, today)).toEqual({
      today: [],
      scheduledToday: [],
      upcoming: [],
      overdue: [],
      all: [],
    })
    expect(overviewMetrics(empty, today)).toEqual({
      activeProjects: 0,
      openTasks: 0,
      dueSoon: 0,
      overdue: 0,
    })
  })
})

describe('scheduled today', () => {
  const now = '2026-11-09'
  const open = (startDate: string | null, dueDate: string | null) => ({
    status: 'todo' as const,
    startDate,
    dueDate,
  })

  describe('isScheduledToday', () => {
    it('needs both dates, start <= today < due, both ends inclusive', () => {
      expect(isScheduledToday(open('2026-11-07', '2026-11-14'), now)).toBe(true)
      expect(isScheduledToday(open('2026-11-09', '2026-11-14'), now)).toBe(true) // starts today
      expect(isScheduledToday(open('2026-11-08', '2026-11-10'), now)).toBe(true) // due tomorrow
    })

    it('leaves out due today (that is the due bucket), overdue, future start and missing dates', () => {
      expect(isScheduledToday(open('2026-11-09', '2026-11-09'), now)).toBe(false)
      expect(isScheduledToday(open('2026-11-01', '2026-11-09'), now)).toBe(false)
      expect(isScheduledToday(open('2026-11-01', '2026-11-08'), now)).toBe(false)
      expect(isScheduledToday(open('2026-11-10', '2026-11-14'), now)).toBe(false)
      expect(isScheduledToday(open('2026-11-01', null), now)).toBe(false)
      expect(isScheduledToday(open(null, '2026-11-14'), now)).toBe(false)
      expect(isScheduledToday(open(null, null), now)).toBe(false)
    })

    it('is for open tasks only', () => {
      const span = { startDate: '2026-11-07', dueDate: '2026-11-14' }
      expect(isScheduledToday({ status: 'in_progress', ...span }, now)).toBe(true)
      expect(isScheduledToday({ status: 'done', ...span }, now)).toBe(false)
    })

    it('crosses month and year boundaries', () => {
      expect(isScheduledToday(open('2026-10-28', '2026-11-03'), '2026-11-01')).toBe(true)
      expect(isScheduledToday(open('2026-12-30', '2027-01-02'), '2026-12-31')).toBe(true)
      expect(isScheduledToday(open('2026-12-30', '2027-01-02'), '2027-01-01')).toBe(true)
      expect(isScheduledToday(open('2026-12-30', '2027-01-02'), '2027-01-02')).toBe(false)
      expect(isScheduledToday(open('2026-12-30', '2027-01-02'), '2026-12-29')).toBe(false)
    })
  })

  describe('myTasks().scheduledToday', () => {
    const proj = makeProject({ id: 'p', sortOrder: 'a1' })
    const other = makeProject({ id: 'q', sortOrder: 'a2' })
    const old = makeProject({ id: 'old', sortOrder: 'a0', status: 'archived' })
    const t = (id: string, overrides: Partial<Task> = {}) =>
      makeTask({ id, title: id, projectId: 'p', ...overrides })
    const build = (tasks: Task[], when = now) =>
      myTasks(makeWorkspace({ projects: [old, proj, other], tasks }), when)
    const ids = (list: Task[]) => list.map((task) => task.id)

    it('puts each case in the right lists', () => {
      const buckets = build([
        t('span', { startDate: '2026-11-07', dueDate: '2026-11-14' }),
        t('one-day', { startDate: now, dueDate: now, sortOrder: 'a1' }),
        t('due-only', { dueDate: now, sortOrder: 'a2' }),
        t('start-only', { startDate: '2026-11-01' }),
        t('no-dates'),
        t('overdue', { startDate: '2026-11-01', dueDate: '2026-11-08' }),
        t('future', { startDate: '2026-11-10', dueDate: '2026-11-15' }),
        t('done', { startDate: '2026-11-07', dueDate: '2026-11-14', status: 'done' }),
        t('archived', { projectId: 'old', startDate: '2026-11-07', dueDate: '2026-11-14' }),
        t('gone', { projectId: 'deleted', startDate: '2026-11-07', dueDate: '2026-11-14' }),
      ])
      expect(ids(buckets.scheduledToday)).toEqual(['span'])
      expect(ids(buckets.today)).toEqual(['one-day', 'due-only'])
      expect(ids(buckets.overdue)).toEqual(['overdue'])
      expect(ids(buckets.upcoming)).toEqual(['span', 'future']) // still by due date
    })

    it('judges a subtask by its own dates, not its parent’s', () => {
      const span = { startDate: '2026-11-07', dueDate: '2026-11-14' }
      const buckets = build([
        t('parent-scheduled', { ...span, sortOrder: 'a1' }),
        t('sub-plain', { parentTaskId: 'parent-scheduled', dueDate: '2026-11-20' }),
        t('parent-plain', { dueDate: '2026-11-20', sortOrder: 'a2' }),
        t('sub-scheduled', { parentTaskId: 'parent-plain', ...span }),
      ])
      expect(ids(buckets.scheduledToday)).toEqual(['parent-scheduled', 'sub-scheduled'])
    })

    it('handles a span across a month and across a year', () => {
      const crossMonth = [t('m', { startDate: '2026-10-28', dueDate: '2026-11-03' })]
      expect(ids(build(crossMonth, '2026-11-01').scheduledToday)).toEqual(['m'])
      const crossYear = [t('y', { startDate: '2026-12-30', dueDate: '2027-01-02' })]
      expect(ids(build(crossYear, '2026-12-31').scheduledToday)).toEqual(['y'])
      expect(ids(build(crossYear, '2027-01-01').scheduledToday)).toEqual(['y'])
      expect(ids(build(crossYear, '2027-01-02').scheduledToday)).toEqual([])
      expect(ids(build(crossYear, '2027-01-02').today)).toEqual(['y'])
    })

    it('is disjoint from today, and a task is in at most one of today / scheduledToday', () => {
      const buckets = build([
        t('a', { startDate: '2026-11-01', dueDate: now, sortOrder: 'a1' }),
        t('b', { startDate: '2026-11-01', dueDate: '2026-11-10' }),
        t('c', { dueDate: now, sortOrder: 'a2' }),
        t('d', { startDate: now, dueDate: now, sortOrder: 'a3' }),
      ])
      const dueToday = new Set(ids(buckets.today))
      expect(ids(buckets.scheduledToday).filter((id) => dueToday.has(id))).toEqual([])
      expect(ids(buckets.today)).toEqual(['a', 'c', 'd'])
      expect(ids(buckets.scheduledToday)).toEqual(['b'])
    })

    it('sorts like the other lists: due date, priority, project order, outline position', () => {
      const span = { startDate: '2026-11-01' }
      const buckets = build([
        t('late', { ...span, dueDate: '2026-11-20' }),
        t('soon-low', { ...span, dueDate: '2026-11-12', priority: 'low', sortOrder: 'a0' }),
        t('soon-urgent', { ...span, dueDate: '2026-11-12', priority: 'urgent' }),
        t('soon-q', { projectId: 'q', ...span, dueDate: '2026-11-12', priority: 'low' }),
        t('soon-p2', { ...span, dueDate: '2026-11-12', priority: 'low', sortOrder: 'a2' }),
        t('soon-p1', { ...span, dueDate: '2026-11-12', priority: 'low', sortOrder: 'a1' }),
      ])
      expect(ids(buckets.scheduledToday)).toEqual([
        'soon-urgent',
        'soon-low',
        'soon-p1',
        'soon-p2',
        'soon-q',
        'late',
      ])
    })

    it('does not change overview metrics (Due soon stays due-date based)', () => {
      const withSpan = makeWorkspace({
        projects: [proj],
        tasks: [
          t('span', { startDate: '2026-11-07', dueDate: '2026-12-31' }), // far due: later
          t('due', { dueDate: now }),
        ],
      })
      expect(myTasks(withSpan, now).scheduledToday.map((task) => task.id)).toEqual(['span'])
      expect(overviewMetrics(withSpan, now)).toEqual({
        activeProjects: 1,
        openTasks: 2,
        dueSoon: 1,
        overdue: 0,
      })
      expect(dueBucket({ status: 'todo', dueDate: '2026-12-31' }, now)).toBe('later')
    })
  })
})
