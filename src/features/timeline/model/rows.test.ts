import { describe, expect, it } from 'vitest'
import { toEpochDay } from '@/domain/dates'
import {
  makeDependency,
  makeMilestone,
  makePhase,
  makeProject,
  makeTask,
  makeWorkspace,
} from '@/domain/testFactories'
import {
  PROJECT_ROW_HEIGHT,
  UNSCHEDULED_SECTION_KEY,
  buildTimelineRows,
  nextMilestoneIds,
  progressLabel,
  projectRowKey,
  projectRowSummary,
  rowHeightOf,
  type ProjectRow,
  type TimelineRow,
  type TimelineRowModel,
} from './rows'

const d = toEpochDay

function build(
  rows: Parameters<typeof makeWorkspace>[0],
  options: { expanded?: string[]; includeCompleted?: boolean } = {},
): TimelineRowModel {
  return buildTimelineRows(makeWorkspace(rows), {
    expanded: new Set(options.expanded ?? []),
    includeCompleted: options.includeCompleted ?? false,
  })
}

function projectRow(model: TimelineRowModel, id: string): ProjectRow {
  const row = model.rows.find((candidate) => candidate.key === projectRowKey(id))
  if (row?.kind !== 'project') throw new Error(`no row for project ${id}`)
  return row
}

function describeRow(row: TimelineRow): string {
  switch (row.kind) {
    case 'project':
      return `${row.expanded ? 'v' : '>'} ${row.project.name}`
    case 'section':
      return `-- unscheduled (${row.count})`
    case 'task':
      return `  ${row.task.title}`
    case 'milestone':
      return `  ◆${row.milestone.name}`
  }
}

const outline = (model: TimelineRowModel) => model.rows.map(describeRow)

describe('project range', () => {
  const tasks = (projectId: string) => [
    makeTask({ projectId, startDate: '2026-03-10', dueDate: '2026-03-20' }),
  ]
  const milestones = (projectId: string) => [makeMilestone({ projectId, date: '2026-04-15' })]

  it('uses the project dates when both are set, whatever its tasks and milestones say', () => {
    const p = makeProject({ id: 'p', startDate: '2026-03-15', dueDate: '2026-03-18' })
    const row = projectRow(
      build({ projects: [p], tasks: tasks('p'), milestones: milestones('p') }),
      'p',
    )
    expect(row.range).toEqual({ start: d('2026-03-15'), end: d('2026-03-18') })
    expect(row.rolledUp).toBe(false)
  })

  it('rolls up tasks and milestones when the project has no dates', () => {
    const p = makeProject({ id: 'p' })
    const row = projectRow(
      build({ projects: [p], tasks: tasks('p'), milestones: milestones('p') }),
      'p',
    )
    expect(row.range).toEqual({ start: d('2026-03-10'), end: d('2026-04-15') })
    expect(row.rolledUp).toBe(true)
  })

  it('takes each missing end from the roll-up on its own', () => {
    const onlyStart = makeProject({ id: 's', startDate: '2026-03-01' })
    const onlyDue = makeProject({ id: 'e', dueDate: '2026-05-01' })
    const model = build({
      projects: [onlyStart, onlyDue],
      tasks: [...tasks('s'), ...tasks('e')],
      milestones: [...milestones('s'), ...milestones('e')],
    })
    expect(projectRow(model, 's').range).toEqual({ start: d('2026-03-01'), end: d('2026-04-15') })
    expect(projectRow(model, 's').rolledUp).toBe(true)
    expect(projectRow(model, 'e').range).toEqual({ start: d('2026-03-10'), end: d('2026-05-01') })
  })

  it('counts subtask dates and single-date tasks in the roll-up', () => {
    const p = makeProject({ id: 'p' })
    const parent = makeTask({ projectId: 'p', id: 'parent' })
    const model = build({
      projects: [p],
      tasks: [
        parent,
        makeTask({
          projectId: 'p',
          parentTaskId: 'parent',
          startDate: '2026-02-01',
          dueDate: '2026-02-03',
        }),
        makeTask({ projectId: 'p', dueDate: '2026-06-01' }),
      ],
    })
    expect(projectRow(model, 'p').range).toEqual({ start: d('2026-02-01'), end: d('2026-06-01') })
  })

  it('never produces an inverted range: an inconsistent mix becomes the union', () => {
    const p = makeProject({ id: 'p', dueDate: '2026-01-05' })
    const row = projectRow(build({ projects: [p], tasks: tasks('p') }), 'p')
    expect(row.range).toEqual({ start: d('2026-01-05'), end: d('2026-03-20') })
  })

  it('a single date overall is a one-day range', () => {
    const p = makeProject({ id: 'p', dueDate: '2026-07-01' })
    const row = projectRow(build({ projects: [p] }), 'p')
    expect(row.range).toEqual({ start: d('2026-07-01'), end: d('2026-07-01') })
    expect(row.rolledUp).toBe(false)
  })
})

describe('listing', () => {
  it('orders rows like the projects list (byte order of the keys, not locale order)', () => {
    const projects = [
      makeProject({ id: 'b', name: 'Lowercase key', sortOrder: 'a0', dueDate: '2026-01-01' }),
      makeProject({ id: 'a', name: 'Uppercase key', sortOrder: 'Zz', dueDate: '2026-01-01' }),
      makeProject({ id: 'c', name: 'Later key', sortOrder: 'a1', dueDate: '2026-01-01' }),
    ]
    expect(outline(build({ projects }))).toEqual([
      '> Uppercase key',
      '> Lowercase key',
      '> Later key',
    ])
  })

  it('lists active projects by default; completed on request; archived never', () => {
    const projects = [
      makeProject({ name: 'Active', sortOrder: 'a0', dueDate: '2026-01-01' }),
      makeProject({ name: 'Done', status: 'completed', sortOrder: 'a1', dueDate: '2026-01-01' }),
      makeProject({ name: 'Old', status: 'archived', sortOrder: 'a2', dueDate: '2026-01-01' }),
    ]
    const hidden = build({ projects })
    expect(outline(hidden)).toEqual(['> Active'])
    expect(hidden.projectCount).toBe(1)
    expect(hidden.completedCount).toBe(1)

    const shown = build({ projects }, { includeCompleted: true })
    expect(outline(shown)).toEqual(['> Active', '> Done'])
    expect(shown.projectCount).toBe(2)
    expect(shown.completedCount).toBe(1)
  })
})

describe('unscheduled bucket', () => {
  it('puts projects with nothing dated under a header at the bottom, in project order', () => {
    const model = build({
      projects: [
        makeProject({ id: 'u1', name: 'Idea', sortOrder: 'a0' }),
        makeProject({ id: 's1', name: 'Dated', sortOrder: 'a1', startDate: '2026-01-01' }),
        makeProject({ id: 'u2', name: 'Someday', sortOrder: 'a2' }),
        makeProject({ id: 's2', name: 'Via milestone', sortOrder: 'a3' }),
        makeProject({ id: 's3', name: 'Via task', sortOrder: 'a4' }),
      ],
      tasks: [
        makeTask({ projectId: 'u1', title: 'No date' }),
        makeTask({ projectId: 's3', startDate: '2026-02-01' }),
      ],
      milestones: [makeMilestone({ projectId: 's2', date: '2026-03-01' })],
    })
    expect(outline(model)).toEqual([
      '> Dated',
      '> Via milestone',
      '> Via task',
      '-- unscheduled (2)',
      '> Idea',
      '> Someday',
    ])
    expect(projectRow(model, 'u1').range).toBeNull()
    expect(model.projectCount).toBe(5)
    expect(model.scheduledCount).toBe(3)
    expect(model.firstProject?.name).toBe('Dated')
  })

  it('has no header when every project is scheduled', () => {
    const model = build({ projects: [makeProject({ startDate: '2026-01-01' })] })
    expect(model.rows.some((row) => row.key === UNSCHEDULED_SECTION_KEY)).toBe(false)
  })

  it('reports an all-unscheduled workspace (the empty state) and still lists its projects', () => {
    const model = build({ projects: [makeProject({ name: 'Idea' })] })
    expect(model.scheduledCount).toBe(0)
    expect(model.bounds).toBeNull()
    expect(model.firstProject?.name).toBe('Idea')
    expect(outline(model)).toEqual(['-- unscheduled (1)', '> Idea'])
  })

  it('never expands an unscheduled project', () => {
    const p = makeProject({ id: 'p', name: 'Idea' })
    const model = build(
      { projects: [p], tasks: [makeTask({ projectId: 'p', title: 'No date' })] },
      { expanded: ['p'] },
    )
    expect(projectRow(model, 'p').childCount).toBe(0)
    expect(projectRow(model, 'p').expanded).toBe(false)
    expect(outline(model)).toEqual(['-- unscheduled (1)', '> Idea'])
  })
})

describe('expansion', () => {
  const seed = () => {
    const project = makeProject({ id: 'p', name: 'Launch' })
    const phase = makePhase({ projectId: 'p', id: 'ph' })
    return {
      projects: [project],
      phases: [phase],
      tasks: [
        makeTask({
          projectId: 'p',
          title: 'In phase',
          phaseId: 'ph',
          dueDate: '2026-03-02',
          sortOrder: 'a0',
        }),
        makeTask({ projectId: 'p', title: 'No phase', startDate: '2026-03-01', sortOrder: 'a1' }),
        makeTask({ projectId: 'p', title: 'Undated', sortOrder: 'a2' }),
        makeTask({ projectId: 'p', title: 'Parent', id: 'parent', sortOrder: 'a3' }),
        makeTask({
          projectId: 'p',
          title: 'Dated child',
          parentTaskId: 'parent',
          startDate: '2026-03-03',
          dueDate: '2026-03-04',
        }),
        makeTask({
          projectId: 'p',
          title: 'Parent with dates',
          id: 'dated-parent',
          startDate: '2026-03-05',
          dueDate: '2026-03-06',
          sortOrder: 'a4',
        }),
        makeTask({
          projectId: 'p',
          title: 'Late child',
          parentTaskId: 'dated-parent',
          startDate: '2026-03-07',
          dueDate: '2026-03-09',
        }),
      ],
      milestones: [
        makeMilestone({ projectId: 'p', name: 'Second', date: '2026-04-01' }),
        makeMilestone({ projectId: 'p', name: 'First', date: '2026-03-15', phaseId: 'ph' }),
      ],
    }
  }

  it('is collapsed by default, so the chart stays one row per project', () => {
    const model = build(seed())
    expect(outline(model)).toEqual(['> Launch'])
    // Four scheduled top-level tasks + two milestones are waiting behind the chevron.
    expect(projectRow(model, 'p').childCount).toBe(6)
  })

  it('lists scheduled top-level tasks in outline order, then milestones by date', () => {
    const model = build(seed(), { expanded: ['p'] })
    expect(outline(model)).toEqual([
      'v Launch',
      '  In phase',
      '  No phase',
      '  Parent',
      '  Parent with dates',
      '  ◆First',
      '  ◆Second',
    ])
  })

  it('keeps the Gantt row shape: spans, roll-ups, and no subtask chevron', () => {
    const model = build(seed(), { expanded: ['p'] })
    const byTitle = (title: string) => {
      const row = model.rows.find((r) => r.kind === 'task' && r.task.title === title)
      if (row?.kind !== 'task') throw new Error(`no row for ${title}`)
      return row
    }
    expect(byTitle('In phase').span).toMatchObject({ kind: 'due_only', end: d('2026-03-02') })
    expect(byTitle('No phase').span).toMatchObject({ kind: 'start_only', start: d('2026-03-01') })
    expect(byTitle('Parent').rollup).toEqual({ start: d('2026-03-03'), end: d('2026-03-04') })
    expect(byTitle('Parent with dates').span.kind).toBe('range')
    expect(byTitle('Parent with dates').subtaskRollup).toEqual({
      start: d('2026-03-07'),
      end: d('2026-03-09'),
    })
    for (const title of ['Parent', 'Parent with dates']) {
      expect(byTitle(title).subtaskCount).toBe(0)
      expect(byTitle(title).collapsed).toBe(false)
      expect(byTitle(title).drawable).toBe(false)
    }
  })

  it('only expands the requested projects, and their rows stay under them', () => {
    const other = makeProject({ id: 'o', name: 'Other', sortOrder: 'a5' })
    const seeded = seed()
    const model = build(
      {
        ...seeded,
        projects: [...seeded.projects, other],
        tasks: [
          ...seeded.tasks,
          makeTask({ projectId: 'o', title: 'Theirs', dueDate: '2026-05-01' }),
        ],
      },
      { expanded: ['o', 'missing-project'] },
    )
    expect(outline(model)).toEqual(['> Launch', 'v Other', '  Theirs'])
  })

  it('has nothing to expand when only the project itself is dated', () => {
    const p = makeProject({ id: 'p', name: 'Own dates', startDate: '2026-01-01' })
    const model = build(
      { projects: [p], tasks: [makeTask({ projectId: 'p', title: 'Undated' })] },
      { expanded: ['p'] },
    )
    expect(projectRow(model, 'p').childCount).toBe(0)
    expect(projectRow(model, 'p').expanded).toBe(false)
    expect(outline(model)).toEqual(['> Own dates'])
  })

  it('adds up row heights: project rows are taller than task rows', () => {
    const collapsed = build(seed())
    expect(collapsed.totalHeight).toBe(PROJECT_ROW_HEIGHT)
    const open = build(seed(), { expanded: ['p'] })
    expect(open.totalHeight).toBe(PROJECT_ROW_HEIGHT + 6 * 32)
    expect(open.rows.map(rowHeightOf).reduce((a, b) => a + b)).toBe(open.totalHeight)
  })
})

describe('project row contents', () => {
  it('marks milestones on the row by date; a corrupt date gets no diamond but no crash', () => {
    const p = makeProject({ id: 'p', startDate: '2026-01-01' })
    const model = build({
      projects: [p],
      milestones: [
        makeMilestone({ projectId: 'p', id: 'late', date: '2026-03-01' }),
        makeMilestone({ projectId: 'p', id: 'early', date: '2026-02-01' }),
        makeMilestone({ projectId: 'p', id: 'bad', date: 'not-a-date' }),
      ],
    })
    const marks = projectRow(model, 'p').milestones
    expect(marks.map((mark) => mark.milestone.id)).toEqual(['early', 'late'])
    expect(marks[0].day).toBe(d('2026-02-01'))
  })

  it('computes progress from leaf tasks; milestones never count', () => {
    const p = makeProject({ id: 'p', startDate: '2026-01-01' })
    const model = build({
      projects: [p],
      tasks: [
        makeTask({ projectId: 'p', id: 'parent' }),
        makeTask({ projectId: 'p', parentTaskId: 'parent', status: 'done' }),
        makeTask({ projectId: 'p', parentTaskId: 'parent' }),
        makeTask({ projectId: 'p' }),
      ],
      milestones: [makeMilestone({ projectId: 'p', date: '2026-02-01' })],
    })
    expect(projectRow(model, 'p').progress).toMatchObject({ done: 1, total: 3, percent: 33 })
  })

  it('reports "No tasks", never a fake 100%, for a project without tasks', () => {
    const p = makeProject({ id: 'p', startDate: '2026-01-01' })
    const row = projectRow(build({ projects: [p] }), 'p')
    expect(row.progress.ratio).toBeNull()
    expect(progressLabel(row.progress)).toBe('No tasks')
  })

  it('finds each project’s next milestone, today included', () => {
    const model = build({
      projects: [
        makeProject({ id: 'a', sortOrder: 'a0', startDate: '2026-01-01' }),
        makeProject({ id: 'b', sortOrder: 'a1', startDate: '2026-01-01' }),
        makeProject({ id: 'c', sortOrder: 'a2', startDate: '2026-01-01' }),
      ],
      milestones: [
        makeMilestone({ projectId: 'a', id: 'a-past', date: '2026-01-01' }),
        makeMilestone({ projectId: 'a', id: 'a-today', date: '2026-02-01' }),
        makeMilestone({ projectId: 'a', id: 'a-later', date: '2026-03-01' }),
        makeMilestone({ projectId: 'b', id: 'b-later', date: '2026-02-02' }),
        makeMilestone({ projectId: 'c', id: 'c-past', date: '2026-01-02' }),
      ],
    })
    expect([...nextMilestoneIds(model.rows, '2026-02-01')].sort()).toEqual(['a-today', 'b-later'])
  })

  it('words the row for the tooltip and screen readers', () => {
    const own = makeProject({ id: 'own', startDate: '2026-11-02', dueDate: '2026-11-10' })
    const rolled = makeProject({ id: 'rolled', sortOrder: 'a1' })
    const model = build({
      projects: [own, rolled],
      tasks: [
        makeTask({ projectId: 'own', status: 'done' }),
        makeTask({ projectId: 'own' }),
        makeTask({ projectId: 'rolled', startDate: '2026-11-01', dueDate: '2026-11-03' }),
      ],
      milestones: [makeMilestone({ projectId: 'rolled', date: '2026-11-03' })],
    })
    expect(projectRowSummary(projectRow(model, 'own'), '2026-11-04')).toBe(
      'Nov 2 – Nov 10 · 1 of 2 tasks done · 50%',
    )
    expect(projectRowSummary(projectRow(model, 'rolled'), '2026-11-04')).toBe(
      'Nov 1 – Nov 3 (from its tasks and milestones) · 0 of 1 task done · 0% · 1 milestone',
    )

    // Only the end that really comes from the tasks is described as rolled up.
    const dueOnly = makeProject({ id: 'dueOnly', sortOrder: 'a2', dueDate: '2026-12-09' })
    const startOnly = makeProject({ id: 'startOnly', sortOrder: 'a3', startDate: '2026-11-01' })
    const half = build({
      projects: [dueOnly, startOnly],
      tasks: [
        makeTask({ projectId: 'dueOnly', startDate: '2026-10-30', dueDate: '2026-11-09' }),
        makeTask({ projectId: 'startOnly', startDate: '2026-11-05', dueDate: '2026-11-20' }),
      ],
    })
    expect(projectRowSummary(projectRow(half, 'dueOnly'), '2026-11-04')).toBe(
      'Oct 30 – Dec 9 (start from its tasks and milestones) · 0 of 1 task done · 0%',
    )
    expect(projectRowSummary(projectRow(half, 'startOnly'), '2026-11-04')).toBe(
      'Nov 1 – Nov 20 (end from its tasks and milestones) · 0 of 1 task done · 0%',
    )

    const done = makeProject({ id: 'done', status: 'completed', dueDate: '2026-11-02' })
    const shown = build({ projects: [done] }, { includeCompleted: true })
    expect(projectRowSummary(projectRow(shown, 'done'), '2026-11-04')).toBe(
      'Completed · Due Nov 2 · No tasks',
    )

    const idea = makeProject({ id: 'idea', startDate: 'not-a-date' })
    expect(projectRowSummary(projectRow(build({ projects: [idea] }), 'idea'), '2026-11-04')).toBe(
      'No dates · No tasks',
    )
  })
})

describe('bounds', () => {
  it('spans every listed project, collapsed or not, and ignores hidden ones', () => {
    const model = build({
      projects: [
        makeProject({ id: 'a', sortOrder: 'a0', startDate: '2026-02-01' }),
        makeProject({ id: 'b', sortOrder: 'a1' }),
        makeProject({
          id: 'hidden',
          status: 'archived',
          startDate: '2020-01-01',
          dueDate: '2030-01-01',
        }),
      ],
      tasks: [makeTask({ projectId: 'a', dueDate: '2026-02-20' })],
      milestones: [makeMilestone({ projectId: 'b', date: '2026-06-01' })],
    })
    expect(model.bounds).toEqual({ start: d('2026-02-01'), end: d('2026-06-01') })
  })

  it('includes tasks outside an explicit project range, so they can be scrolled to', () => {
    const p = makeProject({ id: 'p', startDate: '2026-02-01', dueDate: '2026-02-10' })
    const model = build({
      projects: [p],
      tasks: [makeTask({ projectId: 'p', dueDate: '2026-09-01' })],
    })
    expect(model.bounds).toEqual({ start: d('2026-02-01'), end: d('2026-09-01') })
    expect(projectRow(model, 'p').range).toEqual({ start: d('2026-02-01'), end: d('2026-02-10') })
  })

  it('is null when nothing is dated', () => {
    expect(build({ projects: [makeProject()] }).bounds).toBeNull()
    expect(build({ projects: [] }).bounds).toBeNull()
  })

  it('ignores dependencies and other rows it does not list', () => {
    const p = makeProject({ id: 'p', startDate: '2026-02-01' })
    const a = makeTask({ projectId: 'p', id: 'a' })
    const b = makeTask({ projectId: 'p', id: 'b' })
    const model = build({
      projects: [p],
      tasks: [a, b, makeTask({ projectId: 'gone', dueDate: '1999-01-01' })],
      dependencies: [makeDependency({ projectId: 'p', predecessorId: 'a', successorId: 'b' })],
    })
    expect(model.bounds).toEqual({ start: d('2026-02-01'), end: d('2026-02-01') })
    expect(outline(model)).toEqual(['> Project'])
  })
})
