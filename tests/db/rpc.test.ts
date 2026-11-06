import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  countAllOwned,
  expectPgError,
  getRow,
  makeDependency,
  makeProject,
  makeTask,
  seedWorkspace,
  snapshotOwned,
  type DependencyRow,
  type MilestoneRow,
  type PhaseRow,
  type ProjectRow,
  type TaskRow,
} from './fixtures.ts'
import { createTestDb, type DbClient, type TestDb, type UserClient } from './harness.ts'

let db: TestDb
let alice: UserClient
let bob: UserClient

beforeAll(async () => {
  db = await createTestDb()
  alice = await db.createUser()
  bob = await db.createUser()
})

afterAll(async () => {
  await db.close()
})

const LONG_AGO = new Date('2000-01-01T00:00:00Z')
const task = async (id: string) => (await getRow<TaskRow>(db.admin, 'tasks', id))!

describe('apply_task_schedule', () => {
  const schedule = (client: DbClient, changes: unknown) =>
    client.query<TaskRow>('select * from public.apply_task_schedule($1::jsonb)', [
      JSON.stringify(changes),
    ])

  async function threeTasks() {
    const project = await makeProject(alice)
    const dates = { start_date: '2026-11-02', due_date: '2026-11-03', updated_at: LONG_AGO }
    return Promise.all([1, 2, 3].map(() => makeTask(alice, project.id, dates)))
  }

  it('updates several tasks in one call and returns the stored rows', async () => {
    const [t1, t2, t3] = await threeTasks()
    const { rows } = await schedule(alice, [
      { id: t1.id, start_date: '2026-11-10', due_date: '2026-11-12' },
      { id: t2.id, start_date: null, due_date: '2026-11-20' },
    ])
    expect(rows.map((row) => [row.id, row.start_date, row.due_date]).sort()).toEqual(
      [
        [t1.id, '2026-11-10', '2026-11-12'],
        [t2.id, null, '2026-11-20'],
      ].sort(),
    )
    expect(rows.every((row) => row.updated_at.getTime() > LONG_AGO.getTime())).toBe(true)
    expect(await task(t1.id)).toMatchObject({ start_date: '2026-11-10', due_date: '2026-11-12' })
    expect(await task(t3.id)).toMatchObject({ start_date: '2026-11-02', due_date: '2026-11-03' })
  })

  it('can clear both dates', async () => {
    const [t1] = await threeTasks()
    await schedule(alice, [{ id: t1.id, start_date: null, due_date: null }])
    expect(await task(t1.id)).toMatchObject({ start_date: null, due_date: null })
  })

  it('treats an empty list as a no-op', async () => {
    expect((await schedule(alice, [])).rows).toEqual([])
  })

  it('changes nothing when one row has due before start', async () => {
    const [t1, t2] = await threeTasks()
    await expectPgError(
      schedule(alice, [
        { id: t1.id, start_date: '2026-11-10', due_date: '2026-11-12' },
        { id: t2.id, start_date: '2026-11-10', due_date: '2026-11-09' },
      ]),
      '23514',
      'Due date cannot be before start date',
    )
    expect(await task(t1.id)).toMatchObject({ start_date: '2026-11-02', due_date: '2026-11-03' })
  })

  it("changes nothing when one id is another user's task", async () => {
    const [t1, t2] = await threeTasks()
    const foreign = await makeTask(bob, (await makeProject(bob)).id, { due_date: '2026-01-01' })
    await expectPgError(
      schedule(alice, [
        { id: t1.id, start_date: '2026-11-10', due_date: '2026-11-12' },
        { id: foreign.id, start_date: '2030-01-01', due_date: '2030-01-02' },
        { id: t2.id, start_date: '2026-11-10', due_date: '2026-11-12' },
      ]),
      'P0002',
      'Some tasks could not be found',
    )
    expect(await task(t1.id)).toMatchObject({ start_date: '2026-11-02', due_date: '2026-11-03' })
    expect(await task(t2.id)).toMatchObject({ start_date: '2026-11-02', due_date: '2026-11-03' })
    expect(await task(foreign.id)).toMatchObject({ start_date: null, due_date: '2026-01-01' })
  })

  it('changes nothing when one id does not exist', async () => {
    const [t1] = await threeTasks()
    await expectPgError(
      schedule(alice, [
        { id: t1.id, start_date: '2026-11-10', due_date: '2026-11-12' },
        { id: randomUUID(), start_date: null, due_date: null },
      ]),
      'P0002',
    )
    expect(await task(t1.id)).toMatchObject({ start_date: '2026-11-02' })
  })

  it.each([
    ['not an array', { id: 'x' }, '22023', 'must be a JSON array'],
    ['an element that is not an object', [1], '22023', 'needs "id", "start_date" and "due_date"'],
    ['a missing key', [{ id: randomUUID(), start_date: null }], '22023', 'needs "id"'],
    ['a null id', [{ id: null, start_date: null, due_date: null }], '22023', 'needs a task id'],
    [
      'an invalid id',
      [{ id: 'abc', start_date: null, due_date: null }],
      '22023',
      'Invalid task id',
    ],
    [
      'a non-ISO date',
      [{ id: randomUUID(), start_date: '11/02/2026', due_date: null }],
      '22007',
      'YYYY-MM-DD',
    ],
    [
      'infinity',
      [{ id: randomUUID(), start_date: null, due_date: 'infinity' }],
      '22007',
      'YYYY-MM-DD',
    ],
    [
      'an impossible date',
      [{ id: randomUUID(), start_date: '2026-02-30', due_date: null }],
      '22008',
      'Invalid date',
    ],
  ])('rejects %s', async (_, payload, code, message) => {
    await expectPgError(schedule(alice, payload), code, message)
  })

  it('rejects the same task twice', async () => {
    const [t1] = await threeTasks()
    const change = { id: t1.id, start_date: null, due_date: '2026-11-20' }
    await expectPgError(schedule(alice, [change, change]), '22023', 'more than once')
    expect(await task(t1.id)).toMatchObject({ due_date: '2026-11-03' })
  })

  it('rejects a null argument', async () => {
    await expectPgError(alice.query('select * from public.apply_task_schedule(null)'), '22023')
  })
})

describe('delete_task', () => {
  const deleteTask = (client: DbClient, id: string | null, keep: boolean, promoted: unknown = []) =>
    client.query('select public.delete_task($1, $2, $3::jsonb)', [
      id,
      keep,
      JSON.stringify(promoted),
    ])

  it('keep_subtasks = false (the default) deletes the task, its subtasks and dependencies', async () => {
    const ws = await seedWorkspace(alice)
    await alice.query('select public.delete_task($1)', [ws.parent.id])
    for (const id of [ws.parent.id, ws.subtaskA.id, ws.subtaskB.id]) {
      expect(await getRow(db.admin, 'tasks', id)).toBeUndefined()
    }
    expect(await getRow(db.admin, 'task_dependencies', ws.dependency.id)).toBeUndefined()
    expect(await getRow(db.admin, 'tasks', ws.other.id)).toBeDefined()
  })

  it('keep_subtasks = true promotes the subtasks with the given sort orders, then deletes', async () => {
    const ws = await seedWorkspace(alice)
    const kept = await makeDependency(alice, ws.project.id, ws.other.id, ws.subtaskA.id)
    await deleteTask(alice, ws.parent.id, true, [
      { id: ws.subtaskA.id, sort_order: 'a0V' },
      { id: ws.subtaskB.id, sort_order: 'a0k' },
    ])
    expect(await getRow(db.admin, 'tasks', ws.parent.id)).toBeUndefined()
    expect(await task(ws.subtaskA.id)).toMatchObject({
      parent_task_id: null,
      sort_order: 'a0V',
      phase_id: ws.phase.id,
    })
    expect(await task(ws.subtaskB.id)).toMatchObject({ parent_task_id: null, sort_order: 'a0k' })
    expect(await getRow(db.admin, 'task_dependencies', ws.dependency.id)).toBeUndefined()
    expect(await getRow<DependencyRow>(db.admin, 'task_dependencies', kept.id)).toBeDefined()
  })

  it('keep_subtasks = true on a task without subtasks just deletes it', async () => {
    const ws = await seedWorkspace(alice)
    await deleteTask(alice, ws.other.id, true, [])
    expect(await getRow(db.admin, 'tasks', ws.other.id)).toBeUndefined()
  })

  const mismatch = "do not match the task's current subtasks"

  it.each<[string, (ws: Workspace) => unknown, string]>([
    [
      'a subtask is missing from the list',
      (ws) => [{ id: ws.subtaskA.id, sort_order: 'b' }],
      mismatch,
    ],
    [
      'the list contains a task that is not a subtask',
      (ws) => [
        { id: ws.subtaskA.id, sort_order: 'b' },
        { id: ws.subtaskB.id, sort_order: 'c' },
        { id: ws.other.id, sort_order: 'd' },
      ],
      mismatch,
    ],
    [
      'a subtask is listed twice',
      (ws) => [
        { id: ws.subtaskA.id, sort_order: 'b' },
        { id: ws.subtaskA.id, sort_order: 'c' },
      ],
      'more than once',
    ],
    ['the list is not an array', () => ({ id: 'x' }), 'must be a JSON array'],
    ['an entry has no sort_order', (ws) => [{ id: ws.subtaskA.id }], 'needs "id" and "sort_order"'],
    [
      'a sort_order is not a string',
      (ws) => [{ id: ws.subtaskA.id, sort_order: 5 }],
      'needs "id" and "sort_order"',
    ],
    ['an id is invalid', () => [{ id: 'nope', sort_order: 'b' }], 'Invalid subtask id'],
  ])('changes nothing when %s', async (_, promoted, message) => {
    const ws = await seedWorkspace(alice)
    await expectPgError(deleteTask(alice, ws.parent.id, true, promoted(ws)), '22023', message)
    expect(await getRow(db.admin, 'tasks', ws.parent.id)).toBeDefined()
    expect(await task(ws.subtaskA.id)).toMatchObject({
      parent_task_id: ws.parent.id,
      sort_order: 'a0',
    })
    expect(await task(ws.subtaskB.id)).toMatchObject({ parent_task_id: ws.parent.id })
  })

  it('changes nothing when a promoted sort_order is invalid', async () => {
    const ws = await seedWorkspace(alice)
    await expectPgError(
      deleteTask(alice, ws.parent.id, true, [
        { id: ws.subtaskA.id, sort_order: 'b' },
        { id: ws.subtaskB.id, sort_order: '' },
      ]),
      '23514',
    )
    expect(await task(ws.subtaskA.id)).toMatchObject({
      parent_task_id: ws.parent.id,
      sort_order: 'a0',
    })
  })

  it("refuses another user's task (both modes) and changes nothing", async () => {
    const ws = await seedWorkspace(alice)
    const before = await countAllOwned(db.admin, alice.id)
    await expectPgError(deleteTask(bob, ws.parent.id, false), 'P0002', 'Task not found')
    await expectPgError(
      deleteTask(bob, ws.parent.id, true, [
        { id: ws.subtaskA.id, sort_order: 'b' },
        { id: ws.subtaskB.id, sort_order: 'c' },
      ]),
      'P0002',
      'Task not found',
    )
    expect(await countAllOwned(db.admin, alice.id)).toEqual(before)
    expect(await task(ws.subtaskA.id)).toMatchObject({ parent_task_id: ws.parent.id })
  })

  it("cannot promote another user's tasks while deleting your own", async () => {
    const own = await seedWorkspace(bob)
    const foreign = await seedWorkspace(alice)
    const before = await db.admin.query('select * from public.tasks where project_id = $1', [
      foreign.project.id,
    ])
    await expectPgError(
      deleteTask(bob, own.parent.id, true, [
        { id: own.subtaskA.id, sort_order: 'b' },
        { id: own.subtaskB.id, sort_order: 'c' },
        { id: foreign.subtaskA.id, sort_order: 'd' },
      ]),
      '22023',
      mismatch,
    )
    expect(await getRow(db.admin, 'tasks', own.parent.id)).toBeDefined()
    expect(
      (
        await db.admin.query('select * from public.tasks where project_id = $1', [
          foreign.project.id,
        ])
      ).rows,
    ).toEqual(before.rows)
  })

  it('reports missing or null ids', async () => {
    await expectPgError(deleteTask(alice, randomUUID(), false), 'P0002', 'Task not found')
    await expectPgError(deleteTask(alice, null, false), '22023', 'A task id is required')
  })
})

type Workspace = Awaited<ReturnType<typeof seedWorkspace>>

describe('import_workspace', () => {
  const importWorkspace = (client: DbClient, data: unknown) =>
    client.query<{ summary: Record<string, number> }>(
      'select public.import_workspace($1::jsonb) as summary',
      [JSON.stringify(data)],
    )

  const newId = (): string => randomUUID()

  /** An id-remapped backup as the client sends it (snake_case rows). */
  function backup() {
    const id = {
      project: newId(),
      emptyProject: newId(),
      phase: newId(),
      parent: newId(),
      subtask: newId(),
      other: newId(),
      milestone: newId(),
      dependency: newId(),
    }
    const data = {
      projects: [
        {
          id: id.project,
          user_id: bob.id, // must be ignored
          name: 'Imported',
          description: 'From a backup',
          status: 'active',
          color: 'blue',
          start_date: '2026-11-01',
          due_date: '2026-12-31',
          schedule_mode: 'auto',
          sort_order: 'a0',
          created_at: '2020-01-01T00:00:00.000Z',
          updated_at: '2020-01-01T00:00:00.000Z',
        },
        { id: id.emptyProject, name: 'Minimal', sort_order: 'a1' },
      ],
      phases: [
        { id: id.phase, project_id: id.project, name: 'Design', color: 'orange', sort_order: 'a0' },
      ],
      tasks: [
        // The subtask comes first on purpose: parents must still be inserted before subtasks.
        {
          id: id.subtask,
          project_id: id.project,
          phase_id: null,
          parent_task_id: id.parent,
          title: 'Subtask',
          status: 'done',
          priority: 'low',
          sort_order: 'a0',
          completed_at: '2026-10-01T08:00:00.000Z',
          user_id: bob.id,
        },
        {
          id: id.parent,
          project_id: id.project,
          phase_id: id.phase,
          parent_task_id: null,
          title: 'Parent',
          description: null,
          status: 'in_progress',
          priority: 'high',
          start_date: '2026-11-02',
          due_date: '2026-11-05',
          sort_order: 'a0',
          completed_at: null,
        },
        { id: id.other, project_id: id.project, title: 'Other', sort_order: 'a1' },
      ],
      milestones: [
        {
          id: id.milestone,
          project_id: id.project,
          phase_id: id.phase,
          name: 'Launch',
          date: '2026-12-01',
        },
      ],
      dependencies: [
        {
          id: id.dependency,
          project_id: id.project,
          predecessor_id: id.parent,
          successor_id: id.other,
          type: 'FS',
          user_id: bob.id,
        },
      ],
    }
    return { id, data }
  }

  it('inserts everything as new rows owned by the caller and returns the counts', async () => {
    const carol = await db.createUser()
    const existing = await makeProject(carol, { name: 'Existing' })
    const bobBefore = await countAllOwned(db.admin, bob.id)
    const { id, data } = backup()

    const { rows } = await importWorkspace(carol, data)
    expect(rows[0].summary).toEqual({
      projects: 2,
      phases: 1,
      tasks: 3,
      milestones: 1,
      dependencies: 1,
    })
    expect(await countAllOwned(db.admin, carol.id)).toMatchObject({
      projects: 3,
      phases: 1,
      tasks: 3,
      milestones: 1,
      task_dependencies: 1,
    })
    // The payload's user_id (Bob) is ignored.
    expect(await countAllOwned(db.admin, bob.id)).toEqual(bobBefore)

    const project = await getRow<ProjectRow>(db.admin, 'projects', id.project)
    expect(project).toMatchObject({
      user_id: carol.id,
      name: 'Imported',
      color: 'blue',
      schedule_mode: 'auto',
      start_date: '2026-11-01',
    })
    expect(project!.created_at.getTime()).toBeGreaterThan(LONG_AGO.getTime())
    expect(await getRow<ProjectRow>(db.admin, 'projects', id.emptyProject)).toMatchObject({
      status: 'active',
      color: 'gray',
      schedule_mode: 'manual',
      description: null,
    })
    expect(await getRow<PhaseRow>(db.admin, 'phases', id.phase)).toMatchObject({
      user_id: carol.id,
      color: 'orange', // phase colours survive a backup import
    })
    expect(await task(id.subtask)).toMatchObject({
      user_id: carol.id,
      parent_task_id: id.parent,
      phase_id: id.phase, // follows the parent, not the payload
      completed_at: new Date('2026-10-01T08:00:00.000Z'),
    })
    expect(await task(id.parent)).toMatchObject({ status: 'in_progress', completed_at: null })
    expect(await getRow<MilestoneRow>(db.admin, 'milestones', id.milestone)).toMatchObject({
      user_id: carol.id,
      date: '2026-12-01',
    })
    expect(await getRow<DependencyRow>(db.admin, 'task_dependencies', id.dependency)).toMatchObject(
      {
        user_id: carol.id,
      },
    )
    expect(await getRow<ProjectRow>(db.admin, 'projects', existing.id)).toEqual(existing)
  })

  it('a backup made before phase colours (no color key at all) imports as "inherit the project colour"', async () => {
    const heidi = await db.createUser()
    const { id, data } = backup()
    for (const phase of data.phases as { color?: string }[]) delete phase.color
    await importWorkspace(heidi, data)
    expect(await getRow<PhaseRow>(db.admin, 'phases', id.phase)).toMatchObject({
      user_id: heidi.id,
      color: null,
    })
  })

  it('accepts an empty import', async () => {
    const { rows } = await importWorkspace(alice, {})
    expect(rows[0].summary).toEqual({
      projects: 0,
      phases: 0,
      tasks: 0,
      milestones: 0,
      dependencies: 0,
    })
    const nulls = await importWorkspace(alice, { projects: null, tasks: [] })
    expect(nulls.rows[0].summary.projects).toBe(0)
  })

  type Data = ReturnType<typeof backup>['data']
  type Ids = ReturnType<typeof backup>['id']

  it.each<[string, (data: Data, id: Ids) => void, string, string?]>([
    ['an invalid task status', (data) => void (data.tasks[2].status = 'blocked'), '23514'],
    [
      'a task due before its start',
      (data) =>
        void Object.assign(data.tasks[1], { start_date: '2026-11-05', due_date: '2026-11-01' }),
      '23514',
    ],
    [
      'a subtask of a subtask',
      (data, id) =>
        void data.tasks.push({
          id: randomUUID(),
          project_id: id.project,
          parent_task_id: id.subtask,
          title: 'Too deep',
          sort_order: 'a0',
        } as Data['tasks'][number]),
      '23514',
      'Subtasks can only be one level deep',
    ],
    [
      'a dependency cycle',
      (data, id) =>
        void data.dependencies.push({
          id: randomUUID(),
          project_id: id.project,
          predecessor_id: id.other,
          successor_id: id.parent,
          type: 'FS',
          user_id: '',
        }),
      '23514',
      'cycle',
    ],
    ['a duplicate id', (data) => void (data.projects[1].id = data.projects[0].id), '23505'],
    ['a blank name', (data) => void (data.phases[0].name = '   '), '23514'],
    [
      'a phase colour outside the palette (red is reserved)',
      (data) => void ((data.phases[0] as { color?: string }).color = 'red'),
      '23514',
      'phases_color_valid',
    ],
    ['an invalid uuid', (data) => void (data.milestones[0].id = 'not-a-uuid'), '22P02'],
    [
      'a phase from another project of the import',
      (data, id) =>
        void (data.tasks[2] = {
          ...data.tasks[2],
          project_id: id.emptyProject,
          phase_id: id.phase,
        } as Data['tasks'][number]),
      '23503',
    ],
  ])('rolls back everything on %s', async (_, mutate, code, message) => {
    const dave = await db.createUser()
    const { id, data } = backup()
    mutate(data, id)
    await expectPgError(importWorkspace(dave, data), code, message)
    expect(Object.values(await countAllOwned(db.admin, dave.id))).toEqual([0, 0, 0, 0, 0, 0])
  })

  it.each<[string, (data: Data, other: Workspace, own: ProjectRow) => void]>([
    [
      "a phase in another user's project",
      (data, other) => void (data.phases[0].project_id = other.project.id),
    ],
    [
      "a task under another user's parent task",
      (data, other) => void (data.tasks[0].parent_task_id = other.parent.id),
    ],
    [
      "a milestone in another user's phase",
      (data, other) => void (data.milestones[0].phase_id = other.phase.id),
    ],
    [
      "a dependency on another user's tasks",
      (data, other) =>
        void Object.assign(data.dependencies[0], {
          predecessor_id: other.other.id,
          successor_id: other.subtaskA.id,
        }),
    ],
    [
      "a task added to the caller's existing project",
      (data, _other, own) => void (data.tasks[2].project_id = own.id),
    ],
  ])('cannot attach rows elsewhere: %s', async (_, mutate) => {
    const erin = await db.createUser()
    const own = await makeProject(erin)
    const other = await seedWorkspace(alice)
    const aliceBefore = await countAllOwned(db.admin, alice.id)
    const { data } = backup()
    mutate(data, other, own)

    await expectPgError(
      importWorkspace(erin, data),
      '23503',
      'Import data references rows that are not part of the import',
    )
    expect(await countAllOwned(db.admin, erin.id)).toMatchObject({
      projects: 1,
      tasks: 0,
      phases: 0,
    })
    expect(await countAllOwned(db.admin, alice.id)).toEqual(aliceBefore)
  })

  it.each([
    ['a project', (data: Data) => void delete (data.projects[1] as { id?: string }).id],
    ['a phase', (data: Data) => void ((data.phases[0] as { id: string | null }).id = null)],
    ['a task', (data: Data) => void delete (data.tasks[2] as { id?: string }).id],
    ['a milestone', (data: Data) => void delete (data.milestones[0] as { id?: string }).id],
    ['a dependency', (data: Data) => void delete (data.dependencies[0] as { id?: string }).id],
  ])('rejects %s without an id', async (_, mutate) => {
    const gina = await db.createUser()
    const { data } = backup()
    mutate(data)
    await expectPgError(importWorkspace(gina, data), '22023', 'Every imported row needs an id')
    expect(Object.values(await countAllOwned(db.admin, gina.id))).toEqual([0, 0, 0, 0, 0, 0])
  })

  // `x = any (ids)` is NULL, not false, once `ids` holds a NULL, so an id-less project used to
  // switch the self-containment check off for every phase (only a later NOT NULL error stopped it).
  it.each([
    ["the caller's existing project", (own: ProjectRow) => own.id],
    ["another user's project", (_own: ProjectRow, other: Workspace) => other.project.id],
  ])('an id-less project cannot open a way to %s', async (_, target) => {
    const hank = await db.createUser()
    const own = await makeProject(hank)
    const other = await seedWorkspace(alice)
    const aliceBefore = await countAllOwned(db.admin, alice.id)
    const data = {
      projects: [{ name: 'No id', sort_order: 'a0' }],
      phases: [{ id: newId(), project_id: target(own, other), name: 'Smuggled', sort_order: 'a0' }],
    }
    await expectPgError(importWorkspace(hank, data), '22023', 'Every imported row needs an id')
    expect(await countAllOwned(db.admin, hank.id)).toMatchObject({ projects: 1, phases: 0 })
    expect(await countAllOwned(db.admin, alice.id)).toEqual(aliceBefore)
  })

  it.each<[string, (id: Ids) => string, (other: Workspace) => string]>([
    ['project', (id) => id.project, (other) => other.project.id],
    ['phase', (id) => id.phase, (other) => other.phase.id],
    ['task', (id) => id.parent, (other) => other.parent.id],
    ['milestone', (id) => id.milestone, (other) => other.milestone.id],
    ['dependency', (id) => id.dependency, (other) => other.dependency.id],
  ])(
    "cannot overwrite or take over another user's %s by reusing its id",
    async (_, ours, theirs) => {
      const ivan = await db.createUser()
      const other = await seedWorkspace(alice)
      const aliceBefore = await snapshotOwned(db.admin, alice.id)
      const { id, data } = backup()
      // Every reference to the row follows the reused id, so the payload stays self-contained.
      const payload = JSON.parse(JSON.stringify(data).replaceAll(ours(id), theirs(other)))

      await expectPgError(importWorkspace(ivan, payload), '23505')
      expect(Object.values(await countAllOwned(db.admin, ivan.id))).toEqual([0, 0, 0, 0, 0, 0])
      expect(await snapshotOwned(db.admin, alice.id)).toEqual(aliceBefore)
    },
  )

  it.each([
    ['null', null, 'must be a JSON object'],
    ['an array', [], 'must be a JSON object'],
    ['a non-array section', { projects: {} }, 'must contain arrays'],
    ['a section with non-object rows', { tasks: [1] }, 'array of objects'],
  ])('rejects %s', async (_, payload, message) => {
    const frank = await db.createUser()
    await expectPgError(importWorkspace(frank, payload), '22023', message)
  })

  it('requires a signed-in user', async () => {
    await expectPgError(
      db.admin.transaction(async (tx) => {
        await tx.exec('set local role authenticated')
        return tx.query(`select public.import_workspace('{}')`)
      }),
      '42501',
      'You must be signed in',
    )
  })
})
