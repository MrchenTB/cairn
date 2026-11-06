/**
 * Seeded property test of computeAutoSchedule over random dependency graphs (diamonds, long chains,
 * every span kind, undated tasks). Each failure message names the seed: rerun with that seed alone.
 */
import { describe, expect, it } from 'vitest'
import { addDays, tryToEpochDay } from './dates'
import { computeAutoSchedule, findConflicts, type ScheduleShift } from './scheduling'
import { makeDependency, makeTask, seededRandom } from './testFactories'
import type { Dependency, ISODate, ScheduleChange, Task } from './types'

const PROJECT = 'p'
const SEEDS = 400
const BASE: ISODate = '2026-03-01'

type Random = () => number
const int = (random: Random, n: number) => Math.floor(random() * n)

function randomDates(random: Random): Pick<Task, 'startDate' | 'dueDate'> {
  const start = addDays(BASE, int(random, 120))
  const roll = random()
  if (roll < 0.1) return { startDate: null, dueDate: null }
  if (roll < 0.25) return { startDate: start, dueDate: null }
  if (roll < 0.4) return { startDate: null, dueDate: start }
  return { startDate: start, dueDate: addDays(start, int(random, 30)) }
}

/** A random DAG: edges only go from a lower to a higher (shuffled) position, so no cycles. */
function randomGraph(seed: number) {
  const random = seededRandom(seed)
  const size = 2 + int(random, 40)
  const ids = Array.from({ length: size }, (_, index) => `t${index}`)
  for (let i = ids.length - 1; i > 0; i--) {
    const j = int(random, i + 1)
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
  }
  const tasks: Record<string, Task> = {}
  for (const id of ids) {
    tasks[id] = makeTask({ projectId: PROJECT, id, title: id, ...randomDates(random) })
  }
  const density = random() * 0.25
  const dependencies: Dependency[] = []
  for (let i = 0; i < size; i++) {
    for (let j = i + 1; j < size; j++) {
      if (random() < density) {
        dependencies.push(
          makeDependency({ projectId: PROJECT, predecessorId: ids[i], successorId: ids[j] }),
        )
      }
    }
  }
  return { random, ids, tasks, dependencies }
}

function randomChange(random: Random, ids: readonly string[], tasks: Record<string, Task>) {
  const taskId = ids[int(random, ids.length)]
  // Sometimes a different kind of span altogether: dates cleared, or given to an undated task.
  if (random() < 0.3) return { taskId, ...randomDates(random) }
  const { startDate, dueDate } = tasks[taskId]
  const delta = int(random, 91) - 30
  const change: ScheduleChange = {
    taskId,
    startDate: startDate ? addDays(startDate, delta) : null,
    dueDate: dueDate ? addDays(dueDate, delta) : null,
  }
  return change
}

function applied(
  tasks: Record<string, Task>,
  changes: readonly ScheduleChange[],
  shifts: readonly ScheduleShift[],
): Record<string, Task> {
  const next = { ...tasks }
  for (const { taskId, startDate, dueDate } of changes) {
    next[taskId] = { ...next[taskId], startDate, dueDate }
  }
  for (const { taskId, to } of shifts) next[taskId] = { ...next[taskId], ...to }
  return next
}

const finish = (task: Task) => tryToEpochDay(task.dueDate) ?? tryToEpochDay(task.startDate)
const latest = (task: Task) => tryToEpochDay(task.startDate) ?? tryToEpochDay(task.dueDate)

function checkShiftShape(shift: ScheduleShift, before: Task, label: string) {
  const { from, to, deltaDays } = shift
  // Nothing moves earlier; every known date moves by the same delta, so durations hold.
  expect(deltaDays, label).toBeGreaterThanOrEqual(1)
  expect(from, label).toEqual({ startDate: before.startDate, dueDate: before.dueDate })
  expect(to.startDate, label).toBe(from.startDate && addDays(from.startDate, deltaDays))
  expect(to.dueDate, label).toBe(from.dueDate && addDays(from.dueDate, deltaDays))
  expect(from.startDate ?? from.dueDate, `${label}: an undated task never moves`).not.toBeNull()
}

describe('computeAutoSchedule properties', () => {
  it('changes: [] resolves every conflict, minimally, and is idempotent', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { tasks, dependencies } = randomGraph(seed)
      const shifts = computeAutoSchedule(tasks, dependencies, [])
      const label = `seed ${seed}`
      const after = applied(tasks, [], shifts)
      expect(findConflicts(after, dependencies), label).toEqual([])
      expect(computeAutoSchedule(after, dependencies, []), label).toEqual([])

      const position = new Map(shifts.map((shift, index) => [shift.taskId, index]))
      expect(position.size, `${label}: one shift per task`).toBe(shifts.length)
      for (const shift of shifts) {
        checkShiftShape(shift, tasks[shift.taskId], label)
        // Moved only as far as needed: it lands right after its latest predecessor.
        const predecessors = dependencies.filter((d) => d.successorId === shift.taskId)
        const required = Math.max(
          ...predecessors.map((d) => finish(after[d.predecessorId]) ?? -Infinity),
        )
        expect(latest(after[shift.taskId]), label).toBe(required + 1)
        for (const { predecessorId } of predecessors) {
          const index = position.get(predecessorId)
          if (index !== undefined)
            expect(index, `${label}: topological`).toBeLessThan(
              position.get(shift.taskId) as number,
            )
        }
      }
      // Whoever did not move had no conflict left to begin with.
      for (const { successorId, predecessorId } of dependencies) {
        if (position.has(successorId)) continue
        const need = finish(after[predecessorId])
        const start = latest(after[successorId])
        if (need !== null && start !== null) expect(start, label).toBeGreaterThan(need)
      }
    }
  })

  it('a change moves only the tasks it forces and is idempotent', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { random, ids, tasks, dependencies } = randomGraph(seed + 10_000)
      const change = randomChange(random, ids, tasks)
      const shifts = computeAutoSchedule(tasks, dependencies, [change])
      const label = `seed ${seed}`
      const after = applied(tasks, [change], shifts)
      const moved = new Set(shifts.map((shift) => shift.taskId))
      expect(moved.size, label).toBe(shifts.length)
      expect(moved.has(change.taskId), `${label}: the edited task stays put`).toBe(false)
      expect(after[change.taskId].startDate, label).toBe(change.startDate)
      expect(after[change.taskId].dueDate, label).toBe(change.dueDate)

      const pushers = new Set([change.taskId, ...moved])
      for (const shift of shifts) {
        checkShiftShape(shift, tasks[shift.taskId], label)
        const predecessors = dependencies.filter((d) => d.successorId === shift.taskId)
        // Forced: a pusher finishes on or after the start the task had.
        const oldStart = latest(tasks[shift.taskId]) as number
        const forced = predecessors.some(({ predecessorId }) => {
          const end = pushers.has(predecessorId) ? finish(after[predecessorId]) : null
          return end !== null && end >= oldStart
        })
        expect(forced, `${label}: ${shift.taskId} moved without being forced`).toBe(true)
        // Lands after ALL its predecessors, not just the pusher, and no further.
        const required = Math.max(
          ...predecessors.map((d) => finish(after[d.predecessorId]) ?? -Infinity),
        )
        expect(latest(after[shift.taskId]), label).toBe(required + 1)
      }
      // Nothing this edit pushes still conflicts, except into the edited task itself (it is fixed).
      for (const conflict of findConflicts(after, dependencies)) {
        const touched =
          pushers.has(conflict.predecessorId) && conflict.successorId !== change.taskId
        expect(touched, `${label}: ${conflict.predecessorId} -> ${conflict.successorId}`).toBe(
          false,
        )
      }
      // A forced-free task keeps its dates, however conflicted it was before.
      for (const id of ids) {
        if (id === change.taskId || moved.has(id)) continue
        expect(after[id], label).toBe(tasks[id])
      }
      expect(computeAutoSchedule(after, dependencies, [change]), label).toEqual([])
    }
  })

  it('does not depend on the order of the dependencies', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { random, ids, tasks, dependencies } = randomGraph(seed + 20_000)
      const change = randomChange(random, ids, tasks)
      const reversed = [...dependencies].reverse()
      const sorted = (shifts: ScheduleShift[]) =>
        [...shifts].sort((a, b) => (a.taskId < b.taskId ? -1 : 1))
      expect(sorted(computeAutoSchedule(tasks, reversed, [change])), `seed ${seed}`).toEqual(
        sorted(computeAutoSchedule(tasks, dependencies, [change])),
      )
    }
  })

  it('survives cycles in the input: no throw, nothing inside a cycle pushes itself around', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { random, ids, tasks, dependencies } = randomGraph(seed + 30_000)
      const looped = [...dependencies]
      for (let index = 0; index < 5; index++) {
        const [a, b] = [ids[int(random, ids.length)], ids[int(random, ids.length)]]
        looped.push(makeDependency({ projectId: PROJECT, predecessorId: a, successorId: b }))
      }
      const change = randomChange(random, ids, tasks)
      for (const changes of [[], [change]]) {
        const shifts = computeAutoSchedule(tasks, looped, changes)
        const after = applied(tasks, changes, shifts)
        expect(computeAutoSchedule(after, looped, changes), `seed ${seed}`).toEqual([])
      }
    }
  })

  it('near the end of the calendar: skips what cannot move, never leaves it, stays idempotent', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = seededRandom(seed + 40_000)
      const size = 3 + int(random, 20)
      const tasks: Record<string, Task> = {}
      const dependencies: Dependency[] = []
      for (let index = 0; index < size; index++) {
        const id = `t${index}`
        const start = addDays('9999-12-01', int(random, 31))
        const span = int(random, 3)
        tasks[id] = makeTask({
          projectId: PROJECT,
          id,
          startDate: span === 1 ? null : start,
          dueDate: span === 2 ? null : start,
        })
        if (index > 0) {
          const predecessorId = `t${int(random, index)}`
          dependencies.push(makeDependency({ projectId: PROJECT, predecessorId, successorId: id }))
        }
      }
      const shifts = computeAutoSchedule(tasks, dependencies, [])
      for (const { to } of shifts) {
        for (const date of [to.startDate, to.dueDate]) {
          if (date) expect(date <= '9999-12-31', `seed ${seed}`).toBe(true)
        }
      }
      const after = applied(tasks, [], shifts)
      expect(computeAutoSchedule(after, dependencies, []), `seed ${seed}`).toEqual([])
    }
  })

  it('terminates quickly on big graphs and gets them right', () => {
    const size = 20_000
    const chainTasks: Record<string, Task> = {}
    const chain: Dependency[] = []
    for (let index = 0; index < size; index++) {
      const id = `c${index}`
      chainTasks[id] = makeTask({ projectId: PROJECT, id, startDate: BASE, dueDate: BASE })
      if (index > 0) {
        chain.push(
          makeDependency({ projectId: PROJECT, predecessorId: `c${index - 1}`, successorId: id }),
        )
      }
    }
    const started = performance.now()
    const shifts = computeAutoSchedule(chainTasks, chain, [])
    expect(shifts).toHaveLength(size - 1)
    expect(shifts.at(-1)?.deltaDays).toBe(size - 1)

    // A layered lattice: 200 layers of 25, every task depends on the whole previous layer
    // (125 000 edges, an enormous number of paths).
    const latticeTasks: Record<string, Task> = {}
    const lattice: Dependency[] = []
    for (let layer = 0; layer < 200; layer++) {
      for (let cell = 0; cell < 25; cell++) {
        const id = `l${layer}-${cell}`
        latticeTasks[id] = makeTask({ projectId: PROJECT, id, startDate: BASE, dueDate: BASE })
        if (layer === 0) continue
        for (let from = 0; from < 25; from++) {
          lattice.push(
            makeDependency({
              projectId: PROJECT,
              predecessorId: `l${layer - 1}-${from}`,
              successorId: id,
            }),
          )
        }
      }
    }
    const moved = computeAutoSchedule(latticeTasks, lattice, [
      { taskId: 'l0-0', startDate: BASE, dueDate: addDays(BASE, 1) },
    ])
    expect(moved).toHaveLength(199 * 25)
    expect(moved.at(-1)?.deltaDays).toBe(199 + 1)
    expect(performance.now() - started).toBeLessThan(5_000)
  }, 20_000)
})
