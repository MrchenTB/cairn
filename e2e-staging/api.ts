/**
 * Everything the staging suite does without a browser: its settings, the REST and Auth calls, the
 * sessions of the two test accounts, the test projects it creates and removes, and its metrics.
 *
 * Only public interfaces are used (`/rest/v1`, `/auth/v1`), always as an ordinary signed-in user
 * (or with no user at all), so the same code runs against the local simulator and a real Supabase
 * project. There is no SQL, no service role and no simulator control API in this suite.
 *
 * Tokens and passwords are never printed. Sessions are written only to `test-results/staging/`
 * (ignored by Git) and removed again by `forgetSessions` when the run ends.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateNKeysBetween } from 'fractional-indexing'
import {
  checkStagingEnv,
  findForeignProjects,
  isTestProjectName,
  TEST_PROJECT_PREFIX,
  type StagingAccount,
  type StagingSettings,
} from '../tests/staging/guard.ts'

export type UserKey = 'A' | 'B'

export const STATE_DIR = resolve('test-results/staging')
const SESSIONS_FILE = resolve(STATE_DIR, 'sessions.json')
const METRICS_FILE = resolve(STATE_DIR, 'metrics.json')

/** Playwright storageState of each account (a browser session signed in through the form). */
export const STORAGE_STATE: Record<UserKey, string> = {
  A: resolve(STATE_DIR, 'state-a.json'),
  B: resolve(STATE_DIR, 'state-b.json'),
}

export const isDryRun = () => process.env.CAIRN_STAGING_DRY_RUN === '1'

let cached: StagingSettings | undefined

/** The checked settings. Throws (before any request) when a safety rule is not met. */
export function settings(): StagingSettings {
  cached ??= checkStagingEnv(process.env, { dryRun: isDryRun() })
  return cached
}

export function account(user: UserKey): StagingAccount {
  return user === 'A' ? settings().userA : settings().userB
}

/** Unique per worker process; every project the suite creates carries it in its name. */
export const RUN_ID = randomUUID().slice(0, 8)

export const testProjectName = (label: string) => `${TEST_PROJECT_PREFIX}${RUN_ID} ${label}`

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface HttpResult {
  status: number
  body: unknown
  headers: Headers
}

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function send(url: string, init: RequestInit & { timeoutMs?: number }): Promise<HttpResult> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
    })
    // A hosted project rate-limits Auth and sometimes the API: wait and ask again, a few times.
    if (response.status === 429 && attempt < 3) {
      await sleep(5_000 * (attempt + 1))
      continue
    }
    const text = await response.text()
    let body: unknown = text === '' ? null : text
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      // Not JSON (a gateway page): keep the text.
    }
    return { status: response.status, body, headers: response.headers }
  }
}

export interface RestInit {
  method?: string
  body?: unknown
  prefer?: string
  /** `null` sends no apikey header at all. */
  apikey?: string | null
  headers?: Record<string, string>
  timeoutMs?: number
}

/** A call to `/rest/v1/<path>` with this user's access token (`null` = no Authorization header). */
export function rest(token: string | null, path: string, init: RestInit = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...init.headers }
  if (init.apikey !== null) headers.apikey = init.apikey ?? settings().publishableKey
  if (token) headers.Authorization = `Bearer ${token}`
  if (init.prefer) headers.Prefer = init.prefer
  return send(`${settings().url}/rest/v1/${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    timeoutMs: init.timeoutMs,
  })
}

function auth(path: string, body: unknown): Promise<HttpResult> {
  return send(`${settings().url}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: settings().publishableKey },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface Session {
  access_token: string
  refresh_token: string
  /** Seconds since the epoch. */
  expires_at: number
}

function toSession(answer: HttpResult, what: string): Session {
  const body = answer.body as Partial<Session> & { expires_in?: number }
  if (answer.status !== 200 || !body?.access_token || !body.refresh_token) {
    throw new Error(`${what} failed (HTTP ${answer.status}).`)
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: body.expires_at ?? Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600),
  }
}

export async function signInWithPassword(user: UserKey): Promise<Session> {
  const { email, password } = account(user)
  const answer = await auth('token?grant_type=password', { email, password })
  return toSession(answer, `Signing in account ${user} through the Auth API`)
}

/** Dry run only: creates both test accounts on the local simulator through the public sign-up. */
export async function signUpDryRunAccounts(): Promise<void> {
  if (!isDryRun()) throw new Error('Creating accounts is only allowed in a dry run.')
  for (const user of ['A', 'B'] as const) {
    const { email, password } = account(user)
    const answer = await auth('signup', { email, password })
    if (answer.status !== 200) {
      throw new Error(`Creating dry-run account ${user} failed (HTTP ${answer.status}).`)
    }
  }
}

type SessionFile = Partial<Record<UserKey, Session>>

function readSessions(): SessionFile {
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as SessionFile
  } catch {
    return {}
  }
}

function writeSession(user: UserKey, session: Session): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(SESSIONS_FILE, JSON.stringify({ ...readSessions(), [user]: session }), {
    mode: 0o600,
  })
}

/**
 * The REST session of an account: its own sign-in, separate from the browser's, so refreshing
 * one never invalidates the other. Renewed shortly before it expires.
 */
export async function tokenFor(user: UserKey): Promise<string> {
  let session = readSessions()[user]
  const now = Math.floor(Date.now() / 1000)
  if (!session) {
    session = await signInWithPassword(user)
    writeSession(user, session)
  } else if (session.expires_at - now < 600) {
    try {
      session = toSession(
        await auth('token?grant_type=refresh_token', { refresh_token: session.refresh_token }),
        `Refreshing the session of account ${user}`,
      )
    } catch {
      session = await signInWithPassword(user)
    }
    writeSession(user, session)
  }
  return session.access_token
}

/** Removes every stored session of this run; the measurements stay. */
export function forgetSessions(): void {
  rmSync(SESSIONS_FILE, { force: true })
  rmSync(STORAGE_STATE.A, { force: true })
  rmSync(STORAGE_STATE.B, { force: true })
}

/** Seeds the REST session file (global setup already signed in once to check the account). */
export function rememberSession(user: UserKey, session: Session): void {
  writeSession(user, session)
}

/** The user id (`sub`) inside an access token. */
export function userIdOf(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as {
    sub?: string
  }
  if (!payload.sub) throw new Error('Access token has no sub claim.')
  return payload.sub
}

// ---------------------------------------------------------------------------
// Test projects
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: string
  name: string
}

const PROJECT_LIMIT = 1000

/** The account's projects. Stops when there are more than one request can show. */
export async function listProjects(token: string): Promise<ProjectRow[]> {
  const answer = await rest(token, `projects?select=id,name&order=id.asc&limit=${PROJECT_LIMIT}`)
  if (answer.status !== 200 || !Array.isArray(answer.body)) {
    throw new Error(`Reading the projects of an account failed (HTTP ${answer.status}).`)
  }
  if (answer.body.length >= PROJECT_LIMIT) {
    throw new Error('A test account has 1,000 or more projects: it must hold only test data.')
  }
  return answer.body as ProjectRow[]
}

export function assertOnlyTestData(user: UserKey, projects: readonly ProjectRow[]): void {
  const foreign = findForeignProjects(projects)
  if (foreign.length > 0) {
    // Counts only: the names of someone's real projects are not printed.
    throw new Error(
      `Test account ${user} contains ${foreign.length} project${foreign.length === 1 ? '' : 's'} ` +
        `that ${foreign.length === 1 ? 'was' : 'were'} not created by these tests (names not ` +
        `starting with "${TEST_PROJECT_PREFIX}"). This account must contain only test data. ` +
        'Stopping without touching anything.',
    )
  }
}

/**
 * Deletes every test project of the account (and with it its tasks, by cascade). Refuses, before
 * deleting anything, if the account holds anything else. Each delete also carries the exact name it
 * just read, so the server removes nothing if the project was renamed in between.
 */
export async function deleteTestProjects(user: UserKey, only?: readonly string[]): Promise<number> {
  const token = await tokenFor(user)
  const projects = await listProjects(token)
  assertOnlyTestData(user, projects)
  let removed = 0
  for (const project of projects) {
    if (only && !only.includes(project.id)) continue
    if (!isTestProjectName(project.name)) continue
    const answer = await rest(
      token,
      `projects?id=eq.${project.id}&name=eq.${encodeURIComponent(project.name)}`,
      { method: 'DELETE', prefer: 'return=minimal', timeoutMs: 120_000 },
    )
    if (answer.status >= 300) {
      throw new Error(`Deleting a test project failed (HTTP ${answer.status}).`)
    }
    removed += 1
  }
  return removed
}

export interface TaskSpec {
  key: string
  title: string
  description?: string
  start?: string
  due?: string
  status?: 'todo' | 'in_progress' | 'done'
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent'
  completedAt?: string
  phase?: string
  parent?: string
}

export interface SeedSpec {
  /** Appended to the `[e2e] <run id> ` prefix. */
  label: string
  phases?: { name: string; color?: string }[]
  tasks?: TaskSpec[]
  milestones?: { key: string; name: string; date: string; phase?: string }[]
  deps?: [string, string][]
}

export interface Seeded {
  projectId: string
  name: string
  /** Task and milestone ids by key, phase ids by name. */
  ids: Record<string, string>
}

/** The payload of `rpc/import_workspace` for one project (ids are fresh). */
export function buildImport(spec: SeedSpec): Seeded & { data: Record<string, unknown[]> } {
  const projectId = randomUUID()
  const name = testProjectName(spec.label)
  const ids: Record<string, string> = {}
  const phases = spec.phases ?? []
  const tasks = spec.tasks ?? []
  for (const phase of phases) ids[phase.name] = randomUUID()
  for (const task of tasks) ids[task.key] = randomUUID()
  for (const milestone of spec.milestones ?? []) ids[milestone.key] = randomUUID()
  const taskKeys = generateNKeysBetween(null, null, Math.max(tasks.length, 1))
  return {
    projectId,
    name,
    ids,
    data: {
      projects: [
        {
          id: projectId,
          name,
          description: null,
          status: 'active',
          color: 'violet',
          start_date: null,
          due_date: null,
          schedule_mode: 'manual',
          sort_order: 'a0',
        },
      ],
      phases: phases.map((phase, index) => ({
        id: ids[phase.name],
        project_id: projectId,
        name: phase.name,
        color: phase.color ?? null,
        sort_order: `a${index}`,
      })),
      tasks: tasks.map((task, index) => ({
        id: ids[task.key],
        project_id: projectId,
        phase_id: task.phase ? ids[task.phase] : null,
        parent_task_id: task.parent ? ids[task.parent] : null,
        title: task.title,
        description: task.description ?? null,
        status: task.status ?? 'todo',
        priority: task.priority ?? 'none',
        start_date: task.start ?? null,
        due_date: task.due ?? null,
        sort_order: taskKeys[index],
        completed_at: task.completedAt ?? null,
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

/** A project of `count` plain tasks, for the scale tests (one import, so one request). */
export function bulkSpec(label: string, count: number): SeedSpec {
  return {
    label,
    tasks: Array.from({ length: count }, (_, index) => ({
      key: `t${index}`,
      title: `Bulk task ${String(index + 1).padStart(5, '0')}`,
      status: index % 3 === 0 ? 'done' : index % 3 === 1 ? 'in_progress' : 'todo',
      start: index % 2 === 0 ? '2026-11-02' : undefined,
      due: index % 2 === 0 ? '2026-11-20' : undefined,
    })),
  }
}

/** Creates a test project (set-up only, through the import RPC with the user's own token). */
export async function createTestProject(user: UserKey, spec: SeedSpec): Promise<Seeded> {
  const { data, ...seeded } = buildImport(spec)
  const answer = await rest(await tokenFor(user), 'rpc/import_workspace', {
    method: 'POST',
    body: { p_data: data },
    timeoutMs: 180_000,
  })
  if (answer.status !== 200) {
    throw new Error(
      `Creating a test project failed (HTTP ${answer.status}): ${errorText(answer.body)}`,
    )
  }
  return seeded
}

/**
 * A project with `count` tasks made in batches: one small import for the project, then plain
 * inserts of 400 tasks each. Used where the number of tasks is only the set-up, so that a limit
 * on one big request cannot stop a test that is about something else.
 */
export async function createBulkProject(
  user: UserKey,
  label: string,
  count: number,
): Promise<Seeded> {
  const seeded = await createTestProject(user, { label })
  const token = await tokenFor(user)
  const keys = generateNKeysBetween(null, null, count)
  for (let from = 0; from < count; from += 400) {
    const rows = Array.from({ length: Math.min(400, count - from) }, (_, offset) => {
      const index = from + offset
      return {
        id: randomUUID(),
        project_id: seeded.projectId,
        title: `Bulk task ${String(index + 1).padStart(5, '0')}`,
        status: index % 3 === 0 ? 'done' : index % 3 === 1 ? 'in_progress' : 'todo',
        start_date: index % 2 === 0 ? '2026-11-02' : null,
        due_date: index % 2 === 0 ? '2026-11-20' : null,
        sort_order: keys[index],
      }
    })
    const answer = await rest(token, 'tasks', {
      method: 'POST',
      body: rows,
      prefer: 'return=minimal',
      timeoutMs: 120_000,
    })
    if (answer.status >= 300) {
      throw new Error(`Adding bulk tasks failed (HTTP ${answer.status}): ${errorText(answer.body)}`)
    }
  }
  return seeded
}

/** A short, safe description of an error body (codes and messages only, never row data). */
export function errorText(body: unknown): string {
  if (typeof body !== 'object' || body === null) return String(body).slice(0, 200)
  const { code, message } = body as { code?: unknown; message?: unknown }
  return `${String(code ?? '')} ${String(message ?? '')}`.trim().slice(0, 300)
}

/** One entry of a table by id, through REST with the user's token. */
export async function getRow<Row = Record<string, unknown>>(
  token: string,
  table: string,
  id: string,
  columns = '*',
): Promise<Row | undefined> {
  const answer = await rest(token, `${table}?id=eq.${id}&select=${columns}`)
  if (answer.status !== 200 || !Array.isArray(answer.body)) {
    throw new Error(`Reading ${table} failed (HTTP ${answer.status}).`)
  }
  return (answer.body as Row[])[0]
}

/** The number of rows a query matches, counted by the server (not limited by max_rows). */
export async function countRows(token: string, table: string, filter = ''): Promise<number> {
  const answer = await rest(token, `${table}?select=id&limit=1${filter ? `&${filter}` : ''}`, {
    prefer: 'count=exact',
  })
  const total = /\/(\d+)$/.exec(answer.headers.get('content-range') ?? '')?.[1]
  if (!total) throw new Error(`Counting ${table} failed (HTTP ${answer.status}).`)
  return Number(total)
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface Metric {
  id: string
  name: string
  value: number
  unit: string
  note?: string
}

export function readMetrics(): Metric[] {
  try {
    return JSON.parse(readFileSync(METRICS_FILE, 'utf8')) as Metric[]
  } catch {
    return []
  }
}

export function resetMetrics(): void {
  rmSync(METRICS_FILE, { force: true })
}

/** Appends a measurement to `test-results/staging/metrics.json` (one worker, so no locking). */
export function recordMetric(metric: Metric): void {
  mkdirSync(STATE_DIR, { recursive: true })
  const others = readMetrics().filter((m) => !(m.id === metric.id && m.name === metric.name))
  writeFileSync(METRICS_FILE, JSON.stringify([...others, metric], null, 2))
}
