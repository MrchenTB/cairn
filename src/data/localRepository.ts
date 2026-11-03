/**
 * Repository over this browser's localStorage, used in local data mode (no Supabase keys) and by
 * the E2E tests. It enforces the SAME rules as the database (supabase/migrations, docs/
 * architecture.md §4.2–4.3) so both modes behave identically:
 * - constraints: names/titles, descriptions, enums, date order, sort keys, composite references
 *   (a phase/parent/dependency must belong to the same project), unique ids and dependency pairs;
 * - triggers: completed_at, one-level hierarchy, subtask phase = parent phase (and subtasks follow
 *   their parent), immutable id/project, dependency rules (no self/parent edges, no cycles);
 * - cascades: project → everything, phase → ungroup, task → subtasks + dependencies;
 * - RPC equivalents (delete_task, apply_task_schedule, import_workspace) are all-or-nothing.
 *
 * Every call reads the stored JSON, applies the change to that fresh copy and writes it back only
 * when the whole operation succeeded, so a rejected write never leaves partial data. Inputs and
 * outputs are copies: callers can never mutate stored rows. Deliberate difference: ids are not
 * required to be UUIDs.
 */
import { isISODate } from '@/domain/dates'
import { validateDateRange, validateDescription, validateName } from '@/domain/validation'
import { validateNewDependency } from '@/domain/scheduling'
import {
  DEPENDENCY_TYPES,
  NAME_MAX_LENGTH,
  PROJECT_COLORS,
  PROJECT_STATUSES,
  SCHEDULE_MODES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  THEME_PREFERENCES,
  TITLE_MAX_LENGTH,
} from '@/domain/types'
import type {
  AppErrorKind,
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
  Timestamp,
  WorkspaceSnapshot,
} from '@/domain/types'
import type { Repository, UpsertPreferencesOptions } from './contracts'
import { NETWORK_ERROR_MESSAGE, RepositoryError } from './errors'

export const LOCAL_STORAGE_KEY = 'cairn:local:workspace:v1'

/** The subset of the Web Storage API the repository needs. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** In-memory Storage (tests, or browsers where localStorage is unavailable). */
export function createMemoryStorage(initial: Record<string, string> = {}): StorageLike {
  const items = new Map(Object.entries(initial))
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, String(value))
    },
    removeItem: (key) => {
      items.delete(key)
    },
  }
}

const STORAGE_PROBE_KEY = '__cairn_storage_probe__'

/** A "storage is full" error (names and legacy codes differ between browsers). */
function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { name, code } = error as { name?: unknown; code?: unknown }
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014
  )
}

/**
 * `window.localStorage` when the browser lets this site use it, else null (blocked, or some
 * private modes). A FULL storage is still returned: the saved workspace is in it, and saves then
 * fail with a clear error instead of silently going to memory.
 */
export function getBrowserStorage(): StorageLike | null {
  let storage: Storage
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    storage = window.localStorage
    storage.getItem(STORAGE_PROBE_KEY)
  } catch {
    return null
  }
  try {
    storage.setItem(STORAGE_PROBE_KEY, STORAGE_PROBE_KEY)
    storage.removeItem(STORAGE_PROBE_KEY)
  } catch (error) {
    return isQuotaError(error) ? storage : null
  }
  return storage
}

/** What `onUnreadableData` receives when the stored workspace could not be read. */
export interface UnreadableLocalData {
  /** Storage key the unreadable text was moved to, or null when there was no room for it. */
  backupKey: string | null
  /** The unreadable text itself (e.g. to offer it as a download). */
  raw: string
}

export interface LocalRepositoryOptions {
  /** Defaults to `window.localStorage`, falling back to memory. */
  storage?: StorageLike
  storageKey?: string
  /** Artificial latency per call in ms (default 0). */
  latencyMs?: number
  /** Clock for server-side timestamps. */
  now?: () => Timestamp
  /**
   * Called (once per unreadable value) when the stored workspace could not be read. The data is
   * set aside and a new, empty workspace starts, so the app keeps working; the app tells the user.
   */
  onUnreadableData?: (info: UnreadableLocalData) => void
}

interface LocalDb {
  version: 1
  projects: Record<string, Project>
  phases: Record<string, Phase>
  tasks: Record<string, Task>
  milestones: Record<string, Milestone>
  dependencies: Record<string, Dependency>
  preferences: Preferences | null
}

function emptyDb(): LocalDb {
  return {
    version: 1,
    projects: {},
    phases: {},
    tasks: {},
    milestones: {},
    dependencies: {},
    preferences: null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type FieldCheck = (value: unknown) => boolean

const isText: FieldCheck = (value) => typeof value === 'string'
const isOptionalText: FieldCheck = (value) => value === null || typeof value === 'string'
const isOptionalDate: FieldCheck = (value) => value === null || isISODate(value)
const isOneOf =
  (allowed: readonly string[]): FieldCheck =>
  (value) =>
    typeof value === 'string' && allowed.includes(value)

/**
 * The fields every stored row must have, with the types the views rely on. A row that does not
 * fit (hand-edited storage, another tool, a newer app version) would crash rendering, so the whole
 * stored value is treated as unreadable instead.
 */
const ROW_SHAPES = {
  projects: {
    id: isText,
    name: isText,
    description: isOptionalText,
    status: isOneOf(PROJECT_STATUSES),
    color: isOneOf(PROJECT_COLORS),
    startDate: isOptionalDate,
    dueDate: isOptionalDate,
    scheduleMode: isOneOf(SCHEDULE_MODES),
    sortOrder: isText,
    createdAt: isText,
    updatedAt: isText,
  },
  phases: {
    id: isText,
    projectId: isText,
    name: isText,
    sortOrder: isText,
    createdAt: isText,
    updatedAt: isText,
  },
  tasks: {
    id: isText,
    projectId: isText,
    phaseId: isOptionalText,
    parentTaskId: isOptionalText,
    title: isText,
    description: isOptionalText,
    status: isOneOf(TASK_STATUSES),
    priority: isOneOf(TASK_PRIORITIES),
    startDate: isOptionalDate,
    dueDate: isOptionalDate,
    sortOrder: isText,
    completedAt: isOptionalText,
    createdAt: isText,
    updatedAt: isText,
  },
  milestones: {
    id: isText,
    projectId: isText,
    phaseId: isOptionalText,
    name: isText,
    date: isISODate,
    createdAt: isText,
    updatedAt: isText,
  },
  dependencies: {
    id: isText,
    projectId: isText,
    predecessorId: isText,
    successorId: isText,
    type: isOneOf(DEPENDENCY_TYPES),
    createdAt: isText,
  },
} as const satisfies Record<Exclude<keyof LocalDb, 'version' | 'preferences'>, object>

function isTableOf(table: unknown, shape: Readonly<Record<string, FieldCheck>>): boolean {
  if (!isRecord(table)) return false
  for (const [key, row] of Object.entries(table)) {
    if (!isRecord(row) || row.id !== key) return false
    for (const field in shape) if (!shape[field](row[field])) return false
  }
  return true
}

/** Stored preferences, or null when missing or unreadable (the app then uses its defaults). */
function readPreferences(value: unknown): Preferences | null {
  if (!isRecord(value)) return null
  const { theme, sidebarCollapsed, timezone, weekStartsOn } = value
  const knownTheme = THEME_PREFERENCES.find((option) => option === theme)
  if (
    !knownTheme ||
    typeof sidebarCollapsed !== 'boolean' ||
    typeof timezone !== 'string' ||
    timezone === '' ||
    (weekStartsOn !== 0 && weekStartsOn !== 1)
  ) {
    return null
  }
  return { theme: knownTheme, sidebarCollapsed, timezone, weekStartsOn }
}

/** The stored workspace, or null when it is not one this version can read safely. */
function parseDb(raw: string): LocalDb | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.version !== 1) return null
  for (const [table, shape] of Object.entries(ROW_SHAPES)) {
    if (!isTableOf(parsed[table], shape)) return null
  }
  return { ...(parsed as unknown as LocalDb), preferences: readPreferences(parsed.preferences) }
}

// ---------------------------------------------------------------------------
// Rule helpers (messages mirror the database's)
// ---------------------------------------------------------------------------

function fail(kind: AppErrorKind, message: string): never {
  throw new RepositoryError(kind, message)
}
function invalid(message: string): never {
  throw new RepositoryError('validation', message)
}

function characterCount(value: string): number {
  let n = 0
  for (const _ of value) n++
  return n
}

function checkName(value: unknown, max: number, label: string): void {
  if (typeof value !== 'string') invalid(`${label} is required.`)
  const error = validateName(value, max, label)
  if (error) invalid(error.message)
  if (characterCount(value) > max) {
    invalid(`${label} must be at most ${max.toLocaleString('en-US')} characters.`)
  }
}

function checkDescription(value: unknown): void {
  if (value !== null && typeof value !== 'string') invalid('Description must be text.')
  const error = validateDescription(value)
  if (error) invalid(error.message)
}

function checkEnum(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) invalid(`Invalid ${label}.`)
}

function checkDates(start: unknown, due: unknown): void {
  if (start !== null && typeof start !== 'string') invalid('Start date is not a valid date.')
  if (due !== null && typeof due !== 'string') invalid('Due date is not a valid date.')
  const error = validateDateRange(start, due)
  if (error) invalid(error.message)
}

function checkSortOrder(value: unknown): void {
  if (typeof value !== 'string' || value === '') {
    invalid('The item could not be placed. Refresh and try again.')
  }
}

function checkId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value === '') invalid('A valid id is required.')
}

function assertNewId(table: Record<string, unknown>, id: unknown): asserts id is string {
  checkId(id)
  if (Object.hasOwn(table, id)) fail('conflict', 'This item already exists.')
}

function get<T>(table: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(table, id) ? table[id] : undefined
}

/** Emulates tg_immutable_columns: callers bypassing the types cannot move or re-key rows. */
function rejectImmutable(patch: object, current: object, fields: readonly string[]): void {
  for (const field of fields) {
    if (!Object.hasOwn(patch, field)) continue
    const value = (patch as Record<string, unknown>)[field]
    if (value === undefined || value === (current as Record<string, unknown>)[field]) continue
    invalid(
      field === 'projectId'
        ? 'Moving items to another project is not supported.'
        : `The ${field} of a row cannot be changed.`,
    )
  }
}

/** Copies the defined values of `keys` from `patch` onto `target`. */
function assignDefined<T extends object>(target: T, patch: Partial<T>, keys: readonly (keyof T)[]) {
  for (const key of keys) {
    const value = patch[key]
    if (value !== undefined) target[key] = value as T[keyof T]
  }
}

const PROJECT_PATCH_KEYS = [
  'name',
  'description',
  'status',
  'color',
  'startDate',
  'dueDate',
  'scheduleMode',
  'sortOrder',
] as const satisfies readonly (keyof ProjectPatch)[]
const PHASE_PATCH_KEYS = ['name', 'sortOrder'] as const satisfies readonly (keyof PhasePatch)[]
const TASK_PATCH_KEYS = [
  'title',
  'description',
  'status',
  'priority',
  'startDate',
  'dueDate',
  'phaseId',
  'parentTaskId',
  'sortOrder',
] as const satisfies readonly (keyof TaskPatch)[]
const MILESTONE_PATCH_KEYS = [
  'name',
  'date',
  'phaseId',
] as const satisfies readonly (keyof MilestonePatch)[]

function checkProject(row: Project): void {
  checkName(row.name, NAME_MAX_LENGTH, 'Project name')
  checkDescription(row.description)
  checkEnum(row.status, PROJECT_STATUSES, 'project status')
  checkEnum(row.color, PROJECT_COLORS, 'project color')
  checkEnum(row.scheduleMode, SCHEDULE_MODES, 'schedule mode')
  checkDates(row.startDate, row.dueDate)
  checkSortOrder(row.sortOrder)
}

function checkTask(row: Task): void {
  checkName(row.title, TITLE_MAX_LENGTH, 'Task title')
  checkDescription(row.description)
  checkEnum(row.status, TASK_STATUSES, 'task status')
  checkEnum(row.priority, TASK_PRIORITIES, 'task priority')
  checkDates(row.startDate, row.dueDate)
  checkSortOrder(row.sortOrder)
}

/** Composite FK (phase_id, project_id) → phases(id, project_id). */
function checkPhaseRef(db: LocalDb, projectId: string, phaseId: string | null): void {
  if (phaseId === null) return
  if (typeof phaseId !== 'string' || get(db.phases, phaseId)?.projectId !== projectId) {
    invalid('That phase no longer exists in this project. Refresh and try again.')
  }
}

function checkProjectRef(db: LocalDb, projectId: unknown): void {
  if (typeof projectId !== 'string' || !get(db.projects, projectId)) {
    invalid('That project no longer exists. Refresh and try again.')
  }
}

/** tg_tasks_hierarchy: the parent exists, is in the same project and is top-level. */
function checkParent(db: LocalDb, task: Task, parentId: string): Task {
  if (parentId === task.id) invalid('A task cannot be its own parent.')
  const parent = get(db.tasks, parentId)
  if (!parent) invalid('Parent task not found.')
  if (parent.projectId !== task.projectId) {
    invalid('A subtask must be in the same project as its parent.')
  }
  if (parent.parentTaskId !== null) invalid('Subtasks can only be one level deep.')
  return parent
}

function removeWhere<T>(table: Record<string, T>, predicate: (row: T) => boolean): void {
  for (const [id, row] of Object.entries(table)) if (predicate(row)) delete table[id]
}

/** Deletes tasks and every dependency touching them (FK cascades). */
function removeTasks(db: LocalDb, ids: ReadonlySet<string>): void {
  for (const id of ids) delete db.tasks[id]
  removeWhere(db.dependencies, (d) => ids.has(d.predecessorId) || ids.has(d.successorId))
}

// ---------------------------------------------------------------------------
// Row inserts shared by single inserts and import_workspace
// ---------------------------------------------------------------------------

function insertProjectRow(db: LocalDb, input: Project, now: Timestamp): Project {
  assertNewId(db.projects, input.id)
  const row: Project = {
    id: input.id,
    name: input.name,
    description: input.description ?? null,
    status: input.status ?? 'active',
    color: input.color ?? 'gray',
    startDate: input.startDate ?? null,
    dueDate: input.dueDate ?? null,
    scheduleMode: input.scheduleMode ?? 'manual',
    sortOrder: input.sortOrder,
    createdAt: now,
    updatedAt: now,
  }
  checkProject(row)
  db.projects[row.id] = row
  return row
}

function insertPhaseRow(db: LocalDb, input: Phase, now: Timestamp): Phase {
  assertNewId(db.phases, input.id)
  checkProjectRef(db, input.projectId)
  const row: Phase = {
    id: input.id,
    projectId: input.projectId,
    name: input.name,
    sortOrder: input.sortOrder,
    createdAt: now,
    updatedAt: now,
  }
  checkName(row.name, NAME_MAX_LENGTH, 'Phase name')
  checkSortOrder(row.sortOrder)
  db.phases[row.id] = row
  return row
}

/**
 * `keepCompletedAt`: import_workspace keeps a done task's completion time; a normal insert
 * never sends completed_at, so the trigger stamps "now".
 */
function insertTaskRow(db: LocalDb, input: Task, now: Timestamp, keepCompletedAt: boolean): Task {
  assertNewId(db.tasks, input.id)
  checkProjectRef(db, input.projectId)
  const row: Task = {
    id: input.id,
    projectId: input.projectId,
    phaseId: input.phaseId ?? null,
    parentTaskId: input.parentTaskId ?? null,
    title: input.title,
    description: input.description ?? null,
    status: input.status ?? 'todo',
    priority: input.priority ?? 'none',
    startDate: input.startDate ?? null,
    dueDate: input.dueDate ?? null,
    sortOrder: input.sortOrder,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  if (row.parentTaskId !== null) row.phaseId = checkParent(db, row, row.parentTaskId).phaseId
  checkPhaseRef(db, row.projectId, row.phaseId)
  checkTask(row)
  if (row.status === 'done') {
    row.completedAt = keepCompletedAt && input.completedAt ? input.completedAt : now
  }
  db.tasks[row.id] = row
  return row
}

function insertMilestoneRow(db: LocalDb, input: Milestone, now: Timestamp): Milestone {
  assertNewId(db.milestones, input.id)
  checkProjectRef(db, input.projectId)
  const row: Milestone = {
    id: input.id,
    projectId: input.projectId,
    phaseId: input.phaseId ?? null,
    name: input.name,
    date: input.date,
    createdAt: now,
    updatedAt: now,
  }
  checkMilestone(db, row)
  db.milestones[row.id] = row
  return row
}

function checkMilestone(db: LocalDb, row: Milestone): void {
  checkName(row.name, NAME_MAX_LENGTH, 'Milestone name')
  if (!isISODate(row.date)) invalid('Milestone date is not a valid date.')
  checkPhaseRef(db, row.projectId, row.phaseId)
}

/** tg_task_dependencies_rules + constraints (same project, no self/parent edge, unique, acyclic). */
function insertDependencyRow(db: LocalDb, input: Dependency, now: Timestamp): Dependency {
  assertNewId(db.dependencies, input.id)
  if (input.predecessorId === input.successorId) invalid("A task can't depend on itself.")
  checkProjectRef(db, input.projectId)
  const predecessor = get(db.tasks, input.predecessorId)
  const successor = get(db.tasks, input.successorId)
  if (!predecessor) invalid('Predecessor task not found.')
  if (!successor) invalid('Successor task not found.')
  if (predecessor.projectId !== input.projectId || successor.projectId !== input.projectId) {
    invalid('Dependencies can only link tasks in the same project.')
  }
  checkEnum(input.type ?? 'FS', DEPENDENCY_TYPES, 'dependency type')
  const verdict = validateNewDependency(
    db.tasks,
    Object.values(db.dependencies),
    input.predecessorId,
    input.successorId,
  )
  if (!verdict.ok) fail(verdict.reason === 'duplicate' ? 'conflict' : 'validation', verdict.message)
  const row: Dependency = {
    id: input.id,
    projectId: input.projectId,
    predecessorId: input.predecessorId,
    successorId: input.successorId,
    type: input.type ?? 'FS',
    createdAt: now,
  }
  db.dependencies[row.id] = row
  return row
}

function checkPreferences(value: Preferences): Preferences {
  checkEnum(value.theme, THEME_PREFERENCES, 'theme')
  if (typeof value.sidebarCollapsed !== 'boolean') invalid('Invalid sidebar preference.')
  if (
    typeof value.timezone !== 'string' ||
    value.timezone === '' ||
    characterCount(value.timezone) > 100
  ) {
    invalid('The time zone is not valid.')
  }
  if (value.weekStartsOn !== 0 && value.weekStartsOn !== 1) invalid('Invalid first day of week.')
  return {
    theme: value.theme,
    sidebarCollapsed: value.sidebarCollapsed,
    timezone: value.timezone,
    weekStartsOn: value.weekStartsOn,
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class LocalRepository implements Repository {
  readonly mode = 'local' as const
  private readonly storage: StorageLike
  private readonly storageKey: string
  private readonly now: () => Timestamp
  private readonly onUnreadableData: ((info: UnreadableLocalData) => void) | undefined
  private latencyMs: number
  private failuresLeft = 0
  /** The last stored text known to be readable (skips re-validating unchanged data). */
  private trustedRaw: string | null = null
  /** The last unreadable text reported (each one is reported once). */
  private reportedRaw: string | null = null

  constructor(options: LocalRepositoryOptions = {}) {
    this.storage = options.storage ?? getBrowserStorage() ?? createMemoryStorage()
    this.storageKey = options.storageKey ?? LOCAL_STORAGE_KEY
    this.now = options.now ?? (() => new Date().toISOString())
    this.latencyMs = Math.max(0, options.latencyMs ?? 0)
    this.onUnreadableData = options.onUnreadableData
  }

  /** Test hook: the next `n` writes reject with a network error and store nothing. */
  failNextWrites(n: number): void {
    this.failuresLeft = Math.max(0, Math.floor(Number(n) || 0))
  }
  /** Test hook: artificial latency for every call. */
  setLatency(ms: number): void {
    this.latencyMs = Math.max(0, Number(ms) || 0)
  }
  /** Test hook: deletes all local data and clears the test settings. */
  reset(): void {
    this.storage.removeItem(this.storageKey)
    this.failuresLeft = 0
    this.latencyMs = 0
  }

  loadWorkspace(): Promise<WorkspaceSnapshot> {
    return this.read((db) => ({
      projects: Object.values(db.projects),
      phases: Object.values(db.phases),
      tasks: Object.values(db.tasks),
      milestones: Object.values(db.milestones),
      dependencies: Object.values(db.dependencies),
      preferences: db.preferences,
    }))
  }

  insertProject(project: Project): Promise<Project> {
    return this.write((db, now) => insertProjectRow(db, project, now))
  }
  updateProject(id: string, patch: ProjectPatch): Promise<Project> {
    return this.write((db, now) => {
      const current = get(db.projects, id) ?? fail('not_found', 'Project not found.')
      rejectImmutable(patch, current, ['id'])
      const row = { ...current }
      assignDefined(row, patch, PROJECT_PATCH_KEYS)
      checkProject(row)
      row.updatedAt = now
      db.projects[id] = row
      return row
    })
  }
  deleteProject(id: string): Promise<void> {
    return this.write((db) => {
      if (!get(db.projects, id)) fail('not_found', 'Project not found.')
      delete db.projects[id]
      removeWhere(db.phases, (row) => row.projectId === id)
      removeWhere(db.tasks, (row) => row.projectId === id)
      removeWhere(db.milestones, (row) => row.projectId === id)
      removeWhere(db.dependencies, (row) => row.projectId === id)
    })
  }

  insertPhase(phase: Phase): Promise<Phase> {
    return this.write((db, now) => insertPhaseRow(db, phase, now))
  }
  updatePhase(id: string, patch: PhasePatch): Promise<Phase> {
    return this.write((db, now) => {
      const current = get(db.phases, id) ?? fail('not_found', 'Phase not found.')
      rejectImmutable(patch, current, ['id', 'projectId'])
      const row = { ...current }
      assignDefined(row, patch, PHASE_PATCH_KEYS)
      checkName(row.name, NAME_MAX_LENGTH, 'Phase name')
      checkSortOrder(row.sortOrder)
      row.updatedAt = now
      db.phases[id] = row
      return row
    })
  }
  /** ON DELETE SET NULL (phase_id): the phase's tasks and milestones become ungrouped. */
  deletePhase(id: string): Promise<void> {
    return this.write((db, now) => {
      if (!get(db.phases, id)) fail('not_found', 'Phase not found.')
      delete db.phases[id]
      for (const row of [...Object.values(db.tasks), ...Object.values(db.milestones)]) {
        if (row.phaseId === id) {
          row.phaseId = null
          row.updatedAt = now
        }
      }
    })
  }

  insertTask(task: Task): Promise<Task> {
    return this.write((db, now) => insertTaskRow(db, task, now, false))
  }
  updateTask(id: string, patch: TaskPatch): Promise<Task> {
    return this.write((db, now) => {
      const current = get(db.tasks, id) ?? fail('not_found', 'Task not found.')
      rejectImmutable(patch, current, ['id', 'projectId'])
      const row = { ...current }
      assignDefined(row, patch, TASK_PATCH_KEYS)

      if (row.parentTaskId !== current.parentTaskId && row.parentTaskId !== null) {
        const parentId = row.parentTaskId
        checkParent(db, row, parentId)
        if (Object.values(db.tasks).some((task) => task.parentTaskId === id)) {
          invalid('A task that has subtasks cannot become a subtask.')
        }
        const linked = Object.values(db.dependencies).some(
          (d) =>
            (d.predecessorId === id && d.successorId === parentId) ||
            (d.predecessorId === parentId && d.successorId === id),
        )
        if (linked) invalid('A task cannot depend on its own parent. Remove that dependency first.')
      }
      // tg_tasks_subtask_phase fires when parent_task_id or phase_id is part of the update.
      if ((patch.parentTaskId !== undefined || patch.phaseId !== undefined) && row.parentTaskId) {
        const parent = get(db.tasks, row.parentTaskId)
        if (parent) row.phaseId = parent.phaseId
      }
      checkPhaseRef(db, row.projectId, row.phaseId)
      checkTask(row)

      // tg_tasks_completed_at
      if (row.status !== 'done') row.completedAt = null
      else if (current.status !== 'done') row.completedAt = now
      else row.completedAt = current.completedAt ?? now
      row.updatedAt = now
      db.tasks[id] = row

      // tg_tasks_phase_to_subtasks
      if (row.parentTaskId === null && row.phaseId !== current.phaseId) {
        for (const subtask of Object.values(db.tasks)) {
          if (subtask.parentTaskId === id && subtask.phaseId !== row.phaseId) {
            subtask.phaseId = row.phaseId
            subtask.updatedAt = now
          }
        }
      }
      return row
    })
  }
  /** delete_task RPC. */
  deleteTask(
    id: string,
    options: { keepSubtasks: boolean; promotedSortOrders?: Record<string, string> },
  ): Promise<void> {
    return this.write((db, now) => {
      if (!get(db.tasks, id)) fail('not_found', 'Task not found.')
      const subtasks = Object.values(db.tasks).filter((task) => task.parentTaskId === id)
      const deleted = new Set([id])
      if (options.keepSubtasks) {
        const promoted = options.promotedSortOrders ?? {}
        const promotedIds = Object.keys(promoted)
        const matches =
          promotedIds.length === subtasks.length &&
          subtasks.every((subtask) => Object.hasOwn(promoted, subtask.id))
        if (!matches) {
          invalid(
            "The subtasks to keep do not match the task's current subtasks. Refresh and try again.",
          )
        }
        for (const subtask of subtasks) {
          const sortOrder = promoted[subtask.id]
          checkSortOrder(sortOrder)
          subtask.parentTaskId = null
          subtask.sortOrder = sortOrder
          subtask.updatedAt = now
        }
      } else {
        for (const subtask of subtasks) deleted.add(subtask.id)
      }
      removeTasks(db, deleted)
    })
  }

  insertMilestone(milestone: Milestone): Promise<Milestone> {
    return this.write((db, now) => insertMilestoneRow(db, milestone, now))
  }
  updateMilestone(id: string, patch: MilestonePatch): Promise<Milestone> {
    return this.write((db, now) => {
      const current = get(db.milestones, id) ?? fail('not_found', 'Milestone not found.')
      rejectImmutable(patch, current, ['id', 'projectId'])
      const row = { ...current }
      assignDefined(row, patch, MILESTONE_PATCH_KEYS)
      checkMilestone(db, row)
      row.updatedAt = now
      db.milestones[id] = row
      return row
    })
  }
  deleteMilestone(id: string): Promise<void> {
    return this.write((db) => {
      if (!get(db.milestones, id)) fail('not_found', 'Milestone not found.')
      delete db.milestones[id]
    })
  }

  insertDependency(dependency: Dependency): Promise<Dependency> {
    return this.write((db, now) => insertDependencyRow(db, dependency, now))
  }
  deleteDependency(id: string): Promise<void> {
    return this.write((db) => {
      if (!get(db.dependencies, id)) fail('not_found', 'Dependency not found.')
      delete db.dependencies[id]
    })
  }

  /** apply_task_schedule RPC: validates every change, then updates all or nothing. */
  applySchedule(changes: readonly ScheduleChange[]): Promise<Task[]> {
    return this.write((db, now) => {
      const seen = new Set<string>()
      for (const change of changes) {
        checkId(change.taskId)
        const formatOk = [change.startDate, change.dueDate].every(
          (date) => date === null || isISODate(date),
        )
        if (!formatOk) invalid('Dates must use the YYYY-MM-DD format.')
        if (
          change.startDate !== null &&
          change.dueDate !== null &&
          change.dueDate < change.startDate
        ) {
          invalid('Due date cannot be before start date.')
        }
        if (seen.has(change.taskId)) {
          invalid('A task appears more than once in the schedule changes.')
        }
        seen.add(change.taskId)
      }
      return changes.map((change) => {
        const task =
          get(db.tasks, change.taskId) ??
          fail('not_found', 'Some tasks could not be found. Refresh and try again.')
        task.startDate = change.startDate
        task.dueDate = change.dueDate
        task.updatedAt = now
        return task
      })
    })
  }

  /** One row; `fields` = update only those on an existing row; `onlyIfMissing` = insert only. */
  upsertPreferences(
    preferences: Preferences,
    options: UpsertPreferencesOptions = {},
  ): Promise<Preferences> {
    return this.write((db) => {
      const current = db.preferences
      if (current && options.onlyIfMissing) return current
      let next = preferences
      if (current && options.fields) {
        next = { ...current }
        for (const field of options.fields) {
          if (Object.hasOwn(preferences, field))
            Object.assign(next, { [field]: preferences[field] })
        }
      }
      db.preferences = checkPreferences(next)
      return db.preferences
    })
  }

  /** import_workspace RPC: a self-contained, id-remapped backup inserted all-or-nothing. */
  importWorkspace(data: BackupData): Promise<ImportSummary> {
    return this.write((db, now) => {
      const projectIds = new Set(data.projects.map((row) => row.id))
      const phaseIds = new Set(data.phases.map((row) => row.id))
      const taskIds = new Set(data.tasks.map((row) => row.id))
      const outside =
        data.phases.some((row) => !projectIds.has(row.projectId)) ||
        data.tasks.some(
          (row) =>
            !projectIds.has(row.projectId) ||
            (row.phaseId !== null && !phaseIds.has(row.phaseId)) ||
            (row.parentTaskId !== null && !taskIds.has(row.parentTaskId)),
        ) ||
        data.milestones.some(
          (row) =>
            !projectIds.has(row.projectId) || (row.phaseId !== null && !phaseIds.has(row.phaseId)),
        ) ||
        data.dependencies.some(
          (row) =>
            !projectIds.has(row.projectId) ||
            !taskIds.has(row.predecessorId) ||
            !taskIds.has(row.successorId),
        )
      if (outside) invalid('Import data references rows that are not part of the import.')

      for (const row of data.projects) insertProjectRow(db, row, now)
      for (const row of data.phases) insertPhaseRow(db, row, now)
      // Parents first: a subtask's parent must exist when it is inserted.
      for (const row of data.tasks) if (row.parentTaskId === null) insertTaskRow(db, row, now, true)
      for (const row of data.tasks) if (row.parentTaskId !== null) insertTaskRow(db, row, now, true)
      for (const row of data.milestones) insertMilestoneRow(db, row, now)
      for (const row of data.dependencies) insertDependencyRow(db, row, now)
      return {
        projects: data.projects.length,
        phases: data.phases.length,
        tasks: data.tasks.length,
        milestones: data.milestones.length,
        dependencies: data.dependencies.length,
      }
    })
  }

  // -------------------------------------------------------------------------

  private async read<T>(query: (db: LocalDb) => T): Promise<T> {
    await this.delay()
    return structuredClone(query(this.load()))
  }

  /** Runs `change` on a fresh copy and stores it only if the whole change succeeded. */
  private async write<T>(change: (db: LocalDb, now: Timestamp) => T): Promise<T> {
    const simulateFailure = this.failuresLeft > 0
    if (simulateFailure) this.failuresLeft -= 1
    await this.delay()
    if (simulateFailure) throw new RepositoryError('network', NETWORK_ERROR_MESSAGE)
    const db = this.load()
    const result = change(db, this.now())
    const serialized = JSON.stringify(db)
    try {
      this.storage.setItem(this.storageKey, serialized)
    } catch (error) {
      throw new RepositoryError(
        'unknown',
        "Couldn't save to this browser's storage (it may be full).",
        error,
      )
    }
    this.trustedRaw = serialized
    return result === undefined ? result : structuredClone(result)
  }

  private load(): LocalDb {
    let raw: string | null
    try {
      raw = this.storage.getItem(this.storageKey)
    } catch (error) {
      throw new RepositoryError(
        'unknown',
        "Couldn't read this browser's storage. Allow site data for this page, then try again.",
        error,
      )
    }
    if (raw === null) return emptyDb()
    if (raw === this.trustedRaw) {
      const db = JSON.parse(raw) as LocalDb
      return { ...db, preferences: readPreferences(db.preferences) }
    }
    const db = parseDb(raw)
    if (db) {
      this.trustedRaw = raw
      return db
    }
    // Unreadable data is set aside (never silently overwritten) and a new workspace starts, so
    // the app keeps working; the user is told and can download the unreadable text.
    const backupKey = this.setAside(raw)
    if (this.reportedRaw !== raw) {
      this.reportedRaw = raw
      console.warn(
        backupKey
          ? `[cairn] Local data was unreadable; it was moved to "${backupKey}" and a new workspace started.`
          : '[cairn] Local data was unreadable and the storage is too full to keep a copy; a new workspace started.',
      )
      this.onUnreadableData?.({ backupKey, raw })
    }
    return emptyDb()
  }

  /**
   * Moves unreadable text to `<key>:unreadable:<time>`. When the storage is too full for a second
   * copy, the original is removed first to make room (and put back if even that fails). Returns
   * the copy's key, or null when the text had to stay where it was (the next save replaces it).
   */
  private setAside(raw: string): string | null {
    const backupKey = `${this.storageKey}:unreadable:${Date.now()}`
    try {
      this.storage.setItem(backupKey, raw)
      this.storage.removeItem(this.storageKey)
      return backupKey
    } catch {
      // probably full: try moving it instead of copying
    }
    try {
      this.storage.removeItem(this.storageKey)
      this.storage.setItem(backupKey, raw)
      return backupKey
    } catch {
      try {
        this.storage.setItem(this.storageKey, raw)
      } catch {
        // nothing more can be done without losing it; it stays reported to the app
      }
      return null
    }
  }

  private delay(): Promise<void> {
    if (this.latencyMs <= 0) return Promise.resolve()
    return new Promise((resolve) => setTimeout(resolve, this.latencyMs))
  }
}

// ---------------------------------------------------------------------------
// window.__cairnTest (local mode, dev/e2e builds only)
// ---------------------------------------------------------------------------

export interface CairnTestHooks {
  /** The next `n` writes fail with a network error and store nothing. */
  failNextWrites(n: number): void
  /** Adds `ms` of latency to every repository call (0 = none). */
  setLatency(ms: number): void
  /** Deletes all local data and test settings, then reloads the workspace. */
  reset(): Promise<void>
}

declare global {
  interface Window {
    __cairnTest?: CairnTestHooks
  }
}

/** Installs `window.__cairnTest` for `repository`. Callers decide whether the build allows it. */
export function installTestHooks(
  repository: LocalRepository,
  options: { onReset?: () => unknown; target?: { __cairnTest?: CairnTestHooks } } = {},
): CairnTestHooks {
  const hooks: CairnTestHooks = {
    failNextWrites: (n) => repository.failNextWrites(n),
    setLatency: (ms) => repository.setLatency(ms),
    reset: async () => {
      repository.reset()
      await options.onReset?.()
    },
  }
  const target = options.target ?? (typeof window === 'undefined' ? undefined : window)
  if (target) target.__cairnTest = hooks
  return hooks
}
