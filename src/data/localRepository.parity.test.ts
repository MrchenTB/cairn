/**
 * Differential test: LocalRepository (local data mode, E2E tests) against the REAL database
 * (supabase/migrations on PGlite), operation by operation. Both must accept or refuse the same
 * writes with the same error kind (the store decides rollback / Retry / "already done" on the
 * kind), and end with the same data. A rule added to the migration without its LocalRepository
 * mirror (or the other way round) fails here.
 *
 * The SQL side is a thin Repository over PGlite that issues what PostgREST would (one statement
 * per call, run as the signed-in `authenticated` role under RLS) and maps errors with the same
 * `toRepositoryError` as SupabaseRepository.
 */
import { PGlite, types } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  BackupData,
  Dependency,
  ImportSummary,
  Milestone,
  MilestonePatch,
  Phase,
  PhasePatch,
  Preferences,
  Project,
  ProjectPatch,
  ScheduleChange,
  Task,
  TaskPatch,
  WorkspaceSnapshot,
} from '@/domain/types'
import type { Repository, UpsertPreferencesOptions } from './contracts'
import { RepositoryError } from './errors'
import { createMemoryStorage, LocalRepository } from './localRepository'
import {
  dependencyFromRow,
  dependencyToInsert,
  importPayloadFromBackup,
  milestoneFromRow,
  milestonePatchToRow,
  milestoneToInsert,
  phaseFromRow,
  phasePatchToRow,
  phaseToInsert,
  preferencesFieldsToRow,
  preferencesFromRow,
  preferencesToRow,
  projectFromRow,
  projectPatchToRow,
  projectToInsert,
  taskFromRow,
  taskPatchToRow,
  taskToInsert,
  type DependencyRow,
  type MilestoneRow,
  type PhaseRow,
  type PreferencesRow,
  type ProjectRow,
  type TaskRow,
} from './mappers'
import { toRepositoryError } from './supabaseRepository'

// ---------------------------------------------------------------------------
// The real schema on PGlite (Supabase pieces the migration needs, as in tests/db/harness.ts)
// ---------------------------------------------------------------------------

const MIGRATIONS = import.meta.glob('../../supabase/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const SUPABASE_SHIM = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role migrator nologin noinherit;
  create schema auth;
  grant usage on schema auth to anon, authenticated, migrator;
  create table auth.users (id uuid primary key, email text unique);
  grant references on auth.users to migrator;
  create function auth.uid() returns uuid language sql stable as $$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
  $$;
  grant usage on schema public to anon, authenticated;
  grant usage, create on schema public to migrator;
`

let pg: PGlite

beforeAll(async () => {
  pg = await PGlite.create({
    parsers: {
      [types.DATE]: (value: string) => value,
      [types.TIMESTAMPTZ]: (value: string) => value,
      [types.INT8]: (value: string) => Number(value),
    },
  })
  await pg.exec(SUPABASE_SHIM)
  for (const name of Object.keys(MIGRATIONS).sort()) {
    await pg.exec(`set role migrator;\n${MIGRATIONS[name]}\n;reset role;`)
  }
}, 60_000)

afterAll(async () => {
  await pg?.close()
})

type Table =
  'projects' | 'phases' | 'tasks' | 'milestones' | 'task_dependencies' | 'user_preferences'

/** Repository over PGlite issuing what PostgREST would for SupabaseRepository's calls. */
class SqlRepository implements Repository {
  readonly mode = 'supabase' as const
  private readonly userId: string

  constructor(userId: string) {
    this.userId = userId
  }

  private async run<Row>(sql: string, params: unknown[] = []): Promise<Row[]> {
    try {
      return await pg.transaction(async (tx) => {
        await tx.exec('set local role authenticated')
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: this.userId, role: 'authenticated' }),
        ])
        return (await tx.query<Row>(sql, params)).rows
      })
    } catch (error) {
      if (error instanceof RepositoryError) throw error
      const e = error as { code?: unknown; message?: unknown; detail?: unknown }
      throw toRepositoryError({ code: e.code, message: e.message, details: e.detail }, 400)
    }
  }

  private async insert<Row>(table: Table, values: object): Promise<Row> {
    const entries = Object.entries(values)
    const columns = entries.map(([column]) => column).join(', ')
    const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ')
    const [row] = await this.run<Row>(
      `insert into public.${table} (${columns}) values (${placeholders}) returning *`,
      entries.map(([, value]) => value),
    )
    return row
  }

  /** PATCH ?id=eq.… with `.select().single()`: no row → PGRST116 → not_found. */
  private async update<Row>(table: Table, id: string, values: object): Promise<Row> {
    const entries = Object.entries(values)
    const rows =
      entries.length === 0
        ? await this.run<Row>(`select * from public.${table} where id = $1`, [id])
        : await this.run<Row>(
            `update public.${table} set ${entries
              .map(([column], i) => `${column} = $${i + 2}`)
              .join(', ')} where id = $1 returning *`,
            [id, ...entries.map(([, value]) => value)],
          )
    if (rows.length === 0) throw new RepositoryError('not_found', 'Not found.')
    return rows[0]
  }

  /**
   * The database's own answer to columns SupabaseRepository never sends (its mappers drop fields
   * outside the patch types), for comparing the immutable-column rule itself.
   */
  updateColumns(table: Table, id: string, columns: Record<string, unknown>): Promise<unknown> {
    return this.update(table, id, columns)
  }

  private async remove(table: Table, id: string): Promise<void> {
    const rows = await this.run(`delete from public.${table} where id = $1 returning id`, [id])
    if (rows.length === 0) throw new RepositoryError('not_found', 'Not found.')
  }

  async loadWorkspace(): Promise<WorkspaceSnapshot> {
    const all = <Row>(table: Table, order = 'id') =>
      this.run<Row>(`select * from public.${table} order by ${order}`)
    const preferences = await all<PreferencesRow>('user_preferences', 'user_id')
    return {
      projects: (await all<ProjectRow>('projects')).map(projectFromRow),
      phases: (await all<PhaseRow>('phases')).map(phaseFromRow),
      tasks: (await all<TaskRow>('tasks')).map(taskFromRow),
      milestones: (await all<MilestoneRow>('milestones')).map(milestoneFromRow),
      dependencies: (await all<DependencyRow>('task_dependencies')).map(dependencyFromRow),
      preferences: preferences[0] ? preferencesFromRow(preferences[0]) : null,
    }
  }

  async insertProject(project: Project) {
    return projectFromRow(await this.insert<ProjectRow>('projects', projectToInsert(project)))
  }
  async updateProject(id: string, patch: ProjectPatch) {
    return projectFromRow(await this.update<ProjectRow>('projects', id, projectPatchToRow(patch)))
  }
  deleteProject(id: string) {
    return this.remove('projects', id)
  }
  async insertPhase(phase: Phase) {
    return phaseFromRow(await this.insert<PhaseRow>('phases', phaseToInsert(phase)))
  }
  async updatePhase(id: string, patch: PhasePatch) {
    return phaseFromRow(await this.update<PhaseRow>('phases', id, phasePatchToRow(patch)))
  }
  deletePhase(id: string) {
    return this.remove('phases', id)
  }
  async insertTask(task: Task) {
    return taskFromRow(await this.insert<TaskRow>('tasks', taskToInsert(task)))
  }
  async updateTask(id: string, patch: TaskPatch) {
    return taskFromRow(await this.update<TaskRow>('tasks', id, taskPatchToRow(patch)))
  }
  async deleteTask(
    id: string,
    options: { keepSubtasks: boolean; promotedSortOrders?: Record<string, string> },
  ) {
    const promoted = options.keepSubtasks
      ? Object.entries(options.promotedSortOrders ?? {}).map(([taskId, sortOrder]) => ({
          id: taskId,
          sort_order: sortOrder,
        }))
      : []
    await this.run('select public.delete_task($1::uuid, $2::boolean, $3::jsonb)', [
      id,
      options.keepSubtasks,
      JSON.stringify(promoted),
    ])
  }
  async insertMilestone(milestone: Milestone) {
    return milestoneFromRow(
      await this.insert<MilestoneRow>('milestones', milestoneToInsert(milestone)),
    )
  }
  async updateMilestone(id: string, patch: MilestonePatch) {
    return milestoneFromRow(
      await this.update<MilestoneRow>('milestones', id, milestonePatchToRow(patch)),
    )
  }
  deleteMilestone(id: string) {
    return this.remove('milestones', id)
  }
  async insertDependency(dependency: Dependency) {
    return dependencyFromRow(
      await this.insert<DependencyRow>('task_dependencies', dependencyToInsert(dependency)),
    )
  }
  deleteDependency(id: string) {
    return this.remove('task_dependencies', id)
  }
  async applySchedule(changes: readonly ScheduleChange[]) {
    if (changes.length === 0) return []
    const rows = await this.run<TaskRow>('select * from public.apply_task_schedule($1::jsonb)', [
      JSON.stringify(
        changes.map((c) => ({ id: c.taskId, start_date: c.startDate, due_date: c.dueDate })),
      ),
    ])
    return rows.map(taskFromRow)
  }
  /** The same requests as SupabaseRepository.upsertPreferences, in the same order. */
  async upsertPreferences(preferences: Preferences, options: UpsertPreferencesOptions = {}) {
    const insert = async (values: Record<string, unknown>, onConflict: string) => {
      const entries = Object.entries(values)
      return this.run<PreferencesRow>(
        `insert into public.user_preferences (${entries.map(([c]) => c).join(', ')})
         values (${entries.map((_, i) => `$${i + 1}`).join(', ')})
         on conflict (user_id) ${onConflict} returning *`,
        entries.map(([, value]) => value),
      )
    }
    const update = async (values: Record<string, unknown>) => {
      const entries = Object.entries(values)
      return this.run<PreferencesRow>(
        `update public.user_preferences set ${entries
          .map(([column], i) => `${column} = $${i + 1}`)
          .join(', ')} where user_id is not null returning *`,
        entries.map(([, value]) => value),
      )
    }
    const full = { ...preferencesToRow(preferences) }
    if (options.onlyIfMissing) {
      const [inserted] = await insert(full, 'do nothing')
      if (inserted) return preferencesFromRow(inserted)
      const [existing] = await this.run<PreferencesRow>('select * from public.user_preferences')
      if (existing) return preferencesFromRow(existing)
    }
    if (options.fields && options.fields.length > 0) {
      const changes = preferencesFieldsToRow(preferences, options.fields)
      const [updated] = await update(changes)
      if (updated) return preferencesFromRow(updated)
      const [inserted] = await insert(full, 'do nothing')
      if (inserted) return preferencesFromRow(inserted)
      const [raced] = await update(changes)
      if (raced) return preferencesFromRow(raced)
      throw new RepositoryError('not_found', 'Not found.')
    }
    const set = Object.keys(full)
      .map((column) => `${column} = excluded.${column}`)
      .join(', ')
    const [row] = await insert(full, `do update set ${set}`)
    return preferencesFromRow(row)
  }
  async importWorkspace(data: BackupData): Promise<ImportSummary> {
    const [row] = await this.run<{ counts: ImportSummary }>(
      'select public.import_workspace($1::jsonb) as counts',
      [JSON.stringify(importPayloadFromBackup(data))],
    )
    return row.counts
  }
}

// ---------------------------------------------------------------------------
// Running the same operations on both
// ---------------------------------------------------------------------------

type Outcome = 'ok' | `refused: ${string}`

async function outcome(call: () => Promise<unknown>): Promise<Outcome> {
  try {
    await call()
    return 'ok'
  } catch (error) {
    if (error instanceof RepositoryError) return `refused: ${error.kind}`
    throw error // a crash is a test failure on its own
  }
}

/** Snapshot without server timestamps (completion only as "set or not"). */
function comparable(snapshot: WorkspaceSnapshot) {
  const strip = <T extends { id: string }>(rows: readonly T[]) =>
    [...rows]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((row) => {
        const copy: Record<string, unknown> = { ...row }
        delete copy.createdAt
        delete copy.updatedAt
        if ('completedAt' in copy) copy.completedAt = copy.completedAt !== null
        return copy
      })
  return {
    projects: strip(snapshot.projects),
    phases: strip(snapshot.phases),
    tasks: strip(snapshot.tasks),
    milestones: strip(snapshot.milestones),
    dependencies: strip(snapshot.dependencies),
    preferences: snapshot.preferences,
  }
}

let userSequence = 0

/** A fresh account on the database and a fresh local store. */
async function pair() {
  userSequence += 1
  ID = idsFor()
  const userId = uuid(900_000_000 + userSequence)
  await pg.query('insert into auth.users (id, email) values ($1, $2)', [
    userId,
    `u${userSequence}@example.test`,
  ])
  const local = new LocalRepository({ storage: createMemoryStorage() })
  const sql = new SqlRepository(userId)
  const steps: { name: string; local: Outcome; sql: Outcome }[] = []
  return {
    local,
    sql,
    steps,
    /** Runs `call` on both and records both outcomes. */
    async step(name: string, call: (repo: Repository) => Promise<unknown>) {
      steps.push({
        name,
        local: await outcome(() => call(local)),
        sql: await outcome(() => call(sql)),
      })
    },
    /** The same change expressed for each side. */
    async stepEach(
      name: string,
      onLocal: (repo: LocalRepository) => Promise<unknown>,
      onSql: (repo: SqlRepository) => Promise<unknown>,
    ) {
      steps.push({
        name,
        local: await outcome(() => onLocal(local)),
        sql: await outcome(() => onSql(sql)),
      })
    },
    async expectSameEverywhere() {
      const mismatches = steps.filter((s) => s.local !== s.sql)
      expect(mismatches, 'operations the two repositories answered differently').toEqual([])
      expect(comparable(await local.loadWorkspace())).toEqual(comparable(await sql.loadWorkspace()))
    },
  }
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

/** Ids are primary keys across accounts: every scenario (account) gets its own. */
function u(n: number): string {
  return uuid(userSequence * 1000 + n)
}

const idsFor = () => ({
  P1: u(1),
  P2: u(2),
  PH1: u(11),
  PH2: u(12),
  PH3: u(13), // in P2
  T1: u(21),
  T2: u(22),
  T3: u(23),
  T4: u(24),
  S1: u(31),
  S2: u(32),
  U1: u(41), // in P2
  M1: u(51),
  D1: u(61),
  NEW: u(99),
  NEW2: u(98),
  MISSING: u(97),
})
let ID = idsFor()

const T0 = '2026-11-01T00:00:00.000Z'

const project = (overrides: Partial<Project> = {}): Project => ({
  id: ID.NEW,
  name: 'Project',
  description: null,
  status: 'active',
  color: 'gray',
  startDate: null,
  dueDate: null,
  scheduleMode: 'manual',
  sortOrder: 'a0',
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
})
const phase = (overrides: Partial<Phase> = {}): Phase => ({
  id: ID.NEW,
  projectId: ID.P1,
  name: 'Phase',
  sortOrder: 'a0',
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
})
const task = (overrides: Partial<Task> = {}): Task => ({
  id: ID.NEW,
  projectId: ID.P1,
  phaseId: null,
  parentTaskId: null,
  title: 'Task',
  description: null,
  status: 'todo',
  priority: 'none',
  startDate: null,
  dueDate: null,
  sortOrder: 'a0',
  completedAt: null,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
})
const milestone = (overrides: Partial<Milestone> = {}): Milestone => ({
  id: ID.NEW,
  projectId: ID.P1,
  phaseId: null,
  name: 'Milestone',
  date: '2026-12-01',
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
})
const dependency = (overrides: Partial<Dependency> = {}): Dependency => ({
  id: ID.NEW,
  projectId: ID.P1,
  predecessorId: ID.T1,
  successorId: ID.T4,
  type: 'FS',
  createdAt: T0,
  ...overrides,
})

/**
 * P1: phases PH1, PH2; tasks T1 (PH1, subtasks S1 S2), T2 (PH1), T3 (PH2), T4; milestone M1 (PH1);
 * dependency T2 → T3. P2: phase PH3, task U1.
 */
async function seedBoth(p: Awaited<ReturnType<typeof pair>>) {
  const rows: [string, (repo: Repository) => Promise<unknown>][] = [
    ['P1', (r) => r.insertProject(project({ id: ID.P1, name: 'Alpha', sortOrder: 'a0' }))],
    ['P2', (r) => r.insertProject(project({ id: ID.P2, name: 'Beta', sortOrder: 'a1' }))],
    ['PH1', (r) => r.insertPhase(phase({ id: ID.PH1, name: 'Plan' }))],
    ['PH2', (r) => r.insertPhase(phase({ id: ID.PH2, name: 'Build', sortOrder: 'a1' }))],
    ['PH3', (r) => r.insertPhase(phase({ id: ID.PH3, projectId: ID.P2 }))],
    ['T1', (r) => r.insertTask(task({ id: ID.T1, phaseId: ID.PH1, sortOrder: 'a0' }))],
    ['T2', (r) => r.insertTask(task({ id: ID.T2, phaseId: ID.PH1, sortOrder: 'a1' }))],
    ['T3', (r) => r.insertTask(task({ id: ID.T3, phaseId: ID.PH2, sortOrder: 'a2' }))],
    ['T4', (r) => r.insertTask(task({ id: ID.T4, sortOrder: 'a3', status: 'done' }))],
    ['S1', (r) => r.insertTask(task({ id: ID.S1, parentTaskId: ID.T1, sortOrder: 'a0' }))],
    ['S2', (r) => r.insertTask(task({ id: ID.S2, parentTaskId: ID.T1, phaseId: ID.PH2 }))],
    ['U1', (r) => r.insertTask(task({ id: ID.U1, projectId: ID.P2, phaseId: ID.PH3 }))],
    ['M1', (r) => r.insertMilestone(milestone({ id: ID.M1, phaseId: ID.PH1 }))],
    [
      'D1',
      (r) =>
        r.insertDependency(dependency({ id: ID.D1, predecessorId: ID.T2, successorId: ID.T3 })),
    ],
  ]
  for (const [name, call] of rows) await p.step(`seed ${name}`, call)
  expect(
    p.steps.every((s) => s.local === 'ok' && s.sql === 'ok'),
    JSON.stringify(p.steps),
  ).toBe(true)
}

const longText = (n: number) => 'x'.repeat(n)

describe('LocalRepository answers exactly like the database', () => {
  it('constraints on names, texts, enums, dates and sort keys', async () => {
    const p = await pair()
    await seedBoth(p)
    const insertProject = (name: string, overrides: Partial<Project>) =>
      p.step(`project ${name}`, (r) => r.insertProject(project({ id: ID.NEW, ...overrides })))
    await insertProject('blank name', { name: ' \t ' })
    await insertProject('name 201', { name: longText(201) })
    await insertProject('name 200 + edge spaces', { name: ` ${longText(199)} ` })
    await insertProject('200 emoji', { name: '🙂'.repeat(200), id: ID.NEW2 })
    await insertProject('description 10001', { description: longText(10_001) })
    await insertProject('due before start', { startDate: '2026-11-05', dueDate: '2026-11-04' })
    await insertProject('year 0', { startDate: '0000-12-31' })
    await insertProject('Feb 30', { dueDate: '2026-02-30' })
    await insertProject('bad status', { status: 'paused' as Project['status'] })
    await insertProject('bad color', { color: 'black' as Project['color'] })
    await insertProject('bad schedule mode', { scheduleMode: 'smart' as Project['scheduleMode'] })
    await insertProject('empty sort key', { sortOrder: '' })
    await insertProject('NUL in the sort key', { sortOrder: 'a\u0000' })
    await insertProject('NUL in the name', { name: 'a\u0000b' })
    await insertProject('NUL in the description', { description: 'a\u0000b' })
    await insertProject('last valid date', { startDate: '0001-01-01', dueDate: '9999-12-31' })
    await p.step('duplicate id', (r) => r.insertProject(project({ id: ID.P1 })))

    await p.step('task title 501', (r) => r.insertTask(task({ title: longText(501) })))
    await p.step('task bad priority', (r) =>
      r.insertTask(task({ priority: 'asap' as Task['priority'] })),
    )
    await p.step('milestone Feb 29 2026', (r) =>
      r.insertMilestone(milestone({ date: '2026-02-29' })),
    )
    await p.step('milestone blank name', (r) => r.insertMilestone(milestone({ name: '  ' })))
    await p.step('phase name 201', (r) => r.insertPhase(phase({ name: longText(201) })))
    await p.step('rename phase to blank', (r) => r.updatePhase(ID.PH1, { name: ' ' }))
    await p.step('clear sort key', (r) => r.updateProject(ID.P1, { sortOrder: '' }))
    await p.step('NUL in a moved sort key', (r) => r.updateTask(ID.T2, { sortOrder: 'a1\u0000' }))
    await p.step('NUL in a promoted sort key', (r) =>
      r.deleteTask(ID.T1, {
        keepSubtasks: true,
        promotedSortOrders: { [ID.S1]: 'a0\u0000', [ID.S2]: 'a02' },
      }),
    )
    await p.step('dates in order', (r) =>
      r.updateTask(ID.T2, { startDate: '2026-11-02', dueDate: '2026-11-04' }),
    )
    await p.step('start after due (one field)', (r) =>
      r.updateTask(ID.T2, { startDate: '2026-11-05' }),
    )
    await p.expectSameEverywhere()
  })

  it('references, immutable columns and missing rows', async () => {
    const p = await pair()
    await seedBoth(p)
    await p.step('task in a missing project', (r) => r.insertTask(task({ projectId: ID.MISSING })))
    await p.step("task in another project's phase", (r) => r.insertTask(task({ phaseId: ID.PH3 })))
    await p.step('task in a missing phase', (r) => r.insertTask(task({ phaseId: ID.MISSING })))
    await p.step('phase of a missing project', (r) =>
      r.insertPhase(phase({ projectId: ID.MISSING })),
    )
    await p.step("milestone in another project's phase", (r) =>
      r.insertMilestone(milestone({ phaseId: ID.PH3 })),
    )
    await p.step("move milestone to another project's phase", (r) =>
      r.updateMilestone(ID.M1, { phaseId: ID.PH3 }),
    )
    // Never sent by SupabaseRepository (its mappers drop them); LocalRepository refuses them the
    // way the database's tg_immutable_columns would.
    await p.stepEach(
      'move task to another project',
      (r) => r.updateTask(ID.T2, { projectId: ID.P2 } as TaskPatch),
      (r) => r.updateColumns('tasks', ID.T2, { project_id: ID.P2 }),
    )
    await p.stepEach(
      'change a task id',
      (r) => r.updateTask(ID.T2, { id: ID.NEW } as TaskPatch),
      (r) => r.updateColumns('tasks', ID.T2, { id: ID.NEW }),
    )
    await p.stepEach(
      'change a project id',
      (r) => r.updateProject(ID.P2, { id: ID.NEW } as ProjectPatch),
      (r) => r.updateColumns('projects', ID.P2, { id: ID.NEW }),
    )
    await p.stepEach(
      'move phase to another project',
      (r) => r.updatePhase(ID.PH1, { projectId: ID.P2 } as PhasePatch),
      (r) => r.updateColumns('phases', ID.PH1, { project_id: ID.P2 }),
    )
    await p.stepEach(
      'move milestone to another project',
      (r) => r.updateMilestone(ID.M1, { projectId: ID.P2 } as MilestonePatch),
      (r) => r.updateColumns('milestones', ID.M1, { project_id: ID.P2 }),
    )
    for (const [name, call] of [
      ['update missing task', (r: Repository) => r.updateTask(ID.MISSING, { title: 'x' })],
      ['update missing project', (r: Repository) => r.updateProject(ID.MISSING, { name: 'x' })],
      ['update missing milestone', (r: Repository) => r.updateMilestone(ID.MISSING, { name: 'x' })],
      ['delete missing phase', (r: Repository) => r.deletePhase(ID.MISSING)],
      ['delete missing dependency', (r: Repository) => r.deleteDependency(ID.MISSING)],
      ['delete missing task', (r: Repository) => r.deleteTask(ID.MISSING, { keepSubtasks: false })],
    ] as const) {
      await p.step(name, call)
    }
    await p.expectSameEverywhere()
  })

  it('hierarchy: one level, same project, subtasks carry and follow the parent phase', async () => {
    const p = await pair()
    await seedBoth(p)
    await p.step('subtask of a subtask', (r) => r.insertTask(task({ parentTaskId: ID.S1 })))
    await p.step('subtask of a missing task', (r) =>
      r.insertTask(task({ parentTaskId: ID.MISSING })),
    )
    await p.step('subtask of a task in another project', (r) =>
      r.insertTask(task({ parentTaskId: ID.U1 })),
    )
    await p.step('own parent', (r) => r.updateTask(ID.T4, { parentTaskId: ID.T4 }))
    await p.step('a parent becomes a subtask', (r) => r.updateTask(ID.T1, { parentTaskId: ID.T4 }))
    await p.step('subtask of the task it depends on', (r) =>
      r.updateTask(ID.T3, { parentTaskId: ID.T2 }),
    )
    await p.step('subtask of the task that depends on it', (r) =>
      r.updateTask(ID.T2, { parentTaskId: ID.T3 }),
    )
    await p.step('a subtask moves to its own subtask level', (r) =>
      r.updateTask(ID.T4, { parentTaskId: ID.S1 }),
    )
    await p.step('a subtask is given another phase', (r) =>
      r.updateTask(ID.S1, { phaseId: ID.PH2 }),
    )
    await p.step('the parent changes phase', (r) => r.updateTask(ID.T1, { phaseId: ID.PH2 }))
    await p.step('a task becomes a subtask', (r) => r.updateTask(ID.T4, { parentTaskId: ID.T1 }))
    await p.step('a subtask is promoted with a phase', (r) =>
      r.updateTask(ID.S2, { parentTaskId: null, phaseId: ID.PH1, sortOrder: 'a9' }),
    )
    await p.step('a done subtask is reopened', (r) =>
      r.updateTask(ID.T4, { status: 'in_progress' }),
    )
    await p.step('a task is done', (r) => r.updateTask(ID.T3, { status: 'done' }))
    await p.expectSameEverywhere()
  })

  it('dependencies: same project, no self, parent/subtask, duplicate or cyclic edges', async () => {
    const p = await pair()
    await seedBoth(p)
    const add = (name: string, overrides: Partial<Dependency>) =>
      p.step(name, (r) => r.insertDependency(dependency({ id: ID.NEW, ...overrides })))
    await add('self', { predecessorId: ID.T1, successorId: ID.T1 })
    await add('subtask → parent', { predecessorId: ID.S1, successorId: ID.T1 })
    await add('parent → subtask', { predecessorId: ID.T1, successorId: ID.S2 })
    await add('duplicate pair', { predecessorId: ID.T2, successorId: ID.T3 })
    await add('cycle', { predecessorId: ID.T3, successorId: ID.T2 })
    await add('across projects', { predecessorId: ID.T1, successorId: ID.U1 })
    await add('filed under the other project', { projectId: ID.P2 })
    await add('missing task', { predecessorId: ID.MISSING })
    await add('unknown type', { type: 'SS' as Dependency['type'] })
    await add('subtask → other task', { predecessorId: ID.S1, successorId: ID.T3 })
    await add('longer cycle', { id: ID.NEW2, predecessorId: ID.T3, successorId: ID.S1 })
    await p.step('delete it', (r) => r.deleteDependency(ID.NEW))
    await p.expectSameEverywhere()
  })

  it('apply_task_schedule is all-or-nothing', async () => {
    const p = await pair()
    await seedBoth(p)
    const apply = (name: string, changes: ScheduleChange[]) =>
      p.step(name, (r) => r.applySchedule(changes))
    const change = (taskId: string, startDate: string | null, dueDate: string | null) => ({
      taskId,
      startDate,
      dueDate,
    })
    await apply('nothing', [])
    await apply('two tasks', [
      change(ID.T1, '2026-11-02', '2026-11-04'),
      change(ID.S1, null, '2026-11-03'),
    ])
    await apply('one is due before it starts', [
      change(ID.T2, '2026-11-02', '2026-11-03'),
      change(ID.T3, '2026-11-09', '2026-11-08'),
    ])
    await apply('one is missing', [
      change(ID.T2, '2026-11-02', null),
      change(ID.MISSING, null, null),
    ])
    await apply('a task twice', [change(ID.T2, null, null), change(ID.T2, null, '2026-11-09')])
    await apply('a malformed date', [change(ID.T2, '2026-1-2', null)])
    await apply('an impossible date', [change(ID.T2, '2026-02-30', null)])
    await apply('clear both', [change(ID.T1, null, null)])
    await p.expectSameEverywhere()
  })

  it('delete_task: subtasks deleted, or promoted only when the list is exactly right', async () => {
    const p = await pair()
    await seedBoth(p)
    const keep = (promotedSortOrders: Record<string, string>) => ({
      keepSubtasks: true,
      promotedSortOrders,
    })
    await p.step('promote too few', (r) => r.deleteTask(ID.T1, keep({ [ID.S1]: 'a01' })))
    await p.step('promote a stranger', (r) =>
      r.deleteTask(ID.T1, keep({ [ID.S1]: 'a01', [ID.T2]: 'a02' })),
    )
    await p.step('promote with an empty key', (r) =>
      r.deleteTask(ID.T1, keep({ [ID.S1]: 'a01', [ID.S2]: '' })),
    )
    await p.step('keep on a task without subtasks', (r) => r.deleteTask(ID.T4, keep({})))
    await p.step('promote exactly the subtasks', (r) =>
      r.deleteTask(ID.T1, keep({ [ID.S1]: 'a01', [ID.S2]: 'a02' })),
    )
    await p.step('subtask of the deleted parent is now top-level', (r) =>
      r.updateTask(ID.S1, { title: 'Promoted' }),
    )
    await p.step('delete with dependencies', (r) => r.deleteTask(ID.T2, { keepSubtasks: false }))
    await p.step('delete a phase: ungroups', (r) => r.deletePhase(ID.PH2))
    await p.step('delete a project: cascades', (r) => r.deleteProject(ID.P2))
    await p.expectSameEverywhere()
  })

  it('a parent deleted with its subtasks takes their dependencies along', async () => {
    const p = await pair()
    await seedBoth(p)
    await p.step('subtask dependency', (r) =>
      r.insertDependency(dependency({ id: ID.NEW, predecessorId: ID.S1, successorId: ID.T3 })),
    )
    await p.step('delete the parent', (r) => r.deleteTask(ID.T1, { keepSubtasks: false }))
    await p.expectSameEverywhere()
  })

  it('preferences: one row, checked, partial updates and insert-only seeds', async () => {
    const p = await pair()
    const value: Preferences = {
      theme: 'dark',
      sidebarCollapsed: true,
      timezone: 'Europe/Paris',
      weekStartsOn: 0,
    }
    await p.step('empty time zone', (r) => r.upsertPreferences({ ...value, timezone: '' }))
    await p.step('101-character time zone', (r) =>
      r.upsertPreferences({ ...value, timezone: longText(101) }),
    )
    await p.step('unknown theme', (r) =>
      r.upsertPreferences({ ...value, theme: 'blue' as Preferences['theme'] }),
    )
    await p.step('NUL in the time zone', (r) =>
      r.upsertPreferences({ ...value, timezone: 'Europe/Paris\u0000' }),
    )
    await p.step('week starting on Tuesday', (r) =>
      r.upsertPreferences({ ...value, weekStartsOn: 2 as Preferences['weekStartsOn'] }),
    )
    await p.step('seed', (r) => r.upsertPreferences(value, { onlyIfMissing: true }))
    await p.step('seed again (kept)', (r) =>
      r.upsertPreferences({ ...value, theme: 'light' }, { onlyIfMissing: true }),
    )
    await p.step('one field', (r) =>
      r.upsertPreferences(
        { theme: 'system', sidebarCollapsed: false, timezone: 'Asia/Taipei', weekStartsOn: 1 },
        { fields: ['sidebarCollapsed'] },
      ),
    )
    await p.expectSameEverywhere()
    expect((await p.local.loadWorkspace()).preferences).toEqual({
      ...value,
      sidebarCollapsed: false,
    })
  })

  it('a partial preferences save on an account without a row stores the whole value', async () => {
    const p = await pair()
    const value: Preferences = {
      theme: 'light',
      sidebarCollapsed: true,
      timezone: 'America/New_York',
      weekStartsOn: 0,
    }
    await p.step('one field, no row yet', (r) => r.upsertPreferences(value, { fields: ['theme'] }))
    await p.expectSameEverywhere()
    expect((await p.sql.loadWorkspace()).preferences).toEqual(value)
  })

  it('import_workspace: self-contained, valid, all-or-nothing', async () => {
    const p = await pair()
    await seedBoth(p)
    const X = u(200)
    const XPH = u(201)
    const XT = u(202)
    const XS = u(203)
    const XT2 = u(204)
    const base = (): BackupData => ({
      projects: [project({ id: X, name: 'Imported', sortOrder: 'b0' })],
      phases: [phase({ id: XPH, projectId: X })],
      tasks: [
        task({ id: XT, projectId: X, phaseId: XPH, status: 'done', completedAt: T0 }),
        task({ id: XS, projectId: X, parentTaskId: XT }),
        task({ id: XT2, projectId: X, sortOrder: 'a1' }),
      ],
      milestones: [milestone({ id: u(205), projectId: X, phaseId: XPH })],
      dependencies: [dependency({ id: u(206), projectId: X, predecessorId: XT, successorId: XT2 })],
    })
    const variant = (name: string, change: (data: BackupData) => void) =>
      p.step(`import: ${name}`, (r) => {
        const data = base()
        change(data)
        return r.importWorkspace(data)
      })
    await variant('a task in an existing project', (d) => {
      d.tasks.push(task({ id: u(210), projectId: ID.P1 }))
    })
    await variant('a phase from outside', (d) => {
      d.tasks[2].phaseId = ID.PH1
    })
    await variant('a dependency on an outside task', (d) => {
      d.dependencies[0].successorId = ID.T1
    })
    await variant('a duplicate id', (d) => {
      d.tasks[2].id = XT
    })
    await variant('an id that exists already', (d) => {
      d.tasks[2].id = ID.T1
    })
    await variant('a missing id', (d) => {
      d.milestones[0].id = ''
    })
    await variant('a subtask of a subtask', (d) => {
      d.tasks.push(task({ id: u(211), projectId: X, parentTaskId: XS }))
    })
    await variant('a dependency cycle', (d) => {
      d.dependencies.push(
        dependency({ id: u(212), projectId: X, predecessorId: XT2, successorId: XT }),
      )
    })
    await variant('a dependency between parent and subtask', (d) => {
      d.dependencies[0].successorId = XS
    })
    await variant('a phase of the other imported project', (d) => {
      d.projects.push(project({ id: u(213), sortOrder: 'b1' }))
      d.phases.push(phase({ id: u(214), projectId: u(213) }))
      d.tasks[2].phaseId = u(214)
    })
    await variant('an invalid row', (d) => {
      d.tasks[2].title = '   '
    })
    await variant('everything valid', () => {})
    await p.expectSameEverywhere()
  })
})
