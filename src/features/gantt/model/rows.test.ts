import { describe, expect, it } from 'vitest'
import { toEpochDay } from '@/domain/dates'
import { buildProjectOutline } from '@/domain/hierarchy'
import { makeMilestone, makePhase, makeProject, makeTask } from '@/domain/testFactories'
import type { Milestone, Phase, Task } from '@/domain/types'
import { NO_PHASE_KEY, buildGanttRows, groupRowKey, taskRowKey, type GanttRow } from './rows'

const project = makeProject({ id: 'p' })
const d = toEpochDay

function rowsOf(
  input: { phases?: Phase[]; tasks?: Task[]; milestones?: Milestone[] },
  collapsed: string[] = [],
  options: { unscheduledOnly?: boolean } = {},
) {
  const outline = buildProjectOutline(
    project,
    input.phases ?? [],
    input.tasks ?? [],
    input.milestones ?? [],
  )
  return buildGanttRows(outline, new Set(collapsed), options)
}

function describeRow(row: GanttRow): string {
  switch (row.kind) {
    case 'group':
      return `group:${row.label}`
    case 'task':
      return `${row.depth ? '  ' : ''}${row.task.title}${row.context ? ' (context)' : ''}`
    case 'milestone':
      return `◆${row.milestone.name}`
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
    expect(row.context).toBe(false)
  })

  it('tasks without any dates stay in their phase and order, with a drawable lane', () => {
    const p1 = makePhase({ projectId: 'p', name: 'Design', sortOrder: 'a1' })
    const p2 = makePhase({ projectId: 'p', name: 'Build', sortOrder: 'a2' })
    const dated = makeTask({
      projectId: 'p',
      phaseId: p1.id,
      title: 'Dated',
      dueDate: '2026-11-04',
      sortOrder: 'a1',
    })
    const loose = makeTask({ projectId: 'p', phaseId: p1.id, title: 'Loose', sortOrder: 'a2' })
    const later = makeTask({ projectId: 'p', phaseId: p2.id, title: 'Later', sortOrder: 'a3' })
    const parent = makeTask({ projectId: 'p', title: 'Parent', sortOrder: 'a4' })
    const child = makeTask({ projectId: 'p', parentTaskId: parent.id, title: 'Child' })
    const model = rowsOf({ phases: [p1, p2], tasks: [dated, loose, later, parent, child] })
    expect(model.rows.map(describeRow)).toEqual([
      'group:Design',
      'Dated',
      'Loose',
      'group:Build',
      'Later',
      'group:No phase',
      'Parent',
      '  Child',
    ])
    // The header counts every task of the group, dated or not.
    expect(model.rows[0]).toMatchObject({ kind: 'group', taskCount: 2, unscheduledOnly: false })
    expect(model.rows[5]).toMatchObject({ kind: 'group', taskCount: 2 })
    expect(model.rows[2]).toMatchObject({ kind: 'task', drawable: true, context: false })
    // A subtask without dates under a dated parent also keeps its drawable lane.
    const p = makeTask({ projectId: 'p', title: 'P', dueDate: '2026-11-04' })
    const c = makeTask({ projectId: 'p', parentTaskId: p.id, title: 'C' })
    const nested = rowsOf({ tasks: [p, c] })
    expect(nested.rows.map(describeRow)).toEqual(['P', '  C'])
    expect(nested.rows[1]).toMatchObject({ drawable: true, context: false })
  })

  it('scheduling a task does not move its row', () => {
    const p1 = makePhase({ projectId: 'p', name: 'Design', sortOrder: 'a1' })
    const a = makeTask({ projectId: 'p', phaseId: p1.id, title: 'A', sortOrder: 'a1' })
    const b = makeTask({ projectId: 'p', phaseId: p1.id, title: 'B', sortOrder: 'a2' })
    const c = makeTask({ projectId: 'p', phaseId: p1.id, title: 'C', sortOrder: 'a3' })
    const before = rowsOf({ phases: [p1], tasks: [a, b, c] })
    const after = rowsOf({
      phases: [p1],
      tasks: [a, { ...b, startDate: '2026-11-02', dueDate: '2026-11-09' }, c],
    })
    expect(after.rows.map(describeRow)).toEqual(before.rows.map(describeRow))
    expect(after.taskRowIndex.get(b.id)).toBe(before.taskRowIndex.get(b.id))
    expect(after.unscheduledCount).toBe(2)
  })

  it('a project of only dateless tasks lists them in order, no phases, no extra rows', () => {
    const model = rowsOf({
      tasks: [
        makeTask({ projectId: 'p', title: 'Second', sortOrder: 'a2' }),
        makeTask({ projectId: 'p', title: 'First', sortOrder: 'a1' }),
      ],
    })
    expect(model.rows.map(describeRow)).toEqual(['First', 'Second'])
    expect(model.scheduledTaskCount).toBe(0)
    expect(model.unscheduledCount).toBe(2)
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

describe('unscheduled count', () => {
  const parent = makeTask({ projectId: 'p', title: 'Parent', sortOrder: 'a1' })
  const tasks = [
    parent,
    makeTask({ projectId: 'p', parentTaskId: parent.id, title: 'Sub none' }),
    makeTask({
      projectId: 'p',
      parentTaskId: parent.id,
      title: 'Sub dated',
      dueDate: '2026-11-04',
    }),
    makeTask({ projectId: 'p', title: 'Start only', startDate: '2026-11-02', sortOrder: 'a2' }),
    makeTask({ projectId: 'p', title: 'Due only', dueDate: '2026-11-03', sortOrder: 'a3' }),
    makeTask({ projectId: 'p', title: 'Plain', sortOrder: 'a4' }),
  ]
  const milestones = [makeMilestone({ projectId: 'p', name: 'M', date: '2026-11-10' })]

  it('counts top-level tasks and subtasks without any date, not start-only, due-only or milestones', () => {
    // Parent + "Sub none" + "Plain".
    expect(rowsOf({ tasks, milestones }).unscheduledCount).toBe(3)
    expect(rowsOf({ tasks, milestones }).scheduledTaskCount).toBe(3)
  })

  it('does not depend on collapsed rows or on the filter', () => {
    const phased = rowsOf({ tasks, milestones }, [taskRowKey(parent.id)])
    expect(phased.unscheduledCount).toBe(3)
    expect(rowsOf({ tasks, milestones }, [], { unscheduledOnly: true }).unscheduledCount).toBe(3)
    expect(
      rowsOf({ tasks, milestones }, [taskRowKey(parent.id)], { unscheduledOnly: true })
        .unscheduledCount,
    ).toBe(3)
  })
})

describe('buildGanttRows with unscheduledOnly', () => {
  const only = { unscheduledOnly: true }

  it('scenarios A and C: an unscheduled parent shows with only its unscheduled subtasks', () => {
    const parent = makeTask({ projectId: 'p', title: 'Parent' })
    const none = makeTask({ projectId: 'p', parentTaskId: parent.id, title: 'None' })
    const dated = makeTask({
      projectId: 'p',
      parentTaskId: parent.id,
      title: 'Dated',
      dueDate: '2026-11-12',
    })
    const bare = makeTask({
      projectId: 'p',
      parentTaskId: parent.id,
      title: 'Bare',
      sortOrder: 'z',
    })
    const model = rowsOf({ tasks: [parent, none, dated, bare] }, [], only)
    expect(model.rows.map(describeRow)).toEqual(['Parent', '  None', '  Bare'])
    // Scenario A: the parent is a match (not context); its bracket still spans the REAL subtasks.
    expect(model.rows[0]).toMatchObject({
      context: false,
      subtaskCount: 2,
      drawable: false,
      rollup: { start: d('2026-11-12'), end: d('2026-11-12') },
    })
    // Scenario C: all subtasks scheduled: just the parent, no chevron, bracket from the subtasks.
    const second = makeTask({
      projectId: 'p',
      parentTaskId: parent.id,
      title: 'D2',
      dueDate: '2026-11-13',
    })
    const allDated = rowsOf({ tasks: [parent, dated, second] }, [], only)
    expect(allDated.rows.map(describeRow)).toEqual(['Parent'])
    expect(allDated.rows[0]).toMatchObject({
      subtaskCount: 0,
      rollup: { start: d('2026-11-12'), end: d('2026-11-13') },
    })
  })

  it('scenario B: a scheduled parent is a context row above its unscheduled subtasks, not counted', () => {
    const p1 = makePhase({ projectId: 'p', name: 'Design' })
    const parent = makeTask({
      projectId: 'p',
      phaseId: p1.id,
      title: 'Parent',
      startDate: '2026-11-02',
      dueDate: '2026-11-06',
    })
    const none = makeTask({
      projectId: 'p',
      phaseId: p1.id,
      parentTaskId: parent.id,
      title: 'None',
    })
    const dated = makeTask({
      projectId: 'p',
      phaseId: p1.id,
      parentTaskId: parent.id,
      title: 'Dated',
      dueDate: '2026-11-09',
    })
    const model = rowsOf({ phases: [p1], tasks: [parent, none, dated] }, [], only)
    expect(model.rows.map(describeRow)).toEqual(['group:Design', 'Parent (context)', '  None'])
    expect(model.rows[0]).toMatchObject({ taskCount: 1, unscheduledOnly: true })
    expect(model.rows[1]).toMatchObject({ context: true, subtaskCount: 1, drawable: false })
    expect(model.rows[2]).toMatchObject({ context: false, drawable: true })

    // Collapsed (temporary set): the context parent hides its match; the thin line is real.
    const collapsed = rowsOf(
      { phases: [p1], tasks: [parent, none, dated] },
      [taskRowKey(parent.id)],
      only,
    )
    expect(collapsed.rows.map(describeRow)).toEqual(['group:Design', 'Parent (context)'])
    expect(collapsed.rows[1]).toMatchObject({
      collapsed: true,
      subtaskRollup: { start: d('2026-11-09'), end: d('2026-11-09') },
    })
  })

  it('drops items without a match, empty groups and all milestones', () => {
    const p1 = makePhase({ projectId: 'p', name: 'Design', sortOrder: 'a1' })
    const p2 = makePhase({ projectId: 'p', name: 'Build', sortOrder: 'a2' })
    const p3 = makePhase({ projectId: 'p', name: 'Ship', sortOrder: 'a3' })
    const model = rowsOf(
      {
        phases: [p1, p2, p3],
        tasks: [
          makeTask({ projectId: 'p', phaseId: p1.id, title: 'Dated', dueDate: '2026-11-04' }),
          makeTask({ projectId: 'p', phaseId: p2.id, title: 'Loose', sortOrder: 'a1' }),
          makeTask({ projectId: 'p', title: 'Orphan', sortOrder: 'a2' }),
        ],
        milestones: [
          makeMilestone({ projectId: 'p', phaseId: p2.id, name: 'M', date: '2026-11-09' }),
        ],
      },
      [],
      only,
    )
    // Design (nothing to show) and Ship (empty phase) have no header; No phase does (phases exist).
    expect(model.rows.map(describeRow)).toEqual([
      'group:Build',
      'Loose',
      'group:No phase',
      'Orphan',
    ])
    expect(model.rows.some((row) => row.kind === 'milestone')).toBe(false)
    // The Build header's bracket is still the phase's real extent (its milestone).
    expect(model.rows[0]).toMatchObject({
      rollup: { start: d('2026-11-09'), end: d('2026-11-09') },
    })

    // A project without phases is a flat list: no headers at all.
    const flat = rowsOf({ tasks: [makeTask({ projectId: 'p', title: 'Loose' })] }, [], only)
    expect(flat.rows.map(describeRow)).toEqual(['Loose'])
  })

  it('nothing to show gives an empty model', () => {
    const model = rowsOf({ tasks: [makeTask({ projectId: 'p', dueDate: '2026-11-04' })] }, [], only)
    expect(model.rows).toEqual([])
    expect(model.unscheduledCount).toBe(0)
    expect(model.taskRowIndex.size).toBe(0)
  })

  it('uses only the collapsed set it is given', () => {
    const p1 = makePhase({ projectId: 'p', name: 'Design' })
    const tasks = [
      makeTask({ projectId: 'p', phaseId: p1.id, title: 'A', sortOrder: 'a1' }),
      makeTask({ projectId: 'p', phaseId: p1.id, title: 'B', sortOrder: 'a2' }),
    ]
    // Empty set: every match visible, whatever the persisted prefs say.
    expect(rowsOf({ phases: [p1], tasks }, [], only).rows.map(describeRow)).toEqual([
      'group:Design',
      'A',
      'B',
    ])
    expect(rowsOf({ phases: [p1], tasks }, [groupRowKey(p1)], only).rows.map(describeRow)).toEqual([
      'group:Design',
    ])
  })

  it('keeps taskRowIndex and rowIndexByKey consistent with rows', () => {
    const p1 = makePhase({ projectId: 'p', name: 'Design' })
    const parent = makeTask({ projectId: 'p', phaseId: p1.id, title: 'P', dueDate: '2026-11-04' })
    const hidden = makeTask({
      projectId: 'p',
      phaseId: p1.id,
      parentTaskId: parent.id,
      title: 'T',
      dueDate: '2026-11-05',
    })
    const tasks = [
      parent,
      makeTask({ projectId: 'p', phaseId: p1.id, parentTaskId: parent.id, title: 'S' }),
      hidden,
      makeTask({ projectId: 'p', title: 'N', sortOrder: 'z' }),
    ]
    for (const options of [{}, only]) {
      const model = rowsOf({ phases: [p1], tasks }, [], options)
      model.rows.forEach((row, index) => {
        expect(model.rowIndexByKey.get(row.key)).toBe(index)
        if (row.kind === 'task') expect(model.taskRowIndex.get(row.task.id)).toBe(index)
      })
      expect(model.rowIndexByKey.size).toBe(model.rows.length)
      expect(model.taskRowIndex.size).toBe(model.rows.filter((r) => r.kind === 'task').length)
    }
    // The scheduled subtask has no row in filter mode.
    const filtered = rowsOf({ phases: [p1], tasks }, [], only)
    expect(filtered.taskRowIndex.has(hidden.id)).toBe(false)
  })

  it('builds a 2000-task project quickly and correctly', () => {
    const phases = [0, 1, 2, 3].map((i) =>
      makePhase({ projectId: 'p', name: `Phase ${i}`, sortOrder: `a${i}` }),
    )
    const tasks: Task[] = []
    for (let i = 0; i < 400; i++) {
      const phaseId = phases[i % phases.length].id
      const top = makeTask({
        projectId: 'p',
        phaseId,
        title: `T${i}`,
        sortOrder: `b${String(i).padStart(4, '0')}`,
        // Every third top-level task is scheduled.
        ...(i % 3 === 0 ? { dueDate: '2026-11-04' } : {}),
      })
      tasks.push(top)
      for (let j = 0; j < 4; j++) {
        tasks.push(
          makeTask({
            projectId: 'p',
            phaseId,
            parentTaskId: top.id,
            title: `T${i}.${j}`,
            sortOrder: `c${j}`,
            ...(j === 0 ? { dueDate: '2026-11-05' } : {}),
          }),
        )
      }
    }
    expect(tasks).toHaveLength(2000)
    const outline = buildProjectOutline(project, phases, tasks, [])
    const started = performance.now()
    const normal = buildGanttRows(outline, new Set())
    const filtered = buildGanttRows(outline, new Set(), { unscheduledOnly: true })
    expect(performance.now() - started).toBeLessThan(500)
    expect(normal.rows.filter((r) => r.kind === 'task')).toHaveLength(2000)
    const expected = tasks.filter((t) => t.startDate === null && t.dueDate === null).length
    expect(normal.unscheduledCount).toBe(expected)
    expect(filtered.unscheduledCount).toBe(expected)
    expect(filtered.rows.filter((r) => r.kind === 'task' && !r.context)).toHaveLength(expected)
    const headerCounts = filtered.rows.reduce(
      (sum, row) => sum + (row.kind === 'group' ? row.taskCount : 0),
      0,
    )
    expect(headerCounts).toBe(expected)
  })
})
