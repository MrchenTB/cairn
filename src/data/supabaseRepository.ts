/**
 * Repository over Supabase (PostgREST + RLS). Table CRUD for single rows, RPCs for the
 * multi-row atomic operations (docs/architecture.md §4.3). Integrity rules live in the
 * database (constraints + triggers); this class only maps rows and errors.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
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
import {
  NETWORK_ERROR_MESSAGE,
  RepositoryError,
  isFetchFailure,
  readableServerMessage,
} from './errors'
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
  snapshotFromRows,
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

/** Rows per request. PostgREST caps responses at `max_rows` (1000 by default). */
export const PAGE_SIZE = 1000

export type TableName =
  'projects' | 'phases' | 'tasks' | 'milestones' | 'task_dependencies' | 'user_preferences'

const NOT_FOUND_MESSAGES: Record<TableName, string> = {
  projects: 'This project no longer exists. Refresh and try again.',
  phases: 'This phase no longer exists. Refresh and try again.',
  tasks: 'This task no longer exists. Refresh and try again.',
  milestones: 'This milestone no longer exists. Refresh and try again.',
  task_dependencies: 'This dependency no longer exists. Refresh and try again.',
  user_preferences: 'Your preferences could not be found. Refresh and try again.',
}

/** Shape of PostgREST / Postgres errors as returned by supabase-js. */
interface PostgrestErrorLike {
  message?: unknown
  details?: unknown
  hint?: unknown
  code?: unknown
}

interface QueryResult {
  data: unknown
  error: PostgrestErrorLike | null
  count?: number | null
  status?: number
}

/** Readable text for constraint violations (matched against message + details). */
const CONSTRAINT_MESSAGES: readonly (readonly [RegExp, string])[] = [
  [/_due_after_start\b/, "Due date can't be before the start date."],
  [/tasks_title_length/, 'Task title must be 1–500 characters.'],
  [/projects_name_length/, 'Project name must be 1–200 characters.'],
  [/phases_name_length/, 'Phase name must be 1–200 characters.'],
  [/milestones_name_length/, 'Milestone name must be 1–200 characters.'],
  [/_description_length/, 'Description must be at most 10,000 characters.'],
  [/_dates?_range/, 'Dates must be between 0001-01-01 and 9999-12-31.'],
  [/_sort_order_not_empty/, 'The item could not be placed. Refresh and try again.'],
  [/task_dependencies_pair_key/, 'This dependency already exists.'],
  [/task_dependencies_not_self/, "A task can't depend on itself."],
  [/tasks_parent_not_self/, "A task can't be its own subtask."],
  [/user_preferences_timezone_length/, 'The time zone is not valid.'],
  [/_pkey\b/, 'This item already exists.'],
  [/_fk\b/, 'A related item no longer exists. Refresh and try again.'],
]

const FALLBACK_MESSAGES: Record<string, string> = {
  '23514': "That change isn't allowed.",
  '23503': 'A related item no longer exists. Refresh and try again.',
  '23502': 'A required value is missing.',
  '22P02': 'Some values are not in a valid format.',
  '22007': 'Dates must use the YYYY-MM-DD format.',
  '22008': 'A date is out of range.',
  '22023': 'The request was not valid. Refresh and try again.',
  // Text Postgres cannot store (NUL, invalid UTF-8): sending it again fails the same way.
  '22P05': 'Some text contains an unsupported character.',
  '22021': 'Some text contains an unsupported character.',
  P0001: "That change isn't allowed.",
}

/** HTTP 413: the request body is over the server's limit (e.g. a very large import). */
const TOO_LARGE_MESSAGE = 'This is too much data to save at once.'

const VALIDATION_CODES = new Set(Object.keys(FALLBACK_MESSAGES))

/** The project's database lacks Cairn's schema (migration not applied, or an older one). */
const MISSING_SCHEMA_CODES = new Set([
  'PGRST202',
  'PGRST204',
  'PGRST205',
  '42P01',
  '42703',
  '42883',
])
export const MISSING_SCHEMA_MESSAGE =
  "The database isn't set up for Cairn yet. Apply the Supabase migration (see the README), then reload."

/** Transient server conditions: sending the same request again usually works. */
const TRANSIENT_MESSAGES: Record<string, string> = {
  '40P01': 'The server was busy. Try again.',
  '40001': 'The server was busy. Try again.',
  '55P03': 'The server was busy. Try again.',
  '57014': 'The server took too long to answer. Try again.',
}

const GENERIC_SERVER_MESSAGE = "The server couldn't complete the request. Try again."

function constraintMessage(error: PostgrestErrorLike): string | null {
  const text = `${typeof error.message === 'string' ? error.message : ''} ${
    typeof error.details === 'string' ? error.details : ''
  }`
  for (const [pattern, message] of CONSTRAINT_MESSAGES) if (pattern.test(text)) return message
  return null
}

/**
 * Maps whatever supabase-js returned or threw to a RepositoryError:
 * fetch failures → network · 23505 → conflict · check/FK/not-null/format/raise/unstorable text
 * and HTTP 413 → validation (server text when readable) · P0002/PGRST116 → not_found ·
 * 42501 → permission · PGRST30x/JWT → auth · missing schema, deadlock/serialization/timeout and
 * anything else → unknown (retryable), with a message saying which.
 */
export function toRepositoryError(error: unknown, status?: number): RepositoryError {
  if (error instanceof RepositoryError) return error
  if (isFetchFailure(error)) return new RepositoryError('network', NETWORK_ERROR_MESSAGE, error)
  if (typeof error !== 'object' || error === null) {
    return new RepositoryError('unknown', GENERIC_SERVER_MESSAGE, error)
  }
  const e = error as PostgrestErrorLike
  const code = typeof e.code === 'string' ? e.code : ''
  const message = typeof e.message === 'string' ? e.message : ''

  // supabase-js reports client-side fetch failures as { code: '', message: 'TypeError: …' }.
  if (
    code === '' &&
    (status === 0 || /^(TypeError|AbortError|TimeoutError|FetchError)\b/.test(message))
  ) {
    return new RepositoryError('network', NETWORK_ERROR_MESSAGE, error)
  }
  if (code === '23505') {
    return new RepositoryError(
      'conflict',
      constraintMessage(e) ?? readableServerMessage(message) ?? 'This item already exists.',
      error,
    )
  }
  if (VALIDATION_CODES.has(code)) {
    return new RepositoryError(
      'validation',
      constraintMessage(e) ?? readableServerMessage(message) ?? FALLBACK_MESSAGES[code],
      error,
    )
  }
  if (code === 'P0002' || code === 'PGRST116') {
    return new RepositoryError(
      'not_found',
      code === 'P0002'
        ? (readableServerMessage(message) ?? 'This item no longer exists. Refresh and try again.')
        : 'This item no longer exists. Refresh and try again.',
      error,
    )
  }
  if (/^PGRST30\d$/.test(code) || /\bjwt\b/i.test(message) || status === 401) {
    return new RepositoryError('auth', 'Your session has expired. Sign in again.', error)
  }
  if (status === 413) return new RepositoryError('validation', TOO_LARGE_MESSAGE, error)
  if (code === '42501' || status === 403) {
    return new RepositoryError(
      'permission',
      readableServerMessage(message) ?? "You don't have permission to do that.",
      error,
    )
  }
  if (MISSING_SCHEMA_CODES.has(code)) {
    return new RepositoryError('unknown', MISSING_SCHEMA_MESSAGE, error)
  }
  if (Object.hasOwn(TRANSIENT_MESSAGES, code)) {
    return new RepositoryError('unknown', TRANSIENT_MESSAGES[code], error)
  }
  return new RepositoryError('unknown', GENERIC_SERVER_MESSAGE, error)
}

/** Awaits a supabase-js builder, turning thrown errors into RepositoryErrors too. */
async function execute(query: PromiseLike<unknown>): Promise<QueryResult> {
  try {
    return (await query) as QueryResult
  } catch (error) {
    throw toRepositoryError(error)
  }
}

function check(result: QueryResult): unknown {
  if (result.error) throw toRepositoryError(result.error, result.status)
  return result.data
}

function count(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export class SupabaseRepository implements Repository {
  readonly mode = 'supabase' as const
  private readonly client: SupabaseClient

  constructor(client: SupabaseClient) {
    this.client = client
  }

  async loadWorkspace(): Promise<WorkspaceSnapshot> {
    const [projects, phases, tasks, milestones, dependencies, preferences] = await Promise.all([
      this.selectAll<ProjectRow>('projects'),
      this.selectAll<PhaseRow>('phases'),
      this.selectAll<TaskRow>('tasks'),
      this.selectAll<MilestoneRow>('milestones'),
      this.selectAll<DependencyRow>('task_dependencies'),
      this.selectAll<PreferencesRow>('user_preferences', 'user_id'),
    ])
    return snapshotFromRows({
      projects,
      phases,
      tasks,
      milestones,
      dependencies,
      preferences: preferences[0] ?? null,
    })
  }

  async insertProject(project: Project): Promise<Project> {
    const row = await this.insertRow<ProjectRow>('projects', projectToInsert(project))
    return projectFromRow(row)
  }
  async updateProject(id: string, patch: ProjectPatch): Promise<Project> {
    return projectFromRow(
      await this.updateRow<ProjectRow>('projects', id, projectPatchToRow(patch)),
    )
  }
  async deleteProject(id: string): Promise<void> {
    await this.deleteRow('projects', id)
  }

  async insertPhase(phase: Phase): Promise<Phase> {
    return phaseFromRow(await this.insertRow<PhaseRow>('phases', phaseToInsert(phase)))
  }
  async updatePhase(id: string, patch: PhasePatch): Promise<Phase> {
    return phaseFromRow(await this.updateRow<PhaseRow>('phases', id, phasePatchToRow(patch)))
  }
  async deletePhase(id: string): Promise<void> {
    await this.deleteRow('phases', id)
  }

  async insertTask(task: Task): Promise<Task> {
    return taskFromRow(await this.insertRow<TaskRow>('tasks', taskToInsert(task)))
  }
  async updateTask(id: string, patch: TaskPatch): Promise<Task> {
    return taskFromRow(await this.updateRow<TaskRow>('tasks', id, taskPatchToRow(patch)))
  }
  async deleteTask(
    id: string,
    options: { keepSubtasks: boolean; promotedSortOrders?: Record<string, string> },
  ): Promise<void> {
    const promoted = options.keepSubtasks
      ? Object.entries(options.promotedSortOrders ?? {}).map(([taskId, sortOrder]) => ({
          id: taskId,
          sort_order: sortOrder,
        }))
      : []
    await this.callRpc('delete_task', {
      p_task_id: id,
      p_keep_subtasks: options.keepSubtasks,
      p_promoted: promoted,
    })
  }

  async insertMilestone(milestone: Milestone): Promise<Milestone> {
    const row = await this.insertRow<MilestoneRow>('milestones', milestoneToInsert(milestone))
    return milestoneFromRow(row)
  }
  async updateMilestone(id: string, patch: MilestonePatch): Promise<Milestone> {
    const row = await this.updateRow<MilestoneRow>('milestones', id, milestonePatchToRow(patch))
    return milestoneFromRow(row)
  }
  async deleteMilestone(id: string): Promise<void> {
    await this.deleteRow('milestones', id)
  }

  async insertDependency(dependency: Dependency): Promise<Dependency> {
    const row = await this.insertRow<DependencyRow>(
      'task_dependencies',
      dependencyToInsert(dependency),
    )
    return dependencyFromRow(row)
  }
  async deleteDependency(id: string): Promise<void> {
    await this.deleteRow('task_dependencies', id)
  }

  /**
   * All-or-nothing on the server (it raises, changing nothing, unless every task was updated).
   * The returned rows are matched by id, never by position: PostgREST's `max_rows` (1000) cuts
   * long answers, so a task can be missing from them although it was updated.
   */
  async applySchedule(changes: readonly ScheduleChange[]): Promise<Task[]> {
    if (changes.length === 0) return []
    const rows = await this.callRpc('apply_task_schedule', {
      p_changes: changes.map((change) => ({
        id: change.taskId,
        start_date: change.startDate,
        due_date: change.dueDate,
      })),
    })
    if (!Array.isArray(rows)) return []
    const requested = new Set(changes.map((change) => change.taskId))
    const byId = new Map<string, Task>()
    for (const row of rows as unknown[]) {
      if (typeof row !== 'object' || row === null) continue
      const task = taskFromRow(row as TaskRow)
      if (requested.has(task.id)) byId.set(task.id, task)
    }
    return [...byId.values()]
  }

  /**
   * One row per user (user_id defaults to auth.uid()). `fields`: an UPDATE of just those columns
   * of the caller's row (other devices' newer values of the rest stay); when there is no row yet,
   * it is created from the whole value. `onlyIfMissing`: ON CONFLICT DO NOTHING, then the existing
   * row is read back. Otherwise: an upsert of every column.
   */
  async upsertPreferences(
    preferences: Preferences,
    options: UpsertPreferencesOptions = {},
  ): Promise<Preferences> {
    if (options.onlyIfMissing) {
      const inserted = await this.insertPreferencesIfMissing(preferences)
      if (inserted) return inserted
      const existing = this.firstPreferences(
        check(await execute(this.client.from('user_preferences').select('*').limit(1))),
      )
      if (existing) return existing
      // Removed in between: store this value after all.
    }
    if (options.fields && options.fields.length > 0) {
      const changes = preferencesFieldsToRow(preferences, options.fields)
      const updated = await this.updatePreferences(changes)
      if (updated) return updated
      // No row yet: create it from the whole value. If another device created it in between,
      // change just these columns on that row after all.
      const inserted = await this.insertPreferencesIfMissing(preferences)
      if (inserted) return inserted
      const raced = await this.updatePreferences(changes)
      if (raced) return raced
      throw new RepositoryError('not_found', NOT_FOUND_MESSAGES.user_preferences)
    }
    const result = await execute(
      this.client
        .from('user_preferences')
        .upsert(preferencesToRow(preferences), { onConflict: 'user_id' })
        .select()
        .single(),
    )
    return preferencesFromRow(check(result) as PreferencesRow)
  }

  private firstPreferences(rows: unknown): Preferences | null {
    return Array.isArray(rows) && rows.length > 0
      ? preferencesFromRow(rows[0] as PreferencesRow)
      : null
  }

  /** INSERT … ON CONFLICT (user_id) DO NOTHING: the stored row, or null when one existed. */
  private async insertPreferencesIfMissing(preferences: Preferences): Promise<Preferences | null> {
    const query = this.client
      .from('user_preferences')
      .upsert(preferencesToRow(preferences), { onConflict: 'user_id', ignoreDuplicates: true })
      .select()
    return this.firstPreferences(check(await execute(query)))
  }

  /**
   * UPDATE of the caller's row (RLS limits it to that row; the filter is only there because
   * PostgREST may refuse an UPDATE without one). Null when the account has no row.
   */
  private async updatePreferences(changes: object): Promise<Preferences | null> {
    const query = this.client
      .from('user_preferences')
      .update(changes)
      .not('user_id', 'is', null)
      .select()
    return this.firstPreferences(check(await execute(query)))
  }

  async importWorkspace(data: BackupData): Promise<ImportSummary> {
    const counts = (await this.callRpc('import_workspace', {
      p_data: importPayloadFromBackup(data),
    })) as Record<string, unknown> | null
    return {
      projects: count(counts?.projects),
      phases: count(counts?.phases),
      tasks: count(counts?.tasks),
      milestones: count(counts?.milestones),
      dependencies: count(counts?.dependencies),
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Every row of a table (RLS limits it to the signed-in user), in pages of `.range()` ordered by
   * `orderBy`. Each page starts after the last key of the previous one (keyset paging), so rows
   * another device adds or deletes meanwhile never shift a row out of the pages read. The first
   * page asks for the exact count, so a server `max_rows` lower than PAGE_SIZE never truncates
   * silently.
   */
  private async selectAll<Row>(table: TableName, orderBy = 'id'): Promise<Row[]> {
    const rows: Row[] = []
    let total: number | null = null
    let after: unknown = null
    for (;;) {
      const first = rows.length === 0
      let query = this.client.from(table).select('*', first ? { count: 'exact' } : undefined)
      if (!first) query = query.gt(orderBy, after)
      const result = await execute(
        query.order(orderBy, { ascending: true }).range(0, PAGE_SIZE - 1),
      )
      const page = (check(result) ?? []) as Row[]
      if (first && typeof result.count === 'number') total = result.count
      rows.push(...page)
      if (page.length === 0) break
      if (total !== null ? rows.length >= total : page.length < PAGE_SIZE) break
      after = (page[page.length - 1] as Record<string, unknown>)[orderBy]
    }
    return rows
  }

  private async insertRow<Row>(table: TableName, values: object): Promise<Row> {
    const result = await execute(this.client.from(table).insert(values).select().single())
    return check(result) as Row
  }

  /** Updates one row by id; 0 rows affected (missing or not owned) → not_found. */
  private async updateRow<Row>(table: TableName, id: string, values: object): Promise<Row> {
    const query =
      Object.keys(values).length === 0
        ? this.client.from(table).select().eq('id', id).single()
        : this.client.from(table).update(values).eq('id', id).select().single()
    const result = await execute(query)
    if (result.error?.code === 'PGRST116') {
      throw new RepositoryError('not_found', NOT_FOUND_MESSAGES[table], result.error)
    }
    return check(result) as Row
  }

  /** Deletes one row by id; 0 rows affected (missing or not owned) → not_found. */
  private async deleteRow(table: TableName, id: string): Promise<void> {
    const result = await execute(this.client.from(table).delete().eq('id', id).select('id'))
    const deleted = check(result)
    if (!Array.isArray(deleted) || deleted.length === 0) {
      throw new RepositoryError('not_found', NOT_FOUND_MESSAGES[table])
    }
  }

  private async callRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    return check(await execute(this.client.rpc(name, args)))
  }
}
