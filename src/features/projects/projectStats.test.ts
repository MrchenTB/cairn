import { describe, expect, it } from 'vitest'
import {
  makeMilestone,
  makePhase,
  makeProject,
  makeTask,
  makeWorkspace,
} from '@/domain/testFactories'
import {
  deleteProjectDescription,
  listJoin,
  plural,
  projectContents,
  taskCountsByProject,
} from './projectStats'

describe('taskCountsByProject', () => {
  it('counts tasks of any level, open = not done', () => {
    const p1 = makeProject({ id: 'p1' })
    const p2 = makeProject({ id: 'p2' })
    const parent = makeTask({ id: 'parent', projectId: 'p1', status: 'in_progress' })
    const data = makeWorkspace({
      projects: [p1, p2],
      tasks: [
        parent,
        makeTask({ projectId: 'p1', parentTaskId: 'parent', status: 'done' }),
        makeTask({ projectId: 'p1', parentTaskId: 'parent' }),
        makeTask({ projectId: 'p1', status: 'done' }),
        makeTask({ projectId: 'ghost' }),
      ],
    })
    expect(taskCountsByProject(data)).toEqual({ p1: { open: 2, total: 4 }, p2: { open: 0, total: 0 } })
  })
})

describe('projectContents / delete copy', () => {
  it('states exactly what goes with the project', () => {
    const data = makeWorkspace({
      projects: [makeProject({ id: 'p1' }), makeProject({ id: 'p2' })],
      phases: [makePhase({ projectId: 'p1' })],
      tasks: [
        makeTask({ id: 't1', projectId: 'p1' }),
        makeTask({ projectId: 'p1', parentTaskId: 't1' }),
        makeTask({ projectId: 'p2' }),
      ],
      milestones: [
        makeMilestone({ projectId: 'p1', date: '2026-11-20' }),
        makeMilestone({ projectId: 'p1', date: '2026-12-01' }),
      ],
    })
    const contents = projectContents(data, 'p1')
    expect(contents).toEqual({ tasks: 2, phases: 1, milestones: 2 })
    expect(deleteProjectDescription(contents)).toBe(
      'Deletes 2 tasks, 1 phase and 2 milestones along with the project. This can’t be undone.',
    )
  })

  it('pluralises and joins English lists', () => {
    expect(plural(0, 'phase')).toBe('0 phases')
    expect(plural(1, 'dependency', 'dependencies')).toBe('1 dependency')
    expect(plural(1200, 'task')).toBe('1,200 tasks')
    expect(listJoin(['a'])).toBe('a')
    expect(listJoin(['a', 'b'])).toBe('a and b')
    expect(listJoin(['a', 'b', 'c'])).toBe('a, b and c')
  })
})
