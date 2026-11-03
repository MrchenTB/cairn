import { describe, expect, it } from 'vitest'
import { findConflicts } from '@/domain/scheduling'
import { makeDependency, makeTask } from '@/domain/testFactories'
import type { Task } from '@/domain/types'
import { conflictMessages, liveConflicts, type DateOverrides } from './conflicts'

const task = (id: string, title: string, startDate: string | null, dueDate: string | null): Task =>
  makeTask({ id, projectId: 'p', title, startDate, dueDate })

// A (Nov 2–4) → B (Nov 5–6), C (Nov 1–3) → B: no conflict as stored.
const tasks: Record<string, Task> = {
  A: task('A', 'Alpha', '2026-11-02', '2026-11-04'),
  B: task('B', 'Beta', '2026-11-05', '2026-11-06'),
  C: task('C', 'Gamma', '2026-11-01', '2026-11-03'),
  D: task('D', 'Delta', '2026-11-20', '2026-11-21'),
}
const deps = [
  makeDependency({ id: 'AB', projectId: 'p', predecessorId: 'A', successorId: 'B' }),
  makeDependency({ id: 'CB', projectId: 'p', predecessorId: 'C', successorId: 'B' }),
  makeDependency({ id: 'BD', projectId: 'p', predecessorId: 'B', successorId: 'D' }),
]

describe('liveConflicts', () => {
  const base = findConflicts(tasks, deps)

  it('returns the stored conflicts as they are when nothing is overridden', () => {
    expect(base).toEqual([])
    expect(liveConflicts(base, deps, tasks, new Map())).toBe(base)
  })

  it('re-checks the links of a bar being dragged against its live dates', () => {
    const overrides: DateOverrides = new Map([
      ['A', { startDate: '2026-11-05', dueDate: '2026-11-07' }],
    ])
    const live = liveConflicts(base, deps, tasks, overrides)
    expect(live.map((c) => c.dependencyId)).toEqual(['AB'])
    expect(live[0]).toMatchObject({ requiredStart: '2026-11-08', actualStart: '2026-11-05' })
  })

  it('drops a stored conflict that the live dates resolve, keeps unrelated ones', () => {
    const stored = { ...tasks, D: task('D', 'Delta', '2026-11-03', '2026-11-04') }
    const before = findConflicts(stored, deps)
    expect(before.map((c) => c.dependencyId)).toEqual(['BD'])
    // Dragging A (not involved in B → D) keeps that conflict; dragging D later fixes it.
    expect(
      liveConflicts(
        before,
        deps,
        stored,
        new Map([['A', { startDate: '2026-11-01', dueDate: '2026-11-02' }]]),
      ).map((c) => c.dependencyId),
    ).toEqual(['BD'])
    expect(
      liveConflicts(
        before,
        deps,
        stored,
        new Map([['D', { startDate: '2026-11-07', dueDate: '2026-11-08' }]]),
      ),
    ).toEqual([])
  })
})

describe('conflictMessages', () => {
  it('words one violated predecessor by name', () => {
    const conflicts = findConflicts(
      { ...tasks, B: task('B', 'Beta', '2026-11-04', '2026-11-06') },
      deps.slice(0, 1),
    )
    const messages = conflictMessages(conflicts, tasks, '2026-11-03')
    expect(messages.get('B')).toBe('Should start after “Alpha” ends — on Nov 5 or later')
  })

  it('counts several predecessors and uses the latest required start', () => {
    const late = {
      ...tasks,
      A: task('A', 'Alpha', '2026-11-02', '2026-11-09'),
      C: task('C', 'Gamma', '2026-11-01', '2026-11-12'),
    }
    const messages = conflictMessages(findConflicts(late, deps), late, '2026-11-03')
    expect(messages.get('B')).toBe('Should start after 2 tasks end — on Nov 13 or later')
    expect(messages.has('A')).toBe(false)
  })

  it('shows the year outside the current one', () => {
    const conflicts = findConflicts(
      {
        A: task('A', 'Alpha', '2027-01-02', '2027-01-04'),
        B: task('B', 'Beta', '2027-01-03', '2027-01-05'),
      },
      deps.slice(0, 1),
    )
    expect(conflictMessages(conflicts, tasks, '2026-11-03').get('B')).toBe(
      'Should start after “Alpha” ends — on Jan 5, 2027 or later',
    )
  })
})
