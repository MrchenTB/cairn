import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  countAllOwned,
  getRow,
  insertRow,
  makeDependency,
  seedWorkspace,
  type MilestoneRow,
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

const rowsOfProject = async (projectId: string) => {
  const { rows } = await db.admin.query<{ table_name: string; count: number }>(
    `select 'phases' as table_name, count(*) as count from public.phases where project_id = $1
     union all select 'tasks', count(*) from public.tasks where project_id = $1
     union all select 'milestones', count(*) from public.milestones where project_id = $1
     union all select 'task_dependencies', count(*) from public.task_dependencies where project_id = $1`,
    [projectId],
  )
  return Object.fromEntries(rows.map((row) => [row.table_name, row.count]))
}

describe('deleting a project', () => {
  it('removes its phases, tasks, subtasks, milestones and dependencies only', async () => {
    const doomed = await seedWorkspace(alice)
    const kept = await seedWorkspace(alice)
    expect(await rowsOfProject(doomed.project.id)).toEqual({
      phases: 2,
      tasks: 4,
      milestones: 1,
      task_dependencies: 1,
    })

    await alice.query('delete from public.projects where id = $1', [doomed.project.id])
    expect(await rowsOfProject(doomed.project.id)).toEqual({
      phases: 0,
      tasks: 0,
      milestones: 0,
      task_dependencies: 0,
    })
    expect(await rowsOfProject(kept.project.id)).toEqual({
      phases: 2,
      tasks: 4,
      milestones: 1,
      task_dependencies: 1,
    })
  })
})

describe('deleting a phase', () => {
  it('ungroups its tasks, subtasks and milestones (phase_id → null) and keeps everything else', async () => {
    const ws = await seedWorkspace(alice)
    await alice.query('delete from public.phases where id = $1', [ws.phase.id])

    for (const task of [ws.parent, ws.subtaskA, ws.subtaskB]) {
      const row = await getRow<TaskRow>(db.admin, 'tasks', task.id)
      expect(row).toMatchObject({ phase_id: null, project_id: ws.project.id, title: task.title })
    }
    expect((await getRow<TaskRow>(db.admin, 'tasks', ws.subtaskA.id))?.parent_task_id).toBe(
      ws.parent.id,
    )
    expect(await getRow<MilestoneRow>(db.admin, 'milestones', ws.milestone.id)).toMatchObject({
      phase_id: null,
      project_id: ws.project.id,
    })
    expect(await getRow(db.admin, 'phases', ws.otherPhase.id)).toBeDefined()
    expect(await getRow(db.admin, 'task_dependencies', ws.dependency.id)).toBeDefined()
  })
})

describe('deleting a task', () => {
  it('removes its subtasks and every dependency touching the task or its subtasks', async () => {
    const ws = await seedWorkspace(alice)
    const subtaskDependency = await makeDependency(
      alice,
      ws.project.id,
      ws.other.id,
      ws.subtaskA.id,
    )

    await alice.query('delete from public.tasks where id = $1', [ws.parent.id])
    for (const id of [ws.parent.id, ws.subtaskA.id, ws.subtaskB.id]) {
      expect(await getRow(db.admin, 'tasks', id)).toBeUndefined()
    }
    expect(await getRow(db.admin, 'task_dependencies', ws.dependency.id)).toBeUndefined()
    expect(await getRow(db.admin, 'task_dependencies', subtaskDependency.id)).toBeUndefined()
    expect(await getRow(db.admin, 'tasks', ws.other.id)).toBeDefined()
    expect(await getRow(db.admin, 'milestones', ws.milestone.id)).toBeDefined()
  })

  it('deleting a subtask keeps its parent and siblings', async () => {
    const ws = await seedWorkspace(alice)
    await alice.query('delete from public.tasks where id = $1', [ws.subtaskA.id])
    expect(await getRow(db.admin, 'tasks', ws.parent.id)).toBeDefined()
    expect(await getRow(db.admin, 'tasks', ws.subtaskB.id)).toBeDefined()
  })
})

describe('deleting an account', () => {
  it("removes all of that user's rows and nobody else's", async () => {
    const bob = await db.createUser()
    const carol = await db.createUser()
    await seedWorkspace(bob)
    await insertRow(bob, 'user_preferences', {})
    await seedWorkspace(carol)
    await insertRow(carol, 'user_preferences', {})
    const carolBefore = await countAllOwned(db.admin, carol.id)

    await db.admin.query('delete from auth.users where id = $1', [bob.id])
    expect(Object.values(await countAllOwned(db.admin, bob.id))).toEqual([0, 0, 0, 0, 0, 0])
    expect(await countAllOwned(db.admin, carol.id)).toEqual(carolBefore)
  })
})
