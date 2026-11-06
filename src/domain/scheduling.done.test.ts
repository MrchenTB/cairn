import { describe, expect, it } from 'vitest'
import {
  computeAutoSchedule,
  computeAutoScheduleDetailed,
  findConflicts,
  findHistoricalInconsistencies,
} from './scheduling'
import { makeDependency, makeTask, seededRandom } from './testFactories'
import type { Dependency, ISODate, ScheduleChange, Task, TaskStatus } from './types'

/**
 * Completed tasks are history: Auto-schedule and "Resolve all" never rewrite their dates, a
 * conflict whose successor is already done is a historical inconsistency (kept visible, not
 * auto-fixable), and every other conflict is still resolved as before.
 */
const PROJECT = 'p1'
type Spec = [start: ISODate | null, due: ISODate | null, status?: TaskStatus]

function tasksOf(spec: Record<string, Spec>): Record<string, Task> {
  return Object.fromEntries(
    Object.entries(spec).map(([id, [startDate, dueDate, status = 'todo']]) => [
      id,
      makeTask({ projectId: PROJECT, id, title: id, startDate, dueDate, status }),
    ]),
  )
}
const deps = (...pairs: Array<[string, string]>): Dependency[] =>
  pairs.map(([predecessorId, successorId]) =>
    makeDependency({ projectId: PROJECT, predecessorId, successorId }),
  )
const change = (
  taskId: string,
  startDate: ISODate | null,
  dueDate: ISODate | null,
): ScheduleChange => ({
  taskId,
  startDate,
  dueDate,
})

describe('conflicts: active vs historical', () => {
  // A (todo) 2–6 → B starts 4: B starts before A finishes.
  const spec = (successorStatus: TaskStatus, predecessorStatus: TaskStatus = 'todo') =>
    tasksOf({
      A: ['2026-11-02', '2026-11-06', predecessorStatus],
      B: ['2026-11-04', '2026-11-08', successorStatus],
    })

  it('a successor that is still open is an active conflict, as before', () => {
    for (const status of ['todo', 'in_progress'] as const) {
      expect(findConflicts(spec(status), deps(['A', 'B']))).toHaveLength(1)
      expect(findHistoricalInconsistencies(spec(status), deps(['A', 'B']))).toEqual([])
    }
  })

  it('a done successor is a historical inconsistency, not an active conflict', () => {
    const tasks = spec('done')
    expect(findConflicts(tasks, deps(['A', 'B']))).toEqual([])
    const historical = findHistoricalInconsistencies(tasks, deps(['A', 'B']))
    expect(historical).toHaveLength(1)
    expect(historical[0]).toMatchObject({
      predecessorId: 'A',
      successorId: 'B',
      requiredStart: '2026-11-07',
      actualStart: '2026-11-04',
      shiftDays: 3,
    })
  })

  it('both done: historical; a done predecessor with an open successor: still active', () => {
    expect(findConflicts(spec('done', 'done'), deps(['A', 'B']))).toEqual([])
    expect(findHistoricalInconsistencies(spec('done', 'done'), deps(['A', 'B']))).toHaveLength(1)
    expect(findConflicts(spec('todo', 'done'), deps(['A', 'B']))).toHaveLength(1)
  })

  it('no conflict is lost: active + historical = every violated dependency', () => {
    const random = seededRandom(7)
    for (let round = 0; round < 50; round++) {
      const ids = Array.from({ length: 8 }, (_, i) => `T${i}`)
      const tasks = Object.fromEntries(
        ids.map((id) => {
          const start = Math.floor(random() * 20) + 1
          const status = (['todo', 'in_progress', 'done'] as const)[Math.floor(random() * 3)]
          return [
            id,
            makeTask({
              projectId: PROJECT,
              id,
              status,
              startDate: `2026-11-${String(start).padStart(2, '0')}`,
              dueDate: `2026-11-${String(start + Math.floor(random() * 5)).padStart(2, '0')}`,
            }),
          ]
        }),
      )
      const dependencies = deps(
        ...ids
          .slice(1)
          .map((id, i) => [ids[Math.floor(random() * (i + 1))], id] as [string, string]),
      )
      const active = findConflicts(tasks, dependencies).map((c) => c.dependencyId)
      const historical = findHistoricalInconsistencies(tasks, dependencies).map(
        (c) => c.dependencyId,
      )
      expect(new Set([...active, ...historical]).size).toBe(active.length + historical.length)
      for (const c of findHistoricalInconsistencies(tasks, dependencies)) {
        expect(tasks[c.successorId].status).toBe('done')
      }
      for (const c of findConflicts(tasks, dependencies)) {
        expect(tasks[c.successorId].status).not.toBe('done')
      }
    }
  })
})

describe('Auto-schedule never moves a completed task', () => {
  const chain = () =>
    tasksOf({
      A: ['2026-11-02', '2026-11-04'],
      B: ['2026-11-05', '2026-11-06', 'done'],
      C: ['2026-11-07', '2026-11-09'],
    })

  it('the user’s edit pushes past a done successor: it stays, and is reported as not moved', () => {
    const result = computeAutoScheduleDetailed(chain(), deps(['A', 'B'], ['B', 'C']), [
      change('A', '2026-11-04', '2026-11-06'),
    ])
    expect(result.shifts).toEqual([]) // B is done; C is judged against B's unchanged finish
    expect(result.blocked).toEqual([
      {
        taskId: 'B',
        from: { startDate: '2026-11-05', dueDate: '2026-11-06' },
        to: { startDate: '2026-11-07', dueDate: '2026-11-08' },
        deltaDays: 2,
      },
    ])
    expect(
      computeAutoSchedule(chain(), deps(['A', 'B'], ['B', 'C']), [
        change('A', '2026-11-04', '2026-11-06'),
      ]),
    ).toEqual([])
  })

  it('a done task in the middle does not drag its successors along (no unreachable schedule)', () => {
    const { shifts } = computeAutoScheduleDetailed(chain(), deps(['A', 'B'], ['B', 'C']), [
      change('A', '2026-11-20', '2026-11-25'),
    ])
    // C only ever follows B's real finish (Nov 6), which it already clears.
    expect(shifts).toEqual([])
  })

  it('open tasks around a done one are still scheduled normally', () => {
    const tasks = tasksOf({
      A: ['2026-11-02', '2026-11-04'],
      B: ['2026-11-05', '2026-11-06', 'done'],
      C: ['2026-11-07', '2026-11-09'],
      D: ['2026-11-05', '2026-11-06'], // second successor of A, still open
    })
    const { shifts, blocked } = computeAutoScheduleDetailed(
      tasks,
      deps(['A', 'B'], ['B', 'C'], ['A', 'D']),
      [change('A', '2026-11-04', '2026-11-06')],
    )
    expect(shifts.map((s) => s.taskId)).toEqual(['D'])
    expect(blocked.map((s) => s.taskId)).toEqual(['B'])
  })

  it('a done predecessor still pushes an open successor that starts too early (resolve all)', () => {
    const tasks = tasksOf({
      A: ['2026-11-02', '2026-11-06', 'done'],
      B: ['2026-11-04', '2026-11-08'],
    })
    const { shifts, blocked } = computeAutoScheduleDetailed(tasks, deps(['A', 'B']), [])
    expect(shifts).toEqual([
      {
        taskId: 'B',
        from: { startDate: '2026-11-04', dueDate: '2026-11-08' },
        to: { startDate: '2026-11-07', dueDate: '2026-11-11' },
        deltaDays: 3,
      },
    ])
    expect(blocked).toEqual([])
  })

  it('resolve all leaves a done successor alone and says so; nothing is written for it', () => {
    const tasks = tasksOf({
      A: ['2026-11-02', '2026-11-06'],
      B: ['2026-11-03', '2026-11-05', 'done'], // a historical inconsistency
      C: ['2026-11-04', '2026-11-09'], // a real conflict with A
    })
    const dependencies = deps(['A', 'B'], ['A', 'C'])
    const { shifts, blocked } = computeAutoScheduleDetailed(tasks, dependencies, [])
    expect(shifts.map((s) => s.taskId)).toEqual(['C'])
    expect(blocked.map((s) => s.taskId)).toEqual(['B'])
    expect(findConflicts(tasks, dependencies).map((c) => c.successorId)).toEqual(['C'])
  })

  it('the done task the user edits themselves moves (an explicit edit is not an auto change)', () => {
    const tasks = chain()
    const { shifts, blocked } = computeAutoScheduleDetailed(tasks, deps(['A', 'B'], ['B', 'C']), [
      change('B', '2026-11-10', '2026-11-12'),
    ])
    expect(blocked).toEqual([])
    expect(shifts.map((s) => s.taskId)).toEqual(['C']) // C is open and now collides with B
  })

  it('applying the shifts leaves no active conflict and never touches a done task (property)', () => {
    const random = seededRandom(11)
    for (let round = 0; round < 120; round++) {
      const n = 3 + Math.floor(random() * 6)
      const ids = Array.from({ length: n }, (_, i) => `T${i}`)
      const spec: Record<string, Spec> = {}
      for (const id of ids) {
        const start = 1 + Math.floor(random() * 20)
        const due = start + Math.floor(random() * 5)
        const day = (d: number) => `2026-11-${String(d).padStart(2, '0')}` as ISODate
        spec[id] = [day(start), day(due), random() < 0.35 ? 'done' : 'todo']
      }
      const tasks = tasksOf(spec)
      const dependencies = deps(
        ...ids
          .slice(1)
          .map((id, i) => [ids[Math.floor(random() * (i + 1))], id] as [string, string]),
      )
      const { shifts, blocked } = computeAutoScheduleDetailed(tasks, dependencies, [])
      for (const shift of shifts) expect(tasks[shift.taskId].status).not.toBe('done')
      for (const shift of blocked) expect(tasks[shift.taskId].status).toBe('done')
      // Apply the plan: every conflict that remains involves a done successor (history), never an
      // open one — "Resolve all" fully resolves what it is allowed to touch.
      const after = { ...tasks }
      for (const s of shifts) after[s.taskId] = { ...after[s.taskId], ...s.to }
      for (const id of ids) {
        if (tasks[id].status === 'done') {
          expect(after[id].startDate).toBe(tasks[id].startDate)
          expect(after[id].dueDate).toBe(tasks[id].dueDate)
        }
      }
      expect(findConflicts(after, dependencies)).toEqual([])
    }
  })
})
