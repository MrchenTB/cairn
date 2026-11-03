import { describe, expect, it } from 'vitest'
import { wouldCreateCycle } from './scheduling'
import {
  makeDependency,
  makeMilestone,
  makePhase,
  makeProject,
  makeTask,
  makeWorkspace,
  seededRandom,
} from './testFactories'
import type {
  BackupFile,
  Dependency,
  ISODate,
  Phase,
  Preferences,
  Project,
  Task,
  WorkspaceData,
} from './types'
import { parseBackupFile, validateDateRange, validateDescription, validateName } from './validation'

describe('storable text', () => {
  it('rejects characters PostgreSQL cannot store (NUL, unpaired surrogates)', () => {
    expect(validateName('Launch\u0000', 200, 'Project name')?.message).toBe(
      'Project name contains an unsupported character.',
    )
    expect(validateName('Launch \ud83d', 500, 'Task title')?.message).toBe(
      'Task title contains an unsupported character.',
    )
    expect(validateName('\udc00Launch', 500, 'Task title')).not.toBeNull()
    expect(validateName('Launch 🚀 計畫', 500, 'Task title')).toBeNull()
    expect(validateDescription('notes\u0000')?.message).toBe(
      'Description contains an unsupported character.',
    )
    expect(validateDescription('🚀'.slice(0, 1))).not.toBeNull()
    expect(validateDescription('🚀 ok')).toBeNull()
  })
})

describe('validateName', () => {
  it('requires a non-blank value', () => {
    expect(validateName('', 200, 'Project name')).toEqual({
      kind: 'validation',
      message: 'Project name is required.',
    })
    expect(validateName(' \t\n ', 200, 'Project name')?.message).toBe('Project name is required.')
    expect(validateName(undefined as unknown as string, 200, 'Name')?.kind).toBe('validation')
    expect(validateName('Launch', 200, 'Project name')).toBeNull()
  })

  it('limits the trimmed length in characters', () => {
    expect(validateName('a'.repeat(200), 200, 'Project name')).toBeNull()
    expect(validateName(`  ${'a'.repeat(200)}  `, 200, 'Project name')).toBeNull()
    expect(validateName('a'.repeat(201), 200, 'Project name')?.message).toBe(
      'Project name must be at most 200 characters.',
    )
    // Emoji are one character each (code points), like PostgreSQL's char_length.
    expect(validateName('😀'.repeat(200), 200, 'Name')).toBeNull()
    expect(validateName('😀'.repeat(201), 200, 'Name')).not.toBeNull()
    expect(validateName('中'.repeat(500), 500, 'Task title')).toBeNull()
  })
})

describe('validateDateRange', () => {
  it('accepts empty and well-ordered ranges', () => {
    expect(validateDateRange(null, null)).toBeNull()
    expect(validateDateRange(undefined, undefined)).toBeNull()
    expect(validateDateRange('2026-11-02', null)).toBeNull()
    expect(validateDateRange(null, '2026-11-02')).toBeNull()
    expect(validateDateRange('2026-11-02', '2026-11-02')).toBeNull()
    expect(validateDateRange('2026-12-31', '2027-01-01')).toBeNull()
  })

  it('rejects malformed dates and due before start', () => {
    expect(validateDateRange('2026-02-30', null)?.message).toBe('Start date is not a valid date.')
    expect(validateDateRange('', null)?.message).toBe('Start date is not a valid date.')
    expect(validateDateRange(null, '11/02/2026')?.message).toBe('Due date is not a valid date.')
    expect(validateDateRange('2026-11-05', '2026-11-02')).toEqual({
      kind: 'validation',
      message: "Due date can't be before the start date.",
    })
  })
})

describe('validateDescription', () => {
  it('allows empty values and up to 10,000 characters', () => {
    expect(validateDescription(null)).toBeNull()
    expect(validateDescription(undefined)).toBeNull()
    expect(validateDescription('')).toBeNull()
    expect(validateDescription('x'.repeat(10_000))).toBeNull()
    expect(validateDescription('x'.repeat(10_001))?.message).toBe(
      'Description must be at most 10,000 characters.',
    )
  })
})

describe('parseBackupFile', () => {
  function validBackup() {
    return {
      app: 'cairn',
      formatVersion: 1,
      exportedAt: '2026-11-02T08:30:00.000Z',
      data: {
        projects: [
          makeProject({
            id: 'p1',
            name: 'Research',
            startDate: '2026-11-01',
            dueDate: '2026-12-31',
          }),
          makeProject({ id: 'p2', name: 'Community' }),
        ],
        phases: [
          makePhase({ projectId: 'p1', id: 'ph1', name: 'Design' }),
          makePhase({ projectId: 'p2', id: 'ph2', name: 'Plan' }),
        ],
        tasks: [
          makeTask({
            projectId: 'p1',
            id: 't1',
            title: 'Write report',
            phaseId: 'ph1',
            startDate: '2026-11-02',
            dueDate: '2026-11-04',
          }),
          makeTask({
            projectId: 'p1',
            id: 't2',
            title: 'Outline',
            parentTaskId: 't1',
            phaseId: 'ph1',
            status: 'done',
            completedAt: '2026-11-02T08:30:00.123456+00:00',
          }),
          makeTask({ projectId: 'p1', id: 't3', title: 'Review' }),
          makeTask({ projectId: 'p2', id: 't4', title: 'Venue' }),
        ],
        milestones: [
          makeMilestone({
            projectId: 'p1',
            phaseId: 'ph1',
            id: 'm1',
            name: 'Submit',
            date: '2026-11-30',
          }),
        ],
        dependencies: [
          makeDependency({ projectId: 'p1', id: 'd1', predecessorId: 't1', successorId: 't3' }),
        ],
      },
      preferences: {
        theme: 'dark',
        sidebarCollapsed: false,
        timezone: 'Asia/Taipei',
        weekStartsOn: 1,
      },
    }
  }
  type RawBackup = ReturnType<typeof validBackup>

  function parseWith(edit: (file: RawBackup) => void) {
    const file = structuredClone(validBackup())
    edit(file)
    return parseBackupFile(file)
  }

  function errorOf(result: ReturnType<typeof parseBackupFile>): string {
    expect(result.ok).toBe(false)
    if (result.ok) return ''
    expect(result.error.kind).toBe('validation')
    return result.error.message
  }

  it('accepts a valid backup and returns it typed', () => {
    const input = validBackup()
    const result = parseBackupFile(JSON.parse(JSON.stringify(input)))
    expect(result.ok).toBe(true)
    if (result.ok) {
      const file: BackupFile = result.value
      expect(file).toEqual(input)
    }
  })

  it('accepts an empty workspace (what a fresh account exports)', () => {
    const result = parseBackupFile({
      app: 'cairn',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      data: { projects: [], phases: [], tasks: [], milestones: [], dependencies: [] },
      preferences: null,
    })
    expect(result.ok).toBe(true)
  })

  it('drops unknown fields and tolerates missing or unreadable preferences', () => {
    const extra = parseWith((file) => {
      Object.assign(file, { comment: 'hi' })
      Object.assign(file.data.tasks[0], { color: 'red' })
    })
    expect(extra.ok).toBe(true)
    if (extra.ok) {
      expect(extra.value).not.toHaveProperty('comment')
      expect(extra.value.data.tasks[0]).not.toHaveProperty('color')
    }
    const missing = parseWith((file) => {
      delete (file as Partial<RawBackup>).preferences
    })
    expect(missing.ok && missing.value.preferences).toBeNull()
    const unreadable = parseWith((file) => {
      file.preferences.theme = 'neon'
    })
    expect(unreadable.ok && unreadable.value.preferences).toBeNull()
  })

  it('rejects files that are not Cairn backups', () => {
    for (const input of [null, undefined, 42, 'text', [], {}, { app: 'other', formatVersion: 1 }]) {
      expect(errorOf(parseBackupFile(input))).toBe("This file isn't a Cairn backup.")
    }
  })

  it('rejects other format versions with a clear message', () => {
    expect(errorOf(parseWith((file) => (file.formatVersion = 2)))).toMatch(
      /Unsupported backup format version 2 .*version 1/,
    )
    expect(errorOf(parseWith((file) => Object.assign(file, { formatVersion: '1' })))).toMatch(
      /version "1"/,
    )
    expect(errorOf(parseWith((file) => delete (file as Partial<RawBackup>).formatVersion))).toMatch(
      /version missing/,
    )
  })

  it('reports shape problems with readable paths', () => {
    expect(
      errorOf(parseWith((file) => Object.assign(file.data.tasks[2], { status: 'blocked' }))),
    ).toMatch(/^This backup file is invalid\. tasks\[2\]\.status: .*todo/)
    expect(errorOf(parseWith((file) => (file.data.tasks[0].title = '   ')))).toContain(
      'tasks[0].title: Task title is required.',
    )
    expect(errorOf(parseWith((file) => (file.data.tasks[0].title = 'x'.repeat(501))))).toContain(
      'Task title must be at most 500 characters.',
    )
    expect(errorOf(parseWith((file) => (file.data.projects[0].dueDate = '2026-02-30')))).toContain(
      'projects[0].dueDate: Invalid date (expected YYYY-MM-DD).',
    )
    expect(errorOf(parseWith((file) => (file.data.milestones[0].date = '')))).toContain(
      'milestones[0].date',
    )
    expect(errorOf(parseWith((file) => (file.exportedAt = 'yesterday')))).toContain(
      'exportedAt: Invalid timestamp.',
    )
    expect(
      errorOf(parseWith((file) => delete (file.data as Partial<RawBackup['data']>).phases)),
    ).toContain('phases:')
    expect(errorOf(parseWith((file) => Object.assign(file.data.tasks[0], { id: 7 })))).toContain(
      'tasks[0].id',
    )
    // A missing section is named, not reported as a bare "expected object".
    expect(
      errorOf(
        parseBackupFile({ app: 'cairn', formatVersion: 1, exportedAt: '2026-11-02T08:30:00Z' }),
      ),
    ).toMatch(/^This backup file is invalid\. data: /)
  })

  it('returns names trimmed (the form the app stores), so database length limits hold', () => {
    const result = parseWith((file) => {
      file.data.projects[0].name = '  Research  '
      file.data.phases[0].name = '\tDesign\n'
      file.data.tasks[0].title = ` ${'x'.repeat(500)} ` // 502 characters as written
      file.data.milestones[0].name = 'Submit　' // ideographic space
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const { projects, phases, tasks, milestones } = result.value.data
      expect(projects[0].name).toBe('Research')
      expect(phases[0].name).toBe('Design')
      expect(tasks[0].title).toBe('x'.repeat(500))
      expect(milestones[0].name).toBe('Submit')
    }
  })

  it('never throws, whatever the header holds', () => {
    expect(errorOf(parseBackupFile({ app: 'cairn', formatVersion: 1n }))).toMatch(
      /^Unsupported backup format version/,
    )
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(errorOf(parseBackupFile({ app: 'cairn', formatVersion: cyclic }))).toMatch(
      /^Unsupported backup format version/,
    )
  })

  const violations: Array<[string, (file: RawBackup) => void, RegExp]> = [
    ['duplicate task id', (f) => (f.data.tasks[3].id = 't1'), /Duplicate task id "t1"\./],
    ['duplicate project id', (f) => (f.data.projects[1].id = 'p1'), /Duplicate project id "p1"\./],
    [
      'task in a missing project',
      (f) => (f.data.tasks[2].projectId = 'nope'),
      /Task "Review" belongs to a project that isn't in the file\./,
    ],
    [
      'phase in a missing project',
      (f) => (f.data.phases[1].projectId = 'nope'),
      /Phase "Plan" belongs to a project that isn't in the file\./,
    ],
    [
      'task with a missing phase',
      (f) => (f.data.tasks[2].phaseId = 'nope'),
      /Task "Review" refers to a phase that isn't in the file\./,
    ],
    [
      'task with a phase of another project',
      (f) => (f.data.tasks[2].phaseId = 'ph2'),
      /Task "Review" refers to a phase of another project\./,
    ],
    [
      'subtask with a missing parent',
      (f) => (f.data.tasks[1].parentTaskId = 'nope'),
      /Task "Outline" refers to a parent task that isn't in the file\./,
    ],
    [
      'task that is its own parent',
      (f) => (f.data.tasks[2].parentTaskId = 't3'),
      /Task "Review" is its own parent\./,
    ],
    [
      'parent in another project',
      (f) => (f.data.tasks[3].parentTaskId = 't1'),
      /Task "Venue" has a parent task in another project\./,
    ],
    [
      'two levels of subtasks',
      (f) => (f.data.tasks[2].parentTaskId = 't2'),
      /Task "Review" is nested more than one level deep/,
    ],
    [
      'task due before it starts',
      (f) => (f.data.tasks[0].dueDate = '2026-11-01'),
      /Task "Write report" is due before it starts\./,
    ],
    [
      'project due before it starts',
      (f) => (f.data.projects[0].dueDate = '2026-10-01'),
      /Project "Research" is due before it starts\./,
    ],
    [
      'milestone in a missing project',
      (f) => (f.data.milestones[0].projectId = 'nope'),
      /Milestone "Submit" belongs to a project that isn't in the file\./,
    ],
    [
      'milestone with a phase of another project',
      (f) => (f.data.milestones[0].phaseId = 'ph2'),
      /Milestone "Submit" refers to a phase of another project\./,
    ],
    [
      'dependency on a missing task',
      (f) => (f.data.dependencies[0].successorId = 'nope'),
      /A dependency refers to a task that isn't in the file\./,
    ],
    [
      'self dependency',
      (f) => (f.data.dependencies[0].successorId = 't1'),
      /Task "Write report" depends on itself\./,
    ],
    [
      'cross-project dependency',
      (f) => (f.data.dependencies[0].successorId = 't4'),
      /"Write report" → "Venue" links tasks of different projects\./,
    ],
    [
      'dependency filed under the wrong project',
      (f) => (f.data.dependencies[0].projectId = 'p2'),
      /is filed under the wrong project\./,
    ],
    [
      'dependency between parent and subtask',
      (f) => (f.data.dependencies[0].successorId = 't2'),
      /"Write report" → "Outline" links a task to its own parent or subtask\./,
    ],
    [
      'duplicate dependency',
      (f) =>
        f.data.dependencies.push(
          makeDependency({ projectId: 'p1', id: 'd2', predecessorId: 't1', successorId: 't3' }),
        ),
      /"Write report" → "Review" appears more than once\./,
    ],
    [
      'duplicate dependency id',
      (f) =>
        f.data.dependencies.push(
          makeDependency({ projectId: 'p1', id: 'd1', predecessorId: 't3', successorId: 't2' }),
        ),
      /Duplicate dependency id "d1"\./,
    ],
    [
      'dependency cycle',
      (f) =>
        f.data.dependencies.push(
          makeDependency({ projectId: 'p1', id: 'd2', predecessorId: 't3', successorId: 't1' }),
        ),
      /Dependencies form a cycle between ("Write report", "Review"|"Review", "Write report")\./,
    ],
    [
      'title with a NUL character',
      (f) => (f.data.tasks[0].title = 'Write\u0000report'),
      /tasks\[0\]\.title: Task title contains an unsupported character\./,
    ],
    [
      'description with an unpaired surrogate',
      (f) => (f.data.projects[0].description = 'notes \ud800'),
      /projects\[0\]\.description: Description contains an unsupported character\./,
    ],
    [
      'sort order with a NUL character',
      (f) => (f.data.tasks[0].sortOrder = 'a0\u0000'),
      /tasks\[0\]\.sortOrder: /,
    ],
  ]

  it.each(violations)('rejects a %s', (_name, edit, message) => {
    expect(errorOf(parseWith(edit))).toMatch(message)
  })

  /** What an export of `data` looks like on disk (records → arrays, through JSON). */
  function exportOf(data: WorkspaceData, preferences: Preferences | null): unknown {
    return JSON.parse(
      JSON.stringify({
        app: 'cairn',
        formatVersion: 1,
        exportedAt: '2026-11-02T08:30:00.000Z',
        data: {
          projects: Object.values(data.projects),
          phases: Object.values(data.phases),
          tasks: Object.values(data.tasks),
          milestones: Object.values(data.milestones),
          dependencies: Object.values(data.dependencies),
        },
        preferences,
      }),
    )
  }

  /** Valid workspace data in the shapes the database and local mode produce. */
  function randomWorkspace(random: () => number): WorkspaceData {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
    const timestamps = [
      '2026-11-02T08:30:00.123456+00:00', // PostgREST
      '2026-11-02T08:30:00+00:00', // PostgREST, whole second
      '2026-11-02T08:30:00.12+00:00', // PostgREST trims trailing zeros
      '2026-11-02T08:30:00.000Z', // local mode (toISOString)
      '2026-11-02T16:30:00+08:00',
    ]
    const names = [
      'Research',
      '研究計畫 2026',
      'Launch 🚀',
      'a  b',
      'x'.repeat(200),
      '😀'.repeat(200),
    ]
    const titles = [...names, '中'.repeat(500), '😀'.repeat(500), 'Q4 報告 · draft']
    const days: ISODate[] = ['0001-01-01', '2024-02-29', '2026-11-02', '2026-12-31', '9999-12-31']
    const range = (): [ISODate | null, ISODate | null] => {
      const [a, b] = [pick(days), pick(days)].sort()
      const kind = random()
      return kind < 0.4 ? [a, b] : kind < 0.6 ? [a, null] : kind < 0.8 ? [null, b] : [null, null]
    }
    const stamps = () => ({ createdAt: pick(timestamps), updatedAt: pick(timestamps) })

    const projects: Project[] = []
    const phases: Phase[] = []
    const tasks: Task[] = []
    const dependencies: Dependency[] = []
    for (let p = 0; p < 3; p++) {
      const [startDate, dueDate] = range()
      const project = makeProject({
        name: pick(names),
        description: pick([null, '', 'd'.repeat(10_000), '說明\n第二行']),
        status: pick(['active', 'completed', 'archived'] as const),
        color: pick(['gray', 'teal'] as const),
        startDate,
        dueDate,
        scheduleMode: pick(['manual', 'auto'] as const),
        sortOrder: pick(['a0', 'a1', 'Zz', 'a0V']),
        ...stamps(),
      })
      projects.push(project)
      const projectPhases = Array.from({ length: Math.floor(random() * 3) }, () =>
        makePhase({ projectId: project.id, name: pick(names), ...stamps() }),
      )
      phases.push(...projectPhases)
      const projectTasks: Task[] = []
      for (let t = 0; t < 8; t++) {
        const parent = random() < 0.4 ? projectTasks.find((x) => !x.parentTaskId) : undefined
        const status = pick(['todo', 'in_progress', 'done'] as const)
        const [startDate, dueDate] = range()
        projectTasks.push(
          makeTask({
            projectId: project.id,
            parentTaskId: parent?.id ?? null,
            phaseId: parent ? parent.phaseId : (pick([null, ...projectPhases])?.id ?? null),
            title: pick(titles),
            description: pick([null, '', 'notes']),
            status,
            priority: pick(['none', 'urgent'] as const),
            startDate,
            dueDate,
            completedAt: status === 'done' ? pick(timestamps) : null,
            ...stamps(),
          }),
        )
      }
      tasks.push(...projectTasks)
      for (let d = 0; d < 6; d++) {
        const [a, b] = [pick(projectTasks), pick(projectTasks)]
        const related = a.parentTaskId === b.id || b.parentTaskId === a.id
        const duplicate = dependencies.some(
          (x) => x.predecessorId === a.id && x.successorId === b.id,
        )
        if (a === b || related || duplicate || wouldCreateCycle(dependencies, a.id, b.id)) continue
        dependencies.push(
          makeDependency({ projectId: project.id, predecessorId: a.id, successorId: b.id }),
        )
      }
    }
    const milestones = projects.map((project) =>
      makeMilestone({ projectId: project.id, name: pick(names), date: pick(days), ...stamps() }),
    )
    return makeWorkspace({ projects, phases, tasks, milestones, dependencies })
  }

  it('parses every export of valid workspace data unchanged (round-trip property test)', () => {
    const random = seededRandom(2026)
    for (let round = 0; round < 40; round++) {
      const preferences: Preferences | null =
        round % 2 === 0
          ? null
          : {
              theme: 'dark',
              sidebarCollapsed: true,
              timezone: 'Pacific/Kiritimati',
              weekStartsOn: 0,
            }
      const file = exportOf(randomWorkspace(random), preferences)
      const result = parseBackupFile(file)
      expect(result.ok ? 'ok' : result.error.message).toBe('ok')
      if (result.ok) expect(result.value).toEqual(file)
    }
  })

  it('validates a 5,000-task backup quickly', () => {
    const tasks = Array.from({ length: 5_000 }, (_, i) =>
      makeTask({ projectId: 'p1', id: `t${i}`, title: `Task ${i}`, startDate: '2026-11-02' }),
    )
    const dependencies = tasks
      .slice(1)
      .map((task, i) =>
        makeDependency({ projectId: 'p1', predecessorId: tasks[i].id, successorId: task.id }),
      )
    const file = exportOf(
      makeWorkspace({ projects: [makeProject({ id: 'p1' })], tasks, dependencies }),
      null,
    )
    const started = performance.now()
    expect(parseBackupFile(file).ok).toBe(true)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('lists the first few problems and keeps all of them in the cause', () => {
    const result = parseWith((file) => {
      for (const task of file.data.tasks) task.projectId = 'nope'
      for (const phase of file.data.phases) phase.projectId = 'nope'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const problems = (result.error.cause as { problems: string[] }).problems
      expect(problems.length).toBeGreaterThan(5)
      expect(result.error.message).toMatch(/^This backup file is invalid\. /)
      expect(result.error.message).toContain(problems[0])
      expect(result.error.message).toContain(problems[4])
      expect(result.error.message).not.toContain(problems[5])
      expect(result.error.message).toMatch(
        new RegExp(`…and ${problems.length - 5} more problems?\\.$`),
      )
    }
  })
})
