import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEPENDENCY_TYPES,
  DESCRIPTION_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PHASE_COLORS,
  PROJECT_COLORS,
  PROJECT_STATUSES,
  SCHEDULE_MODES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  THEME_PREFERENCES,
  TITLE_MAX_LENGTH,
} from '../../src/domain/types.ts'
import {
  expectPgError,
  insertRow,
  makeDependency,
  makeMilestone,
  makePhase,
  makeProject,
  makeTask,
  type DependencyRow,
  type PreferencesRow,
  type ProjectRow,
  type TaskRow,
} from './fixtures.ts'
import { createTestDb, type TestDb, type UserClient } from './harness.ts'

let db: TestDb
let alice: UserClient
let projectId: string

beforeAll(async () => {
  db = await createTestDb()
  alice = await db.createUser()
  projectId = (await makeProject(alice)).id
})

afterAll(async () => {
  await db.close()
})

describe('defaults', () => {
  it('fills project defaults', async () => {
    const project = await insertRow<ProjectRow>(alice, 'projects', { name: 'P', sort_order: 'a0' })
    expect(project).toMatchObject({
      user_id: alice.id,
      description: null,
      status: 'active',
      color: 'gray',
      start_date: null,
      due_date: null,
      schedule_mode: 'manual',
    })
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(project.created_at).toBeInstanceOf(Date)
    expect(project.updated_at).toBeInstanceOf(Date)
  })

  it('fills task and dependency defaults', async () => {
    const task = await insertRow<TaskRow>(alice, 'tasks', {
      project_id: projectId,
      title: 'T',
      sort_order: 'a0',
    })
    expect(task).toMatchObject({
      status: 'todo',
      priority: 'none',
      phase_id: null,
      parent_task_id: null,
      completed_at: null,
    })
    const other = await makeTask(alice, projectId)
    const dependency = await insertRow<DependencyRow>(alice, 'task_dependencies', {
      project_id: projectId,
      predecessor_id: task.id,
      successor_id: other.id,
    })
    expect(dependency.type).toBe('FS')
  })

  it('fills preference defaults', async () => {
    const carol = await db.createUser()
    const preferences = await insertRow<PreferencesRow>(carol, 'user_preferences', {})
    expect(preferences).toMatchObject({
      user_id: carol.id,
      theme: 'system',
      sidebar_collapsed: false,
      timezone: 'Asia/Taipei',
      week_starts_on: 1,
    })
  })
})

describe('enumerations match src/domain/types.ts', () => {
  it('projects.status', async () => {
    for (const status of PROJECT_STATUSES) {
      expect((await makeProject(alice, { status })).status).toBe(status)
    }
    await expectPgError(makeProject(alice, { status: 'paused' }), '23514', 'projects_status_check')
  })

  it('projects.color', async () => {
    for (const color of PROJECT_COLORS) {
      expect((await makeProject(alice, { color })).color).toBe(color)
    }
    await expectPgError(makeProject(alice, { color: 'purple' }), '23514', 'projects_color_check')
  })

  it('phases.color: NULL (inherit the project colour) or a palette name, never red', async () => {
    expect((await makePhase(alice, projectId)).color).toBeNull() // default, existing rows too
    for (const color of PHASE_COLORS) {
      expect((await makePhase(alice, projectId, { color })).color).toBe(color)
    }
    await expectPgError(
      makePhase(alice, projectId, { color: 'red' }),
      '23514',
      'phases_color_valid',
    )
    await expectPgError(
      makePhase(alice, projectId, { color: '#ff0000' }),
      '23514',
      'phases_color_valid',
    )
    await expectPgError(makePhase(alice, projectId, { color: '' }), '23514', 'phases_color_valid')
    // Changing it later is subject to the same rule; clearing is allowed.
    const phase = await makePhase(alice, projectId, { color: 'teal' })
    const { rows } = await alice.query<{ color: string | null }>(
      'update phases set color = null where id = $1 returning color',
      [phase.id],
    )
    expect(rows[0].color).toBeNull()
    await expectPgError(
      alice.query('update phases set color = $2 where id = $1', [phase.id, 'red']),
      '23514',
      'phases_color_valid',
    )
  })

  it('projects.schedule_mode', async () => {
    for (const schedule_mode of SCHEDULE_MODES) {
      expect((await makeProject(alice, { schedule_mode })).schedule_mode).toBe(schedule_mode)
    }
    await expectPgError(
      makeProject(alice, { schedule_mode: 'smart' }),
      '23514',
      'projects_schedule_mode_check',
    )
  })

  it('tasks.status', async () => {
    for (const status of TASK_STATUSES) {
      expect((await makeTask(alice, projectId, { status })).status).toBe(status)
    }
    await expectPgError(
      makeTask(alice, projectId, { status: 'blocked' }),
      '23514',
      'tasks_status_check',
    )
  })

  it('tasks.priority', async () => {
    for (const priority of TASK_PRIORITIES) {
      expect((await makeTask(alice, projectId, { priority })).priority).toBe(priority)
    }
    await expectPgError(
      makeTask(alice, projectId, { priority: 'critical' }),
      '23514',
      'tasks_priority_check',
    )
  })

  it('task_dependencies.type', async () => {
    for (const type of DEPENDENCY_TYPES) {
      const [p, s] = [await makeTask(alice, projectId), await makeTask(alice, projectId)]
      expect((await makeDependency(alice, projectId, p.id, s.id, { type })).type).toBe(type)
    }
    const [p, s] = [await makeTask(alice, projectId), await makeTask(alice, projectId)]
    await expectPgError(
      makeDependency(alice, projectId, p.id, s.id, { type: 'SS' }),
      '23514',
      'task_dependencies_type_check',
    )
  })

  it('user_preferences.theme and week_starts_on', async () => {
    for (const theme of THEME_PREFERENCES) {
      const user = await db.createUser()
      expect((await insertRow<PreferencesRow>(user, 'user_preferences', { theme })).theme).toBe(
        theme,
      )
    }
    for (const week_starts_on of [0, 1]) {
      const user = await db.createUser()
      const row = await insertRow<PreferencesRow>(user, 'user_preferences', { week_starts_on })
      expect(row.week_starts_on).toBe(week_starts_on)
    }
    const user = await db.createUser()
    await expectPgError(insertRow(user, 'user_preferences', { theme: 'sepia' }), '23514')
    await expectPgError(insertRow(user, 'user_preferences', { week_starts_on: 6 }), '23514')
  })
})

describe('names and titles', () => {
  const cases = [
    {
      label: 'projects.name',
      max: NAME_MAX_LENGTH,
      insert: (name: string) => makeProject(alice, { name }),
    },
    {
      label: 'phases.name',
      max: NAME_MAX_LENGTH,
      insert: (name: string) => makePhase(alice, projectId, { name }),
    },
    {
      label: 'milestones.name',
      max: NAME_MAX_LENGTH,
      insert: (name: string) => makeMilestone(alice, projectId, { name }),
    },
    {
      label: 'tasks.title',
      max: TITLE_MAX_LENGTH,
      insert: (title: string) => makeTask(alice, projectId, { title }),
    },
  ]

  it.each(cases)(
    '$label accepts 1..$max characters (counted as characters, not bytes)',
    async ({ max, insert }) => {
      await insert('x')
      await insert('a'.repeat(max))
      await insert('研'.repeat(max))
      await insert('  padded  ')
    },
  )

  it.each(cases)('$label rejects empty, blank and over-long values', async ({ max, insert }) => {
    for (const value of ['', '   ', '\t\n', 'a'.repeat(max + 1)]) {
      await expectPgError(insert(value), '23514')
    }
    await expectPgError(insert(null as unknown as string), '23502')
  })
})

describe('descriptions', () => {
  it.each([
    ['projects', (description: unknown) => makeProject(alice, { description })],
    ['tasks', (description: unknown) => makeTask(alice, projectId, { description })],
  ] as const)('%s.description is optional and at most 10000 characters', async (_, insert) => {
    await insert(null)
    await insert('')
    await insert('d'.repeat(DESCRIPTION_MAX_LENGTH))
    await expectPgError(insert('d'.repeat(DESCRIPTION_MAX_LENGTH + 1)), '23514')
  })
})

describe('dates', () => {
  it.each([
    ['projects', (values: Record<string, unknown>) => makeProject(alice, values)],
    ['tasks', (values: Record<string, unknown>) => makeTask(alice, projectId, values)],
  ] as const)('%s: due date may not be before start date', async (_, insert) => {
    await insert({ start_date: '2026-11-02', due_date: '2026-11-02' })
    await insert({ start_date: '2026-11-02', due_date: '2026-11-30' })
    await insert({ start_date: '2026-11-02' })
    await insert({ due_date: '2026-11-02' })
    await expectPgError(
      insert({ start_date: '2026-11-03', due_date: '2026-11-02' }),
      '23514',
      'due_after_start',
    )
  })

  it('tasks: date order is enforced on update too', async () => {
    const task = await makeTask(alice, projectId, {
      start_date: '2026-11-02',
      due_date: '2026-11-04',
    })
    await expectPgError(
      alice.query(`update public.tasks set due_date = '2026-11-01' where id = $1`, [task.id]),
      '23514',
      'tasks_due_after_start',
    )
  })

  it.each([
    ['projects.start_date', (date: string) => makeProject(alice, { start_date: date })],
    ['projects.due_date', (date: string) => makeProject(alice, { due_date: date })],
    ['tasks.start_date', (date: string) => makeTask(alice, projectId, { start_date: date })],
    ['tasks.due_date', (date: string) => makeTask(alice, projectId, { due_date: date })],
    ['milestones.date', (date: string) => makeMilestone(alice, projectId, { date })],
  ] as const)('%s only stores dates that serialise as YYYY-MM-DD', async (_, insert) => {
    await insert('0001-01-01')
    await insert('9999-12-31')
    for (const value of ['infinity', '-infinity', '10000-01-01', '0001-12-31 BC']) {
      await expectPgError(insert(value), '23514')
    }
  })

  it('milestones.date is required', async () => {
    await expectPgError(makeMilestone(alice, projectId, { date: null }), '23502')
  })
})

describe('other rules', () => {
  it('sort_order is required and never empty', async () => {
    await expectPgError(
      makeProject(alice, { sort_order: '' }),
      '23514',
      'projects_sort_order_not_empty',
    )
    await expectPgError(makePhase(alice, projectId, { sort_order: '' }), '23514')
    await expectPgError(makeTask(alice, projectId, { sort_order: '' }), '23514')
    await expectPgError(makeTask(alice, projectId, { sort_order: null }), '23502')
  })

  it('a task cannot be its own parent', async () => {
    const task = await makeTask(alice, projectId)
    await expectPgError(
      alice.query('update public.tasks set parent_task_id = id where id = $1', [task.id]),
      '23514',
      'A task cannot be its own parent',
    )
    const id = crypto.randomUUID()
    await expectPgError(makeTask(alice, projectId, { id, parent_task_id: id }), '23514')
  })

  it('a dependency cannot link a task to itself', async () => {
    const task = await makeTask(alice, projectId)
    await expectPgError(
      makeDependency(alice, projectId, task.id, task.id),
      '23514',
      'A task cannot depend on itself',
    )
  })

  it('user_preferences.timezone is 1..100 characters', async () => {
    await expectPgError(
      insertRow(await db.createUser(), 'user_preferences', { timezone: '' }),
      '23514',
    )
    await expectPgError(
      insertRow(await db.createUser(), 'user_preferences', { timezone: 'x'.repeat(101) }),
      '23514',
    )
  })

  it('user_preferences has one row per user', async () => {
    const user = await db.createUser()
    await insertRow(user, 'user_preferences', {})
    await expectPgError(insertRow(user, 'user_preferences', {}), '23505')
  })
})
