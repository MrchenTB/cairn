import { describe, expect, it } from 'vitest'
import { toEpochDay } from '@/domain/dates'
import { buildProjectOutline } from '@/domain/hierarchy'
import { makeMilestone, makePhase, makeProject, makeTask } from '@/domain/testFactories'
import type { Milestone, Phase, Task } from '@/domain/types'
import {
  NO_PHASE_KEY,
  UNSCHEDULED_KEY,
  buildGanttRows,
  groupRowKey,
  taskRowKey,
  type GanttRow,
} from './rows'

const project = makeProject({ id: 'p' })
const d = toEpochDay

function rowsOf(
  input: { phases?: Phase[]; tasks?: Task[]; milestones?: Milestone[] },
  collapsed: string[] = [],
) {
  const outline = buildProjectOutline(
    project,
    input.phases ?? [],
    input.tasks ?? [],
    input.milestones ?? [],
  )
  return buildGanttRows(outline, new Set(collapsed))
}

function describeRow(row: GanttRow): string {
  switch (row.kind) {
    case 'group':
      return `group:${row.label}`
    case 'task':
      return `${row.depth ? '  ' : ''}${row.task.title}`
    case 'milestone':
      return `◆${row.milestone.name}`
    case 'unscheduled':
      return `unscheduled(${row.count})`
  }
}

describe('buildGanttRows', () => {
  it('flat project: no group header, tasks in sortOrder then milestones by date', () => {
    const model = rowsOf({
      tasks: [
        makeTask({ projectId: 'p', title: 'B', sortOrder: 'a2', dueDate: '2026-11-05' }),
        makeTask({ projectId: 'p', title: 'A', sortOrder: 'a1', startDate: '2026-11-02' }),
      ],
      milestones: [
        makeMilestone({ projectId: 'p', name: 'Late', date: '2026-12-01' }),
        makeMilestone({ projectId: 'p', name: 'Early', date: '2026-11-10' }),
      ],
    })
    expect(model.rows.map(describeRow)).toEqual(['A', 'B', '◆Early', '◆Late'])
    expect(model.scheduledTaskCount).toBe(2)
    expect(model.unscheduledCount).toBe(0)
  })

  it('phases: "No phase" header only when it has content, empty phases still listed', () => {
    const p1 = makePhase({ projectId: 'p', name: 'Design', sortOrder: 'a1' })
    const p2 = makePhase({ projectId: 'p', name: 'Build', sortOrder: 'a2' })
    const model = rowsOf({
      phases: [p2, p1],
      tasks: [
        makeTask({ projectId: 'p', title: 'Loose', dueDate: '2026-11-04', sortOrder: 'a0' }),
        makeTask({
          projectId: 'p',
          phaseId: p1.id,
          title: 'Wireframes',
          startDate: '2026-11-02',
          dueDate: '2026-11-06',
          sortOrder: 'a1',
        }),
      ],
      milestones: [
        makeMilestone({ projectId: 'p', phaseId: p1.id, name: 'Review', date: '2026-11-09' }),
      ],
    })
    // Phases first, in their order; "No phase" comes last (iteration 3).
    expect(model.rows.map(describeRow)).toEqual([
      'group:Design',
      'Wireframes',
      '◆Review',
      'group:Build',
      'group:No phase',
      'Loose',
    ])
    const design = model.rows[0]
    expect(design.kind === 'group' && design.rollup).toEqual({
      start: d('2026-11-02'),
      end: d('2026-11-09'),
    })
    const build = model.rows[3]
    expect(build.kind === 'group' && build.rollup).toBeNull()

    const withoutLoose = rowsOf({ phases: [p1], tasks: [] })
    expect(withoutLoose.rows.map(describeRow)).toEqual(['group:Design'])
  })

  it('collapsing a phase hides its tasks and milestones but keeps the rollup', () => {
    const p1 = makePhase({ projectId: 'p', name: 'Design' })
    const model = rowsOf(
      {
        phases: [p1],
        tasks: [makeTask({ projectId: 'p', phaseId: p1.id, title: 'T', dueDate: '2026-11-04' })],
        milestones: [
          makeMilestone({ projectId: 'p', phaseId: p1.id, name: 'M', date: '2026-11-09' }),
        ],
      },
      [groupRowKey(p1)],
    )
    expect(model.rows.map(describeRow)).toEqual(['group:Design'])
    expect(model.rows[0]).toMatchObject({ collapsed: true, taskCount: 1 })
    expect(model.taskRowIndex.size).toBe(0)
  })

  it('subtasks are indented under their parent and hidden when it is collapsed', () => {
    const parent = makeTask({
      projectId: 'p',
      title: 'Parent',
      startDate: '2026-11-02',
      dueDate: '2026-11-03',
    })
    const child = makeTask({
      projectId: 'p',
      parentTaskId: parent.id,
      title: 'Child',
      startDate: '2026-11-04',
      dueDate: '2026-11-10',
    })
    const expanded = rowsOf({ tasks: [parent, child] })
    expect(expanded.rows.map(describeRow)).toEqual(['Parent', '  Child'])
    expect(expanded.rows[0]).toMatchObject({
      subtaskCount: 1,
      collapsed: false,
      rollup: null,
      subtaskRollup: null,
    })
    expect(expanded.taskRowIndex.get(child.id)).toBe(1)

    const collapsed = rowsOf({ tasks: [parent, child] }, [taskRowKey(parent.id)])
    expect(collapsed.rows.map(describeRow)).toEqual(['Parent'])
    // Own dates → own bar, plus a thin line for the hidden subtasks.
    expect(collapsed.rows[0]).toMatchObject({
      collapsed: true,
      subtaskRollup: { start: d('2026-11-04'), end: d('2026-11-10') },
    })
    expect(collapsed.taskRowIndex.has(child.id)).toBe(false)
  })

  it('a parent without own dates shows a rollup bracket of its subtasks', () => {
    const parent = makeTask({ projectId: 'p', title: 'Parent' })
    const child = makeTask({
      projectId: 'p',
      parentTaskId: parent.id,
      title: 'Child',
      dueDate: '2026-11-12',
    })
    const model = rowsOf({ tasks: [parent, child] })
    const row = model.rows[0]
    expect(row.kind).toBe('task')
    if (row.kind !== 'task') return
    expect(row.span.kind).toBe('unscheduled')
    expect(row.rollup).toEqual({ start: d('2026-11-12'), end: d('2026-11-12') })
    expect(row.drawable).toBe(false)
    expect(row.inUnscheduledGroup).toBe(false)
  })

  it('tasks without any dates go to "Unscheduled (n)" at the bottom, drawable', () => {
    const p1 = makePhase({ projectId: 'p', name: 'Design' })
    const dated = makeTask({
      projectId: 'p',
      phaseId: p1.id,
      title: 'Dated',
      dueDate: '2026-11-04',
      sortOrder: 'a1',
    })
    const loose = makeTask({ projectId: 'p', phaseId: p1.id, title: 'Loose', sortOrder: 'a2' })
    const parent = makeTask({ projectId: 'p', title: 'Parent', sortOrder: 'a3' })
    const child = makeTask({ projectId: 'p', parentTaskId: parent.id, title: 'Child' })
    const model = rowsOf({ phases: [p1], tasks: [dated, loose, parent, child] })
    expect(model.rows.map(describeRow)).toEqual([
      'group:Design',
      'Dated',
      'unscheduled(3)',
      'Loose',
      'Parent',
      '  Child',
    ])
    expect(model.unscheduledCount).toBe(3)
    const looseRow = model.rows[3]
    expect(looseRow).toMatchObject({ kind: 'task', inUnscheduledGroup: true, drawable: true })
    // A subtask without dates under a dated parent stays with its parent (drawable lane).
    const p = makeTask({ projectId: 'p', title: 'P', dueDate: '2026-11-04' })
    const c = makeTask({ projectId: 'p', parentTaskId: p.id, title: 'C' })
    const nested = rowsOf({ tasks: [p, c] })
    expect(nested.rows.map(describeRow)).toEqual(['P', '  C'])
    expect(nested.rows[1]).toMatchObject({ drawable: true, inUnscheduledGroup: false })

    const collapsed = rowsOf({ phases: [p1], tasks: [dated, loose] }, [UNSCHEDULED_KEY])
    expect(collapsed.rows.map(describeRow)).toEqual(['group:Design', 'Dated', 'unscheduled(1)'])
  })

  it('indexes every visible task row', () => {
    const a = makeTask({ projectId: 'p', title: 'A', sortOrder: 'a1', dueDate: '2026-11-03' })
    const b = makeTask({ projectId: 'p', title: 'B', sortOrder: 'a2', dueDate: '2026-11-04' })
    const model = rowsOf({ tasks: [a, b] })
    expect([...model.taskRowIndex.entries()]).toEqual([
      [a.id, 0],
      [b.id, 1],
    ])
    expect(NO_PHASE_KEY).toBe('group:none')
  })
})
