import { describe, expect, it } from 'vitest'
import { myTasks } from '@/domain/buckets'
import { makeProject, makeTask, makeWorkspace } from '@/domain/testFactories'
import { groupAllTasks, myTasksCounts, parseMyTasksTab, staysInList } from './myTasksModel'

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
      all: 5,
      done: 1,
    })
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
