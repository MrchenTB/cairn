/// <reference lib="dom" />
/**
 * Shared helpers of the cloud-mode specs (playwright.cloud.config.ts): the real app in Supabase mode
 * against tests/cloud-sim. `sim` talks to the simulator's test-only control API; `rest` talks to its
 * PostgREST with a user's own token, like any HTTP client could.
 */
import { randomUUID } from 'node:crypto'
import { expect, test as base, type Locator, type Page } from '@playwright/test'

export const SIM_URL = 'http://127.0.0.1:54399'
export const API_KEY = 'sb_publishable_cloudsim_test_key'
export const PASSWORD = 'correct horse battery'

async function control<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${SIM_URL}/__sim/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  })
  if (!response.ok) throw new Error(`/__sim/${path} answered ${response.status}`)
  return (await response.json()) as T
}

export interface SimFault {
  method?: string
  path: string
  when: 'before' | 'after'
  action: 'drop' | 'status' | 'delay' | 'replay'
  status?: number
  body?: string
  contentType?: string
  delayMs?: number
  times?: number
}

export interface LoggedRequest {
  method: string
  path: string
  query: string
  status: number | 'dropped'
  role: string | null
}

export const DEFAULT_SIM_CONFIG = {
  autoconfirm: true,
  accessTokenTtlSeconds: 3600,
  clockOffsetSeconds: 0,
  emailIntervalSeconds: 60,
  otpExpirySeconds: 3600,
  refreshReuseSeconds: 10,
}

export const sim = {
  config: (changes: Partial<typeof DEFAULT_SIM_CONFIG>) =>
    control('config', { method: 'POST', body: JSON.stringify(changes) }),
  mail: (to: string) =>
    control<{ type: string; link: string; token: string }[]>(`mail?to=${encodeURIComponent(to)}`),
  revokeSessions: (email: string) =>
    control('revoke-sessions', { method: 'POST', body: JSON.stringify({ email }) }),
  /** Superuser SELECT: what is really stored, bypassing RLS. */
  sql: async <Row = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (
      await control<{ rows: Row[] }>('sql', {
        method: 'POST',
        body: JSON.stringify({ sql, params }),
      })
    ).rows,
  fault: (fault: SimFault) => control('fault', { method: 'POST', body: JSON.stringify(fault) }),
  clearFaults: () => control('faults', { method: 'DELETE' }),
  /** Real-network speed: every API request waits a random minMs..maxMs (0, 0 = off). */
  latency: (minMs: number, maxMs: number) =>
    control('latency', { method: 'POST', body: JSON.stringify({ minMs, maxMs }) }),
  requests: () => control<LoggedRequest[]>('requests'),
  unsupported: () => control<string[]>('unsupported'),
  clearUnsupported: () => control('unsupported', { method: 'DELETE' }),
}

/** The browser's own line for any failed HTTP answer: expected wherever a test provokes one. */
const NETWORK_LOG = /^Failed to load resource/

const errors: string[] = []

/** The console check for a page of its own: a second device or a second tab. */
export function watchConsole(page: Page): void {
  page.on('console', (message) => {
    if (message.type() === 'error' && !NETWORK_LOG.test(message.text())) {
      errors.push(message.text())
    }
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
}

/** Every test fails if a page logs a console error or throws, or the simulator refused a request. */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      errors.length = 0
      watchConsole(page)
      await sim.clearFaults()
      await sim.clearUnsupported()
      await sim.config(DEFAULT_SIM_CONFIG)
      // CAIRN_SIM_LATENCY=200-400 re-runs any cloud spec at real network speed.
      const [low = 0, high = low] = (process.env.CAIRN_SIM_LATENCY ?? '0').split('-').map(Number)
      await sim.latency(low, high)
      await use(errors)
      await sim.latency(0, 0)
      await sim.clearFaults()
      await sim.config(DEFAULT_SIM_CONFIG)
      expect(errors, 'console errors / uncaught exceptions').toEqual([])
      expect(await sim.unsupported(), 'requests the simulator does not implement').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`
}

export function sidebar(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Sidebar' })
}

/** The app shell is up and the workspace finished loading. */
export async function expectShell(page: Page): Promise<void> {
  await expect(sidebar(page)).toBeVisible()
  await expect(page.getByRole('main').locator('[aria-busy="true"]')).toHaveCount(0)
}

export function syncIndicator(page: Page, label: string | RegExp): Locator {
  return sidebar(page).getByRole('button', {
    name: typeof label === 'string' ? `Sync status: ${label}` : label,
  })
}

/** Fills the /login form as sign-up (it must be showing) and submits. */
export async function submitSignUp(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
}

export async function submitSignIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

/** A new account through the real form, ending on the app's first page. */
export async function signUpNew(page: Page, email = uniqueEmail()): Promise<string> {
  await page.goto('/login')
  await submitSignUp(page, email)
  await expect(page).toHaveURL(/\/overview$/)
  await expectShell(page)
  return email
}

/** Signs in through the form; the app returns to the page it remembered (or the first page). */
export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login')
  await submitSignIn(page, email, password)
  await expect(page).not.toHaveURL(/\/login/)
  await expectShell(page)
}

/** Settings → Account → Sign out, confirmed. */
export async function signOut(page: Page): Promise<void> {
  await page.goto('/settings/account')
  await expectShell(page)
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page).toHaveURL(/\/login/)
}

/** The Supabase session this browser stores (`sb-…-auth-token`). */
export async function storedSession(
  page: Page,
): Promise<{ access_token: string; refresh_token: string; expires_at: number } | null> {
  return page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index) ?? ''
      if (key.startsWith('sb-') && key.endsWith('-auth-token')) {
        return JSON.parse(localStorage.getItem(key) ?? 'null')
      }
    }
    return null
  })
}

export async function accessToken(page: Page): Promise<string> {
  const session = await storedSession(page)
  if (!session) throw new Error('no stored session')
  return session.access_token
}

/** A direct call to the simulated PostgREST with this token (null = no Authorization header). */
export async function rest(
  token: string | null,
  path: string,
  init: { method?: string; body?: unknown; prefer?: string; apikey?: string | null } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (init.apikey !== null) headers.apikey = init.apikey ?? API_KEY
  if (token) headers.Authorization = `Bearer ${token}`
  if (init.prefer) headers.Prefer = init.prefer
  const response = await fetch(`${SIM_URL}/rest/v1/${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : JSON.parse(text) }
}

/** The user id of an email, as stored. */
export async function userId(email: string): Promise<string> {
  const [row] = await sim.sql<{ id: string }>('select id from auth.users where email = $1', [email])
  if (!row) throw new Error(`no user ${email}`)
  return row.id
}

// ---------------------------------------------------------------------------
// Seeding: the import RPC with the user's own token (set-up only, never to fake a result)
// ---------------------------------------------------------------------------

export interface TaskSpec {
  key: string
  title: string
  start?: string
  due?: string
  status?: 'todo' | 'in_progress' | 'done'
  phase?: string
  parent?: string
}

export interface SeedSpec {
  name?: string
  mode?: 'manual' | 'auto'
  phases?: string[]
  tasks?: TaskSpec[]
  milestones?: { key: string; name: string; date: string; phase?: string }[]
  deps?: [string, string][]
}

export interface Seeded {
  projectId: string
  /** Task and milestone ids by key, phase ids by name. */
  ids: Record<string, string>
}

export function buildImport(spec: SeedSpec): Seeded & { data: unknown } {
  const projectId = randomUUID()
  const ids: Record<string, string> = {}
  for (const name of spec.phases ?? []) ids[name] = randomUUID()
  for (const task of spec.tasks ?? []) ids[task.key] = randomUUID()
  for (const milestone of spec.milestones ?? []) ids[milestone.key] = randomUUID()
  return {
    projectId,
    ids,
    data: {
      projects: [
        {
          id: projectId,
          name: spec.name ?? 'Seeded project',
          description: null,
          status: 'active',
          color: 'violet',
          start_date: null,
          due_date: null,
          schedule_mode: spec.mode ?? 'manual',
          sort_order: 'a0',
        },
      ],
      phases: (spec.phases ?? []).map((name, index) => ({
        id: ids[name],
        project_id: projectId,
        name,
        sort_order: `a${index}`,
      })),
      tasks: (spec.tasks ?? []).map((task, index) => ({
        id: ids[task.key],
        project_id: projectId,
        phase_id: task.phase ? ids[task.phase] : null,
        parent_task_id: task.parent ? ids[task.parent] : null,
        title: task.title,
        description: null,
        status: task.status ?? 'todo',
        priority: 'none',
        start_date: task.start ?? null,
        due_date: task.due ?? null,
        sort_order: `a${index}`,
        completed_at: null,
      })),
      milestones: (spec.milestones ?? []).map((milestone) => ({
        id: ids[milestone.key],
        project_id: projectId,
        phase_id: milestone.phase ? ids[milestone.phase] : null,
        name: milestone.name,
        date: milestone.date,
      })),
      dependencies: (spec.deps ?? []).map(([from, to]) => ({
        id: randomUUID(),
        project_id: projectId,
        predecessor_id: ids[from],
        successor_id: ids[to],
        type: 'FS',
      })),
    },
  }
}

/** Seeds a project into the signed-in account and reloads, so the app reads it from the server. */
export async function seedProject(page: Page, spec: SeedSpec, path?: string): Promise<Seeded> {
  const { data, projectId, ids } = buildImport(spec)
  const answer = await rest(await accessToken(page), 'rpc/import_workspace', {
    method: 'POST',
    body: { p_data: data },
  })
  if (answer.status !== 200) throw new Error(`seed failed: ${JSON.stringify(answer.body)}`)
  await page.goto(path ?? `/projects/${projectId}/list`)
  await expect(page.getByRole('main').locator('[aria-busy="true"]')).toHaveCount(0)
  return { projectId, ids }
}

// ---------------------------------------------------------------------------
// Locators shared with the local-mode specs
// ---------------------------------------------------------------------------

export const taskRow = (page: Page, title: string) =>
  page
    .locator('[data-task-row]')
    .filter({ has: page.getByRole('button', { name: `Move ${title}`, exact: true }) })

/** Titles of the task rows in order; subtasks are marked with "↳ ". */
export function rowTitles(scope: Locator): Promise<string[]> {
  return scope.locator('[data-task-row]').evaluateAll((rows) =>
    rows.map((row) => {
      const handle = row.querySelector('button[aria-label^="Move "]')
      const title = handle?.getAttribute('aria-label')?.slice('Move '.length) ?? '?'
      return row.getAttribute('data-depth') === '1' ? `↳ ${title}` : title
    }),
  )
}

export const listScroll = (page: Page) => page.locator('[data-list-scroll]')

export const phaseGroup = (page: Page, name: string) =>
  page.getByRole('region', { name: new RegExp(`^${name}, \\d+ tasks?$`) })

/** A toast on its way in or showing (one being dismissed stays in the DOM for its exit animation). */
export const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]:not([data-removed="true"])').filter({ hasText: text })

export const toastButton = (page: Page, text: string | RegExp, button: string) =>
  toast(page, text).getByRole('button', { name: button })

/** Makes this tab act on window focus at once (the store throttles focus refreshes to one per 30 s). */
export async function focusAfterThrottle(page: Page): Promise<void> {
  await page.clock.fastForward('00:31')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}
