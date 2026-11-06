/**
 * SupabaseRepository through the real @supabase/supabase-js client and the cloud simulator's
 * PostgREST/GoTrue translation layer (tests/cloud-sim) over the real migration on PGlite, with no
 * sockets and no browser. It checks what a hand-written fake cannot: every Repository method's
 * column names, RPC parameters, response shapes and error mapping against the real schema, RLS and
 * GRANTs. Whatever the simulator does not implement fails the test (`sim.unsupported`).
 */
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { RepositoryError } from '../../src/data/errors.ts'
import { MISSING_SCHEMA_MESSAGE, SupabaseRepository } from '../../src/data/supabaseRepository.ts'
import {
  makeDependency,
  makeMilestone,
  makePhase,
  makeProject,
  makeTask,
} from '../../src/domain/testFactories.ts'
import {
  BACKUP_FORMAT_VERSION,
  type AppErrorKind,
  type Preferences,
  type Project,
  type Task,
} from '../../src/domain/types.ts'
import { parseBackupFile } from '../../src/domain/validation.ts'
import { signJwt } from '../cloud-sim/gotrue.ts'
import { createCloudSim, simFetch, SIM_PUBLISHABLE_KEY, type CloudSim } from '../cloud-sim/sim.ts'

let sim: CloudSim

beforeAll(async () => {
  sim = await createCloudSim()
})
afterAll(async () => {
  await sim.close()
})
afterEach(() => {
  sim.faults.length = 0
  expect(sim.unsupported).toEqual([])
})

function newClient(): SupabaseClient {
  return createClient(sim.url, SIM_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: simFetch(sim) },
  })
}

interface Account {
  client: SupabaseClient
  repository: SupabaseRepository
  userId: string
  email: string
}

async function newAccount(): Promise<Account> {
  const client = newClient()
  const email = `${randomUUID()}@example.test`
  const { data, error } = await client.auth.signUp({ email, password: 'correct horse' })
  expect(error).toBeNull()
  expect(data.session).not.toBeNull()
  return { client, repository: new SupabaseRepository(client), userId: data.user!.id, email }
}

const uuid = () => randomUUID()
const project = (overrides: Partial<Project> = {}) => makeProject({ id: uuid(), ...overrides })
const task = (projectId: string, overrides: Partial<Task> = {}) =>
  makeTask({ id: uuid(), projectId, title: 'A task', ...overrides })

/** What is really stored, read as the superuser (bypasses RLS). */
async function stored<Row>(sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await sim.db.admin.query<Row>(sql, params)).rows
}

async function expectRejection(
  promise: Promise<unknown>,
  kind: AppErrorKind,
  message?: RegExp | string,
): Promise<RepositoryError> {
  const error = await promise.then(
    () => {
      throw new Error('expected the call to reject')
    },
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(RepositoryError)
  const repositoryError = error as RepositoryError
  expect(repositoryError.kind).toBe(kind)
  if (message !== undefined) expect(repositoryError.message).toMatch(message)
  return repositoryError
}

describe('SupabaseRepository through the simulated Supabase API', () => {
  it('insert → update → load → delete a project (every column round-trips)', async () => {
    const { repository, userId } = await newAccount()
    const input = project({
      name: 'Launch 規劃',
      description: 'With "quotes", \\ and emoji 🚀',
      status: 'active',
      color: 'violet',
      startDate: '2026-11-01',
      dueDate: '2026-12-24',
      scheduleMode: 'auto',
      sortOrder: 'a0',
    })
    const created = await repository.insertProject(input)
    expect(created).toMatchObject({
      id: input.id,
      name: input.name,
      description: input.description,
      color: 'violet',
      startDate: '2026-11-01',
      dueDate: '2026-12-24',
      scheduleMode: 'auto',
      sortOrder: 'a0',
    })
    // Server-owned columns: user_id from auth.uid(), server timestamps (not the client's).
    const [row] = await stored<{ user_id: string }>(
      'select user_id from public.projects where id = $1',
      [input.id],
    )
    expect(row.user_id).toBe(userId)
    expect(created.createdAt).not.toBe(input.createdAt)
    expect(new Date(created.createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000)

    const updated = await repository.updateProject(input.id, {
      name: 'Renamed',
      description: null,
      status: 'completed',
      color: 'teal',
      startDate: null,
      dueDate: null,
      scheduleMode: 'manual',
      sortOrder: 'a5',
    })
    expect(updated).toMatchObject({
      name: 'Renamed',
      description: null,
      status: 'completed',
      color: 'teal',
      startDate: null,
      dueDate: null,
      scheduleMode: 'manual',
      sortOrder: 'a5',
    })
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(created.updatedAt).getTime(),
    )
    // An empty patch reads the row instead of writing.
    expect(await repository.updateProject(input.id, {})).toEqual(updated)

    const snapshot = await repository.loadWorkspace()
    expect(snapshot.projects).toEqual([updated])

    await repository.deleteProject(input.id)
    expect((await repository.loadWorkspace()).projects).toEqual([])
    await expectRejection(repository.deleteProject(input.id), 'not_found', /no longer exists/)
    await expectRejection(
      repository.updateProject(input.id, { name: 'Gone' }),
      'not_found',
      /no longer exists/,
    )
  })

  it('phases: insert, rename, reorder, delete ungroups tasks and milestones', async () => {
    const { repository } = await newAccount()
    const p = await repository.insertProject(project())
    const phase = await repository.insertPhase(
      makePhase({ id: uuid(), projectId: p.id, name: 'Build', sortOrder: 'a0' }),
    )
    expect(phase).toMatchObject({ projectId: p.id, name: 'Build', sortOrder: 'a0' })
    expect(await repository.updatePhase(phase.id, { name: 'Ship', sortOrder: 'a1' })).toMatchObject(
      {
        name: 'Ship',
        sortOrder: 'a1',
      },
    )
    const t = await repository.insertTask(task(p.id, { phaseId: phase.id }))
    const m = await repository.insertMilestone(
      makeMilestone({ id: uuid(), projectId: p.id, phaseId: phase.id, date: '2026-12-01' }),
    )
    await repository.deletePhase(phase.id)
    const snapshot = await repository.loadWorkspace()
    expect(snapshot.phases).toEqual([])
    expect(snapshot.tasks.find((row) => row.id === t.id)?.phaseId).toBeNull()
    expect(snapshot.milestones.find((row) => row.id === m.id)?.phaseId).toBeNull()
    await expectRejection(repository.deletePhase(phase.id), 'not_found')
    await expectRejection(repository.updatePhase(phase.id, { name: 'x' }), 'not_found')
  })

  it('tasks: every field, completed_at by trigger, a parent phase change reaches subtasks', async () => {
    const { repository } = await newAccount()
    const p = await repository.insertProject(project())
    const phaseA = await repository.insertPhase(makePhase({ id: uuid(), projectId: p.id }))
    const phaseB = await repository.insertPhase(makePhase({ id: uuid(), projectId: p.id }))
    const parent = await repository.insertTask(
      task(p.id, {
        title: 'Parent',
        description: 'Details',
        priority: 'high',
        status: 'in_progress',
        startDate: '2026-11-02',
        dueDate: '2026-11-03',
        phaseId: phaseA.id,
        sortOrder: 'a1',
      }),
    )
    expect(parent).toMatchObject({
      title: 'Parent',
      description: 'Details',
      priority: 'high',
      status: 'in_progress',
      startDate: '2026-11-02',
      dueDate: '2026-11-03',
      phaseId: phaseA.id,
      sortOrder: 'a1',
      completedAt: null,
    })
    const subtask = await repository.insertTask(task(p.id, { parentTaskId: parent.id }))
    expect(subtask).toMatchObject({ parentTaskId: parent.id, phaseId: phaseA.id })

    const done = await repository.updateTask(parent.id, { status: 'done' })
    expect(done.completedAt).not.toBeNull()
    const reopened = await repository.updateTask(parent.id, { status: 'todo' })
    expect(reopened.completedAt).toBeNull()

    await repository.updateTask(parent.id, { phaseId: phaseB.id })
    const snapshot = await repository.loadWorkspace()
    expect(snapshot.tasks.find((row) => row.id === subtask.id)?.phaseId).toBe(phaseB.id)

    const cleared = await repository.updateTask(parent.id, {
      title: 'Renamed',
      description: null,
      priority: 'none',
      startDate: null,
      dueDate: null,
      phaseId: null,
      sortOrder: 'a2',
    })
    expect(cleared).toMatchObject({
      title: 'Renamed',
      description: null,
      priority: 'none',
      startDate: null,
      dueDate: null,
      phaseId: null,
      sortOrder: 'a2',
    })
    const promoted = await repository.updateTask(subtask.id, { parentTaskId: null })
    expect(promoted.parentTaskId).toBeNull()
  })

  it('deleteTask RPC: without keepSubtasks removes them, with it promotes them in one step', async () => {
    const { repository } = await newAccount()
    const p = await repository.insertProject(project())
    const first = await repository.insertTask(task(p.id))
    const firstSub = await repository.insertTask(task(p.id, { parentTaskId: first.id }))
    await repository.deleteTask(first.id, { keepSubtasks: false })
    let snapshot = await repository.loadWorkspace()
    expect(snapshot.tasks.map((row) => row.id)).not.toContain(firstSub.id)

    const second = await repository.insertTask(task(p.id, { sortOrder: 'a1' }))
    const keepA = await repository.insertTask(
      task(p.id, { parentTaskId: second.id, sortOrder: 'a0' }),
    )
    const keepB = await repository.insertTask(
      task(p.id, { parentTaskId: second.id, sortOrder: 'a1' }),
    )
    await repository.deleteTask(second.id, {
      keepSubtasks: true,
      promotedSortOrders: { [keepA.id]: 'a10', [keepB.id]: 'a11' },
    })
    snapshot = await repository.loadWorkspace()
    expect(snapshot.tasks.map((row) => row.id).sort()).toEqual([keepA.id, keepB.id].sort())
    expect(snapshot.tasks.find((row) => row.id === keepA.id)).toMatchObject({
      parentTaskId: null,
      sortOrder: 'a10',
    })

    // The list of subtasks to keep must match the server's: nothing changes otherwise.
    const third = await repository.insertTask(task(p.id))
    const thirdSub = await repository.insertTask(task(p.id, { parentTaskId: third.id }))
    await expectRejection(
      repository.deleteTask(third.id, { keepSubtasks: true, promotedSortOrders: {} }),
      'validation',
      /do not match/,
    )
    expect((await repository.loadWorkspace()).tasks.map((row) => row.id)).toContain(thirdSub.id)

    await expectRejection(
      repository.deleteTask(uuid(), { keepSubtasks: false }),
      'not_found',
      /Task not found/,
    )
  })

  it('milestones: insert, update, delete', async () => {
    const { repository } = await newAccount()
    const p = await repository.insertProject(project())
    const phase = await repository.insertPhase(makePhase({ id: uuid(), projectId: p.id }))
    const m = await repository.insertMilestone(
      makeMilestone({ id: uuid(), projectId: p.id, name: 'Beta', date: '2026-12-01' }),
    )
    expect(m).toMatchObject({ projectId: p.id, name: 'Beta', date: '2026-12-01', phaseId: null })
    expect(
      await repository.updateMilestone(m.id, { name: 'GA', date: '2026-12-31', phaseId: phase.id }),
    ).toMatchObject({ name: 'GA', date: '2026-12-31', phaseId: phase.id })
    await repository.deleteMilestone(m.id)
    expect((await repository.loadWorkspace()).milestones).toEqual([])
    await expectRejection(repository.deleteMilestone(m.id), 'not_found')
    await expectRejection(repository.updateMilestone(m.id, { name: 'x' }), 'not_found')
  })

  it('dependencies: insert, the server refuses duplicates and cycles, delete', async () => {
    const { repository } = await newAccount()
    const p = await repository.insertProject(project())
    const a = await repository.insertTask(task(p.id))
    const b = await repository.insertTask(task(p.id))
    const dependency = await repository.insertDependency(
      makeDependency({ id: uuid(), projectId: p.id, predecessorId: a.id, successorId: b.id }),
    )
    expect(dependency).toMatchObject({
      projectId: p.id,
      predecessorId: a.id,
      successorId: b.id,
      type: 'FS',
    })
    await expectRejection(
      repository.insertDependency(
        makeDependency({ id: uuid(), projectId: p.id, predecessorId: a.id, successorId: b.id }),
      ),
      'conflict',
      /already exists/,
    )
    await expectRejection(
      repository.insertDependency(
        makeDependency({ id: uuid(), projectId: p.id, predecessorId: b.id, successorId: a.id }),
      ),
      'validation',
      /cycle/,
    )
    expect((await repository.loadWorkspace()).dependencies).toHaveLength(1)
    await repository.deleteDependency(dependency.id)
    expect((await repository.loadWorkspace()).dependencies).toEqual([])
    await expectRejection(repository.deleteDependency(dependency.id), 'not_found')
  })

  it('applySchedule RPC: all or nothing, returns the updated tasks', async () => {
    const { repository } = await newAccount()
    const p = await repository.insertProject(project())
    const a = await repository.insertTask(task(p.id))
    const b = await repository.insertTask(
      task(p.id, { startDate: '2026-11-01', dueDate: '2026-11-02' }),
    )

    expect(await repository.applySchedule([])).toEqual([])
    const updated = await repository.applySchedule([
      { taskId: a.id, startDate: '2026-11-10', dueDate: '2026-11-12' },
      { taskId: b.id, startDate: null, dueDate: null },
    ])
    expect(updated.find((row) => row.id === a.id)).toMatchObject({
      startDate: '2026-11-10',
      dueDate: '2026-11-12',
    })
    expect(updated.find((row) => row.id === b.id)).toMatchObject({ startDate: null, dueDate: null })

    // One unknown task: nothing is applied.
    await expectRejection(
      repository.applySchedule([
        { taskId: a.id, startDate: '2026-12-01', dueDate: '2026-12-02' },
        { taskId: uuid(), startDate: '2026-12-01', dueDate: '2026-12-02' },
      ]),
      'not_found',
      /could not be found/,
    )
    // Due before start: nothing is applied.
    await expectRejection(
      repository.applySchedule([{ taskId: a.id, startDate: '2026-12-02', dueDate: '2026-12-01' }]),
      'validation',
      /before start/,
    )
    const [row] = (await repository.loadWorkspace()).tasks.filter((item) => item.id === a.id)
    expect(row).toMatchObject({ startDate: '2026-11-10', dueDate: '2026-11-12' })
  })

  it('preferences: upsert, partial update, onlyIfMissing, and a partial save with no row yet', async () => {
    const value: Preferences = {
      theme: 'dark',
      sidebarCollapsed: true,
      timezone: 'Asia/Taipei',
      weekStartsOn: 0,
    }
    const first = await newAccount()
    expect((await first.repository.loadWorkspace()).preferences).toBeNull()
    expect(await first.repository.upsertPreferences(value)).toEqual(value)
    expect((await first.repository.loadWorkspace()).preferences).toEqual(value)
    expect(
      await first.repository.upsertPreferences({ ...value, theme: 'light' }, { fields: ['theme'] }),
    ).toEqual({ ...value, theme: 'light' })
    // onlyIfMissing leaves the stored row alone and returns it.
    expect(
      await first.repository.upsertPreferences(
        { ...value, timezone: 'UTC', weekStartsOn: 1 },
        { onlyIfMissing: true },
      ),
    ).toEqual({ ...value, theme: 'light' })
    // Upsert of every column on an existing row.
    expect(await first.repository.upsertPreferences({ ...value, theme: 'system' })).toEqual({
      ...value,
      theme: 'system',
    })

    const second = await newAccount()
    expect(await second.repository.upsertPreferences(value, { onlyIfMissing: true })).toEqual(value)

    const third = await newAccount()
    expect(await third.repository.upsertPreferences(value, { fields: ['theme'] })).toEqual(value)
    const rows = await stored<{ user_id: string }>(
      'select user_id from public.user_preferences where user_id = $1',
      [third.userId],
    )
    expect(rows).toHaveLength(1)
  })

  it('importWorkspace RPC: everything or nothing, returns counts', async () => {
    const { repository } = await newAccount()
    const p = project({ name: 'Imported', sortOrder: 'a0', startDate: '2026-11-01' })
    const phase = makePhase({ id: uuid(), projectId: p.id })
    const parent = task(p.id, {
      phaseId: phase.id,
      status: 'done',
      completedAt: '2026-10-01T10:00:00.000Z',
    })
    const child = task(p.id, { parentTaskId: parent.id, sortOrder: 'a1' })
    const other = task(p.id, { sortOrder: 'a2' })
    const milestone = makeMilestone({ id: uuid(), projectId: p.id, date: '2026-12-01' })
    const dependency = makeDependency({
      id: uuid(),
      projectId: p.id,
      predecessorId: parent.id,
      successorId: other.id,
    })
    expect(
      await repository.importWorkspace({
        projects: [p],
        phases: [phase],
        tasks: [child, parent, other],
        milestones: [milestone],
        dependencies: [dependency],
      }),
    ).toEqual({ projects: 1, phases: 1, tasks: 3, milestones: 1, dependencies: 1 })
    const snapshot = await repository.loadWorkspace()
    expect(snapshot.tasks).toHaveLength(3)
    // A done task keeps its completion time.
    expect(
      new Date(snapshot.tasks.find((row) => row.id === parent.id)!.completedAt!).toISOString(),
    ).toBe('2026-10-01T10:00:00.000Z')

    // A reference outside the payload aborts the whole import.
    const before = (await repository.loadWorkspace()).projects.length
    await expectRejection(
      repository.importWorkspace({
        projects: [project()],
        phases: [],
        tasks: [task(uuid())],
        milestones: [],
        dependencies: [],
      }),
      'validation',
      /not part of the import/,
    )
    expect((await repository.loadWorkspace()).projects).toHaveLength(before)
  })

  it('loadWorkspace pages past max_rows (1000) without losing a row', async () => {
    const { repository } = await newAccount()
    const p = project()
    const tasks = Array.from({ length: 1100 }, (_, index) =>
      task(p.id, { title: `Task ${index}`, sortOrder: `a${index}` }),
    )
    await repository.importWorkspace({
      projects: [p],
      phases: [],
      tasks,
      milestones: [],
      dependencies: [],
    })
    const snapshot = await repository.loadWorkspace()
    expect(new Set(snapshot.tasks.map((row) => row.id)).size).toBe(1100)
    const page = sim.log.filter(
      (entry) => entry.path === '/rest/v1/tasks' && entry.query.includes('id=gt.'),
    )
    expect(page.length).toBeGreaterThan(0)
    // The schedule RPC's answer is cut by nothing here, but the method must cope with any length.
    const changes = tasks.slice(0, 3).map((row) => ({
      taskId: row.id,
      startDate: '2026-11-02',
      dueDate: '2026-11-03',
    }))
    expect(await repository.applySchedule(changes)).toHaveLength(3)
  })

  describe('error mapping from the real database', () => {
    it('check constraints and triggers → validation with readable text, no partial write', async () => {
      const { repository } = await newAccount()
      const p = await repository.insertProject(project())
      await expectRejection(
        repository.insertProject(project({ startDate: '2026-11-02', dueDate: '2026-11-01' })),
        'validation',
        "Due date can't be before the start date.",
      )
      await expectRejection(
        repository.insertProject(project({ name: '   ' })),
        'validation',
        'Project name must be 1–200 characters.',
      )
      await expectRejection(
        repository.insertTask(task(p.id, { title: 'x'.repeat(501) })),
        'validation',
        'Task title must be 1–500 characters.',
      )
      await expectRejection(
        repository.insertTask(task(p.id, { startDate: '2026-11-02', dueDate: '2026-11-01' })),
        'validation',
        "Due date can't be before the start date.",
      )
      await expectRejection(
        repository.insertTask(task(p.id, { sortOrder: '' })),
        'validation',
        /could not be placed/,
      )
      const parent = await repository.insertTask(task(p.id))
      const child = await repository.insertTask(task(p.id, { parentTaskId: parent.id }))
      await expectRejection(
        repository.insertTask(task(p.id, { parentTaskId: child.id })),
        'validation',
        /one level deep/,
      )
      await expectRejection(
        repository.updateProject(p.id, { status: 'nonsense' as Project['status'] }),
        'validation',
      )
      await expectRejection(
        repository.upsertPreferences({
          theme: 'neon' as Preferences['theme'],
          sidebarCollapsed: false,
          timezone: 'UTC',
          weekStartsOn: 1,
        }),
        'validation',
      )
      expect((await repository.loadWorkspace()).tasks).toHaveLength(2)
    })

    it('unique and foreign keys → conflict / validation', async () => {
      const { repository } = await newAccount()
      const p = await repository.insertProject(project())
      await expectRejection(
        repository.insertProject({ ...p }),
        'conflict',
        'This item already exists.',
      )
      await expectRejection(
        repository.insertTask(task(uuid())),
        'validation',
        /related item no longer exists/,
      )
      await expectRejection(
        repository.insertPhase(makePhase({ id: uuid(), projectId: uuid() })),
        'validation',
        /related item no longer exists/,
      )
    })

    it('an invalid value is reported as a format problem (22P02, 22007, 22008)', async () => {
      const { repository } = await newAccount()
      const p = await repository.insertProject(project())
      await expectRejection(repository.updateTask('not-a-uuid', { title: 'x' }), 'validation')
      await expectRejection(
        repository.updateProject(p.id, { startDate: 'not-a-date' }),
        'validation',
      )
      await expectRejection(repository.updateProject(p.id, { dueDate: '2026-02-31' }), 'validation')
    })

    it('another account: RLS makes its rows missing, and owner changes are refused', async () => {
      const alice = await newAccount()
      const bob = await newAccount()
      const p = await alice.repository.insertProject(project({ name: 'Alice only' }))
      const t = await alice.repository.insertTask(task(p.id))
      const m = await alice.repository.insertMilestone(
        makeMilestone({ id: uuid(), projectId: p.id, date: '2026-12-01' }),
      )

      const bobs = await bob.repository.loadWorkspace()
      expect(bobs.projects).toEqual([])
      expect(bobs.tasks).toEqual([])
      expect(bobs.milestones).toEqual([])

      await expectRejection(bob.repository.updateProject(p.id, { name: 'Stolen' }), 'not_found')
      await expectRejection(bob.repository.deleteProject(p.id), 'not_found')
      await expectRejection(bob.repository.updateTask(t.id, { title: 'Stolen' }), 'not_found')
      await expectRejection(bob.repository.deleteTask(t.id, { keepSubtasks: false }), 'not_found')
      await expectRejection(bob.repository.deleteMilestone(m.id), 'not_found')
      await expectRejection(
        bob.repository.applySchedule([{ taskId: t.id, startDate: '2026-01-01', dueDate: null }]),
        'not_found',
      )
      // Attaching to Alice's project: the composite foreign key and RLS both say no.
      const blocked = await bob.repository.insertTask(task(p.id)).catch((reason: unknown) => reason)
      expect(blocked).toBeInstanceOf(RepositoryError)

      const raw = await bob.client
        .from('projects')
        .insert({ id: uuid(), user_id: alice.userId, name: 'Forged', sort_order: 'a0' })
        .select()
      expect(raw.error?.code).toBe('42501')
      expect(raw.status).toBe(403)

      const [row] = await stored<{ name: string }>(
        'select name from public.projects where id = $1',
        [p.id],
      )
      expect(row.name).toBe('Alice only')
    })

    it('the isolation is the database: with RLS off the same request does return the other account', async () => {
      const alice = await newAccount()
      const bob = await newAccount()
      const p = await alice.repository.insertProject(project({ name: 'Alice only' }))
      const read = () => bob.client.from('projects').select('name').eq('id', p.id)
      expect((await read()).data).toEqual([])
      await sim.db.pg.exec('alter table public.projects disable row level security')
      try {
        // Nothing in the simulator filters by owner: this proves the empty answer above was RLS.
        expect((await read()).data).toEqual([{ name: 'Alice only' }])
      } finally {
        await sim.db.pg.exec('alter table public.projects enable row level security')
      }
      expect((await read()).data).toEqual([])
    })

    it('anon has no privileges: the API answers 401 / permission denied, on tables and RPCs', async () => {
      const anon = newClient()
      const repository = new SupabaseRepository(anon)
      await expectRejection(repository.loadWorkspace(), 'auth')
      await expectRejection(
        repository.importWorkspace({
          projects: [],
          phases: [],
          tasks: [],
          milestones: [],
          dependencies: [],
        }),
        'auth',
      )
      const { error, status } = await anon.from('tasks').select('*')
      expect(error?.code).toBe('42501')
      expect(status).toBe(401)
    })

    it('expired or forged tokens → auth, with the code PostgREST uses', async () => {
      const { client, repository } = await newAccount()
      sim.config.clockOffsetSeconds = 7200
      try {
        const expired = await expectRejection(
          repository.loadWorkspace(),
          'auth',
          /session has expired/,
        )
        expect((expired.cause as { code?: string }).code).toBe('PGRST303')
      } finally {
        sim.config.clockOffsetSeconds = 0
      }
      const forged = signJwt(
        { sub: uuid(), role: 'authenticated', exp: 9_999_999_999 },
        'wrong-secret',
      )
      const response = await simFetch(sim)(`${sim.url}/rest/v1/projects?select=*`, {
        headers: { apikey: SIM_PUBLISHABLE_KEY, Authorization: `Bearer ${forged}` },
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ code: 'PGRST301' })
      await client.auth.signOut({ scope: 'local' })
    })

    it('a dropped connection → network; a 500 → unknown (retryable), whether or not it was applied', async () => {
      const { repository } = await newAccount()
      const p = project()
      sim.faults.push({ method: 'POST', path: '/rest/v1/projects', when: 'before', action: 'drop' })
      await expectRejection(repository.insertProject(p), 'network', /check your connection/)
      expect((await repository.loadWorkspace()).projects).toEqual([])

      // Applied, but the answer never came: the row exists and sending it again is a conflict.
      sim.faults.push({ method: 'POST', path: '/rest/v1/projects', when: 'after', action: 'drop' })
      await expectRejection(repository.insertProject(p), 'network')
      expect((await repository.loadWorkspace()).projects).toHaveLength(1)
      await expectRejection(repository.insertProject(p), 'conflict')

      sim.faults.push({
        method: 'PATCH',
        path: '/rest/v1/projects',
        when: 'before',
        action: 'status',
        status: 500,
      })
      await expectRejection(repository.updateProject(p.id, { name: 'x' }), 'unknown')
      sim.faults.push({
        method: 'PATCH',
        path: '/rest/v1/projects',
        when: 'before',
        action: 'status',
        status: 502,
        body: '<html>Bad gateway</html>',
        contentType: 'text/html',
      })
      await expectRejection(
        repository.updateProject(p.id, { name: 'x' }),
        'unknown',
        /couldn't complete the request/,
      )
    })

    it('a database without the migration is named as such (missing table, column and function)', async () => {
      const { client } = await newAccount()
      const table = await client.from('nope').select('*')
      expect(table.error?.code).toBe('PGRST205')
      expect(table.status).toBe(404)
      const column = await client.from('tasks').insert({ nope: 1 }).select()
      expect(column.error?.code).toBe('PGRST204')
      const fn = await client.rpc('nope', { a: 1 })
      expect(fn.error?.code).toBe('PGRST202')
      const { toRepositoryError } = await import('../../src/data/supabaseRepository.ts')
      for (const error of [table.error, column.error, fn.error]) {
        expect(toRepositoryError(error).message).toBe(MISSING_SCHEMA_MESSAGE)
      }
    })
  })
})

describe('what real Postgres sends back', () => {
  it('timestamps with an offset and microseconds pass the backup check and keep their instant', () => {
    // PGlite's clock has millisecond resolution; real Postgres answers with up to six digits.
    const timestamp = '2026-11-04T05:27:26.651234+00:00'
    const p = makeProject({
      id: uuid(),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    const file = {
      app: 'cairn',
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt: timestamp,
      data: {
        projects: [p],
        phases: [],
        tasks: [
          makeTask({
            id: uuid(),
            projectId: p.id,
            completedAt: timestamp,
            status: 'done',
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        ],
        milestones: [],
        dependencies: [],
      },
    }
    expect(parseBackupFile(file).ok).toBe(true)
    expect(Date.parse(timestamp)).toBe(Date.UTC(2026, 10, 4, 5, 27, 26, 651))
  })
})

describe('auth endpoints through @supabase/auth-js', () => {
  it('signs up, refuses a duplicate and a wrong password, rotates the refresh token', async () => {
    const client = newClient()
    const email = `${randomUUID()}@EXAMPLE.test`
    const signUp = await client.auth.signUp({ email, password: 'correct horse' })
    expect(signUp.error).toBeNull()
    expect(signUp.data.user?.email).toBe(email.toLowerCase())

    const duplicate = await newClient().auth.signUp({ email, password: 'correct horse' })
    expect(duplicate.error?.code).toBe('user_already_exists')

    const wrong = await newClient().auth.signInWithPassword({ email, password: 'nope' })
    expect(wrong.error?.code).toBe('invalid_credentials')
    expect(wrong.error?.status).toBe(400)

    const refreshed = await client.auth.refreshSession()
    expect(refreshed.error).toBeNull()
    expect(refreshed.data.session?.refresh_token).not.toBe(signUp.data.session?.refresh_token)
    const { data: user } = await client.auth.getUser()
    expect(user.user?.email).toBe(email.toLowerCase())

    // A rotated token still works for a moment, then the whole session is refused.
    const reuse = await simFetch(sim)(`${sim.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: SIM_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: signUp.data.session?.refresh_token }),
    })
    expect(reuse.status).toBe(200)

    await client.auth.signOut({ scope: 'local' })
    const after = await simFetch(sim)(`${sim.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: SIM_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshed.data.session?.refresh_token }),
    })
    expect(after.status).toBe(400)
    expect(await after.json()).toMatchObject({ code: 'refresh_token_not_found' })
  })

  it('an unknown API key is refused before anything else', async () => {
    const response = await simFetch(sim)(`${sim.url}/rest/v1/projects?select=*`, {
      headers: { apikey: 'sb_publishable_wrong' },
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ message: 'Invalid API key' })
  })
})
