import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  expectPgError,
  getRow,
  makeDependency,
  makeProject,
  makeTask,
  type DependencyRow,
  type TaskRow,
} from './fixtures.ts'
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

/** A project with `count` top-level tasks. */
async function tasks(count: number): Promise<{ projectId: string; ids: string[] }> {
  const project = await makeProject(alice)
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    ids.push((await makeTask(alice, project.id, { title: `T${index}` })).id)
  }
  return { projectId: project.id, ids }
}

const link = (projectId: string, from: string, to: string) =>
  makeDependency(alice, projectId, from, to)

describe('valid dependencies', () => {
  it('links two tasks of the same project (finish-to-start)', async () => {
    const { projectId, ids } = await tasks(2)
    const dependency = await link(projectId, ids[0], ids[1])
    expect(dependency).toMatchObject({
      predecessor_id: ids[0],
      successor_id: ids[1],
      project_id: projectId,
      user_id: alice.id,
      type: 'FS',
    })
  })

  it('allows diamonds and chains (a DAG), but not closing them into a cycle', async () => {
    const { projectId, ids } = await tasks(4)
    const [a, b, c, d] = ids
    await link(projectId, a, b)
    await link(projectId, a, c)
    await link(projectId, b, d)
    await link(projectId, c, d)
    await link(projectId, a, d)
    await expectPgError(link(projectId, d, a), '23514', 'This dependency would create a cycle')
  })

  it('allows links between subtasks, and between a subtask and an unrelated task', async () => {
    const { projectId, ids } = await tasks(2)
    const s1 = await makeTask(alice, projectId, { parent_task_id: ids[0] })
    const s2 = await makeTask(alice, projectId, { parent_task_id: ids[0] })
    const s3 = await makeTask(alice, projectId, { parent_task_id: ids[1] })
    await link(projectId, s1.id, s2.id)
    await link(projectId, s2.id, s3.id)
    await link(projectId, s3.id, ids[0]) // subtask of another parent → parent of s1/s2: fine
  })
})

describe('rejected dependencies', () => {
  it('self', async () => {
    const { projectId, ids } = await tasks(1)
    await expectPgError(link(projectId, ids[0], ids[0]), '23514', 'A task cannot depend on itself')
  })

  it('duplicate', async () => {
    const { projectId, ids } = await tasks(2)
    await link(projectId, ids[0], ids[1])
    await expectPgError(link(projectId, ids[0], ids[1]), '23505', 'This dependency already exists')
  })

  it('2-node cycle (the reverse edge already exists)', async () => {
    const { projectId, ids } = await tasks(2)
    await link(projectId, ids[0], ids[1])
    await expectPgError(
      link(projectId, ids[1], ids[0]),
      '23514',
      'This dependency would create a cycle',
    )
  })

  it('3-node cycle', async () => {
    const { projectId, ids } = await tasks(3)
    await link(projectId, ids[0], ids[1])
    await link(projectId, ids[1], ids[2])
    await expectPgError(
      link(projectId, ids[2], ids[0]),
      '23514',
      'This dependency would create a cycle',
    )
  })

  it('long cycle', async () => {
    const { projectId, ids } = await tasks(8)
    for (let index = 0; index < ids.length - 1; index += 1) {
      await link(projectId, ids[index], ids[index + 1])
    }
    await expectPgError(link(projectId, ids[7], ids[0]), '23514', 'cycle')
    await expectPgError(link(projectId, ids[5], ids[2]), '23514', 'cycle')
  })

  it('across projects', async () => {
    const first = await tasks(1)
    const second = await tasks(1)
    await expectPgError(
      link(first.projectId, first.ids[0], second.ids[0]),
      '23514',
      'Dependencies can only link tasks in the same project',
    )
    await expectPgError(
      link(second.projectId, first.ids[0], second.ids[0]),
      '23514',
      'Dependencies can only link tasks in the same project',
    )
  })

  it('between a task and its own subtask, in either direction', async () => {
    const { projectId, ids } = await tasks(1)
    const subtask = await makeTask(alice, projectId, { parent_task_id: ids[0] })
    await expectPgError(
      link(projectId, ids[0], subtask.id),
      '23514',
      'A task cannot depend on its own parent or subtask',
    )
    await expectPgError(
      link(projectId, subtask.id, ids[0]),
      '23514',
      'A task cannot depend on its own parent or subtask',
    )
  })

  it('referencing a task that does not exist', async () => {
    const { projectId, ids } = await tasks(1)
    await expectPgError(
      link(projectId, crypto.randomUUID(), ids[0]),
      '23503',
      'Predecessor task not found',
    )
    await expectPgError(
      link(projectId, ids[0], crypto.randomUUID()),
      '23503',
      'Successor task not found',
    )
  })
})

describe('updating a dependency', () => {
  it('re-validates the new edge (cycle, duplicate, self)', async () => {
    const { projectId, ids } = await tasks(4)
    const [a, b, c, d] = ids
    await link(projectId, a, b)
    await link(projectId, b, c)
    const cd = await link(projectId, c, d)
    const update = (values: { predecessor_id?: string; successor_id?: string }) =>
      alice.query(
        `update public.task_dependencies
         set predecessor_id = coalesce($2, predecessor_id), successor_id = coalesce($3, successor_id)
         where id = $1`,
        [cd.id, values.predecessor_id ?? null, values.successor_id ?? null],
      )
    await expectPgError(update({ successor_id: a }), '23514', 'cycle') // c → a closes a → b → c
    await expectPgError(update({ predecessor_id: a, successor_id: b }), '23505', 'already exists')
    await expectPgError(update({ successor_id: c }), '23514', 'itself')
    await update({ predecessor_id: b })
    const row = await getRow<DependencyRow>(db.admin, 'task_dependencies', cd.id)
    expect(row).toMatchObject({ predecessor_id: b, successor_id: d })
  })

  it('reversing an edge in place is not a cycle with itself', async () => {
    const { projectId, ids } = await tasks(2)
    const edge = await link(projectId, ids[0], ids[1])
    await alice.query(
      'update public.task_dependencies set predecessor_id = $2, successor_id = $3 where id = $1',
      [edge.id, ids[1], ids[0]],
    )
    expect(await getRow<DependencyRow>(db.admin, 'task_dependencies', edge.id)).toMatchObject({
      predecessor_id: ids[1],
      successor_id: ids[0],
    })
  })
})

describe('concurrency guard', () => {
  it('takes the per-project advisory lock shared with hierarchy changes', async () => {
    const { projectId, ids } = await tasks(2)
    const held = await alice.transaction(async (tx) => {
      await tx.query(
        'insert into public.task_dependencies (project_id, predecessor_id, successor_id) values ($1, $2, $3)',
        [projectId, ids[0], ids[1]],
      )
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
    })
    expect(held).toBe(true)
  })

  it('keeps the lock until an in-flight insert commits, so the reverse edge then sees it', async () => {
    const { projectId, ids } = await tasks(2)
    const lockIsFree = async () =>
      (
        await alice.query<{ free: boolean }>(
          `select pg_try_advisory_xact_lock(hashtextextended('cairn.task_graph:' || $1, 0)) as free`,
          [projectId],
        )
      ).rows[0].free
    const pending = await alice.prepare(async (tx) => {
      await tx.query(
        'insert into public.task_dependencies (project_id, predecessor_id, successor_id) values ($1, $2, $3)',
        [projectId, ids[0], ids[1]],
      )
    })
    try {
      // A concurrent dependency or hierarchy change in this project would wait here.
      expect(await lockIsFree()).toBe(false)
    } finally {
      await pending.commit()
    }
    expect(await lockIsFree()).toBe(true)
    await expectPgError(link(projectId, ids[1], ids[0]), '23514', 'cycle')
  })
})

describe('deleting tasks', () => {
  it('removes their dependencies on both sides', async () => {
    const { projectId, ids } = await tasks(3)
    const ab = await link(projectId, ids[0], ids[1])
    const bc = await link(projectId, ids[1], ids[2])
    await alice.query('delete from public.tasks where id = $1', [ids[1]])
    expect(await getRow(db.admin, 'task_dependencies', ab.id)).toBeUndefined()
    expect(await getRow(db.admin, 'task_dependencies', bc.id)).toBeUndefined()
    expect(await getRow<TaskRow>(db.admin, 'tasks', ids[0])).toBeDefined()
  })
})
