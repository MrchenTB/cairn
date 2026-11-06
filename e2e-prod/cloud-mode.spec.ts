/// <reference lib="dom" />
/**
 * A cloud-mode production build behind the real CSP: Supabase is answered at the network layer,
 * after the browser applied connect-src, so a blocked request would never get here. What Supabase
 * does with these calls is covered by e2e-cloud (simulator) and tests/db (real migration).
 */
import { readFileSync } from 'node:fs'
import { expect, type Page } from '@playwright/test'
import { expectNoInjection } from '../e2e/security.helpers.ts'
import { CLOUD_BASE_URL, FAKE_SUPABASE_URL } from '../playwright.prod.config.ts'
import { test } from './fixtures.ts'

test.use({
  baseURL: CLOUD_BASE_URL,
  timezoneId: 'Asia/Taipei',
  locale: 'en-US',
  colorScheme: 'light',
})

const NOW = '2026-11-03T08:00:00.000Z'
const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'me@example.test',
  app_metadata: {},
  user_metadata: {},
  created_at: NOW,
}
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
  'access-control-expose-headers': '*',
}

function accessToken() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const claims = { sub: USER.id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.signature`
}

/** The hash of a link in a Supabase email (implicit flow). */
function emailLinkHash(type: 'recovery' | 'signup') {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600
  return `#access_token=${accessToken()}&expires_at=${expiresAt}&expires_in=3600&refresh_token=refresh&token_type=bearer&type=${type}`
}

type Row = Record<string, unknown> & { id?: string }
interface Write {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
}
/** In-memory PostgREST: just enough of tables, filters, single-object answers and the three RPCs. */
class FakeDb {
  tables: Record<string, Row[]> = {
    projects: [],
    phases: [],
    tasks: [],
    milestones: [],
    task_dependencies: [],
  }
  writes: Write[] = []
  private serial = 0
  newId() {
    return `00000000-0000-4000-8000-${String(++this.serial).padStart(12, '0')}`
  }
  insertRow(table: string, row: Row): Row {
    const stored = {
      user_id: USER.id,
      created_at: NOW,
      updated_at: NOW,
      ...(table === 'tasks' ? { completed_at: null } : {}),
      ...row,
    }
    this.tables[table].push(stored)
    return stored
  }
  rpc(name: string, args: Record<string, unknown>): unknown {
    if (name === 'apply_task_schedule') {
      const changes = args.p_changes as { id: string; start_date: string; due_date: string }[]
      return changes.map((change) => {
        const task = this.tables.tasks.find((row) => row.id === change.id)!
        task.start_date = change.start_date
        task.due_date = change.due_date
        return task
      })
    }
    if (name === 'import_workspace') {
      const data = args.p_data as Record<
        'projects' | 'phases' | 'tasks' | 'milestones' | 'dependencies',
        Row[]
      >
      const ids = new Map<string, string>()
      const fresh = (id: unknown) => {
        if (id === null || id === undefined) return null
        if (!ids.has(String(id))) ids.set(String(id), this.newId())
        return ids.get(String(id))!
      }
      for (const row of data.projects) this.insertRow('projects', { ...row, id: fresh(row.id)! })
      for (const row of data.phases)
        this.insertRow('phases', { ...row, id: fresh(row.id)!, project_id: fresh(row.project_id) })
      for (const row of data.tasks)
        this.insertRow('tasks', {
          ...row,
          id: fresh(row.id)!,
          project_id: fresh(row.project_id),
          phase_id: fresh(row.phase_id),
          parent_task_id: fresh(row.parent_task_id),
        })
      for (const row of data.milestones)
        this.insertRow('milestones', {
          ...row,
          id: fresh(row.id)!,
          project_id: fresh(row.project_id),
          phase_id: fresh(row.phase_id),
        })
      for (const row of data.dependencies)
        this.insertRow('task_dependencies', {
          id: fresh(row.id)!,
          project_id: fresh(row.project_id),
          predecessor_id: fresh(row.predecessor_id),
          successor_id: fresh(row.successor_id),
          type: row.type,
        })
      return {
        projects: data.projects.length,
        phases: data.phases.length,
        tasks: data.tasks.length,
        milestones: data.milestones.length,
        dependencies: data.dependencies.length,
      }
    }
    throw new Error(`unexpected rpc ${name}`)
  }
}

async function simulateSupabase(page: Page, requests: string[] = [], db?: FakeDb) {
  await page.route(`${FAKE_SUPABASE_URL}/**`, async (route) => {
    const request = route.request()
    const url = request.url()
    requests.push(`${request.method()} ${url}`)
    const json = (status: number, body: unknown, headers = {}) =>
      route.fulfill({
        status,
        headers: { ...CORS, ...headers },
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (url.includes('/auth/v1/token')) {
      if ((request.postDataJSON() as { password?: string }).password === 'wrong-password') {
        return json(400, {
          code: 400,
          error_code: 'invalid_credentials',
          msg: 'Invalid login credentials',
        })
      }
      return json(200, {
        access_token: accessToken(),
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'refresh',
        user: USER,
      })
    }
    if (url.includes('/auth/v1/logout')) return route.fulfill({ status: 204, headers: CORS })
    if (url.includes('/auth/v1/user')) return json(200, USER)
    if (db && url.includes('/rest/v1/') && !url.includes('/user_preferences')) {
      const parsed = new URL(url)
      const name = parsed.pathname.replace('/rest/v1/', '')
      const single = (request.headers()['accept'] ?? '').includes('vnd.pgrst.object')
      const body = request.method() === 'GET' ? null : request.postDataJSON()
      if (request.method() !== 'GET') {
        db.writes.push({
          method: request.method(),
          path: parsed.pathname,
          query: parsed.searchParams,
          body,
        })
      }
      if (name.startsWith('rpc/')) {
        try {
          return json(200, db.rpc(name.slice(4), body as Record<string, unknown>))
        } catch (error) {
          return json(400, { code: 'P0001', message: String(error), details: null, hint: null })
        }
      }
      const rows = db.tables[name]
      const idFilter = /^eq\.(.+)$/.exec(parsed.searchParams.get('id') ?? '')?.[1]
      if (request.method() === 'POST') {
        const stored = db.insertRow(name, body as Row)
        return json(201, single ? stored : [stored])
      }
      if (request.method() === 'PATCH') {
        const row = rows.find((candidate) => candidate.id === idFilter)
        if (!row)
          return json(406, { code: 'PGRST116', message: 'no rows', details: null, hint: null })
        Object.assign(row, body)
        return json(200, single ? row : [row])
      }
      if (request.method() === 'DELETE') {
        const hit = rows.filter((candidate) => candidate.id === idFilter)
        db.tables[name] = rows.filter((candidate) => candidate.id !== idFilter)
        return json(
          200,
          hit.map((row) => ({ id: row.id })),
        )
      }
      const after = /^gt\.(.+)$/.exec(parsed.searchParams.get('id') ?? '')?.[1]
      const page = rows
        .filter((row) => after === undefined || String(row.id) > after)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      return json(200, page, {
        'content-range': page.length ? `0-${page.length - 1}/${rows.length}` : '*/0',
      })
    }
    if (url.includes('/rest/v1/')) {
      // `.single()`: PostgREST answers with one object.
      if ((request.headers()['accept'] ?? '').includes('vnd.pgrst.object')) {
        return json(200, {
          user_id: USER.id,
          theme: 'system',
          sidebar_collapsed: false,
          timezone: 'Asia/Taipei',
          week_starts_on: 1,
          created_at: NOW,
          updated_at: NOW,
          ...((request.postDataJSON() as object | null) ?? {}),
        })
      }
      return json(200, [], { 'content-range': '*/0' })
    }
    return json(404, {})
  })
}

test('wrong password, sign-in, back to the deep link, sign-out', async ({ page, problems }) => {
  const requests: string[] = []
  await simulateSupabase(page, requests)
  await page.goto('/projects/00000000-0000-4000-8000-000000000000/list?task=abc')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Welcome to Cairn' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Sync status/ })).toHaveCount(0)

  await page.getByLabel('Email').fill('me@example.test')
  await page.getByLabel('Password', { exact: true }).fill('wrong-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('Incorrect email or password.')
  // The browser logs the simulated 400 itself: expected here.
  expect(problems.every((problem) => problem.includes('status of 400'))).toBe(true)
  problems.length = 0

  await page.getByLabel('Password', { exact: true }).fill('correct-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/projects\/00000000-0000-4000-8000-000000000000\/list/)
  await expect(page.getByRole('main')).toContainText('Project not found')
  await expect(page.getByRole('button', { name: /Sync status: Local only/ })).toHaveCount(0)
  expect(requests.some((request) => request.includes('/rest/v1/projects'))).toBe(true)

  await page.goto('/settings/account')
  await expect(page.getByRole('main')).toContainText('me@example.test')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)
  const keys = await page.evaluate(() => Object.keys(localStorage))
  expect(keys.filter((key) => /auth-token/.test(key))).toEqual([])
})

test('a password-reset link asks for a new password; its tokens leave the URL', async ({
  page,
}) => {
  const requests: string[] = []
  await simulateSupabase(page, requests)
  await page.goto(`/${emailLinkHash('recovery')}`)
  const dialog = page.getByRole('dialog', { name: 'Set a new password' })
  await expect(dialog).toBeVisible()
  expect(page.url()).not.toContain('access_token')
  expect(page.url()).not.toContain('refresh_token')
  await page.getByLabel('New password', { exact: true }).fill('a-new-password-1')
  await page.getByLabel('Confirm new password', { exact: true }).fill('a-new-password-1')
  await page.getByRole('button', { name: 'Update password' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Password updated' }),
  ).toBeVisible()
  expect(
    requests.some((request) => request.startsWith('PUT') && request.includes('/auth/v1/user')),
  ).toBe(true)
})

test('an email-confirmation link signs in; its tokens leave the URL', async ({ page }) => {
  await simulateSupabase(page)
  await page.goto(`/${emailLinkHash('signup')}`)
  await expect(page).toHaveURL(/\/overview$/)
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
  expect(page.url()).not.toContain('access_token')
})

test('a crafted email link never shows its text', async ({ page }) => {
  await simulateSupabase(page)
  const text = encodeURIComponent('<img src=x onerror=alert(1)> Call 555-EVIL')
  await page.goto(`/login#error=access_denied&error_code=otp_expired&error_description=${text}`)
  await expect(page.getByRole('alert')).toContainText('invalid or has expired')
  await expect(page.getByRole('main')).not.toContainText('555-EVIL')
  await expectNoInjection(page, 'crafted email link')
})

// ---------------------------------------------------------------------------------------------
// Writes under the production CSP (PRD 6.1, 9.2): create, drag, Auto Apply RPC and import all go
// out as the right requests, none is blocked (the fixture fails the test on a CSP violation).
// ---------------------------------------------------------------------------------------------

const AUTO = '00000000-0000-4000-8000-aaaaaaaaaaa1'
const MANUAL = '00000000-0000-4000-8000-aaaaaaaaaaa2'
const T = (n: number) => `00000000-0000-4000-8000-bbbbbbbbbb${String(n).padStart(2, '0')}`
const DAY_PX = 36

function seedDb(): FakeDb {
  const db = new FakeDb()
  const project = (id: string, name: string, mode: string, sort: string) =>
    db.insertRow('projects', {
      id,
      name,
      description: null,
      status: 'active',
      color: 'blue',
      start_date: null,
      due_date: null,
      schedule_mode: mode,
      sort_order: sort,
    })
  project(AUTO, 'Auto plan', 'auto', 'a0')
  project(MANUAL, 'Manual plan', 'manual', 'a1')
  const task = (n: number, projectId: string, title: string, start: string, due: string) =>
    db.insertRow('tasks', {
      id: T(n),
      project_id: projectId,
      phase_id: null,
      parent_task_id: null,
      title,
      description: null,
      status: 'todo',
      priority: 'none',
      start_date: start,
      due_date: due,
      sort_order: `a${n}`,
    })
  task(1, AUTO, 'Alpha', '2026-11-05', '2026-11-07')
  task(2, AUTO, 'Bravo', '2026-11-08', '2026-11-10')
  task(3, AUTO, 'Charlie', '2026-11-11', '2026-11-12')
  task(4, MANUAL, 'Solo', '2026-11-05', '2026-11-07')
  for (const [n, from, to] of [
    [1, 1, 2],
    [2, 2, 3],
  ] as const) {
    db.insertRow('task_dependencies', {
      id: `00000000-0000-4000-8000-cccccccccc0${n}`,
      project_id: AUTO,
      predecessor_id: T(from),
      successor_id: T(to),
      type: 'FS',
    })
  }
  return db
}

async function signInAndGo(page: Page, path: string) {
  await page.clock.setFixedTime(NOW)
  await page.addInitScript(() =>
    localStorage.setItem(
      'cairn:gantt-scales',
      JSON.stringify({
        '00000000-0000-4000-8000-aaaaaaaaaaa1': 'day',
        '00000000-0000-4000-8000-aaaaaaaaaaa2': 'day',
      }),
    ),
  )
  await page.goto('/login')
  await page.getByLabel('Email').fill('me@example.test')
  await page.getByLabel('Password', { exact: true }).fill('correct-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
  await page.goto(path)
  await expect(page.getByRole('main').locator('[aria-busy="true"]')).toHaveCount(0)
}

const bar = (page: Page, id: string) => page.locator(`[data-task-id="${id}"][data-link-target]`)

async function moveBar(page: Page, id: string, days: number) {
  const box = await bar(page, id).boundingBox()
  const from = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + Math.sign(days) * 4, from.y, { steps: 2 })
  await page.mouse.move(from.x + days * DAY_PX, from.y, { steps: 10 })
  await page.mouse.up()
}

test('create a task and drag a bar: the writes reach Supabase with the right bodies', async ({
  page,
}) => {
  const db = seedDb()
  await simulateSupabase(page, [], db)
  await signInAndGo(page, `/projects/${MANUAL}/list`)
  await page.getByRole('button', { name: 'Add task', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'New task' })
  await input.fill('Delta')
  await input.press('Enter')
  await input.press('Escape')
  await expect.poll(() => db.tables.tasks.some((row) => row.title === 'Delta')).toBe(true)
  const create = db.writes.find((w) => w.method === 'POST' && w.path.endsWith('/tasks'))!
  expect(create.body).toMatchObject({ title: 'Delta', project_id: MANUAL, status: 'todo' })
  await expect(page.getByRole('button', { name: /Couldn't save/ })).toHaveCount(0)

  await page.goto(`/projects/${MANUAL}/gantt`)
  await expect(page.getByRole('region', { name: 'Gantt chart' })).toBeVisible()
  await expect(bar(page, T(4))).toHaveAccessibleName('Solo, Nov 5 – Nov 7, 3 days, To Do')
  await moveBar(page, T(4), 2)
  await expect(bar(page, T(4))).toHaveAccessibleName('Solo, Nov 7 – Nov 9, 3 days, To Do')
  await expect
    .poll(() => db.tables.tasks.find((row) => row.id === T(4))?.start_date)
    .toBe('2026-11-07')
  // A date change always goes through the all-or-nothing schedule RPC, never a bare PATCH.
  const rpc = db.writes.filter((w) => w.path.endsWith('apply_task_schedule'))
  expect(rpc.map((w) => w.body)).toEqual([
    { p_changes: [{ id: T(4), start_date: '2026-11-07', due_date: '2026-11-09' }] },
  ])
  await page.reload()
  await expect(bar(page, T(4))).toHaveAccessibleName('Solo, Nov 7 – Nov 9, 3 days, To Do')
})

test('Auto Apply is one RPC with all the changes; import is one RPC with every table', async ({
  page,
}) => {
  const db = seedDb()
  await simulateSupabase(page, [], db)
  await signInAndGo(page, `/projects/${AUTO}/gantt`)
  await expect(page.getByRole('button', { name: 'Dependencies: Auto' })).toBeVisible()
  await moveBar(page, T(1), 2)
  const dialog = page.getByRole('dialog', { name: 'Move dependent tasks?' })
  await expect(dialog).toBeVisible()
  expect(db.writes.filter((w) => w.path.endsWith('apply_task_schedule'))).toHaveLength(0)
  await dialog.getByRole('button', { name: 'Apply 3 changes' }).click()
  await expect(dialog).toHaveCount(0)
  await expect
    .poll(() => db.writes.filter((w) => w.path.endsWith('apply_task_schedule')).length)
    .toBe(1)
  const rpc = db.writes.find((w) => w.path.endsWith('apply_task_schedule'))!
  expect(rpc.body).toEqual({
    p_changes: [
      { id: T(1), start_date: '2026-11-07', due_date: '2026-11-09' },
      { id: T(2), start_date: '2026-11-10', due_date: '2026-11-12' },
      { id: T(3), start_date: '2026-11-13', due_date: '2026-11-14' },
    ],
  })
  await page.reload()
  await expect(bar(page, T(3))).toHaveAccessibleName('Charlie, Nov 13 – Nov 14, 2 days, To Do')

  await page.goto('/settings/data')
  await expect(page.getByRole('main').locator('[aria-busy="true"]')).toHaveCount(0)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export JSON backup' }).click(),
  ])
  const text = readFileSync(await download.path(), 'utf8')
  await page.getByLabel('Backup file').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  })
  const importDialog = page.getByRole('dialog', { name: 'Import backup' })
  await importDialog.getByRole('button', { name: 'Import as new copies' }).click()
  await expect(importDialog).toBeHidden()
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Backup imported' }),
  ).toContainText('Added 2 projects')
  const imp = db.writes.find((w) => w.path.endsWith('import_workspace'))!
  const payload = (imp.body as { p_data: Record<string, unknown[]> }).p_data
  expect(Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, v.length]))).toEqual({
    projects: 2,
    phases: 0,
    tasks: 4,
    milestones: 0,
    dependencies: 2,
  })
  expect(db.tables.tasks).toHaveLength(8)
})
