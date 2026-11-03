import { describe, expect, it } from 'vitest'
import { addDays, diffDays, tryToEpochDay } from './dates'
import { stronglyConnectedComponents } from './graph'
import {
  computeAutoSchedule,
  earliestFinish,
  findConflicts,
  latestStart,
  rollupRange,
  taskSpan,
  toScheduleChanges,
  validateNewDependency,
  wouldCreateCycle,
  type ScheduleShift,
} from './scheduling'
import { makeDependency, makeTask, seededRandom } from './testFactories'
import type { Dependency, ISODate, ScheduleChange, Task } from './types'

const PROJECT = 'p1'
type Dates = [start: ISODate | null, due: ISODate | null]

function tasksOf(spec: Record<string, Dates>): Record<string, Task> {
  return Object.fromEntries(
    Object.entries(spec).map(([id, [startDate, dueDate]]) => [
      id,
      makeTask({ projectId: PROJECT, id, title: id, startDate, dueDate }),
    ]),
  )
}

function deps(...pairs: Array<[string, string]>): Dependency[] {
  return pairs.map(([predecessorId, successorId]) =>
    makeDependency({ projectId: PROJECT, predecessorId, successorId }),
  )
}

function change(
  taskId: string,
  startDate: ISODate | null,
  dueDate: ISODate | null,
): ScheduleChange {
  return { taskId, startDate, dueDate }
}

/** The tasks after the user's changes and the computed shifts are written. */
function applyAll(
  tasks: Record<string, Task>,
  changes: readonly ScheduleChange[],
  shifts: readonly ScheduleShift[],
): Record<string, Task> {
  const next = { ...tasks }
  for (const c of changes) {
    if (next[c.taskId])
      next[c.taskId] = { ...next[c.taskId], startDate: c.startDate, dueDate: c.dueDate }
  }
  for (const s of shifts) next[s.taskId] = { ...next[s.taskId], ...s.to }
  return next
}

const summary = (shifts: readonly ScheduleShift[]) =>
  shifts.map((s) => [s.taskId, s.to.startDate, s.to.dueDate, s.deltaDays])

type DatedTask = Pick<Task, 'startDate' | 'dueDate'>
/** Finish bound (due ?? start) as an epoch day; null when unscheduled. */
const finishDay = (task: DatedTask) => tryToEpochDay(task.dueDate) ?? tryToEpochDay(task.startDate)
/** Start bound (start ?? due) as an epoch day; null when unscheduled. */
const startDay = (task: DatedTask) => tryToEpochDay(task.startDate) ?? tryToEpochDay(task.dueDate)

function randomDates(random: () => number): Dates {
  const start = addDays('2026-11-01', Math.floor(random() * 30))
  const kind = random()
  if (kind < 0.6) return [start, addDays(start, Math.floor(random() * 5))]
  if (kind < 0.75) return [start, null]
  if (kind < 0.9) return [null, start]
  return [null, null]
}

/** Random project: forward edges (a DAG), plus backward edges with probability `backEdges`. */
function randomProject(random: () => number, size: number, edgeCount: number, backEdges = 0) {
  const ids = Array.from({ length: size }, (_, i) => `T${i}`)
  const tasks = tasksOf(Object.fromEntries(ids.map((id) => [id, randomDates(random)])))
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < edgeCount; i++) {
    const a = Math.floor(random() * size)
    const b = Math.floor(random() * size)
    if (a < b || (a > b && random() < backEdges)) pairs.push([ids[a], ids[b]])
  }
  return { ids, tasks, pairs, dependencies: deps(...pairs) }
}

/** Same-component test for edges, computed independently of the scheduler. */
function cycleEdgeTest(ids: readonly string[], pairs: ReadonlyArray<[string, string]>) {
  const index = new Map(ids.map((id, i) => [id, i]))
  const adjacency: number[][] = ids.map(() => [])
  for (const [from, to] of pairs) adjacency[index.get(from)!].push(index.get(to)!)
  const component = stronglyConnectedComponents(adjacency)
  return (from: string, to: string) => component[index.get(from)!] === component[index.get(to)!]
}

/** Shape rules every shift obeys: later only, same delta for both dates, nulls stay null. */
function expectWellFormedShifts(
  shifts: readonly ScheduleShift[],
  tasks: Record<string, Task>,
  fixed: ReadonlySet<string>,
  pairs: ReadonlyArray<[string, string]>,
  inCycle: (from: string, to: string) => boolean = () => false,
) {
  const seen = new Set<string>()
  for (const shift of shifts) {
    expect(fixed.has(shift.taskId)).toBe(false)
    expect(seen.has(shift.taskId)).toBe(false)
    seen.add(shift.taskId)
    expect(shift.deltaDays).toBeGreaterThanOrEqual(1)
    const { startDate, dueDate } = tasks[shift.taskId]
    expect(shift.from).toEqual({ startDate, dueDate })
    if (startDate) expect(diffDays(startDate, shift.to.startDate as string)).toBe(shift.deltaDays)
    if (dueDate) expect(diffDays(dueDate, shift.to.dueDate as string)).toBe(shift.deltaDays)
    if (!startDate) expect(shift.to.startDate).toBeNull()
    if (!dueDate) expect(shift.to.dueDate).toBeNull()
  }
  // Topological: a shifted task never appears before a shifted predecessor.
  const position = new Map(shifts.map((s, i) => [s.taskId, i]))
  for (const [from, to] of pairs) {
    if (position.has(from) && position.has(to) && !inCycle(from, to)) {
      expect(position.get(from) as number).toBeLessThan(position.get(to) as number)
    }
  }
}

/** A shifted task starts exactly the day after its latest (scheduled) predecessor finishes. */
function expectMinimalShifts(
  shifts: readonly ScheduleShift[],
  after: Record<string, Task>,
  pairs: ReadonlyArray<[string, string]>,
  inCycle: (from: string, to: string) => boolean = () => false,
) {
  for (const shift of shifts) {
    let required = Number.NEGATIVE_INFINITY
    for (const [from, to] of pairs) {
      const finish = finishDay(after[from])
      if (to === shift.taskId && !inCycle(from, to) && finish !== null) {
        required = Math.max(required, finish + 1)
      }
    }
    expect(startDay(after[shift.taskId])).toBe(required)
  }
}

describe('spans and bounds', () => {
  it('taskSpan classifies optional dates', () => {
    expect(taskSpan({ startDate: '2026-11-02', dueDate: '2026-11-04' })).toEqual({
      kind: 'range',
      start: '2026-11-02',
      end: '2026-11-04',
    })
    expect(taskSpan({ startDate: '2026-11-02', dueDate: null })).toEqual({
      kind: 'start_only',
      start: '2026-11-02',
      end: null,
    })
    expect(taskSpan({ startDate: null, dueDate: '2026-11-04' })).toEqual({
      kind: 'due_only',
      start: null,
      end: '2026-11-04',
    })
    expect(taskSpan({ startDate: null, dueDate: null })).toEqual({
      kind: 'unscheduled',
      start: null,
      end: null,
    })
  })

  it('earliestFinish = due ?? start; latestStart = start ?? due', () => {
    const range = { startDate: '2026-11-02', dueDate: '2026-11-04' }
    expect(earliestFinish(range)).toBe('2026-11-04')
    expect(latestStart(range)).toBe('2026-11-02')
    expect(earliestFinish({ startDate: '2026-11-02', dueDate: null })).toBe('2026-11-02')
    expect(latestStart({ startDate: null, dueDate: '2026-11-04' })).toBe('2026-11-04')
    expect(earliestFinish({ startDate: null, dueDate: null })).toBeNull()
    expect(latestStart({ startDate: null, dueDate: null })).toBeNull()
  })

  it('treats impossible or malformed dates as missing (never hands them to the renderer)', () => {
    expect(taskSpan({ startDate: '2026-11-05', dueDate: '2026-02-29' })).toEqual({
      kind: 'start_only',
      start: '2026-11-05',
      end: null,
    })
    expect(taskSpan({ startDate: 'soon', dueDate: '2026-11-07' })).toEqual({
      kind: 'due_only',
      start: null,
      end: '2026-11-07',
    })
    expect(taskSpan({ startDate: '2026-13-01', dueDate: '' })).toEqual({
      kind: 'unscheduled',
      start: null,
      end: null,
    })
    expect(earliestFinish({ startDate: '2026-11-05', dueDate: '2026-02-29' })).toBe('2026-11-05')
    expect(latestStart({ startDate: '2026-04-31', dueDate: '2026-11-07' })).toBe('2026-11-07')
  })
})

describe('findConflicts', () => {
  const check = (pred: Dates, succ: Dates) =>
    findConflicts(tasksOf({ P: pred, S: succ }), deps(['P', 'S']))

  it('flags a successor starting on or before the predecessor finishes', () => {
    const [conflict] = check(['2026-11-01', '2026-11-05'], ['2026-11-05', '2026-11-06'])
    expect(conflict).toMatchObject({
      predecessorId: 'P',
      successorId: 'S',
      requiredStart: '2026-11-06',
      actualStart: '2026-11-05',
      shiftDays: 1,
    })
    expect(check(['2026-11-01', '2026-11-05'], ['2026-11-06', '2026-11-07'])).toEqual([])
    expect(check(['2026-11-01', '2026-11-05'], ['2026-11-02', '2026-11-03'])[0].shiftDays).toBe(4)
  })

  it('uses bounds for partial dates (only certain conflicts)', () => {
    // due-only successor: it starts at the latest on its due date.
    expect(check(['2026-11-01', '2026-11-05'], [null, '2026-11-05'])[0]).toMatchObject({
      requiredStart: '2026-11-06',
      actualStart: '2026-11-05',
      shiftDays: 1,
    })
    expect(check(['2026-11-01', '2026-11-05'], [null, '2026-11-06'])).toEqual([])
    // start-only successor.
    expect(check(['2026-11-01', '2026-11-05'], ['2026-11-03', null])[0].shiftDays).toBe(3)
    // start-only predecessor finishes at the earliest on its start date.
    expect(check(['2026-11-05', null], ['2026-11-05', '2026-11-08'])[0].requiredStart).toBe(
      '2026-11-06',
    )
    expect(check(['2026-11-05', null], ['2026-11-06', '2026-11-08'])).toEqual([])
    // due-only predecessor.
    expect(check([null, '2026-11-05'], ['2026-11-05', null])).toHaveLength(1)
    // unscheduled on either side: nothing is certain.
    expect(check([null, null], ['2026-11-01', '2026-11-02'])).toEqual([])
    expect(check(['2026-11-01', '2026-11-05'], [null, null])).toEqual([])
  })

  it('flags exactly the certain violations for every mix of partial dates (brute-force oracle)', () => {
    type Spec = [start: number | null, due: number | null]
    const specs: Spec[] = [[null, null]]
    for (let a = 0; a < 4; a++) {
      specs.push([a, null], [null, a])
      for (let b = a; b < 4; b++) specs.push([a, b])
    }
    // Every way the missing dates could be filled in, within a window wide enough to reach the
    // extremes (earliest finish, latest start) of every spec above.
    const completions = ([start, due]: Spec): Array<[number, number]> => {
      const out: Array<[number, number]> = []
      for (let s = -6; s <= 9; s++) {
        for (let d = s; d <= 9; d++) {
          if ((start === null || start === s) && (due === null || due === d)) out.push([s, d])
        }
      }
      return out
    }
    const date = (offset: number | null) => (offset === null ? null : addDays('2026-11-01', offset))
    for (const p of specs) {
      for (const s of specs) {
        // FS is violated when S starts on or before P finishes; certain = in every completion.
        const certain = completions(p).every(([, pDue]) =>
          completions(s).every(([sStart]) => sStart <= pDue),
        )
        const tasks = tasksOf({ P: [date(p[0]), date(p[1])], S: [date(s[0]), date(s[1])] })
        expect([p, s, findConflicts(tasks, deps(['P', 'S'])).length]).toEqual([
          p,
          s,
          certain ? 1 : 0,
        ])
      }
    }
  })

  it('computes dates across month and year boundaries', () => {
    expect(check(['2026-11-20', '2026-11-30'], ['2026-11-30', null])[0].requiredStart).toBe(
      '2026-12-01',
    )
    expect(check(['2026-12-01', '2026-12-31'], ['2026-12-20', '2026-12-22'])[0]).toMatchObject({
      requiredStart: '2027-01-01',
      shiftDays: 12,
    })
    expect(check(['2028-02-20', '2028-02-28'], ['2028-02-28', null])[0].requiredStart).toBe(
      '2028-02-29',
    )
  })

  it('accepts arrays, ignores missing tasks and self-dependencies', () => {
    const tasks = tasksOf({ P: ['2026-11-01', '2026-11-05'], S: ['2026-11-03', '2026-11-04'] })
    const list = [tasks.P, tasks.S]
    const dependencies = deps(['P', 'S'], ['P', 'gone'], ['gone', 'S'], ['P', 'P'])
    expect(findConflicts(list, dependencies)).toHaveLength(1)
    expect(findConflicts(tasks, dependencies)).toEqual(findConflicts(list, dependencies))
    expect(findConflicts(tasks, dependencies)[0].dependencyId).toBe(dependencies[0].id)
  })

  it('ignores unparseable dates and dates past the supported range', () => {
    expect(check(['garbage', null], ['2026-11-01', null])).toEqual([])
    expect(check(['9999-12-30', '9999-12-31'], ['9999-12-31', null])).toEqual([])
  })

  it('falls back to the other date when one is unparseable, exactly like auto-schedule', () => {
    // P's due date is impossible, so P finishes no earlier than its start (11-05).
    const tasks = tasksOf({ P: ['2026-11-05', '2026-02-29'], S: ['2026-11-01', '2026-11-02'] })
    const dependencies = deps(['P', 'S'])
    expect(findConflicts(tasks, dependencies)).toMatchObject([
      { requiredStart: '2026-11-06', actualStart: '2026-11-01', shiftDays: 5 },
    ])
    expect(summary(computeAutoSchedule(tasks, dependencies, []))).toEqual([
      ['S', '2026-11-06', '2026-11-07', 5],
    ])
    // S's start is malformed, so S starts no later than its due date (11-03).
    const late = tasksOf({ P: ['2026-11-01', '2026-11-05'], S: ['11/02/2026', '2026-11-03'] })
    expect(findConflicts(late, dependencies)).toMatchObject([{ actualStart: '2026-11-03' }])
  })
})

describe('validateNewDependency / wouldCreateCycle', () => {
  const tasks = {
    ...tasksOf({ A: [null, null], B: [null, null], C: [null, null], D: [null, null] }),
    parent: makeTask({ projectId: PROJECT, id: 'parent' }),
    child: makeTask({ projectId: PROJECT, id: 'child', parentTaskId: 'parent' }),
    sibling: makeTask({ projectId: PROJECT, id: 'sibling', parentTaskId: 'parent' }),
    foreign: makeTask({ projectId: 'p2', id: 'foreign' }),
  }
  const existing = deps(['A', 'B'], ['B', 'C'])

  const reason = (pred: string, succ: string, dependencies = existing) => {
    const result = validateNewDependency(tasks, dependencies, pred, succ)
    return result.ok ? 'ok' : result.reason
  }

  it('accepts valid edges', () => {
    expect(validateNewDependency(tasks, existing, 'C', 'D')).toEqual({ ok: true })
    expect(reason('A', 'C')).toBe('ok') // redundant but not a cycle
    expect(reason('child', 'sibling')).toBe('ok')
    expect(reason('child', 'A')).toBe('ok')
  })

  it('reports each reason with a short message', () => {
    const result = validateNewDependency(tasks, existing, 'C', 'A')
    expect(result).toEqual({
      ok: false,
      reason: 'cycle',
      message: 'This would create a circular dependency.',
    })
    expect(reason('A', 'missing')).toBe('missing')
    expect(reason('missing', 'A')).toBe('missing')
    expect(reason('A', 'A')).toBe('self')
    expect(reason('A', 'foreign')).toBe('cross_project')
    expect(reason('parent', 'child')).toBe('hierarchy')
    expect(reason('child', 'parent')).toBe('hierarchy')
    expect(reason('A', 'B')).toBe('duplicate')
    expect(reason('B', 'A')).toBe('cycle') // reverse edge
    const failing: Array<[string, string]> = [
      ['A', 'x'],
      ['A', 'A'],
      ['A', 'foreign'],
      ['parent', 'child'],
      ['A', 'B'],
      ['B', 'A'],
    ]
    for (const [pred, succ] of failing) {
      const failed = validateNewDependency(tasks, existing, pred, succ)
      expect(failed.ok).toBe(false)
      // Short user-facing sentences.
      if (!failed.ok) expect(failed.message).toMatch(/^[A-Z][^\n]{5,80}\.$/)
    }
  })

  it('checks in order: missing, self, cross_project, hierarchy, duplicate, cycle', () => {
    expect(reason('missing', 'missing')).toBe('missing') // missing before self
    expect(reason('foreign', 'foreign')).toBe('self') // self before cross_project
    // hierarchy before duplicate and cycle
    expect(reason('parent', 'child', deps(['parent', 'child'], ['child', 'parent']))).toBe(
      'hierarchy',
    )
    // duplicate before cycle (A→B exists and B→A would also exist)
    expect(reason('A', 'B', deps(['A', 'B'], ['B', 'A']))).toBe('duplicate')
  })

  it('wouldCreateCycle follows paths of any length', () => {
    const chain = deps(['A', 'B'], ['B', 'C'], ['C', 'D'])
    expect(wouldCreateCycle(chain, 'D', 'A')).toBe(true)
    expect(wouldCreateCycle(chain, 'C', 'B')).toBe(true)
    expect(wouldCreateCycle(chain, 'A', 'D')).toBe(false)
    expect(wouldCreateCycle(chain, 'A', 'A')).toBe(true)
    expect(wouldCreateCycle([], 'A', 'B')).toBe(false)
  })
})

describe('computeAutoSchedule', () => {
  it('returns nothing without dependencies or conflicts', () => {
    const tasks = tasksOf({ A: ['2026-11-02', '2026-11-04'], B: ['2026-11-05', '2026-11-06'] })
    expect(computeAutoSchedule(tasks, [], [change('A', '2026-11-10', '2026-11-12')])).toEqual([])
    expect(computeAutoSchedule(tasks, deps(['A', 'B']), [])).toEqual([])
  })

  it('pushes a chain A → B → C later, preserving durations, in topological order', () => {
    const tasks = tasksOf({
      A: ['2026-11-02', '2026-11-04'],
      B: ['2026-11-05', '2026-11-06'],
      C: ['2026-11-07', '2026-11-09'],
    })
    // Dependencies listed out of order on purpose.
    const dependencies = deps(['B', 'C'], ['A', 'B'])
    const shifts = computeAutoSchedule(tasks, dependencies, [
      change('A', '2026-11-04', '2026-11-06'),
    ])
    expect(shifts).toEqual([
      {
        taskId: 'B',
        from: { startDate: '2026-11-05', dueDate: '2026-11-06' },
        to: { startDate: '2026-11-07', dueDate: '2026-11-08' },
        deltaDays: 2,
      },
      {
        taskId: 'C',
        from: { startDate: '2026-11-07', dueDate: '2026-11-09' },
        to: { startDate: '2026-11-09', dueDate: '2026-11-11' },
        deltaDays: 2,
      },
    ])
    // What the Gantt writes atomically alongside the user's own change.
    expect(toScheduleChanges(shifts)).toEqual([
      { taskId: 'B', startDate: '2026-11-07', dueDate: '2026-11-08' },
      { taskId: 'C', startDate: '2026-11-09', dueDate: '2026-11-11' },
    ])
  })

  it('never moves anything earlier and absorbs slack', () => {
    const tasks = tasksOf({
      A: ['2026-11-02', '2026-11-04'],
      B: ['2026-11-08', '2026-11-09'],
      C: ['2026-11-10', '2026-11-10'],
    })
    const dependencies = deps(['A', 'B'], ['B', 'C'])
    expect(
      computeAutoSchedule(tasks, dependencies, [change('A', '2026-10-20', '2026-10-22')]),
    ).toEqual([])
    expect(
      computeAutoSchedule(tasks, dependencies, [change('A', '2026-11-02', '2026-11-06')]),
    ).toEqual([])
    expect(
      summary(computeAutoSchedule(tasks, dependencies, [change('A', '2026-11-02', '2026-11-08')])),
    ).toEqual([
      ['B', '2026-11-09', '2026-11-10', 1],
      ['C', '2026-11-11', '2026-11-11', 1],
    ])
  })

  it('handles a diamond (max of both branches)', () => {
    const tasks = tasksOf({
      A: ['2026-11-01', '2026-11-02'],
      B: ['2026-11-03', '2026-11-05'],
      C: ['2026-11-03', '2026-11-03'],
      D: ['2026-11-06', '2026-11-07'],
    })
    const dependencies = deps(['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D'])
    const shifts = computeAutoSchedule(tasks, dependencies, [
      change('A', '2026-11-01', '2026-11-04'),
    ])
    expect(summary(shifts)).toEqual([
      ['B', '2026-11-05', '2026-11-07', 2],
      ['C', '2026-11-05', '2026-11-05', 2],
      ['D', '2026-11-08', '2026-11-09', 2],
    ])
  })

  it('uses the latest of multiple predecessors', () => {
    const tasks = tasksOf({
      X: ['2026-11-01', '2026-11-10'],
      Y: ['2026-11-01', '2026-11-03'],
      Z: ['2026-11-05', '2026-11-06'],
    })
    const shifts = computeAutoSchedule(tasks, deps(['Y', 'Z'], ['X', 'Z']), [])
    expect(summary(shifts)).toEqual([['Z', '2026-11-11', '2026-11-12', 6]])
  })

  it('moves the known date of partially scheduled successors', () => {
    const tasks = tasksOf({
      A: ['2026-11-01', '2026-11-05'],
      DueOnly: [null, '2026-11-03'],
      StartOnly: ['2026-11-04', null],
      Unscheduled: [null, null],
      AfterUnscheduled: ['2026-11-01', '2026-11-02'],
    })
    const dependencies = deps(
      ['A', 'DueOnly'],
      ['A', 'StartOnly'],
      ['A', 'Unscheduled'],
      ['Unscheduled', 'AfterUnscheduled'],
    )
    expect(summary(computeAutoSchedule(tasks, dependencies, []))).toEqual([
      ['DueOnly', null, '2026-11-06', 3],
      ['StartOnly', '2026-11-06', null, 2],
    ])
  })

  it('treats partially scheduled predecessors by their known date', () => {
    const tasks = tasksOf({
      StartOnly: ['2026-11-05', null],
      DueOnly: [null, '2026-11-07'],
      S1: ['2026-11-05', '2026-11-06'],
      S2: ['2026-11-06', '2026-11-06'],
    })
    const shifts = computeAutoSchedule(tasks, deps(['StartOnly', 'S1'], ['DueOnly', 'S2']), [])
    expect(summary(shifts)).toEqual([
      ['S1', '2026-11-06', '2026-11-07', 1],
      ['S2', '2026-11-08', '2026-11-08', 2],
    ])
  })

  it('never moves tasks the user edited, but uses their new dates', () => {
    const tasks = tasksOf({
      A: ['2026-11-01', '2026-11-05'],
      B: ['2026-11-06', '2026-11-08'],
      C: ['2026-11-09', '2026-11-09'],
    })
    const dependencies = deps(['A', 'B'], ['B', 'C'])
    // The user drags B into a conflict with A: B stays, C follows B's NEW dates.
    const shifts = computeAutoSchedule(tasks, dependencies, [
      change('B', '2026-11-04', '2026-11-12'),
    ])
    expect(summary(shifts)).toEqual([['C', '2026-11-13', '2026-11-13', 4]])
    // Both edited: nothing else to move, and the edits are not echoed back.
    expect(
      computeAutoSchedule(tasks, dependencies, [
        change('A', '2026-11-01', '2026-11-20'),
        change('B', '2026-11-02', '2026-11-03'),
      ]),
    ).toEqual([])
  })

  it('ignores changes for unknown tasks or tasks outside the graph', () => {
    const tasks = tasksOf({
      A: ['2026-11-01', '2026-11-05'],
      B: ['2026-11-03', '2026-11-04'],
      Loose: ['2026-11-01', '2026-11-01'],
    })
    const changes = [
      change('ghost', '2026-11-01', '2026-11-30'),
      change('Loose', '2026-12-01', '2026-12-02'),
    ]
    // Nothing these edits touch has successors, so A → B's existing conflict is not theirs to fix.
    expect(computeAutoSchedule(tasks, deps(['A', 'B']), changes)).toEqual([])
  })

  it('with changes, moves only what they force: conflicts elsewhere stay put', () => {
    const tasks = tasksOf({
      A: ['2026-11-01', '2026-11-05'],
      B: ['2026-11-03', '2026-11-04'], // conflicts with A already (e.g. left in Manual mode)
      Z: ['2026-11-01', '2026-11-01'],
      W: ['2026-11-10', '2026-11-11'],
    })
    const dependencies = deps(['A', 'B'], ['Z', 'W'])
    // Moving Z a day forces nothing: Auto mode applies it without a preview listing B.
    expect(
      computeAutoSchedule(tasks, dependencies, [change('Z', '2026-11-02', '2026-11-02')]),
    ).toEqual([])
    // An edit that does force a move lists only its own consequences.
    expect(
      summary(computeAutoSchedule(tasks, dependencies, [change('Z', '2026-11-12', '2026-11-12')])),
    ).toEqual([['W', '2026-11-13', '2026-11-14', 3]])
    // `changes: []` still resolves every existing conflict ("Fix with Auto").
    expect(summary(computeAutoSchedule(tasks, dependencies, []))).toEqual([
      ['B', '2026-11-06', '2026-11-07', 3],
    ])
  })

  it('a task the changes force to move also clears its other predecessors', () => {
    const tasks = tasksOf({
      A: ['2026-11-01', '2026-11-02'],
      X: ['2026-11-01', '2026-11-20'], // X → C already conflicts
      C: ['2026-11-04', '2026-11-05'],
      D: ['2026-11-06', '2026-11-06'],
    })
    const dependencies = deps(['A', 'C'], ['X', 'C'], ['C', 'D'])
    // A now finishes 11-03 and C starts 11-04: A forces nothing, C's old conflict with X stays.
    expect(
      computeAutoSchedule(tasks, dependencies, [change('A', '2026-11-01', '2026-11-03')]),
    ).toEqual([])
    // A now finishes 11-06: C must move, and lands after X too; D follows C.
    expect(
      summary(computeAutoSchedule(tasks, dependencies, [change('A', '2026-11-01', '2026-11-06')])),
    ).toEqual([
      ['C', '2026-11-21', '2026-11-22', 17],
      ['D', '2026-11-23', '2026-11-23', 17],
    ])
  })

  it('scopes a preview to one dependency when its predecessor is passed unchanged', () => {
    const tasks = tasksOf({
      A: ['2026-11-01', '2026-11-05'],
      B: ['2026-11-03', '2026-11-04'], // A → B was just created and conflicts
      X: ['2026-11-01', '2026-11-05'],
      Y: ['2026-11-02', '2026-11-02'], // X → Y: an older, unrelated conflict
    })
    const dependencies = deps(['A', 'B'], ['X', 'Y'])
    expect(
      summary(computeAutoSchedule(tasks, dependencies, [change('A', '2026-11-01', '2026-11-05')])),
    ).toEqual([['B', '2026-11-06', '2026-11-07', 3]])
  })

  it('an unscheduled task in the middle of a chain stops the push', () => {
    const tasks = tasksOf({
      A: ['2026-11-01', '2026-11-02'],
      U: [null, null],
      C: ['2026-11-04', '2026-11-05'],
      F: ['2026-11-20', '2026-11-21'],
      G: ['2026-11-22', '2026-11-22'],
    })
    // A → U → C: U has no dates, so nothing about C is certain. A → F(fixed) → G: G follows F.
    const dependencies = deps(['A', 'U'], ['U', 'C'], ['A', 'F'], ['F', 'G'])
    const shifts = computeAutoSchedule(tasks, dependencies, [
      change('A', '2026-11-01', '2026-11-10'),
      change('F', '2026-11-03', '2026-11-25'), // edited into conflict with A on purpose
    ])
    expect(summary(shifts)).toEqual([['G', '2026-11-26', '2026-11-26', 4]])
  })

  it('tolerates cycles: ignores the edges inside a cycle and keeps the rest', () => {
    const tasks = tasksOf({
      A: ['2026-11-01', '2026-11-05'],
      B: ['2026-11-03', '2026-11-04'],
      C: ['2026-11-04', '2026-11-04'],
      X: ['2026-11-01', '2026-11-10'],
    })
    // A ⇄ B is a cycle; B → C still applies; X → A applies (edge into the cycle).
    const dependencies = deps(['A', 'B'], ['B', 'A'], ['B', 'C'], ['X', 'A'], ['C', 'C'])
    let shifts: ScheduleShift[] = []
    expect(() => {
      shifts = computeAutoSchedule(tasks, dependencies, [])
    }).not.toThrow()
    // C follows B's (unmoved) finish; A follows X. Any topological order is acceptable.
    expect(summary(shifts).sort()).toEqual([
      ['A', '2026-11-11', '2026-11-15', 10],
      ['C', '2026-11-05', '2026-11-05', 1],
    ])
  })

  it('skips shifts past 9999-12-31 and survives corrupt dates', () => {
    const tasks = tasksOf({
      A: ['9999-12-30', '9999-12-31'],
      B: ['9999-12-31', '9999-12-31'],
      C: ['garbage', '2026-11-10'],
      D: ['2026-11-01', 'also garbage'],
    })
    const shifts = computeAutoSchedule(tasks, deps(['A', 'B'], ['D', 'C']), [])
    // D's finish falls back to its start (11-01); C's latest start is its due (11-10): no conflict.
    expect(shifts).toEqual([])
    const conflicting = tasksOf({ P: ['2026-11-01', '2026-11-20'], S: ['bad', '2026-11-10'] })
    expect(summary(computeAutoSchedule(conflicting, deps(['P', 'S']), []))).toEqual([
      ['S', 'bad', '2026-11-21', 11],
    ])
  })

  it('changes: [] resolves every conflict of a random DAG, minimally (property test)', () => {
    const random = seededRandom(7)
    for (let round = 0; round < 25; round++) {
      const { tasks, pairs, dependencies } = randomProject(random, 40, 60)
      const shifts = computeAutoSchedule(tasks, dependencies, [])
      const after = applyAll(tasks, [], shifts)
      expect(findConflicts(after, dependencies)).toEqual([])
      expectWellFormedShifts(shifts, tasks, new Set(), pairs)
      expectMinimalShifts(shifts, after, pairs)
    }
  })

  it('with changes, moves exactly the tasks they force (property test)', () => {
    const random = seededRandom(11)
    for (let round = 0; round < 40; round++) {
      const { ids, tasks, pairs, dependencies } = randomProject(random, 40, 60)
      const fixedIds = ids.filter(() => random() < 0.15)
      const changes = fixedIds.map((id) => change(id, ...randomDates(random)))
      const shifts = computeAutoSchedule(tasks, dependencies, changes)
      const after = applyAll(tasks, changes, shifts)
      const fixed = new Set(fixedIds)
      const shifted = new Set(shifts.map((s) => s.taskId))
      // Changed and shifted tasks are the ones that can push their successors.
      const pushes = (id: string) => fixed.has(id) || shifted.has(id)

      expectWellFormedShifts(shifts, tasks, fixed, pairs)
      expectMinimalShifts(shifts, after, pairs)
      // Every shift is forced by a pushing predecessor (judged against the task's own dates).
      for (const id of shifted) {
        const before = startDay(tasks[id]) as number
        const forced = pairs.some(([from, to]) => {
          const finish = finishDay(after[from])
          return to === id && pushes(from) && finish !== null && finish + 1 > before
        })
        expect(forced).toBe(true)
      }
      // No pushing predecessor is left in conflict with a successor the user did not pin;
      // conflicts between untouched tasks are left for the user (or `changes: []`).
      for (const conflict of findConflicts(after, dependencies)) {
        expect(fixed.has(conflict.successorId) || !pushes(conflict.predecessorId)).toBe(true)
      }
    }
  })

  it('in cyclic data, ignores only the edges inside a cycle (property test)', () => {
    const random = seededRandom(5)
    for (let round = 0; round < 40; round++) {
      const { ids, tasks, pairs, dependencies } = randomProject(random, 30, 50, 0.3)
      const inCycle = cycleEdgeTest(ids, pairs)
      for (const changes of [[], [change(ids[0], '2026-11-20', '2026-11-25')]]) {
        let shifts: ScheduleShift[] = []
        expect(() => {
          shifts = computeAutoSchedule(tasks, dependencies, changes)
        }).not.toThrow()
        const after = applyAll(tasks, changes, shifts)
        const fixed = new Set(changes.map((c) => c.taskId))
        expectWellFormedShifts(shifts, tasks, fixed, pairs, inCycle)
        expectMinimalShifts(shifts, after, pairs, inCycle)
        if (changes.length === 0) {
          for (const conflict of findConflicts(after, dependencies)) {
            expect(inCycle(conflict.predecessorId, conflict.successorId)).toBe(true)
          }
        }
      }
    }
  })

  it('detects cycles through long chains without recursion limits', () => {
    const count = 20_000
    const chain = deps(
      ...Array.from({ length: count - 1 }, (_, i): [string, string] => [`T${i}`, `T${i + 1}`]),
    )
    expect(wouldCreateCycle(chain, `T${count - 1}`, 'T0')).toBe(true)
    expect(wouldCreateCycle(chain, 'T0', `T${count - 1}`)).toBe(false)
    // Every task on the same day: every link of the chain conflicts.
    const tasks = tasksOf(
      Object.fromEntries(
        Array.from({ length: count }, (_, i): [string, Dates] => [
          `T${i}`,
          ['2026-11-02', '2026-11-02'],
        ]),
      ),
    )
    expect(validateNewDependency(tasks, chain, `T${count - 1}`, 'T0')).toMatchObject({
      ok: false,
      reason: 'cycle',
    })
    expect(computeAutoSchedule(tasks, chain, [])).toHaveLength(count - 1)
    // Closing the chain into one big cycle makes every edge unorderable: nothing moves, no throw.
    const closed = [...chain, ...deps([`T${count - 1}`, 'T0'])]
    expect(computeAutoSchedule(tasks, closed, [])).toEqual([])
  })

  it('schedules 5,000 tasks in well under 200 ms', () => {
    const count = 5_000
    const spec: Record<string, Dates> = {}
    for (let i = 0; i < count; i++) {
      // 3-day tasks starting on consecutive days: every link of the chain conflicts.
      const start = addDays('2026-01-01', i)
      spec[`T${i}`] = [start, addDays(start, 2)]
    }
    const tasks = tasksOf(spec)
    const random = seededRandom(99)
    const pairs: Array<[string, string]> = []
    for (let i = 1; i < count; i++) pairs.push([`T${i - 1}`, `T${i}`])
    for (let i = 0; i < count; i++) {
      const a = Math.floor(random() * count)
      const b = Math.floor(random() * count)
      if (a < b) pairs.push([`T${a}`, `T${b}`])
    }
    const dependencies = deps(...pairs)
    const changes = [change('T0', '2026-01-03', '2026-01-05')]

    let best = Number.POSITIVE_INFINITY
    let shifts: ScheduleShift[] = []
    for (let run = 0; run < 3; run++) {
      const started = performance.now()
      shifts = computeAutoSchedule(tasks, dependencies, changes)
      best = Math.min(best, performance.now() - started)
    }
    expect(shifts).toHaveLength(count - 1)
    expect(best).toBeLessThan(200)
    expect(findConflicts(applyAll(tasks, changes, shifts), dependencies)).toEqual([])

    const conflictsStarted = performance.now()
    expect(findConflicts(tasks, dependencies).length).toBeGreaterThan(count - 2)
    expect(performance.now() - conflictsStarted).toBeLessThan(200)
  })
})

describe('rollupRange', () => {
  it('returns null when nothing is scheduled', () => {
    expect(rollupRange([])).toBeNull()
    expect(rollupRange([{ startDate: null, dueDate: null }])).toBeNull()
  })

  it('spans every known date of every span kind and milestones', () => {
    expect(
      rollupRange([
        { startDate: '2026-11-05', dueDate: '2026-11-08' },
        { startDate: '2026-11-20', dueDate: null },
        { startDate: null, dueDate: '2026-11-02' },
        { startDate: null, dueDate: null },
      ]),
    ).toEqual({ start: '2026-11-02', end: '2026-11-20' })
    expect(
      rollupRange([{ startDate: '2026-11-05', dueDate: '2026-11-08' }], [{ date: '2027-01-15' }]),
    ).toEqual({ start: '2026-11-05', end: '2027-01-15' })
    expect(rollupRange([], [{ date: '2026-12-01' }])).toEqual({
      start: '2026-12-01',
      end: '2026-12-01',
    })
  })

  it('ignores unparseable dates', () => {
    expect(rollupRange([{ startDate: 'nope', dueDate: '2026-11-02' }])).toEqual({
      start: '2026-11-02',
      end: '2026-11-02',
    })
  })
})
