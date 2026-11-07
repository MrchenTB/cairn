/// <reference lib="dom" />
/**
 * R2-R9: Row Level Security and GRANTs on the real project, as the plan's section R describes.
 * Nothing here asserts one exact status code: the hosted gateway may answer differently from the
 * simulator. What is asserted is the outcome: no row comes back, nothing changes, the call is
 * refused (a 4xx/5xx answer).
 */
import { randomUUID } from 'node:crypto'
import {
  createTestProject,
  expect,
  expectShell,
  rest,
  test,
  tokenFor,
  userIdOf,
  type Seeded,
} from './support.ts'

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } })

const TABLES = [
  'projects',
  'phases',
  'tasks',
  'milestones',
  'task_dependencies',
  'user_preferences',
] as const

/** Account A's project, with something in every table the plan lists. */
async function seedAlice(label: string): Promise<Seeded> {
  return createTestProject('A', {
    label,
    phases: [{ name: 'Secret phase of A', color: 'teal' }],
    tasks: [
      { key: 'a', title: 'Secret task of A', phase: 'Secret phase of A', start: '2026-11-05' },
      { key: 's', title: 'Secret subtask of A', parent: 'a', phase: 'Secret phase of A' },
      { key: 'b', title: 'Second task of A' },
    ],
    milestones: [{ key: 'm', name: 'Secret milestone of A', date: '2026-12-01' }],
    deps: [['a', 'b']],
  })
}

const rowsOf = (body: unknown): unknown[] => (Array.isArray(body) ? body : [])
// 501 is "not implemented": a request the server did not understand is not a refusal.
const refused = (status: number) => status >= 400 && status !== 501

/** Everything account A can read, table by table, for before/after comparisons. */
async function snapshotOf(token: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const table of TABLES) {
    const key = table === 'user_preferences' ? 'user_id' : 'id'
    const answer = await rest(token, `${table}?select=*&order=${key}.asc`)
    expect(answer.status, `A reads ${table}`).toBe(200)
    out[table] = answer.body
  }
  return out
}

test.describe('permissions on the real project (R)', () => {
  test('R2: signed out, none of the 6 tables returns a row', async () => {
    const alice = await seedAlice('R2')
    const tokenA = await tokenFor('A')
    // The data exists and A can read it, so an empty answer below is not an empty database.
    expect(
      rowsOf((await rest(tokenA, `projects?id=eq.${alice.projectId}&select=id`)).body),
    ).toHaveLength(1)

    for (const table of TABLES) {
      for (const apikey of [undefined, null] as const) {
        // With the publishable key and no Authorization header, and with nothing at all.
        const answer = await rest(null, `${table}?select=*`, { apikey })
        const label = `${table} ${apikey === null ? 'without apikey' : 'with apikey'} (HTTP ${answer.status})`
        expect(rowsOf(answer.body), label).toEqual([])
        expect(JSON.stringify(answer.body ?? ''), label).not.toContain(alice.projectId)
      }
      const byId = await rest(null, `${table}?id=eq.${alice.projectId}&select=*`)
      expect(rowsOf(byId.body), `${table} by id`).toEqual([])
    }

    // Writes are refused too, and A's data is as it was.
    const patch = await rest(null, `projects?id=eq.${alice.projectId}`, {
      method: 'PATCH',
      body: { name: 'Changed while signed out' },
      prefer: 'return=representation',
    })
    expect(refused(patch.status) || rowsOf(patch.body).length === 0, 'PATCH').toBe(true)
    const remove = await rest(null, `projects?id=eq.${alice.projectId}`, {
      method: 'DELETE',
      prefer: 'return=representation',
    })
    expect(refused(remove.status) || rowsOf(remove.body).length === 0, 'DELETE').toBe(true)
    const insert = await rest(null, 'projects', {
      method: 'POST',
      body: { id: randomUUID(), name: '[e2e] signed out insert', sort_order: 'a0' },
    })
    expect(refused(insert.status), 'POST').toBe(true)
    const after = await rest(tokenA, `projects?id=eq.${alice.projectId}&select=name`)
    expect(after.body).toEqual([{ name: alice.name }])
  })

  test('R3: signed out, the 3 RPCs are refused', async () => {
    const calls: [string, unknown][] = [
      [
        'import_workspace',
        {
          p_data: {
            projects: [{ id: randomUUID(), name: '[e2e] signed out import', sort_order: 'a0' }],
            phases: [],
            tasks: [],
            milestones: [],
            dependencies: [],
          },
        },
      ],
      [
        'apply_task_schedule',
        { p_changes: [{ id: randomUUID(), start_date: '2030-01-01', due_date: '2030-01-02' }] },
      ],
      ['delete_task', { p_task_id: randomUUID(), p_keep_subtasks: false, p_promoted: [] }],
    ]
    for (const [name, body] of calls) {
      for (const apikey of [undefined, null] as const) {
        const answer = await rest(null, `rpc/${name}`, { method: 'POST', body, apikey })
        const label = `${name} ${apikey === null ? 'without apikey' : 'with apikey'}`
        expect(refused(answer.status), `${label} (HTTP ${answer.status})`).toBe(true)
      }
    }
  })

  test("R4: account B reads none of account A's rows", async () => {
    const alice = await seedAlice('R4')
    const tokenA = await tokenFor('A')
    const tokenB = await tokenFor('B')
    const idB = userIdOf(tokenB)
    const idA = userIdOf(tokenA)

    for (const table of TABLES) {
      const all = await rest(tokenB, `${table}?select=*`)
      expect(all.status, `B reads ${table}`).toBe(200)
      const foreign = rowsOf(all.body).filter((row) => (row as { user_id: string }).user_id !== idB)
      expect(foreign, `${table}: rows that are not B's`).toEqual([])
    }
    const byId: [string, string][] = [
      ['projects', alice.projectId],
      ['tasks', alice.ids.a],
      ['tasks', alice.ids.s],
      ['phases', alice.ids['Secret phase of A']],
      ['milestones', alice.ids.m],
    ]
    for (const [table, id] of byId) {
      const answer = await rest(tokenB, `${table}?id=eq.${id}&select=*`)
      expect(answer.status, table).toBe(200)
      expect(answer.body, `B reads A's ${table} row`).toEqual([])
    }
    const byProject = await rest(tokenB, `tasks?project_id=eq.${alice.projectId}&select=*`)
    expect(byProject.body).toEqual([])
    const links = await rest(tokenB, `task_dependencies?project_id=eq.${alice.projectId}&select=*`)
    expect(links.body).toEqual([])
    const prefs = await rest(tokenB, `user_preferences?user_id=eq.${idA}&select=*`)
    expect(prefs.body).toEqual([])

    // The same rows are there for A: B's empty answers are not an outage.
    expect(
      rowsOf((await rest(tokenA, `tasks?project_id=eq.${alice.projectId}&select=id`)).body),
    ).toHaveLength(3)
  })

  test("R5: account B can neither change nor delete account A's rows", async () => {
    const alice = await seedAlice('R5')
    const tokenA = await tokenFor('A')
    const tokenB = await tokenFor('B')
    const before = await snapshotOf(tokenA)

    const targets: [string, string, Record<string, unknown>][] = [
      ['projects', alice.projectId, { name: 'Changed by B' }],
      ['phases', alice.ids['Secret phase of A'], { name: 'Changed by B' }],
      ['tasks', alice.ids.a, { title: 'Changed by B' }],
      ['milestones', alice.ids.m, { name: 'Changed by B' }],
    ]
    for (const [table, id, body] of targets) {
      const patched = await rest(tokenB, `${table}?id=eq.${id}&select=*`, {
        method: 'PATCH',
        body,
        prefer: 'return=representation',
      })
      expect(refused(patched.status) || rowsOf(patched.body).length === 0, `PATCH ${table}`).toBe(
        true,
      )
      const deleted = await rest(tokenB, `${table}?id=eq.${id}&select=id`, {
        method: 'DELETE',
        prefer: 'return=representation',
      })
      expect(refused(deleted.status) || rowsOf(deleted.body).length === 0, `DELETE ${table}`).toBe(
        true,
      )
    }
    const link = await rest(
      tokenB,
      `task_dependencies?project_id=eq.${alice.projectId}&select=id`,
      {
        method: 'DELETE',
        prefer: 'return=representation',
      },
    )
    expect(refused(link.status) || rowsOf(link.body).length === 0, 'DELETE task_dependencies').toBe(
      true,
    )
    // The RPCs run as B, to whom A's rows do not exist.
    const rpcDelete = await rest(tokenB, 'rpc/delete_task', {
      method: 'POST',
      body: { p_task_id: alice.ids.a, p_keep_subtasks: false, p_promoted: [] },
    })
    expect(refused(rpcDelete.status), 'rpc/delete_task').toBe(true)
    const rpcSchedule = await rest(tokenB, 'rpc/apply_task_schedule', {
      method: 'POST',
      body: { p_changes: [{ id: alice.ids.a, start_date: '2030-01-01', due_date: '2030-01-02' }] },
    })
    expect(refused(rpcSchedule.status), 'rpc/apply_task_schedule').toBe(true)

    // The proof: A's rows are exactly as they were, updated_at included.
    expect(await snapshotOf(tokenA)).toEqual(before)
  })

  test("R6: account B cannot attach a task to account A's project", async () => {
    const alice = await seedAlice('R6')
    const bob = await createTestProject('B', {
      label: 'R6',
      tasks: [{ key: 't', title: 'B task' }],
    })
    const tokenA = await tokenFor('A')
    const tokenB = await tokenFor('B')
    const before = await snapshotOf(tokenA)

    const direct = await rest(tokenB, 'tasks?select=*', {
      method: 'POST',
      body: {
        id: randomUUID(),
        project_id: alice.projectId,
        title: 'Planted by B',
        sort_order: 'a0',
      },
      prefer: 'return=representation',
    })
    expect(refused(direct.status), `POST tasks (HTTP ${direct.status})`).toBe(true)

    const phase = await rest(tokenB, 'phases?select=*', {
      method: 'POST',
      body: { id: randomUUID(), project_id: alice.projectId, name: 'Planted', sort_order: 'a0' },
      prefer: 'return=representation',
    })
    expect(refused(phase.status), `POST phases (HTTP ${phase.status})`).toBe(true)

    const viaImport = await rest(tokenB, 'rpc/import_workspace', {
      method: 'POST',
      body: {
        p_data: {
          projects: [],
          phases: [],
          tasks: [
            {
              id: randomUUID(),
              project_id: alice.projectId,
              title: 'Planted by import',
              sort_order: 'a0',
            },
          ],
          milestones: [],
          dependencies: [],
        },
      },
    })
    expect(refused(viaImport.status), `import_workspace (HTTP ${viaImport.status})`).toBe(true)

    const dependency = await rest(tokenB, 'task_dependencies?select=*', {
      method: 'POST',
      body: {
        id: randomUUID(),
        project_id: bob.projectId,
        predecessor_id: bob.ids.t,
        successor_id: alice.ids.a,
      },
      prefer: 'return=representation',
    })
    expect(refused(dependency.status), `POST task_dependencies (HTTP ${dependency.status})`).toBe(
      true,
    )

    expect(await snapshotOf(tokenA)).toEqual(before)
  })

  test('R9: a row cannot be handed over to another account', async () => {
    await seedAlice('R9')
    const bob = await createTestProject('B', {
      label: 'R9',
      tasks: [{ key: 't', title: 'B task' }],
    })
    const tokenA = await tokenFor('A')
    const tokenB = await tokenFor('B')
    const idA = userIdOf(tokenA)
    const beforeA = await snapshotOf(tokenA)

    const move = async (table: string, id: string) =>
      rest(tokenB, `${table}?id=eq.${id}&select=*`, {
        method: 'PATCH',
        body: { user_id: idA },
        prefer: 'return=representation',
      })
    for (const [table, id] of [
      ['projects', bob.projectId],
      ['tasks', bob.ids.t],
    ] as const) {
      const answer = await move(table, id)
      expect(
        refused(answer.status) || rowsOf(answer.body).length === 0,
        `PATCH user_id of ${table} (HTTP ${answer.status})`,
      ).toBe(true)
    }
    const prefs = await rest(tokenB, `user_preferences?user_id=eq.${userIdOf(tokenB)}&select=*`, {
      method: 'PATCH',
      body: { user_id: idA },
      prefer: 'return=representation',
    })
    expect(
      refused(prefs.status) || rowsOf(prefs.body).length === 0,
      `PATCH user_id of user_preferences (HTTP ${prefs.status})`,
    ).toBe(true)

    // Inserting a row as A is refused as well.
    const forged = await rest(tokenB, 'projects?select=*', {
      method: 'POST',
      body: { id: randomUUID(), user_id: idA, name: '[e2e] forged for A', sort_order: 'a0' },
      prefer: 'return=representation',
    })
    expect(refused(forged.status), `POST as A (HTTP ${forged.status})`).toBe(true)

    // B's rows are still B's, and A gained nothing.
    const stillB = await rest(tokenB, `projects?id=eq.${bob.projectId}&select=user_id`)
    expect(stillB.body).toEqual([{ user_id: userIdOf(tokenB) }])
    expect(await snapshotOf(tokenA)).toEqual(beforeA)
  })

  test("R7: account B opening account A's task URL sees Task not found", async ({ device }) => {
    const alice = await createTestProject('A', {
      label: 'R7',
      tasks: [{ key: 'a', title: 'Secret task of A for R7' }],
    })
    const page = await device('B')

    await page.goto(`/my-tasks/all?task=${alice.ids.a}`)
    await expectShell(page)
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'Task not found' }),
    ).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await page.goto(`/projects/${alice.projectId}/list?task=${alice.ids.a}`)
    await expect(page.getByText('Project not found')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    for (const secret of ['Secret task of A for R7', alice.name]) {
      await expect(page.getByText(secret)).toHaveCount(0)
    }
  })
})
