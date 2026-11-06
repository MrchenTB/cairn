/// <reference lib="dom" />
/**
 * Cloud mode, AC-16: a second account sees nothing of the first, through the UI (deep links with the
 * other user's ids) and through direct REST calls with its own token (reads empty, writes affect
 * nothing, RPCs rejected); without a token nothing at all. RLS and GRANTs come from the real
 * migration on Postgres. Hosted-project settings stay out of reach of this proof.
 */
import { createHmac, randomUUID } from 'node:crypto'
import { type Page } from '@playwright/test'
import {
  accessToken,
  buildImport,
  expect,
  expectShell,
  rest,
  seedProject,
  signUpNew,
  sim,
  test,
  userId,
  uniqueEmail,
  watchConsole,
} from './support.ts'

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } })

const SECRET_NAMES = [
  'Alice secret project',
  'Alice secret task',
  'Alice secret phase',
  'Alice secret milestone',
]

const TABLES = [
  'projects',
  'phases',
  'tasks',
  'milestones',
  'task_dependencies',
  'user_preferences',
]

interface Alice {
  email: string
  id: string
  token: string
  projectId: string
  ids: Record<string, string>
}

async function setUpAlice(page: Page): Promise<Alice> {
  const email = await signUpNew(page, uniqueEmail('alice'))
  const { projectId, ids } = await seedProject(page, {
    name: 'Alice secret project',
    phases: ['Alice secret phase'],
    tasks: [
      {
        key: 'a',
        title: 'Alice secret task',
        start: '2026-11-05',
        due: '2026-11-07',
        phase: 'Alice secret phase',
      },
      { key: 's', title: 'Alice secret subtask', parent: 'a', phase: 'Alice secret phase' },
      { key: 'b', title: 'Alice second task' },
    ],
    milestones: [{ key: 'm', name: 'Alice secret milestone', date: '2026-12-01' }],
    deps: [['a', 'b']],
  })
  await expect(page.getByRole('heading', { name: 'Alice secret project' })).toBeVisible()
  return { email, id: await userId(email), token: await accessToken(page), projectId, ids }
}

/** Everything of Alice's as stored, to prove that nothing changed. */
function aliceSnapshot(alice: Alice) {
  return sim.sql(
    `select
       (select json_agg(p order by p.id) from public.projects p where p.user_id = $1) as projects,
       (select json_agg(p order by p.id) from public.phases p where p.user_id = $1) as phases,
       (select json_agg(t order by t.id) from public.tasks t where t.user_id = $1) as tasks,
       (select json_agg(m order by m.id) from public.milestones m where m.user_id = $1) as milestones,
       (select json_agg(d order by d.id) from public.task_dependencies d where d.user_id = $1) as deps,
       (select json_agg(u) from public.user_preferences u where u.user_id = $1) as preferences`,
    [alice.id],
  )
}

test.describe('account isolation (AC-16)', () => {
  test("through the UI: deep links with the other account's ids show nothing of it", async ({
    browser,
    page,
  }) => {
    const alice = await setUpAlice(page)
    const context = await browser.newContext({
      baseURL: 'http://localhost:5181',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    })
    const bob = await context.newPage()
    watchConsole(bob)
    try {
      await signUpNew(bob, uniqueEmail('bob'))

      const expectNothingOfAlice = async () => {
        for (const name of SECRET_NAMES) await expect(bob.getByText(name)).toHaveCount(0)
      }

      for (const view of ['list', 'board', 'gantt']) {
        await bob.goto(`/projects/${alice.projectId}/${view}`)
        await expect(bob.getByText('Project not found')).toBeVisible()
        await expectNothingOfAlice()
      }

      // The task and milestone modals: the same id answers "not found", not its content.
      await bob.goto(`/projects/${alice.projectId}/list?task=${alice.ids.a}`)
      await expect(bob.getByRole('dialog')).toHaveCount(0)
      await expectNothingOfAlice()
      await bob.goto(`/my-tasks/all?task=${alice.ids.a}`)
      await expectShell(bob)
      await expect(
        bob.locator('[data-sonner-toast]').filter({ hasText: 'Task not found' }),
      ).toBeVisible()
      await expect(bob.getByRole('dialog')).toHaveCount(0)
      await expectNothingOfAlice()

      for (const path of ['/overview', '/my-tasks/all', '/projects', '/timeline']) {
        await bob.goto(path)
        await expectShell(bob)
        await expectNothingOfAlice()
      }

      // Search looks everywhere the account can read.
      await bob.goto('/overview')
      await expectShell(bob)
      await bob
        .getByRole('banner')
        .getByRole('button', { name: /^Search/ })
        .click()
      await bob.getByRole('combobox').first().fill('Alice secret')
      await bob.waitForTimeout(300)
      await expect(bob.getByRole('option', { name: /Alice secret/ })).toHaveCount(0)
    } finally {
      await context.close()
    }
  })

  test('through REST with its own token: reads are empty, writes change nothing, RPCs are refused', async ({
    browser,
    page,
  }) => {
    const alice = await setUpAlice(page)
    const before = await aliceSnapshot(alice)
    const context = await browser.newContext({ baseURL: 'http://localhost:5181' })
    const bobPage = await context.newPage()
    watchConsole(bobPage)
    const bobEmail = await signUpNew(bobPage, uniqueEmail('bob'))
    const bob = await accessToken(bobPage)
    const bobId = await userId(bobEmail)
    await context.close()

    // Reads: nothing of Alice's in any table, whichever way it is asked.
    for (const table of TABLES) {
      const all = await rest(bob, `${table}?select=*`)
      expect(all.status, table).toBe(200)
      const rows = all.body as { user_id?: string }[]
      expect(
        rows.filter((row) => row.user_id !== bobId),
        table,
      ).toEqual([])
    }
    const byId: [string, string][] = [
      ['projects', alice.projectId],
      ['tasks', alice.ids.a],
      ['phases', alice.ids['Alice secret phase']],
      ['milestones', alice.ids.m],
    ]
    for (const [table, id] of byId) {
      const answer = await rest(bob, `${table}?id=eq.${id}&select=*`)
      expect(answer, table).toEqual({ status: 200, body: [] })
    }
    const prefs = await rest(bob, `user_preferences?user_id=eq.${alice.id}&select=*`)
    expect(prefs).toEqual({ status: 200, body: [] })

    // PATCH / DELETE: 0 rows affected.
    for (const [table, id] of byId) {
      const body = table === 'tasks' ? { title: 'Hacked' } : { name: 'Hacked' }
      const patched = await rest(bob, `${table}?id=eq.${id}&select=*`, {
        method: 'PATCH',
        body,
        prefer: 'return=representation',
      })
      expect(patched, `PATCH ${table}`).toEqual({ status: 200, body: [] })
      const deleted = await rest(bob, `${table}?id=eq.${id}&select=id`, {
        method: 'DELETE',
        prefer: 'return=representation',
      })
      expect(deleted, `DELETE ${table}`).toEqual({ status: 200, body: [] })
    }
    const prefPatch = await rest(bob, `user_preferences?user_id=eq.${alice.id}&select=*`, {
      method: 'PATCH',
      body: { theme: 'dark' },
      prefer: 'return=representation',
    })
    expect(prefPatch).toEqual({ status: 200, body: [] })
    const prefDelete = await rest(bob, `user_preferences?user_id=eq.${alice.id}`, {
      method: 'DELETE',
    })
    expect(prefDelete.status).toBe(204)

    // INSERT as Alice: refused by the policy's WITH CHECK.
    const forged = await rest(bob, 'projects?select=*', {
      method: 'POST',
      body: { id: randomUUID(), user_id: alice.id, name: 'Forged', sort_order: 'a0' },
      prefer: 'return=representation',
    })
    expect(forged.status).toBe(403)
    expect(forged.body).toMatchObject({ code: '42501' })

    // INSERT into Alice's project under Bob's own id: the composite foreign key refuses it.
    const intoProject = await rest(bob, 'tasks?select=*', {
      method: 'POST',
      body: { id: randomUUID(), project_id: alice.projectId, title: 'Planted', sort_order: 'a0' },
      prefer: 'return=representation',
    })
    expect(intoProject.status).toBe(409)
    expect(intoProject.body).toMatchObject({ code: '23503' })

    // Taking over a row of one's own into Alice's account: refused by the trigger.
    const own = buildImport({ name: 'Bob project', tasks: [{ key: 't', title: 'Bob task' }] })
    const imported = await rest(bob, 'rpc/import_workspace', {
      method: 'POST',
      body: { p_data: own.data },
    })
    expect(imported.status).toBe(200)
    const takeover = await rest(bob, `projects?id=eq.${own.projectId}&select=*`, {
      method: 'PATCH',
      body: { user_id: alice.id },
      prefer: 'return=representation',
    })
    expect(takeover.status).toBe(403)
    expect(takeover.body).toMatchObject({ code: '42501' })

    // Linking Bob's task to Alice's: same project is required, her task is out of reach.
    const link = await rest(bob, 'task_dependencies?select=*', {
      method: 'POST',
      body: {
        id: randomUUID(),
        project_id: own.projectId,
        predecessor_id: own.ids.t,
        successor_id: alice.ids.a,
      },
      prefer: 'return=representation',
    })
    expect([400, 409]).toContain(link.status)

    // RPCs run under the caller's RLS, so her rows do not exist for him.
    const schedule = await rest(bob, 'rpc/apply_task_schedule', {
      method: 'POST',
      body: { p_changes: [{ id: alice.ids.a, start_date: '2030-01-01', due_date: '2030-01-02' }] },
    })
    expect(schedule.status).toBe(500)
    expect(schedule.body).toMatchObject({ code: 'P0002' })

    const deleteTask = await rest(bob, 'rpc/delete_task', {
      method: 'POST',
      body: { p_task_id: alice.ids.a, p_keep_subtasks: false, p_promoted: [] },
    })
    expect(deleteTask.body).toMatchObject({ code: 'P0002' })

    // Import cannot reference her project, nor reuse her ids.
    const attach = await rest(bob, 'rpc/import_workspace', {
      method: 'POST',
      body: {
        p_data: {
          projects: [],
          phases: [
            { id: randomUUID(), project_id: alice.projectId, name: 'Planted', sort_order: 'a0' },
          ],
          tasks: [],
          milestones: [],
          dependencies: [],
        },
      },
    })
    expect(attach.status).toBe(409)
    expect(attach.body).toMatchObject({ code: '23503' })
    const reuse = await rest(bob, 'rpc/import_workspace', {
      method: 'POST',
      body: {
        p_data: {
          projects: [{ id: alice.projectId, name: 'Overwrite', sort_order: 'a0' }],
          phases: [],
          tasks: [],
          milestones: [],
          dependencies: [],
        },
      },
    })
    expect(reuse.status).toBe(409)
    expect(reuse.body).toMatchObject({ code: '23505' })

    // The real proof: Alice's rows are exactly as they were.
    expect(await aliceSnapshot(alice)).toEqual(before)
    // Alice's own token keeps working on them, so the empty answers above were not an outage.
    expect((await rest(alice.token, `projects?id=eq.${alice.projectId}&select=name`)).body).toEqual(
      [{ name: 'Alice secret project' }],
    )
  })

  test('without a token: nothing to read or write; bad keys and forged tokens are refused', async ({
    page,
  }) => {
    const alice = await setUpAlice(page)
    const before = await aliceSnapshot(alice)

    for (const table of TABLES) {
      const read = await rest(null, `${table}?select=*`)
      expect(read.status, `anon GET ${table}`).toBe(401)
      expect(read.body, `anon GET ${table}`).toMatchObject({ code: '42501' })
    }
    const write = await rest(null, `projects?id=eq.${alice.projectId}`, {
      method: 'PATCH',
      body: { name: 'Hacked' },
    })
    expect(write.status).toBe(401)
    const remove = await rest(null, `projects?id=eq.${alice.projectId}`, { method: 'DELETE' })
    expect(remove.status).toBe(401)
    const insert = await rest(null, 'projects', {
      method: 'POST',
      body: { id: randomUUID(), user_id: alice.id, name: 'Hacked', sort_order: 'a0' },
    })
    expect(insert.status).toBe(401)

    for (const [name, body] of [
      ['apply_task_schedule', { p_changes: [] }],
      ['delete_task', { p_task_id: alice.ids.a }],
      ['import_workspace', { p_data: { projects: [] } }],
    ] as const) {
      const rpc = await rest(null, `rpc/${name}`, { method: 'POST', body })
      expect(rpc.status, name).toBe(401)
      expect(rpc.body, name).toMatchObject({ code: '42501' })
    }
    // Trigger functions are not callable by anyone over the API.
    const trigger = await rest(alice.token, 'rpc/tg_set_updated_at', { method: 'POST', body: {} })
    expect(trigger.status).toBe(403)

    // The publishable key alone is the anon role.
    const withKey = await rest('sb_publishable_cloudsim_test_key', 'tasks?select=*')
    expect(withKey.status).toBe(401)

    // No API key, a wrong one, a forged token (wrong secret, and alg none).
    expect((await rest(null, 'tasks?select=*', { apikey: null })).status).toBe(401)
    expect((await rest(null, 'tasks?select=*', { apikey: 'sb_publishable_wrong' })).status).toBe(
      401,
    )
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const claims = { sub: alice.id, role: 'authenticated', exp: 9_999_999_999 }
    const head = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`
    const forged = `${head}.${createHmac('sha256', 'guessed-secret').update(head).digest('base64url')}`
    const forgedAnswer = await rest(forged, 'tasks?select=*')
    expect(forgedAnswer.status).toBe(401)
    expect(forgedAnswer.body).toMatchObject({ code: 'PGRST301' })
    const none = `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`
    expect((await rest(none, 'tasks?select=*')).status).toBe(401)

    expect(await aliceSnapshot(alice)).toEqual(before)
  })
})
