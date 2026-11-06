import type { Transaction } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  catchPgError,
  countAllOwned,
  expectPgError,
  getRow,
  insertRow,
  makeDependency,
  makeMilestone,
  makePhase,
  makeProject,
  makeTask,
  RPC_SIGNATURES,
  seedWorkspace,
  snapshotOwned,
  TABLES,
  type DependencyRow,
  type PgError,
  type MilestoneRow,
  type PhaseRow,
  type PreferencesRow,
  type ProjectRow,
  type Table,
  type TaskRow,
} from './fixtures.ts'
import { createTestDb, type TestDb, type UserClient } from './harness.ts'

let db: TestDb
let alice: UserClient
let bob: UserClient
let a: Awaited<ReturnType<typeof seedWorkspace>>
let b: Awaited<ReturnType<typeof seedWorkspace>>

beforeAll(async () => {
  db = await createTestDb()
  alice = await db.createUser('alice@example.test')
  bob = await db.createUser('bob@example.test')
  a = await seedWorkspace(alice)
  b = await seedWorkspace(bob)
  await insertRow(alice, 'user_preferences', { theme: 'dark' })
  await insertRow(bob, 'user_preferences', { theme: 'light' })
})

afterAll(async () => {
  await db.close()
})

const keyOf = (table: Table) => (table === 'user_preferences' ? 'user_id' : 'id')

/** One of Alice's rows per table. */
const aliceRowId = (table: Table): string =>
  ({
    projects: a.project.id,
    phases: a.phase.id,
    tasks: a.other.id,
    milestones: a.milestone.id,
    task_dependencies: a.dependency.id,
    user_preferences: alice.id,
  })[table]

/** A harmless column change per table, for update attempts. */
const UPDATES: Record<Table, [column: string, value: unknown]> = {
  projects: ['name', 'Changed by Bob'],
  phases: ['name', 'Changed by Bob'],
  tasks: ['title', 'Changed by Bob'],
  milestones: ['name', 'Changed by Bob'],
  task_dependencies: ['type', 'FS'],
  user_preferences: ['theme', 'light'],
}

describe('owner CRUD', () => {
  it('projects: create, read, update, delete', async () => {
    const created = await makeProject(alice, { name: 'Mine' })
    expect(created.user_id).toBe(alice.id)
    const read = await alice.query<ProjectRow>('select * from public.projects where id = $1', [
      created.id,
    ])
    expect(read.rows[0].name).toBe('Mine')
    const updated = await alice.query<ProjectRow>(
      'update public.projects set name = $2, status = $3 where id = $1 returning *',
      [created.id, 'Renamed', 'archived'],
    )
    expect(updated.rows[0]).toMatchObject({ name: 'Renamed', status: 'archived' })
    const deleted = await alice.query('delete from public.projects where id = $1 returning id', [
      created.id,
    ])
    expect(deleted.rows).toHaveLength(1)
    expect(await getRow(db.admin, 'projects', created.id)).toBeUndefined()
  })

  it('phases: create, read, update, delete', async () => {
    const created = await makePhase(alice, a.project.id, { name: 'Phase X' })
    expect(created.user_id).toBe(alice.id)
    const updated = await alice.query<PhaseRow>(
      'update public.phases set name = $2, sort_order = $3 where id = $1 returning *',
      [created.id, 'Renamed', 'b0'],
    )
    expect(updated.rows[0]).toMatchObject({ name: 'Renamed', sort_order: 'b0' })
    const read = await alice.query('select id from public.phases where id = $1', [created.id])
    expect(read.rows).toHaveLength(1)
    await alice.query('delete from public.phases where id = $1', [created.id])
    expect(await getRow(db.admin, 'phases', created.id)).toBeUndefined()
  })

  it('tasks: create, read, update, delete', async () => {
    const created = await makeTask(alice, a.project.id, { title: 'Write intro' })
    expect(created).toMatchObject({ user_id: alice.id, status: 'todo', priority: 'none' })
    const updated = await alice.query<TaskRow>(
      `update public.tasks
       set title = $2, status = 'in_progress', priority = 'high', start_date = '2026-11-02',
           due_date = '2026-11-04', description = 'Notes', phase_id = $3, sort_order = 'a5'
       where id = $1 returning *`,
      [created.id, 'Write the intro', a.otherPhase.id],
    )
    expect(updated.rows[0]).toMatchObject({
      title: 'Write the intro',
      status: 'in_progress',
      priority: 'high',
      start_date: '2026-11-02',
      due_date: '2026-11-04',
      phase_id: a.otherPhase.id,
    })
    const read = await alice.query('select id from public.tasks where id = $1', [created.id])
    expect(read.rows).toHaveLength(1)
    await alice.query('delete from public.tasks where id = $1', [created.id])
    expect(await getRow(db.admin, 'tasks', created.id)).toBeUndefined()
  })

  it('milestones: create, read, update, delete', async () => {
    const created = await makeMilestone(alice, a.project.id, { date: '2026-12-01' })
    expect(created.user_id).toBe(alice.id)
    const updated = await alice.query<MilestoneRow>(
      'update public.milestones set name = $2, date = $3, phase_id = $4 where id = $1 returning *',
      [created.id, 'Launch', '2026-12-24', a.phase.id],
    )
    expect(updated.rows[0]).toMatchObject({
      name: 'Launch',
      date: '2026-12-24',
      phase_id: a.phase.id,
    })
    const read = await alice.query('select id from public.milestones where id = $1', [created.id])
    expect(read.rows).toHaveLength(1)
    await alice.query('delete from public.milestones where id = $1', [created.id])
    expect(await getRow(db.admin, 'milestones', created.id)).toBeUndefined()
  })

  it('task_dependencies: create, read, update, delete', async () => {
    const t1 = await makeTask(alice, a.project.id)
    const t2 = await makeTask(alice, a.project.id)
    const t3 = await makeTask(alice, a.project.id)
    const created = await makeDependency(alice, a.project.id, t1.id, t2.id)
    expect(created).toMatchObject({ user_id: alice.id, type: 'FS' })
    const updated = await alice.query<DependencyRow>(
      'update public.task_dependencies set successor_id = $2 where id = $1 returning *',
      [created.id, t3.id],
    )
    expect(updated.rows[0].successor_id).toBe(t3.id)
    const read = await alice.query('select id from public.task_dependencies where id = $1', [
      created.id,
    ])
    expect(read.rows).toHaveLength(1)
    await alice.query('delete from public.task_dependencies where id = $1', [created.id])
    expect(await getRow(db.admin, 'task_dependencies', created.id)).toBeUndefined()
  })

  it('user_preferences: create, read, update, delete', async () => {
    const carol = await db.createUser()
    const created = await insertRow<PreferencesRow>(carol, 'user_preferences', {
      timezone: 'Europe/Berlin',
    })
    expect(created.user_id).toBe(carol.id)
    const updated = await carol.query<PreferencesRow>(
      'update public.user_preferences set sidebar_collapsed = true returning *',
    )
    expect(updated.rows).toEqual([expect.objectContaining({ sidebar_collapsed: true })])
    const read = await carol.query('select * from public.user_preferences')
    expect(read.rows).toHaveLength(1)
    await carol.query('delete from public.user_preferences')
    expect(await getRow(db.admin, 'user_preferences', carol.id)).toBeUndefined()
  })
})

describe('isolation between users', () => {
  it.each(TABLES)('%s: select only returns your own rows', async (table) => {
    const visible = await bob.query<{ user_id: string }>(`select user_id from public.${table}`)
    expect(visible.rows.length).toBeGreaterThan(0)
    expect(visible.rows.every((row) => row.user_id === bob.id)).toBe(true)
    const targeted = await bob.query(`select * from public.${table} where ${keyOf(table)} = $1`, [
      aliceRowId(table),
    ])
    expect(targeted.rows).toEqual([])
  })

  it.each(TABLES)("%s: update of another user's row changes nothing", async (table) => {
    const before = await getRow(db.admin, table, aliceRowId(table))
    const [column, value] = UPDATES[table]
    const result = await bob.query(
      `update public.${table} set ${column} = $2 where ${keyOf(table)} = $1 returning *`,
      [aliceRowId(table), value],
    )
    expect(result.rows).toEqual([])
    expect(await getRow(db.admin, table, aliceRowId(table))).toEqual(before)
  })

  it.each(TABLES)("%s: delete of another user's row changes nothing", async (table) => {
    const result = await bob.query(
      `delete from public.${table} where ${keyOf(table)} = $1 returning *`,
      [aliceRowId(table)],
    )
    expect(result.rows).toEqual([])
    expect(await getRow(db.admin, table, aliceRowId(table))).toBeDefined()
  })

  it.each(TABLES)('%s: unfiltered update/delete only touch your own rows', async (table) => {
    // Full rows, not counts: a no-op `set x = x` on Alice's rows would still bump updated_at.
    const before = await snapshotOwned(db.admin, alice.id)
    const [column] = UPDATES[table]
    const updated = await bob.query<{ user_id: string }>(
      `update public.${table} set ${column} = ${column} returning user_id`,
    )
    expect(updated.rows.length).toBeGreaterThan(0)
    expect(updated.rows.every((row) => row.user_id === bob.id)).toBe(true)
    await bob.transaction(async (tx) => {
      const deleted = await tx.query<{ user_id: string }>(
        `delete from public.${table} returning user_id`,
      )
      expect(deleted.rows.every((row) => row.user_id === bob.id)).toBe(true)
      await tx.rollback()
    })
    expect(await snapshotOwned(db.admin, alice.id)).toEqual(before)
  })

  /** INSERT … ON CONFLICT on one of Alice's keys, as a PostgREST upsert sends it. */
  const UPSERTS: Record<Exclude<Table, 'user_preferences'>, () => [string, unknown[]]> = {
    projects: () => ['(id, name, sort_order) values ($1, $2, $3)', [a.project.id, 'Taken', 'a0']],
    phases: () => [
      '(id, project_id, name, sort_order) values ($1, $2, $3, $4)',
      [a.phase.id, b.project.id, 'Taken', 'a0'],
    ],
    tasks: () => [
      '(id, project_id, title, sort_order) values ($1, $2, $3, $4)',
      [a.other.id, b.project.id, 'Taken', 'a0'],
    ],
    milestones: () => [
      '(id, project_id, name, date) values ($1, $2, $3, $4)',
      [a.milestone.id, b.project.id, 'Taken', '2026-11-02'],
    ],
    task_dependencies: () => [
      '(id, project_id, predecessor_id, successor_id) values ($1, $2, $3, $4)',
      [a.dependency.id, b.project.id, b.other.id, b.subtaskA.id],
    ],
  }

  it.each(Object.keys(UPSERTS) as (keyof typeof UPSERTS)[])(
    "%s: an upsert on another user's id neither overwrites nor returns the row",
    async (table) => {
      const before = await snapshotOwned(db.admin, alice.id)
      const [values, params] = UPSERTS[table]()
      const column = table === 'task_dependencies' ? 'successor_id' : UPDATES[table][0]
      await expectPgError(
        bob.query(
          `insert into public.${table} ${values}
           on conflict (id) do update set ${column} = excluded.${column} returning *`,
          params,
        ),
        '42501',
        'row-level security',
      )
      const ignored = await bob.query(
        `insert into public.${table} ${values} on conflict (id) do nothing returning *`,
        params,
      )
      expect(ignored.rows).toEqual([])
      expect(await snapshotOwned(db.admin, alice.id)).toEqual(before)
    },
  )

  it('insert: rows claiming another user_id are rejected by RLS', async () => {
    const attempts: [Table, Record<string, unknown>][] = [
      ['projects', { user_id: alice.id, name: 'Spoof', sort_order: 'a0' }],
      ['phases', { user_id: alice.id, project_id: a.project.id, name: 'Spoof', sort_order: 'a0' }],
      ['tasks', { user_id: alice.id, project_id: a.project.id, title: 'Spoof', sort_order: 'a0' }],
      [
        'milestones',
        { user_id: alice.id, project_id: a.project.id, name: 'Spoof', date: '2026-11-02' },
      ],
      [
        'task_dependencies',
        {
          user_id: alice.id,
          project_id: b.project.id,
          predecessor_id: b.other.id,
          successor_id: b.subtaskA.id,
        },
      ],
      ['user_preferences', { user_id: alice.id, theme: 'light' }],
    ]
    const before = await countAllOwned(db.admin, alice.id)
    for (const [table, values] of attempts) {
      await expectPgError(insertRow(bob, table, values), '42501', 'row-level security')
    }
    expect(await countAllOwned(db.admin, alice.id)).toEqual(before)
  })

  it.each(TABLES)('%s: you cannot hand your own row to another user', async (table) => {
    const own = {
      projects: b.project.id,
      phases: b.phase.id,
      tasks: b.other.id,
      milestones: b.milestone.id,
      task_dependencies: b.dependency.id,
      user_preferences: bob.id,
    }[table]
    await expectPgError(
      bob.query(`update public.${table} set user_id = $2 where ${keyOf(table)} = $1`, [
        own,
        alice.id,
      ]),
      '42501',
    )
    expect(await getRow<{ user_id: string }>(db.admin, table, own)).toMatchObject({
      user_id: bob.id,
    })
  })
})

describe("references to another user's rows (every FK path)", () => {
  it('phases.project_id', async () => {
    await expectPgError(makePhase(bob, a.project.id), '23503')
  })

  it('tasks.project_id', async () => {
    await expectPgError(makeTask(bob, a.project.id), '23503')
  })

  it('tasks.phase_id (insert and update)', async () => {
    await expectPgError(makeTask(bob, b.project.id, { phase_id: a.phase.id }), '23503')
    await expectPgError(
      bob.query('update public.tasks set phase_id = $2 where id = $1', [b.other.id, a.phase.id]),
      '23503',
    )
  })

  it('tasks.parent_task_id (insert and update)', async () => {
    await expectPgError(
      makeTask(bob, b.project.id, { parent_task_id: a.parent.id }),
      '23503',
      'Parent task not found',
    )
    await expectPgError(
      bob.query('update public.tasks set parent_task_id = $2 where id = $1', [
        b.other.id,
        a.other.id,
      ]),
      '23503',
      'Parent task not found',
    )
  })

  it('milestones.project_id and milestones.phase_id (insert and update)', async () => {
    await expectPgError(makeMilestone(bob, a.project.id), '23503')
    await expectPgError(makeMilestone(bob, b.project.id, { phase_id: a.phase.id }), '23503')
    await expectPgError(
      bob.query('update public.milestones set phase_id = $2 where id = $1', [
        b.milestone.id,
        a.phase.id,
      ]),
      '23503',
    )
  })

  it('task_dependencies.project_id, predecessor_id and successor_id', async () => {
    await expectPgError(
      makeDependency(bob, a.project.id, a.other.id, a.subtaskA.id),
      '23503',
      'Predecessor task not found',
    )
    await expectPgError(makeDependency(bob, a.project.id, b.other.id, b.subtaskA.id), '23514')
    await expectPgError(
      makeDependency(bob, b.project.id, a.other.id, b.other.id),
      '23503',
      'Predecessor task not found',
    )
    await expectPgError(
      makeDependency(bob, b.project.id, b.other.id, a.other.id),
      '23503',
      'Successor task not found',
    )
    await expectPgError(
      bob.query('update public.task_dependencies set successor_id = $2 where id = $1', [
        b.dependency.id,
        a.other.id,
      ]),
      '23503',
      'Successor task not found',
    )
  })

  it("moving your row into another user's project is rejected", async () => {
    for (const [table, id] of [
      ['phases', b.phase.id],
      ['tasks', b.other.id],
      ['milestones', b.milestone.id],
      ['task_dependencies', b.dependency.id],
    ] as const) {
      await expectPgError(
        bob.query(`update public.${table} set project_id = $2 where id = $1`, [id, a.project.id]),
        '23514',
      )
    }
  })

  it("leaves Alice's data untouched after all of the above", async () => {
    const { rows } = await db.admin.query<{ user_id: string }>(
      `select user_id from public.tasks where project_id = $1
       union all select user_id from public.phases where project_id = $1
       union all select user_id from public.milestones where project_id = $1
       union all select user_id from public.task_dependencies where project_id = $1`,
      [a.project.id],
    )
    expect(rows.every((row) => row.user_id === alice.id)).toBe(true)
  })
})

describe('no side effects or side channels across users', () => {
  it("Bob's cascades and triggers never touch Alice's rows", async () => {
    // FK cascades run their triggers as the table owner, i.e. WITHOUT RLS: only the composite
    // foreign keys keep them inside one user's project.
    const before = await snapshotOwned(db.admin, alice.id)
    const ws = await seedWorkspace(bob)
    await bob.query('update public.tasks set phase_id = $2 where id = $1', [
      ws.parent.id,
      ws.otherPhase.id,
    ])
    await bob.query('delete from public.phases where id = $1', [ws.otherPhase.id])
    await bob.query('select public.delete_task($1, true, $2::jsonb)', [
      ws.parent.id,
      JSON.stringify([
        { id: ws.subtaskA.id, sort_order: 'b0' },
        { id: ws.subtaskB.id, sort_order: 'b1' },
      ]),
    ])
    await bob.query('delete from public.projects where id = $1', [ws.project.id])
    expect(await snapshotOwned(db.admin, alice.id)).toEqual(before)
  })

  it("a share lock taken under RLS (as the hierarchy trigger takes it) never reaches Alice's rows", async () => {
    const pending = await bob.prepare(async (tx) => {
      const { rows } = await tx.query('select id from public.tasks where id = $1 for share', [
        a.parent.id,
      ])
      expect(rows).toEqual([])
    })
    try {
      const { rows } = await db.admin.query(
        'select id from public.tasks where id = $1 for update nowait',
        [a.parent.id],
      )
      expect(rows).toHaveLength(1)
    } finally {
      await pending.rollback()
    }
  })

  it("a reference to Alice's row fails exactly like a reference to a missing row", async () => {
    const missing = crypto.randomUUID()
    const attempts: [string, string, (id: string) => Promise<unknown>][] = [
      ['phase → project', a.project.id, (id) => makePhase(bob, id)],
      ['task → project', a.project.id, (id) => makeTask(bob, id)],
      ['milestone → project', a.project.id, (id) => makeMilestone(bob, id)],
      [
        'dependency → project',
        a.project.id,
        (id) => makeDependency(bob, id, b.other.id, b.subtaskA.id),
      ],
      ['task → phase', a.phase.id, (id) => makeTask(bob, b.project.id, { phase_id: id })],
      ['milestone → phase', a.phase.id, (id) => makeMilestone(bob, b.project.id, { phase_id: id })],
      ['task → parent', a.parent.id, (id) => makeTask(bob, b.project.id, { parent_task_id: id })],
      [
        'dependency → predecessor',
        a.other.id,
        (id) => makeDependency(bob, b.project.id, id, b.other.id),
      ],
      [
        'dependency → successor',
        a.other.id,
        (id) => makeDependency(bob, b.project.id, b.other.id, id),
      ],
      [
        'phase moved to project',
        a.project.id,
        (id) =>
          bob.query('update public.phases set project_id = $2 where id = $1', [b.phase.id, id]),
      ],
      [
        'task phase changed',
        a.phase.id,
        (id) => bob.query('update public.tasks set phase_id = $2 where id = $1', [b.other.id, id]),
      ],
      [
        'apply_task_schedule',
        a.other.id,
        (id) =>
          bob.query('select * from public.apply_task_schedule($1::jsonb)', [
            JSON.stringify([{ id, start_date: null, due_date: null }]),
          ]),
      ],
      ['delete_task', a.other.id, (id) => bob.query('select public.delete_task($1)', [id])],
    ]
    for (const [label, aliceId, attempt] of attempts) {
      const pick = ({ code, message, detail }: PgError) => ({ code, message, detail })
      const forAlice = pick(await catchPgError(attempt(aliceId)))
      const forMissing = pick(await catchPgError(attempt(missing)))
      expect(forAlice, label).toEqual(forMissing)
      expect(JSON.stringify(forAlice), label).not.toContain(aliceId)
    }
  })
})

describe('anon (not signed in)', () => {
  it.each(TABLES)('%s: no select, insert, update or delete', async (table) => {
    await expectPgError(
      db.anon.query(`select * from public.${table}`),
      '42501',
      'permission denied',
    )
    await expectPgError(
      db.anon.query(`insert into public.${table} default values`),
      '42501',
      'permission denied',
    )
    await expectPgError(
      db.anon.query(`update public.${table} set user_id = user_id`),
      '42501',
      'permission denied',
    )
    await expectPgError(db.anon.query(`delete from public.${table}`), '42501', 'permission denied')
  })

  it.each(RPC_SIGNATURES)('cannot execute %s', async (signature) => {
    const call = {
      'apply_task_schedule(jsonb)': `select * from public.apply_task_schedule('[]')`,
      'delete_task(uuid,boolean,jsonb)': `select public.delete_task('${a.other.id}')`,
      'import_workspace(jsonb)': `select public.import_workspace('{}')`,
    }[signature]
    await expectPgError(db.anon.query(call), '42501', 'permission denied for function')
    expect(await getRow(db.admin, 'tasks', a.other.id)).toBeDefined()
  })
})

describe('authenticated privileges', () => {
  it.each(TABLES)('%s cannot be truncated (TRUNCATE ignores RLS)', async (table) => {
    await expectPgError(bob.query(`truncate public.${table} cascade`), '42501', 'permission denied')
  })

  it('cannot call trigger functions directly', async () => {
    await expectPgError(bob.query('select public.tg_set_updated_at()'), '42501')
  })
})

describe('tokens without a usable identity fail closed', () => {
  /** Role `authenticated` with no `sub` claim, so auth.uid() is null. */
  const noSubject = <T>(run: (tx: Transaction) => Promise<T>): Promise<T> =>
    db.admin.transaction(async (tx) => {
      await tx.exec('set local role authenticated')
      return run(tx)
    })

  it.each(TABLES)('%s: no subject reads and changes nothing, and cannot insert', async (table) => {
    const before = await snapshotOwned(db.admin, alice.id)
    expect((await noSubject((tx) => tx.query(`select * from public.${table}`))).rows).toEqual([])
    const [column, value] = UPDATES[table]
    const updated = await noSubject((tx) =>
      tx.query(`update public.${table} set ${column} = $1`, [value]),
    )
    expect(updated.affectedRows ?? 0).toBe(0)
    const deleted = await noSubject((tx) => tx.query(`delete from public.${table}`))
    expect(deleted.affectedRows ?? 0).toBe(0)
    await expect(
      noSubject((tx) => tx.query(`insert into public.${table} default values`)),
    ).rejects.toThrow()
    expect(await snapshotOwned(db.admin, alice.id)).toEqual(before)
  })

  it("no subject cannot claim Alice's user_id", async () => {
    await expectPgError(
      noSubject((tx) =>
        tx.query('insert into public.projects (user_id, name, sort_order) values ($1, $2, $3)', [
          alice.id,
          'Claimed',
          'a0',
        ]),
      ),
      '42501',
      'row-level security',
    )
  })

  it("no subject finds nothing through the RPCs, even Alice's rows", async () => {
    const before = await snapshotOwned(db.admin, alice.id)
    await expectPgError(
      noSubject((tx) =>
        tx.query('select * from public.apply_task_schedule($1::jsonb)', [
          JSON.stringify([{ id: a.other.id, start_date: null, due_date: null }]),
        ]),
      ),
      'P0002',
    )
    await expectPgError(
      noSubject((tx) => tx.query('select public.delete_task($1)', [a.other.id])),
      'P0002',
    )
    expect(await snapshotOwned(db.admin, alice.id)).toEqual(before)
  })

  it('the still valid token of a deleted account finds nothing and cannot write', async () => {
    const carol = await db.createUser()
    const own = await seedWorkspace(carol)
    await insertRow(carol, 'user_preferences', { theme: 'dark' })
    await db.admin.query('delete from auth.users where id = $1', [carol.id])

    for (const table of TABLES) {
      expect((await carol.query(`select * from public.${table}`)).rows, table).toEqual([])
    }
    await expectPgError(makeProject(carol), '23503')
    await expectPgError(insertRow(carol, 'user_preferences', { theme: 'light' }), '23503')
    await expectPgError(carol.query('select public.delete_task($1)', [own.other.id]), 'P0002')
  })
})
