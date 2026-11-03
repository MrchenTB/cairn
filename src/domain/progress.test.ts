import { describe, expect, it } from 'vitest'
import { computeProgress, progressByProject, projectProgress } from './progress'
import { makeMilestone, makeProject, makeTask, makeWorkspace } from './testFactories'
import type { Task } from './types'

const projectId = 'p1'
const task = (overrides: Partial<Task> = {}) => makeTask({ projectId, ...overrides })
const tasksWithDone = (total: number, done: number) =>
  Array.from({ length: total }, (_, i) => task({ status: i < done ? 'done' : 'todo' }))

describe('computeProgress', () => {
  it('reports "No tasks" (null) instead of a fake 100%', () => {
    expect(computeProgress([])).toEqual({ total: 0, done: 0, ratio: null, percent: null })
  })

  it('counts leaf tasks only; parents are never counted', () => {
    const parent = task({ id: 'parent', status: 'done' })
    const tasks = [
      parent,
      task({ parentTaskId: 'parent', status: 'done' }),
      task({ parentTaskId: 'parent', status: 'in_progress' }),
      task({ status: 'done' }),
      task({ status: 'todo' }),
    ]
    // Leaves: 2 subtasks + 2 top-level tasks; the done parent is ignored.
    expect(computeProgress(tasks)).toEqual({ total: 4, done: 2, ratio: 0.5, percent: 50 })
  })

  it('a parent whose subtasks are all done does not add itself', () => {
    const tasks = [
      task({ id: 'p', status: 'todo' }),
      task({ parentTaskId: 'p', status: 'done' }),
      task({ parentTaskId: 'p', status: 'done' }),
    ]
    expect(computeProgress(tasks)).toMatchObject({ total: 2, done: 2, percent: 100 })
  })

  it('treats in_progress as not done', () => {
    expect(computeProgress([task({ status: 'in_progress' })])).toMatchObject({
      total: 1,
      done: 0,
      ratio: 0,
      percent: 0,
    })
  })

  it('rounds the percentage down', () => {
    expect(computeProgress(tasksWithDone(3, 1)).percent).toBe(33)
    expect(computeProgress(tasksWithDone(3, 2)).percent).toBe(66)
    expect(computeProgress(tasksWithDone(200, 199)).percent).toBe(99) // 99.5% is not done
    expect(computeProgress(tasksWithDone(250, 249)).percent).toBe(99) // 99.6%
    expect(computeProgress(tasksWithDone(4, 4)).percent).toBe(100)
  })

  it('avoids floating-point traps (29/100 must be 29, not 28)', () => {
    for (const done of [29, 57, 58, 99]) {
      expect(computeProgress(tasksWithDone(100, done)).percent).toBe(done)
    }
    expect(computeProgress(tasksWithDone(100, 29)).ratio).toBeCloseTo(0.29)
  })

  it('counts a subtask whose parent is missing as a leaf', () => {
    expect(computeProgress([task({ parentTaskId: 'gone', status: 'done' })])).toMatchObject({
      total: 1,
      done: 1,
    })
  })
})

describe('projectProgress / progressByProject', () => {
  const p1 = makeProject({ id: 'p1' })
  const p2 = makeProject({ id: 'p2' })
  const empty = makeProject({ id: 'empty', status: 'archived' })
  const data = makeWorkspace({
    projects: [p1, p2, empty],
    tasks: [
      makeTask({ projectId: 'p1', id: 'parent' }),
      makeTask({ projectId: 'p1', parentTaskId: 'parent', status: 'done' }),
      makeTask({ projectId: 'p1', parentTaskId: 'parent' }),
      makeTask({ projectId: 'p1', status: 'done' }),
      makeTask({ projectId: 'p2', status: 'done' }),
      makeTask({ projectId: 'orphan-project', status: 'done' }),
    ],
    milestones: [makeMilestone({ projectId: 'p1', date: '2026-11-02' })],
  })

  it('filters by project; milestones never count', () => {
    expect(projectProgress(data, 'p1')).toEqual({
      total: 3,
      done: 2,
      ratio: 2 / 3,
      percent: 66,
    })
    expect(projectProgress(data, 'p2')).toMatchObject({ total: 1, done: 1, percent: 100 })
    expect(projectProgress(data, 'missing')).toMatchObject({ total: 0, percent: null })
  })

  it('covers every project and matches projectProgress', () => {
    const all = progressByProject(data)
    expect(Object.keys(all).sort()).toEqual(['empty', 'p1', 'p2'])
    for (const id of Object.keys(all)) expect(all[id]).toEqual(projectProgress(data, id))
    expect(all.empty).toEqual({ total: 0, done: 0, ratio: null, percent: null })
  })
})
