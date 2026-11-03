import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  expectPgError,
  getRow,
  insertRow,
  makeDependency,
  makeMilestone,
  makePhase,
  makeProject,
  makeTask,
  type MilestoneRow,
  type PhaseRow,
  type Table,
  type TaskRow,
} from './fixtures.ts'
import type { Transaction } from '@electric-sql/pglite'
import { createTestDb, type TestDb, type UserClient } from './harness.ts'

let db: TestDb
let alice: UserClient

beforeAll(async () => {
  db = await createTestDb()
  alice = await db.createUser()
})

afterAll(async () => {
  await db.close()
})

const LONG_AGO = new Date('2000-01-01T00:00:00Z')

const taskById = async (id: string) => (await getRow<TaskRow>(db.admin, 'tasks', id))!

/** A project with two phases. */
async function setup() {
  const project = await makeProject(alice)
  const design = await makePhase(alice, project.id, { name: 'Design' })
  const build = await makePhase(alice, project.id, { name: 'Build', sort_order: 'a1' })
  return { project, design, build }
}

describe('updated_at / created_at', () => {
  it.each(['projects', 'phases', 'tasks', 'milestones', 'user_preferences'] as const)(
    '%s: updated_at moves on every update, created_at never changes',
    async (table: Table) => {
      const project = await makeProject(alice)
      const stamps = { created_at: LONG_AGO, updated_at: LONG_AGO }
      const user = table === 'user_preferences' ? await db.createUser() : alice
      const row = await {
        projects: () => makeProject(alice, stamps),
        phases: () => makePhase(alice, project.id, stamps),
        tasks: () => makeTask(alice, project.id, stamps),
        milestones: () => makeMilestone(alice, project.id, stamps),
        task_dependencies: () => Promise.reject(new Error('no updated_at')),
        user_preferences: () => insertRow<{ user_id: string }>(user, 'user_preferences', stamps),
      }[table]()
      const key = table === 'user_preferences' ? 'user_id' : 'id'
      const id = (row as Record<string, string>)[key]
      const column = { projects: 'name', phases: 'name', tasks: 'title', milestones: 'name' }[
        table as string
      ]
      const set = column ? `${column} = 'Renamed'` : `theme = 'dark'`

      const { rows } = await user.query<{ created_at: Date; updated_at: Date }>(
        `update public.${table} set ${set}, created_at = now() where ${key} = $1
         returning created_at, updated_at`,
        [id],
      )
      expect(rows[0].created_at).toEqual(LONG_AGO)
      expect(rows[0].updated_at.getTime()).toBeGreaterThan(LONG_AGO.getTime())
    },
  )
})

describe('tasks.completed_at', () => {
  it('is null for open tasks and set by the server for done tasks', async () => {
    const { project } = await setup()
    expect((await makeTask(alice, project.id)).completed_at).toBeNull()
    const done = await makeTask(alice, project.id, { status: 'done' })
    expect(done.completed_at).toBeInstanceOf(Date)
    const sneaky = await makeTask(alice, project.id, { status: 'todo', completed_at: LONG_AGO })
    expect(sneaky.completed_at).toBeNull()
  })

  it('keeps a completion time supplied with a done task on insert (backup import)', async () => {
    const { project } = await setup()
    const done = await makeTask(alice, project.id, { status: 'done', completed_at: LONG_AGO })
    expect(done.completed_at).toEqual(LONG_AGO)
  })

  it('follows status transitions', async () => {
    const { project } = await setup()
    const task = await makeTask(alice, project.id, { status: 'in_progress' })
    const setStatus = async (status: string) =>
      (
        await alice.query<TaskRow>(
          'update public.tasks set status = $2 where id = $1 returning *',
          [task.id, status],
        )
      ).rows[0]

    const done = await setStatus('done')
    expect(done.completed_at).toBeInstanceOf(Date)

    // Staying done (or a client trying to rewrite it) keeps the original completion time.
    await alice.query(`update public.tasks set title = 'Edited' where id = $1`, [task.id])
    await alice.query('update public.tasks set completed_at = $2 where id = $1', [
      task.id,
      LONG_AGO,
    ])
    await alice.query(`update public.tasks set status = 'done' where id = $1`, [task.id])
    expect((await taskById(task.id)).completed_at).toEqual(done.completed_at)

    expect((await setStatus('todo')).completed_at).toBeNull()
    expect((await setStatus('done')).completed_at).toBeInstanceOf(Date)
    expect((await setStatus('in_progress')).completed_at).toBeNull()
  })
})

describe('task hierarchy', () => {
  it('allows one level of subtasks', async () => {
    const { project } = await setup()
    const parent = await makeTask(alice, project.id)
    const subtask = await makeTask(alice, project.id, { parent_task_id: parent.id })
    expect(subtask.parent_task_id).toBe(parent.id)
  })

  it('rejects a subtask of a subtask (insert and update)', async () => {
    const { project } = await setup()
    const parent = await makeTask(alice, project.id)
    const subtask = await makeTask(alice, project.id, { parent_task_id: parent.id })
    await expectPgError(
      makeTask(alice, project.id, { parent_task_id: subtask.id }),
      '23514',
      'Subtasks can only be one level deep',
    )
    const loose = await makeTask(alice, project.id)
    await expectPgError(
      alice.query('update public.tasks set parent_task_id = $2 where id = $1', [
        loose.id,
        subtask.id,
      ]),
      '23514',
      'Subtasks can only be one level deep',
    )
  })

  it('rejects giving a parent to a task that has subtasks', async () => {
    const { project } = await setup()
    const parent = await makeTask(alice, project.id)
    await makeTask(alice, project.id, { parent_task_id: parent.id })
    const other = await makeTask(alice, project.id)
    await expectPgError(
      alice.query('update public.tasks set parent_task_id = $2 where id = $1', [
        parent.id,
        other.id,
      ]),
      '23514',
      'A task that has subtasks cannot become a subtask',
    )
  })

  it('rejects a parent from another project or a missing parent', async () => {
    const { project } = await setup()
    const elsewhere = await makeTask(alice, (await makeProject(alice)).id)
    await expectPgError(
      makeTask(alice, project.id, { parent_task_id: elsewhere.id }),
      '23514',
      'A subtask must be in the same project as its parent',
    )
    await expectPgError(
      makeTask(alice, project.id, { parent_task_id: crypto.randomUUID() }),
      '23503',
      'Parent task not found',
    )
  })

  it('rejects making a task the subtask of a task it has a dependency with', async () => {
    const { project } = await setup()
    const first = await makeTask(alice, project.id)
    const second = await makeTask(alice, project.id)
    await makeDependency(alice, project.id, first.id, second.id)
    for (const [child, parent] of [
      [second, first],
      [first, second],
    ]) {
      await expectPgError(
        alice.query('update public.tasks set parent_task_id = $2 where id = $1', [
          child.id,
          parent.id,
        ]),
        '23514',
        'A task cannot depend on its own parent',
      )
    }
  })

  it('accepts bulk writes (one statement) that add or move several subtasks', async () => {
    const { project, design } = await setup()
    const parentId = crypto.randomUUID()
    // PostgREST bulk insert: the parent comes first in the same statement as its subtasks.
    await alice.query(
      `insert into public.tasks (id, project_id, phase_id, parent_task_id, title, sort_order)
       values ($1, $2, $3, null, 'Parent', 'a0'), (gen_random_uuid(), $2, null, $1, 'S1', 'a0'),
              (gen_random_uuid(), $2, null, $1, 'S2', 'a1')`,
      [parentId, project.id, design.id],
    )
    const loose = [await makeTask(alice, project.id), await makeTask(alice, project.id)]
    await alice.query('update public.tasks set parent_task_id = $1 where id = any ($2)', [
      parentId,
      loose.map((task) => task.id),
    ])
    const { rows } = await db.admin.query<{ phase_id: string }>(
      'select phase_id from public.tasks where parent_task_id = $1',
      [parentId],
    )
    expect(rows).toEqual(Array(4).fill({ phase_id: design.id }))
  })

  it('lets a subtask be promoted to top level or moved to another parent', async () => {
    const { project } = await setup()
    const parent = await makeTask(alice, project.id)
    const nextParent = await makeTask(alice, project.id)
    const subtask = await makeTask(alice, project.id, { parent_task_id: parent.id })
    await alice.query('update public.tasks set parent_task_id = $2 where id = $1', [
      subtask.id,
      nextParent.id,
    ])
    expect((await taskById(subtask.id)).parent_task_id).toBe(nextParent.id)
    await alice.query('update public.tasks set parent_task_id = null where id = $1', [subtask.id])
    expect((await taskById(subtask.id)).parent_task_id).toBeNull()
  })

  it('takes the per-project advisory lock while changing the hierarchy', async () => {
    const { project } = await setup()
    const parent = await makeTask(alice, project.id)
    const held = await alice.transaction(async (tx) => {
      await tx.query(
        'insert into public.tasks (project_id, parent_task_id, title, sort_order) values ($1, $2, $3, $4)',
        [project.id, parent.id, 'Child', 'a0'],
      )
      return heldAdvisoryLock(tx, project.id)
    })
    expect(held).toBe(true)
  })
})

describe('subtask phase', () => {
  it('a new subtask takes its parent phase, whatever the client sends', async () => {
    const { project, design, build } = await setup()
    const parent = await makeTask(alice, project.id, { phase_id: design.id })
    const withOther = await makeTask(alice, project.id, {
      parent_task_id: parent.id,
      phase_id: build.id,
    })
    const withNone = await makeTask(alice, project.id, {
      parent_task_id: parent.id,
      phase_id: null,
    })
    expect(withOther.phase_id).toBe(design.id)
    expect(withNone.phase_id).toBe(design.id)
  })

  it("changing a subtask's phase directly is overridden by the parent phase", async () => {
    const { project, design, build } = await setup()
    const parent = await makeTask(alice, project.id, { phase_id: design.id })
    const subtask = await makeTask(alice, project.id, { parent_task_id: parent.id })
    const { rows } = await alice.query<TaskRow>(
      'update public.tasks set phase_id = $2 where id = $1 returning phase_id',
      [subtask.id, build.id],
    )
    expect(rows[0].phase_id).toBe(design.id)
  })

  it("subtasks follow their parent's phase changes", async () => {
    const { project, design, build } = await setup()
    const parent = await makeTask(alice, project.id, { phase_id: design.id })
    const s1 = await makeTask(alice, project.id, {
      parent_task_id: parent.id,
      updated_at: LONG_AGO,
    })
    const s2 = await makeTask(alice, project.id, { parent_task_id: parent.id })
    const unrelated = await makeTask(alice, project.id, { phase_id: design.id })

    await alice.query('update public.tasks set phase_id = $2 where id = $1', [parent.id, build.id])
    expect((await taskById(s1.id)).phase_id).toBe(build.id)
    expect((await taskById(s2.id)).phase_id).toBe(build.id)
    expect((await taskById(s1.id)).updated_at.getTime()).toBeGreaterThan(LONG_AGO.getTime())
    expect((await taskById(unrelated.id)).phase_id).toBe(design.id)

    await alice.query('update public.tasks set phase_id = null where id = $1', [parent.id])
    expect((await taskById(s1.id)).phase_id).toBeNull()
    expect((await taskById(s2.id)).phase_id).toBeNull()
  })

  it('a task that becomes a subtask adopts the new parent phase', async () => {
    const { project, design, build } = await setup()
    const parent = await makeTask(alice, project.id, { phase_id: build.id })
    const task = await makeTask(alice, project.id, { phase_id: design.id })
    await alice.query('update public.tasks set parent_task_id = $2 where id = $1', [
      task.id,
      parent.id,
    ])
    expect((await taskById(task.id)).phase_id).toBe(build.id)
  })

  it('a promoted subtask keeps its phase and can then change it freely', async () => {
    const { project, design, build } = await setup()
    const parent = await makeTask(alice, project.id, { phase_id: design.id })
    const subtask = await makeTask(alice, project.id, { parent_task_id: parent.id })
    await alice.query('update public.tasks set parent_task_id = null where id = $1', [subtask.id])
    expect((await taskById(subtask.id)).phase_id).toBe(design.id)
    await alice.query('update public.tasks set phase_id = $2 where id = $1', [subtask.id, build.id])
    expect((await taskById(subtask.id)).phase_id).toBe(build.id)
  })

  it('deleting the phase ungroups parent and subtasks, whatever order the rows are visited in', async () => {
    const { project, design } = await setup()
    const parentId = crypto.randomUUID()
    const subtaskId = crypto.randomUUID()
    // Store the subtask physically BEFORE its parent (setup only: triggers and FK checks are
    // skipped in replica mode), so the ON DELETE SET NULL update visits the subtask first, while
    // the parent still has the old phase. Without the AFTER trigger the subtask would keep a
    // dangling phase_id.
    await db.admin.transaction(async (tx) => {
      await tx.query('set local session_replication_role = replica')
      const insert = `insert into public.tasks
        (id, user_id, project_id, phase_id, parent_task_id, title, sort_order)
        values ($1, $2, $3, $4, $5, $6, 'a0')`
      await tx.query(insert, [subtaskId, alice.id, project.id, design.id, parentId, 'Subtask'])
      await tx.query(insert, [parentId, alice.id, project.id, design.id, null, 'Parent'])
    })
    const order = await db.admin.query<{ id: string }>(
      'select id from public.tasks where id = any ($1) order by ctid',
      [[parentId, subtaskId]],
    )
    expect(order.rows.map((row) => row.id)).toEqual([subtaskId, parentId])

    await alice.query('delete from public.phases where id = $1', [design.id])
    expect((await taskById(parentId)).phase_id).toBeNull()
    expect((await taskById(subtaskId)).phase_id).toBeNull()
    expect((await taskById(subtaskId)).parent_task_id).toBe(parentId)
  })
})

describe('subtask phase with overlapping requests', () => {
  // Request 1 (a subtask appears under the parent) is left uncommitted with prepare(). Request 2
  // moves the parent to another phase. A real request 2 would wait for request 1's locks; PGlite
  // cannot wait, so request 2 takes the parent's row lock with NOWAIT and fails (55P03) instead.
  const moveParentNowait = (parentId: string, phaseId: string) =>
    alice.query(
      `update public.tasks set phase_id = $2
       where id = (select id from public.tasks where id = $1 for no key update nowait)`,
      [parentId, phaseId],
    )

  const subtaskPhases = async (parentId: string) =>
    (
      await db.admin.query<{ phase_id: string | null }>(
        'select phase_id from public.tasks where parent_task_id = $1',
        [parentId],
      )
    ).rows.map((row) => row.phase_id)

  const requests = {
    'adding a subtask': (parent: TaskRow) => async (tx: Transaction) => {
      await tx.query(
        `insert into public.tasks (project_id, parent_task_id, title, sort_order)
         values ($1, $2, 'Child', 'a0')`,
        [parent.project_id, parent.id],
      )
    },
    'moving a task under the parent':
      (parent: TaskRow, loose: TaskRow) => async (tx: Transaction) => {
        await tx.query('update public.tasks set parent_task_id = $2 where id = $1', [
          loose.id,
          parent.id,
        ])
      },
  }

  it.each(Object.keys(requests) as (keyof typeof requests)[])(
    'a parent phase change waits for %s, so the subtask never keeps the old phase',
    async (name) => {
      const { project, design, build } = await setup()
      const parent = await makeTask(alice, project.id, { phase_id: design.id })
      const loose = await makeTask(alice, project.id)
      const pending = await alice.prepare(requests[name](parent, loose))
      let moveError: unknown = null
      try {
        await moveParentNowait(parent.id, build.id)
      } catch (error) {
        moveError = error
      } finally {
        await pending.commit()
      }

      expect(await subtaskPhases(parent.id)).toEqual([(await taskById(parent.id)).phase_id])
      expect(moveError).toMatchObject({ code: '55P03' })

      // Once request 1 has committed, the move goes through and the subtask follows.
      await moveParentNowait(parent.id, build.id)
      expect(await subtaskPhases(parent.id)).toEqual([build.id])
    },
  )
})

describe('immutable ids, owner and project', () => {
  it.each(['phases', 'tasks', 'milestones', 'task_dependencies'] as const)(
    '%s cannot move to another project, owner or id',
    async (table) => {
      const { project } = await setup()
      const target = await makeProject(alice)
      const [t1, t2] = [await makeTask(alice, project.id), await makeTask(alice, project.id)]
      const row = await {
        phases: () => makePhase(alice, project.id),
        tasks: () => makeTask(alice, project.id),
        milestones: () => makeMilestone(alice, project.id),
        task_dependencies: () => makeDependency(alice, project.id, t1.id, t2.id),
      }[table]()
      const before = await getRow<PhaseRow | TaskRow | MilestoneRow>(db.admin, table, row.id)
      const bob = await db.createUser()

      await expectPgError(
        alice.query(`update public.${table} set project_id = $2 where id = $1`, [
          row.id,
          target.id,
        ]),
        '23514',
        'Moving items to another project is not supported',
      )
      await expectPgError(
        alice.query(`update public.${table} set user_id = $2 where id = $1`, [row.id, bob.id]),
        '42501',
        'Rows cannot be moved to another account',
      )
      await expectPgError(
        alice.query(`update public.${table} set id = $2 where id = $1`, [
          row.id,
          crypto.randomUUID(),
        ]),
        '23514',
        'The id of a row cannot be changed',
      )
      expect(await getRow(db.admin, table, row.id)).toEqual(before)
    },
  )

  it('projects and preferences keep their owner and id', async () => {
    const project = await makeProject(alice)
    const bob = await db.createUser()
    await expectPgError(
      alice.query('update public.projects set user_id = $2 where id = $1', [project.id, bob.id]),
      '42501',
    )
    await expectPgError(
      alice.query('update public.projects set id = $2 where id = $1', [
        project.id,
        crypto.randomUUID(),
      ]),
      '23514',
    )
    const carol = await db.createUser()
    await insertRow(carol, 'user_preferences', {})
    await expectPgError(
      carol.query('update public.user_preferences set user_id = $1', [bob.id]),
      '42501',
    )
  })
})

/** True when the transaction holds the per-project task-graph advisory lock. */
async function heldAdvisoryLock(
  tx: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  projectId: string,
): Promise<boolean> {
  const { rows } = await tx.query<{ held: boolean }>(
    `select exists (
       select 1 from pg_locks l
       where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted
         and l.objsubid = 1
         and ((l.classid::bigint << 32) | l.objid::bigint)
           = hashtextextended('cairn.task_graph:' || $1, 0)
     ) as held`,
    [projectId],
  )
  return rows[0].held
}
