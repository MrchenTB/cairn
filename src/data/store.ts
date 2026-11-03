/**
 * Client stores (zustand). `useWorkspaceStore` holds the normalised workspace; `useAuthStore`
 * holds the session and loads/clears the workspace on sign-in/out.
 *
 * Every write follows the contract in ./contracts.ts:
 *   validate (domain rules; failure → { kind: 'validation' }, no state change, no toast)
 *   → apply optimistically with Immer `produceWithPatches` (field-level patches)
 *   → persist through the Repository
 *   → success: reconcile with the stored rows (only entities that still exist)
 *   → failure: apply THIS change's inverse patches, set sync.lastError/canRetry, toast + Retry,
 *     then fetch the current state once idle (a failure without an answer may still have been
 *     applied: such a change then shows up again and its failure is withdrawn).
 *
 * Writes are sent one at a time in the order they were made (a FIFO queue), so the server
 * applies them in the user's order (create-then-edit never races) while the UI stays instant.
 * Several changes can be pending at once; to keep their rollbacks exact:
 * - rolling back change A skips any path a LATER pending change also wrote (that value is the
 *   newest intent) and hands A's original value to that later change, so if it fails too the
 *   field returns to its last saved value;
 * - reconciling A's stored row skips fields a later pending change wrote, updating that
 *   change's rollback value to the stored one instead;
 * - a full load reads behind the writes already sent (same queue) and re-applies the writes made
 *   meanwhile on top of the snapshot, so it never reverts or loses them.
 *
 * Retry re-sends the retryable failures not followed by a successful write, in the order they
 * were made (an edit of a task whose creation failed goes after the creation). A newer change of
 * the same fields withdraws an older failure's Retry, so a Retry never overwrites newer work.
 */
import {
  applyPatches,
  enablePatches,
  freeze,
  produce,
  produceWithPatches,
  type Draft,
  type Patch,
} from 'immer'
import { create, type StoreApi } from 'zustand'
import { getBrowserTimeZone, isISODate, isValidTimeZone, todayInTimeZone } from '@/domain/dates'
import { canBecomeSubtaskOf } from '@/domain/hierarchy'
import {
  bySortOrder,
  isAtPlacement,
  keyAtEnd,
  keyForPlacement,
  keysBetween,
  sortByOrder,
  type Ordered,
  type Placement,
} from '@/domain/ordering'
import { validateNewDependency } from '@/domain/scheduling'
import {
  BACKUP_FORMAT_VERSION,
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
  AppError,
  BackupData,
  BackupFile,
  Dependency,
  ImportSummary,
  Milestone,
  MilestonePatch,
  MoveTaskInput,
  NewMilestoneInput,
  NewPhaseInput,
  NewProjectInput,
  NewTaskInput,
  Phase,
  PhasePatch,
  Preferences,
  Project,
  ProjectPatch,
  Result,
  ScheduleChange,
  Task,
  TaskPatch,
  ThemePreference,
  WorkspaceData,
  WorkspaceSnapshot,
} from '@/domain/types'
import {
  hasUnstorableCharacters,
  parseBackupFile,
  validateDateRange,
  validateDescription,
  validateName,
} from '@/domain/validation'
import { notify } from '@/lib/notify'
import { createAuthService, LOCAL_USER } from './auth'
import { downloadTextFile } from './backup'
import { getDataMode, isTestHooksEnabled } from './config'
import type {
  AuthChangeEvent,
  AuthService,
  AuthState,
  AuthUser,
  DataMode,
  Repository,
  SyncState,
  WorkspaceActions,
  WorkspaceState,
} from './contracts'
import { DEFAULT_PREFERENCES, EMPTY_WORKSPACE } from './defaults'
import { isRetryable, toAppError } from './errors'
import {
  createMemoryStorage,
  getBrowserStorage,
  installTestHooks,
  LocalRepository,
  type StorageLike,
  type UnreadableLocalData,
} from './localRepository'
import { getSupabaseClient } from './supabaseClient'
import { SupabaseRepository } from './supabaseRepository'

enablePatches()

/** localStorage key of the theme/sidebar cache read synchronously at startup (and by index.html). */
export const UI_PREFS_STORAGE_KEY = 'cairn:ui-prefs'
/** Minimum time between automatic refreshes on window focus / tab visibility. */
export const AUTO_REFRESH_INTERVAL_MS = 30_000
/** Failed writes share one toast id, so the newest failure replaces the previous toast. */
export const SYNC_ERROR_TOAST_ID = 'cairn-sync-error'
/** Toast shown when a reset (sign-out) dropped changes that were still being saved. */
export const UNSAVED_ON_RESET_TOAST_ID = 'cairn-unsaved-on-reset'

/** The toast API the store needs (injectable for tests; `dismiss` is optional). */
export type Notifier = Pick<typeof notify, 'error'> & Partial<Pick<typeof notify, 'dismiss'>>

/** Event sources for cross-device freshness (browser: window, document, navigator). */
export interface WorkspaceEnvironment {
  window: Pick<EventTarget, 'addEventListener'>
  document?: Pick<EventTarget, 'addEventListener'> & { readonly visibilityState?: string }
  navigator?: { readonly onLine?: boolean }
}

export interface WorkspaceStoreOptions {
  mode: DataMode
  /** The repository, or a factory called on first use. */
  repository: Repository | (() => Repository)
  notify?: Notifier
  /** Storage for the UI-preferences cache (default: localStorage; null disables it). */
  storage?: StorageLike | null
  /** Listeners for focus / visibility / online refreshes (default: none). */
  environment?: WorkspaceEnvironment | null
  /** Clock in epoch ms. */
  now?: () => number
  /** Id generator for new entities and imports (default crypto.randomUUID). */
  randomId?: () => string
  /** Aborting it removes the store's event listeners (HMR, tests). */
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// UI preferences cache (theme + sidebar, read before the workspace loads)
// ---------------------------------------------------------------------------

export interface UiPrefsCache {
  theme: ThemePreference
  sidebarCollapsed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads `cairn:ui-prefs` ({ theme, sidebarCollapsed }); unknown or invalid values are ignored. */
export function readUiPrefsCache(storage: StorageLike | null | undefined): Partial<UiPrefsCache> {
  if (!storage) return {}
  try {
    const parsed: unknown = JSON.parse(storage.getItem(UI_PREFS_STORAGE_KEY) ?? 'null')
    if (!isRecord(parsed)) return {}
    const cache: Partial<UiPrefsCache> = {}
    const theme = THEME_PREFERENCES.find((value) => value === parsed.theme)
    if (theme) cache.theme = theme
    if (typeof parsed.sidebarCollapsed === 'boolean')
      cache.sidebarCollapsed = parsed.sidebarCollapsed
    return cache
  } catch {
    return {}
  }
}

function writeUiPrefsCache(storage: StorageLike, preferences: Preferences): void {
  try {
    const cache: UiPrefsCache = {
      theme: preferences.theme,
      sidebarCollapsed: preferences.sidebarCollapsed,
    }
    storage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // storage full or blocked: the cache is only a startup hint
  }
}

// ---------------------------------------------------------------------------
// Patch bookkeeping
// ---------------------------------------------------------------------------

/** Everything optimistic writes touch (one Immer root so preferences roll back the same way). */
interface Doc {
  data: WorkspaceData
  preferences: Preferences
}

type Path = readonly (string | number)[]

/** A write applied to `data` whose server answer is still pending. */
interface PendingWrite {
  /** Forward patches of THIS write (re-applied on top of a snapshot loaded meanwhile). */
  patches: Patch[]
  /** Inverse patches of THIS write; their paths are the paths the write touched. */
  inverse: Patch[]
  /** When the change was made (see RetryHandle.seq). */
  seq: number
}

/**
 * A failed write that Retry can send again. Only valid in the session (epoch) that made it, and
 * only until a newer change of the same fields replaces it: re-sending it then would overwrite
 * that newer change with an older value.
 */
interface RetryHandle {
  run: () => Promise<Result<unknown>>
  epoch: number
  /** When the original change was made (a Retry that fails again keeps its place in line). */
  seq: number
  /** The fields it changes (bookkeeping fields left out), as Immer paths. */
  paths: readonly Path[]
  /** Its forward patches: a later snapshot that already holds them shows it was saved after all. */
  patches: readonly Patch[]
  /** What it failed with (sync.lastError while it is the latest failure). */
  error: AppError
  /** A newer change replaced it. */
  stale: boolean
  /** Already re-sent by a Retry. */
  used: boolean
  /** The re-sent change reached the write pipeline (which reported its outcome). */
  sent: boolean
}

/** Fields every write of an entity sets as a side effect; they never make two changes overlap. */
const BOOKKEEPING_FIELDS: ReadonlySet<string | number> = new Set(['updatedAt', 'completedAt'])

/** The paths of `patches` without bookkeeping fields (['data', table, id, field]). */
function changedPaths(patches: readonly Patch[]): Path[] {
  return patches
    .map((patch) => patch.path)
    .filter((path) => !(path.length === 4 && BOOKKEEPING_FIELDS.has(path[3])))
}

/**
 * True when a change of `newer` replaces some value `older` changed: the same field, or a whole
 * entity containing it. Editing a field of an entity `older` created or deleted does not replace
 * it (that edit depends on it).
 */
function replaces(newer: readonly Path[], older: readonly Path[]): boolean {
  return older.some((path) => newer.some((candidate) => isPrefix(candidate, path)))
}

/** A stored row to merge into the state at `path` (['data', table, id] or ['preferences']). */
interface RowUpdate {
  path: readonly string[]
  row: object
}

/** Row fields the server sets itself: a stored row never matches the optimistic one there. */
const SERVER_STAMPED_FIELDS: ReadonlySet<string> = new Set([
  'createdAt',
  'updatedAt',
  'completedAt',
])

/** Same stored value; whole rows are compared without their server-stamped fields. */
function sameStoredValue(stored: unknown, expected: unknown): boolean {
  if (Object.is(stored, expected)) return true
  if (!isRecord(stored) || !isRecord(expected)) return false
  for (const key of new Set([...Object.keys(stored), ...Object.keys(expected)])) {
    if (!SERVER_STAMPED_FIELDS.has(key) && !Object.is(stored[key], expected[key])) return false
  }
  return true
}

/**
 * True when `doc` (a fresh server snapshot) already holds every change of a write's forward
 * patches: a write that failed without an answer was then applied by the server after all.
 */
function holdsChanges(doc: unknown, patches: readonly Patch[]): boolean {
  const changes = patches.filter(
    (patch) => !(patch.path.length === 4 && BOOKKEEPING_FIELDS.has(patch.path[3])),
  )
  return (
    changes.length > 0 &&
    changes.every((patch) =>
      patch.op === 'remove'
        ? resolvePath(doc, patch.path) === undefined
        : sameStoredValue(resolvePath(doc, patch.path), patch.value),
    )
  )
}

function isPrefix(prefix: Path, path: Path): boolean {
  return prefix.length <= path.length && prefix.every((segment, i) => segment === path[i])
}

function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && isPrefix(a, b)
}

function resolvePath(root: unknown, path: Path): unknown {
  let node = root
  for (const segment of path) {
    if (!isRecord(node) || !Object.hasOwn(node, segment)) return undefined
    node = node[segment as string]
  }
  return node
}

/** Immer's applyPatches throws when a patch's parent is gone (entity deleted meanwhile). */
function canApply(root: unknown, patch: Patch): boolean {
  return isRecord(resolvePath(root, patch.path.slice(0, -1)))
}

/**
 * A later write `later` also touched `earlier.path` (same path, or an ancestor such as the
 * whole entity). Rewrites the later write's inverse patch so that undoing it restores the value
 * `earlier` would have restored.
 */
function inheritInverse(later: Patch, earlier: Patch): Patch {
  if (later.path.length === earlier.path.length) {
    return earlier.op === 'remove'
      ? { op: 'remove', path: later.path }
      : { op: 'replace', path: later.path, value: earlier.value }
  }
  if (later.op === 'remove' || !isRecord(later.value)) return later
  const relative: Patch = { ...earlier, path: earlier.path.slice(later.path.length) }
  if (!canApply(later.value, relative)) return later
  return { ...later, value: applyPatches(later.value, [relative]) }
}

function toWorkspaceData(snapshot: WorkspaceSnapshot): WorkspaceData {
  const byId = <T extends { id: string }>(rows: readonly T[]): Record<string, T> => {
    const table: Record<string, T> = {}
    for (const row of rows) table[row.id] = row
    return table
  }
  return freeze(
    {
      projects: byId(snapshot.projects),
      phases: byId(snapshot.phases),
      tasks: byId(snapshot.tasks),
      milestones: byId(snapshot.milestones),
      dependencies: byId(snapshot.dependencies),
    },
    true,
  )
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const OK: Result = { ok: true, value: undefined }

/** Result of a write that was still waiting when the workspace was reset (sign-out). */
const SIGNED_OUT_ERROR: AppError = {
  kind: 'auth',
  message: 'You were signed out before this change was saved.',
}

function invalid(message: string): { ok: false; error: AppError } {
  return { ok: false, error: { kind: 'validation', message } }
}
function missing(what: string): { ok: false; error: AppError } {
  return { ok: false, error: { kind: 'not_found', message: `This ${what} no longer exists.` } }
}
function failed(error: AppError): { ok: false; error: AppError } {
  return { ok: false, error }
}
function toVoid(result: Result<unknown>): Result {
  return result.ok ? OK : result
}

function enumError(value: unknown, allowed: readonly string[], label: string): AppError | null {
  if (value === undefined || (typeof value === 'string' && allowed.includes(value))) return null
  return { kind: 'validation', message: `Invalid ${label}.` }
}

/** A sort key the database stores: non-empty text without NUL or unpaired surrogates. */
function sortOrderError(value: unknown): AppError | null {
  if (value === undefined) return null
  if (typeof value === 'string' && value !== '' && !hasUnstorableCharacters(value)) return null
  return { kind: 'validation', message: 'Invalid sort order.' }
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Empty / whitespace-only descriptions are stored as null. */
function normalizeDescription(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function own<T>(table: Record<string, T>, id: string | null | undefined): T | undefined {
  return typeof id === 'string' && Object.hasOwn(table, id) ? table[id] : undefined
}

/** The fields of `patch` whose value differs from `current` (undefined = not part of it). */
function changedFields<T extends object>(current: T, patch: Partial<T>): Partial<T> {
  const changes: Partial<T> = {}
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key]
    if (value !== undefined && !Object.is(value, current[key])) changes[key] = value
  }
  return changes
}

function isEmpty(value: object): boolean {
  return Object.keys(value).length === 0
}

// The fields each patch type may change. Callers sometimes pass more (a whole row spread into the
// patch); everything else is ignored so it can never reach the optimistic state or the server.
const PROJECT_PATCH_FIELDS = keysOf<ProjectPatch>({
  name: true,
  description: true,
  status: true,
  color: true,
  startDate: true,
  dueDate: true,
  scheduleMode: true,
  sortOrder: true,
})
const PHASE_PATCH_FIELDS = keysOf<PhasePatch>({ name: true, sortOrder: true })
const TASK_PATCH_FIELDS = keysOf<TaskPatch>({
  title: true,
  description: true,
  status: true,
  priority: true,
  startDate: true,
  dueDate: true,
  phaseId: true,
  parentTaskId: true,
  sortOrder: true,
})
const MILESTONE_PATCH_FIELDS = keysOf<MilestonePatch>({ name: true, date: true, phaseId: true })
const PREFERENCE_FIELDS = keysOf<Preferences>({
  theme: true,
  sidebarCollapsed: true,
  timezone: true,
  weekStartsOn: true,
})

/** The keys of an exhaustive `{ field: true }` map (a new patch field must be listed). */
function keysOf<T extends object>(fields: Record<keyof T, true>): readonly (keyof T)[] {
  return Object.keys(fields) as (keyof T)[]
}

/** Only the patchable fields of `patch`. */
function pickPatch<T extends object>(patch: T, fields: readonly (keyof T)[]): T {
  const picked: Partial<T> = {}
  for (const field of fields) {
    if (Object.hasOwn(patch, field)) picked[field] = patch[field]
  }
  return picked as T
}

/**
 * The database never lets these columns change (tg_immutable_columns): a patch that tries is
 * refused before any optimistic change, like the server would. Equal values are fine (a whole
 * row passed as the patch).
 */
function immutableError(
  patch: object,
  current: object,
  fields: readonly string[],
): AppError | null {
  for (const field of fields) {
    if (!Object.hasOwn(patch, field)) continue
    const value = (patch as Record<string, unknown>)[field]
    if (value === undefined || value === (current as Record<string, unknown>)[field]) continue
    return {
      kind: 'validation',
      message:
        field === 'projectId'
          ? 'Moving items to another project is not supported.'
          : "An item's id can't be changed.",
    }
  }
  return null
}

/** The fields of `patch` that are set (undefined = not part of it). */
function definedFields<T extends object>(patch: Partial<T>): Partial<T> {
  const fields: Partial<T> = {}
  for (const key of Object.keys(patch) as (keyof T)[]) {
    if (patch[key] !== undefined) fields[key] = patch[key]
  }
  return fields
}

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null
  return () => (promise ??= fn())
}

function topLevelSiblings(
  tasks: Record<string, Task>,
  projectId: string,
  excludeId?: string,
): Task[] {
  return Object.values(tasks).filter(
    (task) => task.projectId === projectId && task.parentTaskId === null && task.id !== excludeId,
  )
}

function subtaskSiblings(
  tasks: Record<string, Task>,
  parentId: string,
  excludeId?: string,
): Task[] {
  return Object.values(tasks).filter(
    (task) => task.parentTaskId === parentId && task.id !== excludeId,
  )
}

const tableRow = (table: keyof WorkspaceData, row: { id: string }): RowUpdate => ({
  path: ['data', table, row.id],
  row,
})

// ---------------------------------------------------------------------------
// Workspace store
// ---------------------------------------------------------------------------

interface WriteSpec<T> {
  /** Toast title: `Couldn't ${label}`. */
  label: string
  /** Optimistic change (omit for writes that wait for the server, e.g. import). */
  recipe?: (draft: Draft<Doc>) => void
  /**
   * For a write without a recipe: the changes it makes once stored, as patches (a refresh that
   * already holds them shows that a failure without an answer was applied after all).
   */
  expected?: () => Patch[]
  persist: (repository: Repository) => Promise<T>
  /** Stored rows to merge on success. */
  reconcile?: (value: T) => RowUpdate[]
  afterSuccess?: (value: T) => void
  onFailure?: (error: AppError) => void
  /** Re-runs the action (Retry). */
  retry: () => Promise<Result<unknown>>
  /** Background housekeeping: never toasts and never touches lastError / lastSavedAt. */
  background?: boolean
  /**
   * The server's refusal means the change is already in place, so the optimistic change is kept
   * and the server state fetched instead of rolling back; the action then resolves with
   * `value()`. `not_found` for deletes (deleted on another device, or by an earlier attempt whose
   * answer was lost); `conflict` for creates the server already has (a retried create whose first
   * answer was lost, a dependency another device added).
   */
  alreadyDone?: { kind: 'not_found' | 'conflict'; value: () => T }
}

/** The tables an import fills (BackupData and WorkspaceData share these names). */
const IMPORTED_TABLES = ['projects', 'phases', 'tasks', 'milestones', 'dependencies'] as const

/** Deletes: a row that is already gone is deleted. */
const DELETED: WriteSpec<void>['alreadyDone'] = { kind: 'not_found', value: () => undefined }

/**
 * Creates: when the attempt is a Retry (`retrying`), a duplicate means the first attempt was
 * stored although its answer was lost.
 */
function storedIfDuplicate<T>(retrying: boolean, row: T): WriteSpec<T>['alreadyDone'] {
  return retrying ? { kind: 'conflict', value: () => row } : undefined
}

/** Creates an independent workspace store (the app uses `useWorkspaceStore`; tests make their own). */
export function createWorkspaceStore(options: WorkspaceStoreOptions) {
  const notifier = options.notify ?? notify
  const now = options.now ?? (() => Date.now())
  const randomId = options.randomId ?? (() => crypto.randomUUID())
  const storage = options.storage === undefined ? getBrowserStorage() : options.storage
  const environment = options.environment ?? null
  const signal = options.signal
  const source = options.repository
  let repositoryInstance: Repository | null = typeof source === 'function' ? null : source
  const repository = (): Repository => (repositoryInstance ??= (source as () => Repository)())

  const defaultPreferences = (): Preferences => ({
    ...DEFAULT_PREFERENCES,
    ...readUiPrefsCache(storage),
  })

  // Private mutable state (never rendered).
  let epoch = 0 // bumped by reset(): answers to older requests are ignored
  let loadToken = 0 // the latest load/refresh wins
  let writeSeq = 0 // bumped by every write; a refresh that saw a write start is discarded
  let queue: Promise<unknown> = Promise.resolve()
  const pendingWrites: PendingWrite[] = [] // in send order; the head is in flight
  let confirmedPreferences: Preferences = defaultPreferences()
  /** A snapshot of this session's account has been applied (preferences are known). */
  let workspaceLoaded = false
  /** User writes not yet answered (background housekeeping excluded). */
  let userWritesPending = 0
  /** True once the account has a stored preferences row (later saves send changed fields only). */
  let preferencesStored = false
  /** Preference changes made before the workspace loaded: saved on top of the stored values. */
  let deferredPreferences: Partial<Preferences> = {}
  let deferredWaiters: ((result: Result) => void)[] = []
  /** Retryable failures not followed by a successful write, oldest first: what Retry re-sends. */
  let failedWrites: RetryHandle[] = []
  /** The failure whose error toast (with its Retry button) was posted last. */
  let toastRetry: RetryHandle | null = null
  /** The failure being re-sent right now (its write keeps the original place in line). */
  let retrying: RetryHandle | null = null
  /** Retries run one after another. */
  let retryChain: Promise<unknown> = Promise.resolve()
  /** sync.lastError came from a load/refresh (a later successful load clears it). */
  let lastErrorFromLoad = false
  let lastRefreshAt = 0
  let preferencesSeeded = false
  let resyncWhenIdle = false

  const store = create<WorkspaceState>()((set, get) => {
    const isoNow = () => new Date(now()).toISOString()
    const getDoc = (): Doc => ({ data: get().data, preferences: get().preferences })
    const setDoc = (doc: Doc) => set({ data: doc.data, preferences: doc.preferences })

    function updateSync(patch: Partial<SyncState>): void {
      set((state) => ({ sync: { ...state.sync, ...patch } }))
      if (resyncWhenIdle && get().sync.pending === 0) scheduleResync()
    }

    /** Fetches the current server state once no write is pending (silent refresh). */
    function requestResync(): void {
      resyncWhenIdle = true
      if (get().sync.pending === 0) scheduleResync()
    }

    function scheduleResync(): void {
      resyncWhenIdle = false
      queueMicrotask(() => {
        // A write started meanwhile: try again when it is done.
        if (get().sync.pending > 0) resyncWhenIdle = true
        else void refresh({ silent: true })
      })
    }

    function enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = queue.then(task, task)
      queue = run.catch(() => undefined)
      return run
    }

    /** Removes `write` from the pending list; returns the writes sent after it (or null if gone). */
    function settle(write: PendingWrite | null): PendingWrite[] | null {
      if (!write) return pendingWrites.slice()
      const index = pendingWrites.indexOf(write)
      if (index < 0) return null // no longer tracked (defensive: reset() clears the list)
      pendingWrites.splice(index, 1)
      return pendingWrites.slice(index)
    }

    function rollback(write: PendingWrite, later: readonly PendingWrite[]): void {
      const undo: Patch[] = []
      for (const patch of write.inverse) {
        const heir = later.find((other) => other.inverse.some((q) => isPrefix(q.path, patch.path)))
        if (heir) {
          heir.inverse = heir.inverse.map((q) =>
            isPrefix(q.path, patch.path) ? inheritInverse(q, patch) : q,
          )
        } else {
          undo.push(patch)
        }
      }
      const doc = getDoc()
      const applicable = undo.filter((patch) => canApply(doc, patch))
      if (applicable.length > 0) setDoc(applyPatches(doc, applicable))
    }

    /** Reconcile/afterSuccess must never break the pipeline: on a surprise, fetch the truth. */
    function safely(step: () => void): void {
      try {
        step()
      } catch (error) {
        console.error('[cairn] Unexpected server answer; reloading the workspace.', error)
        requestResync()
      }
    }

    function reconcile(updates: readonly RowUpdate[], later: readonly PendingWrite[]): void {
      if (updates.length === 0) return
      const next = produce(getDoc(), (draft) => {
        for (const { path, row } of updates) {
          const target = resolvePath(draft, path)
          if (!isRecord(target)) continue // the entity was deleted meanwhile
          if (later.some((write) => write.inverse.some((q) => isPrefix(q.path, path)))) continue
          for (const [field, value] of Object.entries(row)) {
            const fieldPath = [...path, field]
            const heir = later.find((write) =>
              write.inverse.some((q) => samePath(q.path, fieldPath)),
            )
            if (heir) {
              heir.inverse = heir.inverse.map((q) =>
                samePath(q.path, fieldPath) ? { op: 'replace', path: q.path, value } : q,
              )
            } else if (!Object.is(target[field], value)) {
              target[field] = value
            }
          }
        }
      })
      setDoc(next)
    }

    /** Whether Retry has failed writes to send (superseded ones are dropped from the list). */
    function hasFailedWrites(): boolean {
      return failedWrites.length > 0
    }

    /**
     * A new change (`paths`, made at `seq`) replaces older failed changes of the same fields:
     * their Retry would now overwrite it with an older value, so it is withdrawn (and the toast
     * offering it goes away — the newer change is what counts now).
     */
    function supersedeFailures(paths: readonly Path[], seq: number): void {
      if (paths.length === 0) return
      const replaced = (handle: RetryHandle) =>
        !handle.stale && !handle.used && handle.seq < seq && replaces(paths, handle.paths)
      let withdrawn = false
      for (const handle of failedWrites) {
        if (replaced(handle)) {
          handle.stale = true
          withdrawn = true
        }
      }
      if (toastRetry && (toastRetry.stale || replaced(toastRetry))) {
        toastRetry.stale = true
        toastRetry = null
        notifier.dismiss?.(SYNC_ERROR_TOAST_ID)
      }
      if (withdrawn) {
        failedWrites = failedWrites.filter((handle) => !handle.stale)
        updateSync({ canRetry: hasFailedWrites() })
      }
    }

    function onWriteFailed<T>(
      spec: WriteSpec<T>,
      error: AppError,
      write: PendingWrite | null,
      later: readonly PendingWrite[],
      seq: number,
    ): void {
      spec.onFailure?.(error)
      if (!spec.background) userWritesPending -= 1
      if (spec.background) {
        updateSync({ pending: get().sync.pending - 1 })
        return
      }
      // Fetch the current state once idle. A refusal of a change that passed our own checks means
      // this device is behind (another device changed the data); a failure without an answer
      // (network, timeout, server error) leaves open whether the server applied the change, and
      // if it did, it must show up rather than look lost (the user would make it a second time).
      // Offline, the 'online' event refreshes instead.
      if (!isRetryable(error) || get().sync.online) requestResync()
      let retry: RetryHandle | null = null
      if (isRetryable(error)) {
        const paths = write ? changedPaths(write.patches) : []
        // A newer change of the same fields is already on its way: that one counts, not this.
        const superseded = later.some(
          (other) => other.seq > seq && replaces(changedPaths(other.patches), paths),
        )
        if (!superseded) {
          retry = {
            run: once(spec.retry),
            epoch,
            seq,
            paths,
            patches: write?.patches ?? spec.expected?.() ?? [],
            error,
            stale: false,
            used: false,
            sent: false,
          }
          failedWrites = [...failedWrites, retry].sort((a, b) => a.seq - b.seq)
        }
      }
      toastRetry = retry
      lastErrorFromLoad = false
      updateSync({
        pending: get().sync.pending - 1,
        lastError: error,
        canRetry: hasFailedWrites(),
      })
      const handle = retry
      notifier.error(`Couldn't ${spec.label}`, {
        id: SYNC_ERROR_TOAST_ID,
        description: error.message,
        action: handle
          ? {
              label: 'Retry',
              // Everything that failed since the last save, or (after an unrelated save) this.
              onClick: () => void runRetry([...failedWrites, handle]),
            }
          : undefined,
      })
    }

    function onWriteSucceeded<T>(spec: WriteSpec<T>, seq: number): void {
      if (!spec.background) userWritesPending -= 1
      if (spec.background) {
        updateSync({ pending: get().sync.pending - 1 })
        return
      }
      // A save ends the failures made before it (contract: lastError is cleared by a success).
      failedWrites = failedWrites.filter((handle) => handle.seq > seq)
      lastErrorFromLoad = false
      updateSync({
        pending: get().sync.pending - 1,
        lastSavedAt: now(),
        lastError: null,
        canRetry: hasFailedWrites(),
      })
    }

    /** The write pipeline (see the header comment). Resolves after the server answered. */
    function write<T>(spec: WriteSpec<T>): Promise<Result<T>> {
      const startEpoch = epoch
      writeSeq += 1
      // A Retry re-sends an older change: it keeps that change's place among the failures.
      const retryOf = retrying
      if (retryOf) retryOf.sent = true
      const seq = retryOf?.seq ?? writeSeq
      let pending: PendingWrite | null = null
      if (spec.recipe) {
        const [next, patches, inverse] = produceWithPatches(getDoc(), spec.recipe)
        if (patches.length > 0) {
          pending = { patches, inverse, seq }
          pendingWrites.push(pending)
          setDoc(next)
          if (!spec.background) supersedeFailures(changedPaths(patches), seq)
        }
      }
      if (!spec.background) userWritesPending += 1
      updateSync({ pending: get().sync.pending + 1 })

      return enqueue(async (): Promise<Result<T>> => {
        if (startEpoch !== epoch) return failed(SIGNED_OUT_ERROR)
        let value: T
        try {
          value = await spec.persist(repository())
        } catch (thrown) {
          const error = toAppError(thrown)
          const { alreadyDone } = spec
          if (alreadyDone && alreadyDone.kind === error.kind) {
            // What the user asked for is already true on the server: keep it, fetch the truth.
            if (startEpoch === epoch) {
              settle(pending)
              requestResync()
              onWriteSucceeded(spec, seq)
            }
            return { ok: true, value: alreadyDone.value() }
          }
          if (startEpoch === epoch) {
            const later = settle(pending)
            if (pending && later) safely(() => rollback(pending, later))
            onWriteFailed(spec, error, pending, later ?? [], seq)
          }
          return failed(error)
        }
        if (startEpoch === epoch) {
          const later = settle(pending)
          if (later && spec.reconcile) {
            const { reconcile: rows } = spec
            safely(() => reconcile(rows(value), later))
          }
          if (spec.afterSuccess) {
            const { afterSuccess } = spec
            safely(() => afterSuccess(value))
          }
          onWriteSucceeded(spec, seq)
        }
        return { ok: true, value }
      })
    }

    /**
     * Re-sends failed writes in the order they were made, one at a time (a change that depends on
     * an earlier one — an edit of a task whose creation failed — is sent after it). Stops at the
     * first that fails again; the rest stay for the next Retry. Retries never overlap.
     */
    function runRetry(handles: readonly RetryHandle[]): Promise<Result> {
      const run = retryChain.then(() => retryInOrder(handles))
      retryChain = run.catch(() => undefined)
      return run
    }

    async function retryInOrder(handles: readonly RetryHandle[]): Promise<Result> {
      const startEpoch = epoch
      // A Retry from before a sign-out (perhaps another account now) must never run.
      const batch = [...new Set(handles)]
        .filter((handle) => handle.epoch === startEpoch && !handle.stale && !handle.used)
        .sort((a, b) => a.seq - b.seq)
      if (batch.length === 0) return OK
      // The failure is being handled; a new toast follows if it fails again.
      notifier.dismiss?.(SYNC_ERROR_TOAST_ID)
      if (toastRetry && batch.includes(toastRetry)) toastRetry = null
      for (const handle of batch) {
        if (epoch !== startEpoch) return failed(SIGNED_OUT_ERROR)
        if (handle.stale || handle.used) continue // a newer change replaced it meanwhile
        handle.used = true
        failedWrites = failedWrites.filter((other) => other !== handle)
        updateSync({ canRetry: hasFailedWrites() })
        retrying = handle
        let running: Promise<Result<unknown>>
        try {
          running = handle.run()
        } finally {
          retrying = null
        }
        const result = await running
        if (!result.ok) {
          if (!handle.sent && epoch === startEpoch) {
            // Refused before sending (it no longer fits the current data); nothing else says so.
            toastRetry = null
            notifier.error("Couldn't retry", {
              id: SYNC_ERROR_TOAST_ID,
              description: result.error.message,
            })
          }
          return toVoid(result)
        }
      }
      return OK
    }

    // -- loading ---------------------------------------------------------------

    /**
     * Replaces the workspace with a server snapshot. Writes still waiting for the server keep
     * their optimistic changes on top of it (and their rollbacks now restore the snapshot's
     * values), so a load never reverts or loses them.
     */
    function applySnapshot(snapshot: WorkspaceSnapshot): void {
      const preferences = snapshot.preferences ?? defaultPreferences()
      confirmedPreferences = preferences
      preferencesStored = snapshot.preferences !== null
      workspaceLoaded = true
      let doc: Doc = { data: toWorkspaceData(snapshot), preferences }
      withdrawAppliedFailures(doc)
      for (const write of pendingWrites) {
        const base = doc
        const applicable = write.patches.filter((patch) => canApply(base, patch))
        const [next, patches, inverse] = produceWithPatches(base, (draft) => {
          applyPatches(draft, applicable)
        })
        write.patches = patches
        write.inverse = inverse
        doc = next
      }
      setDoc(doc)
    }

    /**
     * Failed writes that `stored` (a server snapshot) already holds were saved after all (their
     * answer was lost): their Retry, toast and error are withdrawn, so nothing claims a saved
     * change failed. Others stay.
     */
    function withdrawAppliedFailures(stored: Doc): void {
      // The toast's failure too: an unrelated save took it off the Retry list, not off the toast.
      const candidates =
        toastRetry && !failedWrites.includes(toastRetry)
          ? [...failedWrites, toastRetry]
          : failedWrites
      const applied = candidates.filter(
        (handle) =>
          handle.epoch === epoch &&
          !handle.stale &&
          !handle.used &&
          holdsChanges(stored, handle.patches),
      )
      if (applied.length === 0) return
      for (const handle of applied) handle.stale = true
      failedWrites = failedWrites.filter((handle) => !handle.stale)
      if (toastRetry?.stale) {
        toastRetry = null
        notifier.dismiss?.(SYNC_ERROR_TOAST_ID)
      }
      const { lastError } = get().sync
      const cleared = applied.some((handle) => handle.error === lastError)
      updateSync({ canRetry: hasFailedWrites(), ...(cleared ? { lastError: null } : {}) })
    }

    /** A successful load/refresh: the error of an earlier failed load is over. */
    function loadedSync(sync: SyncState): SyncState {
      const cleared = lastErrorFromLoad ? { lastError: null, canRetry: false } : {}
      lastErrorFromLoad = false
      return { ...sync, ...cleared, lastLoadedAt: now() }
    }

    function afterSnapshot(snapshot: WorkspaceSnapshot): void {
      seedPreferences(snapshot)
      flushDeferredPreferences()
    }

    /**
     * First run on this account: save the default preferences once. Only inserts — preferences
     * another device saved in the meantime win, and are applied here.
     */
    function seedPreferences(snapshot: WorkspaceSnapshot): void {
      if (snapshot.preferences !== null || preferencesSeeded) return
      preferencesSeeded = true
      const defaults = get().preferences
      void write<Preferences>({
        label: 'save preferences',
        background: true,
        persist: (repo) => repo.upsertPreferences(defaults, { onlyIfMissing: true }),
        reconcile: (stored) => [{ path: ['preferences'], row: stored }],
        afterSuccess: (stored) => {
          confirmedPreferences = stored
          preferencesStored = true
        },
        onFailure: () => {
          preferencesSeeded = false
        },
        retry: async () => OK,
      })
    }

    /** Saves the preference changes made before the load on top of the loaded (stored) values. */
    function flushDeferredPreferences(): void {
      const changes = deferredPreferences
      const waiters = deferredWaiters
      deferredPreferences = {}
      deferredWaiters = []
      if (isEmpty(changes)) return
      void updatePreferences(changes).then((result) => {
        for (const resolve of waiters) resolve(result)
      })
    }

    async function load(): Promise<Result> {
      const token = ++loadToken
      lastRefreshAt = now()
      set({ status: 'loading', loadError: null })
      try {
        // Read behind the writes already sent (same queue), so the snapshot includes them;
        // writes made meanwhile wait behind the read and are re-applied on top of it.
        const snapshot = await enqueue(() => repository().loadWorkspace())
        if (token !== loadToken) return OK
        applySnapshot(snapshot)
        set((state) => ({ status: 'ready', loadError: null, sync: loadedSync(state.sync) }))
        afterSnapshot(snapshot)
        return OK
      } catch (thrown) {
        if (token !== loadToken) return OK
        const error = toAppError(thrown)
        lastErrorFromLoad = true
        set((state) => ({
          status: 'error',
          loadError: error,
          sync: { ...state.sync, lastError: error, canRetry: false },
        }))
        return failed(error)
      }
    }

    async function refresh(refreshOptions: { silent?: boolean } = {}): Promise<Result> {
      const silent = refreshOptions.silent ?? false
      const { status, sync } = get()
      if (status === 'error') return load()
      if (status !== 'ready' || sync.pending > 0) return OK // nothing loaded yet, or writes pending
      const token = ++loadToken
      const startedAtWrite = writeSeq
      lastRefreshAt = now()
      if (!silent) set({ status: 'loading' })
      try {
        const snapshot = await repository().loadWorkspace()
        if (token !== loadToken) return OK
        if (writeSeq !== startedAtWrite || get().sync.pending > 0) {
          // A write started after this read began: the snapshot may predate it. Keep local state.
          if (!silent) set({ status: 'ready' })
          return OK
        }
        applySnapshot(snapshot)
        set((state) => ({ status: 'ready', sync: loadedSync(state.sync) }))
        afterSnapshot(snapshot)
        return OK
      } catch (thrown) {
        const error = toAppError(thrown)
        if (token !== loadToken) return OK
        if (!silent) {
          // A failed write awaiting Retry stays the error reported.
          const keepWriteError = hasFailedWrites()
          if (!keepWriteError) lastErrorFromLoad = true
          set((state) => ({
            status: 'ready',
            sync: keepWriteError ? state.sync : { ...state.sync, lastError: error },
          }))
          toastRetry = null // this toast replaces the failure toast (same id)
          notifier.error("Couldn't refresh", {
            id: SYNC_ERROR_TOAST_ID,
            description: error.message,
          })
        }
        return failed(error)
      }
    }

    function reset(): void {
      const unsaved = userWritesPending > 0
      epoch += 1
      loadToken += 1
      pendingWrites.length = 0
      userWritesPending = 0
      failedWrites = []
      toastRetry = null
      retrying = null
      lastErrorFromLoad = false
      preferencesSeeded = false
      preferencesStored = false
      workspaceLoaded = false
      resyncWhenIdle = false
      const waiters = deferredWaiters
      deferredPreferences = {}
      deferredWaiters = []
      for (const resolve of waiters) resolve(failed(SIGNED_OUT_ERROR))
      const preferences = defaultPreferences()
      confirmedPreferences = preferences
      set((state) => ({
        status: 'idle',
        loadError: null,
        data: EMPTY_WORKSPACE,
        preferences,
        sync: {
          pending: 0,
          lastError: null,
          lastSavedAt: null,
          lastLoadedAt: null,
          online: state.sync.online,
          canRetry: false,
        },
      }))
      // The previous session's error toast (and its Retry) no longer applies.
      notifier.dismiss?.(SYNC_ERROR_TOAST_ID)
      if (unsaved) {
        notifier.error('Some changes may not have been saved', {
          id: UNSAVED_ON_RESET_TOAST_ID,
          description: 'You were signed out while they were still being saved.',
        })
      }
    }

    // -- projects --------------------------------------------------------------

    async function createProject(
      input: NewProjectInput,
      presetId?: string,
    ): Promise<Result<Project>> {
      const name = trimmed(input.name)
      const error =
        validateName(name, NAME_MAX_LENGTH, 'Project name') ??
        validateDescription(input.description) ??
        validateDateRange(input.startDate, input.dueDate) ??
        enumError(input.status, PROJECT_STATUSES, 'project status') ??
        enumError(input.color, PROJECT_COLORS, 'project color')
      if (error) return failed(error)
      const timestamp = isoNow()
      const project: Project = {
        id: presetId ?? randomId(),
        name,
        description: normalizeDescription(input.description) ?? null,
        status: input.status ?? 'active',
        color: input.color ?? 'gray',
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
        scheduleMode: 'manual',
        sortOrder: keyAtEnd(Object.values(get().data.projects)),
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      return write({
        label: 'create project',
        recipe: (draft) => {
          draft.data.projects[project.id] = project
        },
        persist: (repo) => repo.insertProject(project),
        reconcile: (row) => [tableRow('projects', row)],
        alreadyDone: storedIfDuplicate(presetId !== undefined, project),
        retry: () => createProject(input, project.id),
      })
    }

    async function updateProject(id: string, input: ProjectPatch): Promise<Result> {
      const current = own(get().data.projects, id)
      if (!current) return missing('project')
      const immutable = immutableError(input, current, ['id'])
      if (immutable) return failed(immutable)
      const patch = pickPatch(input, PROJECT_PATCH_FIELDS)
      const proposed: ProjectPatch = { ...patch }
      if (patch.name !== undefined) proposed.name = trimmed(patch.name)
      if (patch.description !== undefined)
        proposed.description = normalizeDescription(patch.description)
      const merged = { ...current, ...changedFields(current, proposed) }
      const error =
        (proposed.name !== undefined
          ? validateName(merged.name, NAME_MAX_LENGTH, 'Project name')
          : null) ??
        validateDescription(merged.description) ??
        validateDateRange(merged.startDate, merged.dueDate) ??
        enumError(patch.status, PROJECT_STATUSES, 'project status') ??
        enumError(patch.color, PROJECT_COLORS, 'project color') ??
        enumError(patch.scheduleMode, SCHEDULE_MODES, 'schedule mode') ??
        sortOrderError(patch.sortOrder)
      if (error) return failed(error)
      const changes = changedFields(current, proposed)
      if (isEmpty(changes)) return OK
      return toVoid(
        await write({
          label: 'update project',
          recipe: (draft) => {
            Object.assign(draft.data.projects[id], changes, { updatedAt: isoNow() })
          },
          persist: (repo) => repo.updateProject(id, changes),
          reconcile: (row) => [tableRow('projects', row)],
          retry: () => updateProject(id, patch),
        }),
      )
    }

    async function deleteProject(id: string): Promise<Result> {
      const data = get().data
      if (!own(data.projects, id)) return missing('project')
      return toVoid(
        await write({
          label: 'delete project',
          recipe: (draft) => {
            delete draft.data.projects[id]
            for (const table of ['phases', 'tasks', 'milestones', 'dependencies'] as const) {
              for (const row of Object.values(data[table])) {
                if (row.projectId === id) delete draft.data[table][row.id]
              }
            }
          },
          persist: (repo) => repo.deleteProject(id),
          alreadyDone: DELETED,
          retry: () => deleteProject(id),
        }),
      )
    }

    async function moveProject(id: string, afterProjectId: string | null): Promise<Result> {
      const projects = get().data.projects
      const project = own(projects, id)
      if (!project) return missing('project')
      const siblings = Object.values(projects).filter((p) => p.id !== id)
      const placement = { afterId: afterProjectId }
      if (isAtPlacement(project, siblings, placement)) return OK
      const sortOrder = keyForPlacement(siblings, placement)
      return toVoid(
        await write({
          label: 'move project',
          recipe: (draft) => {
            Object.assign(draft.data.projects[id], { sortOrder, updatedAt: isoNow() })
          },
          persist: (repo) => repo.updateProject(id, { sortOrder }),
          reconcile: (row) => [tableRow('projects', row)],
          retry: () => moveProject(id, afterProjectId),
        }),
      )
    }

    // -- phases ----------------------------------------------------------------

    /** `afterPhaseId` = insert after that phase; omitted or null = append at the end. */
    async function createPhase(input: NewPhaseInput, presetId?: string): Promise<Result<Phase>> {
      const data = get().data
      if (!own(data.projects, input.projectId)) return invalid('This project no longer exists.')
      const name = trimmed(input.name)
      const error = validateName(name, NAME_MAX_LENGTH, 'Phase name')
      if (error) return failed(error)
      const siblings = Object.values(data.phases).filter((p) => p.projectId === input.projectId)
      const timestamp = isoNow()
      const phase: Phase = {
        id: presetId ?? randomId(),
        projectId: input.projectId,
        name,
        sortOrder: input.afterPhaseId
          ? keyForPlacement(siblings, { afterId: input.afterPhaseId })
          : keyAtEnd(siblings),
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      return write({
        label: 'create phase',
        recipe: (draft) => {
          draft.data.phases[phase.id] = phase
        },
        persist: (repo) => repo.insertPhase(phase),
        reconcile: (row) => [tableRow('phases', row)],
        alreadyDone: storedIfDuplicate(presetId !== undefined, phase),
        retry: () => createPhase(input, phase.id),
      })
    }

    async function updatePhase(id: string, input: PhasePatch): Promise<Result> {
      const current = own(get().data.phases, id)
      if (!current) return missing('phase')
      const immutable = immutableError(input, current, ['id', 'projectId'])
      if (immutable) return failed(immutable)
      const patch = pickPatch(input, PHASE_PATCH_FIELDS)
      const proposed: PhasePatch = { ...patch }
      if (patch.name !== undefined) proposed.name = trimmed(patch.name)
      const error =
        (proposed.name !== undefined
          ? validateName(proposed.name, NAME_MAX_LENGTH, 'Phase name')
          : null) ?? sortOrderError(patch.sortOrder)
      if (error) return failed(error)
      const changes = changedFields(current, proposed)
      if (isEmpty(changes)) return OK
      return toVoid(
        await write({
          label: 'update phase',
          recipe: (draft) => {
            Object.assign(draft.data.phases[id], changes, { updatedAt: isoNow() })
          },
          persist: (repo) => repo.updatePhase(id, changes),
          reconcile: (row) => [tableRow('phases', row)],
          retry: () => updatePhase(id, patch),
        }),
      )
    }

    async function deletePhase(id: string): Promise<Result> {
      const data = get().data
      if (!own(data.phases, id)) return missing('phase')
      return toVoid(
        await write({
          label: 'delete phase',
          recipe: (draft) => {
            const timestamp = isoNow()
            delete draft.data.phases[id]
            for (const table of ['tasks', 'milestones'] as const) {
              for (const row of Object.values(data[table])) {
                if (row.phaseId === id)
                  Object.assign(draft.data[table][row.id], { phaseId: null, updatedAt: timestamp })
              }
            }
          },
          persist: (repo) => repo.deletePhase(id),
          alreadyDone: DELETED,
          retry: () => deletePhase(id),
        }),
      )
    }

    async function movePhase(id: string, afterPhaseId: string | null): Promise<Result> {
      const phases = get().data.phases
      const phase = own(phases, id)
      if (!phase) return missing('phase')
      const siblings = Object.values(phases).filter(
        (p) => p.projectId === phase.projectId && p.id !== id,
      )
      const placement = { afterId: afterPhaseId }
      if (isAtPlacement(phase, siblings, placement)) return OK
      const sortOrder = keyForPlacement(siblings, placement)
      return toVoid(
        await write({
          label: 'move phase',
          recipe: (draft) => {
            Object.assign(draft.data.phases[id], { sortOrder, updatedAt: isoNow() })
          },
          persist: (repo) => repo.updatePhase(id, { sortOrder }),
          reconcile: (row) => [tableRow('phases', row)],
          retry: () => movePhase(id, afterPhaseId),
        }),
      )
    }

    // -- tasks -----------------------------------------------------------------

    /** Applies task field changes like the database triggers do (completedAt, subtask phase). */
    function applyTaskChanges(
      draft: Draft<Doc>,
      base: WorkspaceData,
      id: string,
      changes: TaskPatch,
      timestamp: string,
    ): void {
      const task = draft.data.tasks[id]
      const wasDone = task.status === 'done'
      Object.assign(task, changes, { updatedAt: timestamp })
      if (changes.status !== undefined) {
        if (changes.status !== 'done') task.completedAt = null
        else if (!wasDone) task.completedAt = timestamp
      }
      if (task.parentTaskId === null && changes.phaseId !== undefined) {
        for (const subtask of Object.values(base.tasks)) {
          if (subtask.parentTaskId === id && subtask.phaseId !== task.phaseId) {
            Object.assign(draft.data.tasks[subtask.id], {
              phaseId: task.phaseId,
              updatedAt: timestamp,
            })
          }
        }
      }
    }

    function taskFieldErrors(fields: {
      title?: string
      description?: string | null
      status?: unknown
      priority?: unknown
      startDate: string | null | undefined
      dueDate: string | null | undefined
      sortOrder?: unknown
    }): AppError | null {
      return (
        (fields.title !== undefined
          ? validateName(fields.title, TITLE_MAX_LENGTH, 'Task title')
          : null) ??
        validateDescription(fields.description) ??
        enumError(fields.status, TASK_STATUSES, 'task status') ??
        enumError(fields.priority, TASK_PRIORITIES, 'task priority') ??
        validateDateRange(fields.startDate, fields.dueDate) ??
        sortOrderError(fields.sortOrder)
      )
    }

    /** Validates that `task` may become a subtask of `parentId` (hierarchy + no dependency edge). */
    function parentError(data: WorkspaceData, task: Task, parentId: string): AppError | null {
      const parent = own(data.tasks, parentId)
      if (!parent) return { kind: 'validation', message: 'The parent task no longer exists.' }
      const verdict = canBecomeSubtaskOf(
        task,
        parent,
        Object.values(data.tasks),
        Object.values(data.dependencies),
      )
      return verdict.ok ? null : verdict.error
    }

    function phaseError(
      data: WorkspaceData,
      projectId: string,
      phaseId: string | null,
    ): AppError | null {
      if (phaseId === null || own(data.phases, phaseId)?.projectId === projectId) return null
      return { kind: 'validation', message: 'That phase no longer exists in this project.' }
    }

    async function createTask(input: NewTaskInput, presetId?: string): Promise<Result<Task>> {
      const data = get().data
      if (!input.projectId) return invalid('Choose a project for this task.')
      if (!own(data.projects, input.projectId)) return invalid('This project no longer exists.')
      const title = trimmed(input.title)
      const fieldError = taskFieldErrors({
        title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        startDate: input.startDate,
        dueDate: input.dueDate,
      })
      if (fieldError) return failed(fieldError)

      let parent: Task | null = null
      if (input.parentTaskId) {
        parent = own(data.tasks, input.parentTaskId) ?? null
        if (!parent) return invalid('The parent task no longer exists.')
        if (parent.projectId !== input.projectId) {
          return invalid('A subtask must be in the same project as its parent.')
        }
        if (parent.parentTaskId) return invalid('Only top-level tasks can have subtasks.')
      }
      // A subtask always carries its parent's phase.
      const phaseId = parent ? parent.phaseId : (input.phaseId ?? null)
      const refError = parent ? null : phaseError(data, input.projectId, phaseId)
      if (refError) return failed(refError)

      const siblings = parent
        ? subtaskSiblings(data.tasks, parent.id)
        : topLevelSiblings(data.tasks, input.projectId)
      const status = input.status ?? 'todo'
      const timestamp = isoNow()
      const task: Task = {
        id: presetId ?? randomId(),
        projectId: input.projectId,
        phaseId,
        parentTaskId: parent?.id ?? null,
        title,
        description: normalizeDescription(input.description) ?? null,
        status,
        priority: input.priority ?? 'none',
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
        sortOrder: keyForPlacement(siblings, input.placement ?? {}),
        completedAt: status === 'done' ? timestamp : null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      return write({
        label: 'create task',
        recipe: (draft) => {
          draft.data.tasks[task.id] = task
        },
        persist: (repo) => repo.insertTask(task),
        reconcile: (row) => [tableRow('tasks', row)],
        alreadyDone: storedIfDuplicate(presetId !== undefined, task),
        retry: () => createTask(input, task.id),
      })
    }

    /**
     * Validates title/dates/hierarchy. A parent change appends the task at the end of its new
     * sibling list (unless `sortOrder` is given) and moves it into the new parent's phase; a
     * top-level task's phase change also moves its subtasks. A subtask's phase always follows its
     * parent (a different `phaseId` for a subtask is ignored, like the database does).
     */
    async function updateTask(id: string, input: TaskPatch): Promise<Result> {
      const data = get().data
      const task = own(data.tasks, id)
      if (!task) return missing('task')
      const immutable = immutableError(input, task, ['id', 'projectId'])
      if (immutable) return failed(immutable)
      const patch = pickPatch(input, TASK_PATCH_FIELDS)
      const proposed: TaskPatch = { ...patch }
      if (patch.title !== undefined) proposed.title = trimmed(patch.title)
      if (patch.description !== undefined)
        proposed.description = normalizeDescription(patch.description)

      const fieldError = taskFieldErrors({
        title: proposed.title,
        description: proposed.description,
        status: patch.status,
        priority: patch.priority,
        startDate: patch.startDate !== undefined ? patch.startDate : task.startDate,
        dueDate: patch.dueDate !== undefined ? patch.dueDate : task.dueDate,
        sortOrder: patch.sortOrder,
      })
      if (fieldError) return failed(fieldError)

      const parentId = patch.parentTaskId !== undefined ? patch.parentTaskId : task.parentTaskId
      const parentChanged = parentId !== task.parentTaskId
      if (parentChanged && parentId !== null) {
        const error = parentError(data, task, parentId)
        if (error) return failed(error)
      }
      if (parentId !== null) {
        proposed.phaseId = own(data.tasks, parentId)?.phaseId ?? null
      } else if (proposed.phaseId !== undefined) {
        const error = phaseError(data, task.projectId, proposed.phaseId)
        if (error) return failed(error)
      }
      if (parentChanged) {
        proposed.parentTaskId = parentId
        if (patch.sortOrder === undefined) {
          proposed.sortOrder = keyAtEnd(
            parentId === null
              ? topLevelSiblings(data.tasks, task.projectId, id)
              : subtaskSiblings(data.tasks, parentId, id),
          )
        }
      }
      const changes = changedFields(task, proposed)
      if (isEmpty(changes)) return OK
      return toVoid(
        await write({
          label: 'update task',
          recipe: (draft) => applyTaskChanges(draft, data, id, changes, isoNow()),
          persist: (repo) => repo.updateTask(id, changes),
          reconcile: (row) => [tableRow('tasks', row)],
          retry: () => updateTask(id, patch),
        }),
      )
    }

    async function moveTask(input: MoveTaskInput): Promise<Result> {
      const data = get().data
      const task = own(data.tasks, input.taskId)
      if (!task) return missing('task')
      const statusError = enumError(input.status, TASK_STATUSES, 'task status')
      if (statusError) return failed(statusError)

      const parentId = input.parentTaskId !== undefined ? input.parentTaskId : task.parentTaskId
      const parentChanged = parentId !== task.parentTaskId
      if (parentChanged && parentId !== null) {
        const error = parentError(data, task, parentId)
        if (error) return failed(error)
      }
      let phaseId = task.phaseId
      if (parentId !== null) {
        phaseId = own(data.tasks, parentId)?.phaseId ?? null
      } else if (input.phaseId !== undefined) {
        const error = phaseError(data, task.projectId, input.phaseId)
        if (error) return failed(error)
        phaseId = input.phaseId
      }

      const changes: TaskPatch = {}
      if (parentChanged) changes.parentTaskId = parentId
      if (phaseId !== task.phaseId) changes.phaseId = phaseId
      if (input.status !== undefined && input.status !== task.status) changes.status = input.status

      // The new key comes from the destination siblings WITHOUT the moved task.
      const siblings =
        parentId === null
          ? topLevelSiblings(data.tasks, task.projectId, task.id)
          : subtaskSiblings(data.tasks, parentId, task.id)
      const placement: Placement = { afterId: input.afterId, beforeId: input.beforeId }
      if (parentChanged || !isAtPlacement(task, siblings, placement)) {
        changes.sortOrder = keyForPlacement(siblings, placement)
      }
      if (isEmpty(changes)) return OK
      return toVoid(
        await write({
          label: 'move task',
          recipe: (draft) => applyTaskChanges(draft, data, task.id, changes, isoNow()),
          persist: (repo) => repo.updateTask(task.id, changes),
          reconcile: (row) => [tableRow('tasks', row)],
          retry: () => moveTask(input),
        }),
      )
    }

    async function deleteTask(id: string, options: { keepSubtasks: boolean }): Promise<Result> {
      const data = get().data
      const task = own(data.tasks, id)
      if (!task) return missing('task')
      const subtasks = sortByOrder(subtaskSiblings(data.tasks, id))
      const keep = options.keepSubtasks && subtasks.length > 0
      const promoted: Record<string, string> = {}
      if (keep) {
        // Promoted subtasks take the parent's place, in their current order.
        const topLevel = sortByOrder(topLevelSiblings(data.tasks, task.projectId))
        const next = topLevel[topLevel.findIndex((t) => t.id === id) + 1] ?? null
        const keys = keysBetween(task.sortOrder, next?.sortOrder ?? null, subtasks.length)
        subtasks.forEach((subtask, i) => {
          promoted[subtask.id] = keys[i]
        })
      }
      const removed = new Set([id, ...(keep ? [] : subtasks.map((subtask) => subtask.id))])
      return toVoid(
        await write({
          label: 'delete task',
          recipe: (draft) => {
            const timestamp = isoNow()
            for (const taskId of removed) delete draft.data.tasks[taskId]
            for (const [subtaskId, sortOrder] of Object.entries(promoted)) {
              Object.assign(draft.data.tasks[subtaskId], {
                parentTaskId: null,
                sortOrder,
                updatedAt: timestamp,
              })
            }
            for (const dependency of Object.values(data.dependencies)) {
              if (removed.has(dependency.predecessorId) || removed.has(dependency.successorId)) {
                delete draft.data.dependencies[dependency.id]
              }
            }
          },
          // keepSubtasks is sent as asked even when this device sees no subtasks: subtasks added
          // on another device are then refused by the server instead of deleted unseen.
          persist: (repo) =>
            repo.deleteTask(
              id,
              options.keepSubtasks
                ? { keepSubtasks: true, promotedSortOrders: promoted }
                : { keepSubtasks: false },
            ),
          alreadyDone: DELETED,
          retry: () => deleteTask(id, options),
        }),
      )
    }

    // -- milestones ------------------------------------------------------------

    async function createMilestone(
      input: NewMilestoneInput,
      presetId?: string,
    ): Promise<Result<Milestone>> {
      const data = get().data
      if (!own(data.projects, input.projectId)) return invalid('This project no longer exists.')
      const name = trimmed(input.name)
      const error =
        validateName(name, NAME_MAX_LENGTH, 'Milestone name') ??
        (isISODate(input.date)
          ? null
          : { kind: 'validation' as const, message: 'Choose a valid date.' }) ??
        phaseError(data, input.projectId, input.phaseId ?? null)
      if (error) return failed(error)
      const timestamp = isoNow()
      const milestone: Milestone = {
        id: presetId ?? randomId(),
        projectId: input.projectId,
        phaseId: input.phaseId ?? null,
        name,
        date: input.date,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      return write({
        label: 'create milestone',
        recipe: (draft) => {
          draft.data.milestones[milestone.id] = milestone
        },
        persist: (repo) => repo.insertMilestone(milestone),
        reconcile: (row) => [tableRow('milestones', row)],
        alreadyDone: storedIfDuplicate(presetId !== undefined, milestone),
        retry: () => createMilestone(input, milestone.id),
      })
    }

    async function updateMilestone(id: string, input: MilestonePatch): Promise<Result> {
      const data = get().data
      const current = own(data.milestones, id)
      if (!current) return missing('milestone')
      const immutable = immutableError(input, current, ['id', 'projectId'])
      if (immutable) return failed(immutable)
      const patch = pickPatch(input, MILESTONE_PATCH_FIELDS)
      const proposed: MilestonePatch = { ...patch }
      if (patch.name !== undefined) proposed.name = trimmed(patch.name)
      const error =
        (proposed.name !== undefined
          ? validateName(proposed.name, NAME_MAX_LENGTH, 'Milestone name')
          : null) ??
        (patch.date === undefined || isISODate(patch.date)
          ? null
          : { kind: 'validation' as const, message: 'Choose a valid date.' }) ??
        (patch.phaseId !== undefined ? phaseError(data, current.projectId, patch.phaseId) : null)
      if (error) return failed(error)
      const changes = changedFields(current, proposed)
      if (isEmpty(changes)) return OK
      return toVoid(
        await write({
          label: 'update milestone',
          recipe: (draft) => {
            Object.assign(draft.data.milestones[id], changes, { updatedAt: isoNow() })
          },
          persist: (repo) => repo.updateMilestone(id, changes),
          reconcile: (row) => [tableRow('milestones', row)],
          retry: () => updateMilestone(id, patch),
        }),
      )
    }

    async function deleteMilestone(id: string): Promise<Result> {
      if (!own(get().data.milestones, id)) return missing('milestone')
      return toVoid(
        await write({
          label: 'delete milestone',
          recipe: (draft) => {
            delete draft.data.milestones[id]
          },
          persist: (repo) => repo.deleteMilestone(id),
          alreadyDone: DELETED,
          retry: () => deleteMilestone(id),
        }),
      )
    }

    // -- dependencies ----------------------------------------------------------

    async function addDependency(
      predecessorId: string,
      successorId: string,
      presetId?: string,
    ): Promise<Result<Dependency>> {
      const data = get().data
      const verdict = validateNewDependency(
        data.tasks,
        Object.values(data.dependencies),
        predecessorId,
        successorId,
      )
      if (!verdict.ok) return invalid(verdict.message)
      const dependency: Dependency = {
        id: presetId ?? randomId(),
        projectId: data.tasks[predecessorId].projectId,
        predecessorId,
        successorId,
        type: 'FS',
        createdAt: isoNow(),
      }
      return write({
        label: 'add dependency',
        recipe: (draft) => {
          draft.data.dependencies[dependency.id] = dependency
        },
        persist: (repo) => repo.insertDependency(dependency),
        reconcile: (row) => [tableRow('dependencies', row)],
        // The server already has this link (another device added it, or a first attempt whose
        // answer was lost): the user's intent holds; the resync brings the stored row.
        alreadyDone: { kind: 'conflict', value: () => dependency },
        retry: () => addDependency(predecessorId, successorId, dependency.id),
      })
    }

    async function removeDependency(id: string): Promise<Result> {
      if (!own(get().data.dependencies, id)) return missing('dependency')
      return toVoid(
        await write({
          label: 'remove dependency',
          recipe: (draft) => {
            delete draft.data.dependencies[id]
          },
          persist: (repo) => repo.deleteDependency(id),
          alreadyDone: DELETED,
          retry: () => removeDependency(id),
        }),
      )
    }

    // -- schedule --------------------------------------------------------------

    async function applySchedule(changes: readonly ScheduleChange[]): Promise<Result> {
      const tasks = get().data.tasks
      const seen = new Set<string>()
      const effective: ScheduleChange[] = []
      for (const change of changes) {
        const task = own(tasks, change.taskId)
        if (!task) return invalid('That task no longer exists.')
        if (seen.has(change.taskId))
          return invalid('A task appears more than once in the schedule changes.')
        seen.add(change.taskId)
        const startDate = change.startDate ?? null
        const dueDate = change.dueDate ?? null
        const error = validateDateRange(startDate, dueDate)
        if (error) return failed(error)
        if (startDate !== task.startDate || dueDate !== task.dueDate) {
          effective.push({ taskId: change.taskId, startDate, dueDate })
        }
      }
      if (effective.length === 0) return OK
      return toVoid(
        await write({
          label: effective.length > 1 ? 'reschedule tasks' : 'change dates',
          recipe: (draft) => {
            const timestamp = isoNow()
            for (const { taskId, startDate, dueDate } of effective) {
              Object.assign(draft.data.tasks[taskId], { startDate, dueDate, updatedAt: timestamp })
            }
          },
          persist: (repo) => repo.applySchedule(effective),
          reconcile: (rows) => rows.map((row) => tableRow('tasks', row)),
          retry: () => applySchedule(changes),
        }),
      )
    }

    // -- preferences -----------------------------------------------------------

    async function updatePreferences(input: Partial<Preferences>): Promise<Result> {
      const patch = pickPatch(input, PREFERENCE_FIELDS)
      const error =
        enumError(patch.theme, THEME_PREFERENCES, 'theme') ??
        (patch.sidebarCollapsed === undefined || typeof patch.sidebarCollapsed === 'boolean'
          ? null
          : { kind: 'validation' as const, message: 'Invalid sidebar preference.' }) ??
        (patch.timezone === undefined ||
        (typeof patch.timezone === 'string' &&
          patch.timezone.length <= 100 &&
          isValidTimeZone(patch.timezone))
          ? null
          : { kind: 'validation' as const, message: 'Choose a valid time zone.' }) ??
        (patch.weekStartsOn === undefined || patch.weekStartsOn === 0 || patch.weekStartsOn === 1
          ? null
          : { kind: 'validation' as const, message: 'The week must start on Sunday or Monday.' })
      if (error) return failed(error)
      if (!workspaceLoaded) {
        // Not loaded yet, so the stored values are unknown (a new device has only defaults):
        // apply now, save on top of the stored values once the workspace has loaded.
        const fields = definedFields(patch)
        if (isEmpty(fields)) return OK
        deferredPreferences = { ...deferredPreferences, ...fields }
        set((state) => ({ preferences: { ...state.preferences, ...fields } }))
        return new Promise<Result>((resolve) => deferredWaiters.push(resolve))
      }
      const changes = changedFields(get().preferences, patch)
      if (isEmpty(changes)) return OK
      return toVoid(
        await write<Preferences>({
          label: 'save preferences',
          recipe: (draft) => {
            Object.assign(draft.preferences, changes)
          },
          // Only the changed fields are saved (another device's newer values stay); the full
          // value (last stored + this change, never another pending change) creates the row.
          persist: (repo) =>
            repo.upsertPreferences(
              { ...confirmedPreferences, ...changes },
              preferencesStored
                ? { fields: Object.keys(changes) as (keyof Preferences)[] }
                : undefined,
            ),
          reconcile: (stored) => [{ path: ['preferences'], row: stored }],
          afterSuccess: (stored) => {
            confirmedPreferences = stored
            preferencesStored = true
          },
          retry: () => updatePreferences(patch),
        }),
      )
    }

    // -- backup ----------------------------------------------------------------

    function exportBackup(): BackupFile {
      const { data, preferences } = get()
      const byProjectThenOrder = (
        a: Ordered & { projectId: string },
        b: Ordered & { projectId: string },
      ) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : bySortOrder(a, b))
      const backup: BackupData = {
        projects: sortByOrder(Object.values(data.projects)),
        phases: Object.values(data.phases).sort(byProjectThenOrder),
        tasks: Object.values(data.tasks).sort(byProjectThenOrder),
        milestones: Object.values(data.milestones).sort((a, b) =>
          a.projectId !== b.projectId
            ? a.projectId < b.projectId
              ? -1
              : 1
            : a.date < b.date
              ? -1
              : a.date > b.date
                ? 1
                : 0,
        ),
        dependencies: Object.values(data.dependencies).sort((a, b) =>
          a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
        ),
      }
      const file: BackupFile = {
        app: 'cairn',
        formatVersion: BACKUP_FORMAT_VERSION,
        exportedAt: isoNow(),
        data: backup,
        preferences: { ...preferences },
      }
      return structuredClone(file)
    }

    /**
     * Fresh ids everywhere; projects appended after the existing ones in their original order.
     * Rows are shaped the way the database stores them (a subtask carries its parent's phase).
     */
    function remapBackup(data: BackupData): BackupData {
      const timestamp = isoNow()
      const maps = {
        projects: new Map<string, string>(),
        phases: new Map<string, string>(),
        tasks: new Map<string, string>(),
      }
      const fresh = (map: Map<string, string>, id: string) => {
        let next = map.get(id)
        if (!next) {
          next = randomId()
          map.set(id, next)
        }
        return next
      }
      const ref = (map: Map<string, string>, id: string | null) =>
        id === null ? null : fresh(map, id)
      const projects = sortByOrder(data.projects)
      const lastKey = sortByOrder(Object.values(get().data.projects)).at(-1)?.sortOrder ?? null
      const keys = keysBetween(lastKey, null, projects.length)
      const phaseOf = new Map(data.tasks.map((task) => [task.id, task.phaseId]))
      const phaseOfTask = (task: { parentTaskId: string | null; phaseId: string | null }) =>
        task.parentTaskId !== null && phaseOf.has(task.parentTaskId)
          ? (phaseOf.get(task.parentTaskId) ?? null)
          : task.phaseId
      return {
        projects: projects.map((project, i) => ({
          ...project,
          id: fresh(maps.projects, project.id),
          sortOrder: keys[i],
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
        phases: data.phases.map((phase) => ({
          ...phase,
          id: fresh(maps.phases, phase.id),
          projectId: fresh(maps.projects, phase.projectId),
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
        tasks: data.tasks.map((task) => ({
          ...task,
          id: fresh(maps.tasks, task.id),
          projectId: fresh(maps.projects, task.projectId),
          phaseId: ref(maps.phases, phaseOfTask(task)),
          parentTaskId: ref(maps.tasks, task.parentTaskId),
          completedAt: task.status === 'done' ? (task.completedAt ?? timestamp) : null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
        milestones: data.milestones.map((milestone) => ({
          ...milestone,
          id: randomId(),
          projectId: fresh(maps.projects, milestone.projectId),
          phaseId: ref(maps.phases, milestone.phaseId),
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
        dependencies: data.dependencies.map((dependency) => ({
          ...dependency,
          id: randomId(),
          projectId: fresh(maps.projects, dependency.projectId),
          predecessorId: fresh(maps.tasks, dependency.predecessorId),
          successorId: fresh(maps.tasks, dependency.successorId),
          createdAt: timestamp,
        })),
      }
    }

    async function importBackup(file: BackupFile): Promise<Result<ImportSummary>> {
      const parsed = parseBackupFile(file)
      if (!parsed.ok) return failed(parsed.error)
      return importCopy(remapBackup(parsed.value.data), false)
    }

    /**
     * Retries send the SAME copy (same ids): when the first attempt reached the server but its
     * answer was lost, the retry is refused as a duplicate instead of importing a second copy —
     * and that refusal means the copy is stored.
     */
    function importCopy(copy: BackupData, retrying: boolean): Promise<Result<ImportSummary>> {
      return write<ImportSummary>({
        label: 'import the backup',
        persist: async (repo) => {
          try {
            return await repo.importWorkspace(copy)
          } catch (error) {
            if (!retrying || toAppError(error).kind !== 'conflict') throw error
            requestResync() // already imported by the attempt whose answer was lost
            return {
              projects: copy.projects.length,
              phases: copy.phases.length,
              tasks: copy.tasks.length,
              milestones: copy.milestones.length,
              dependencies: copy.dependencies.length,
            }
          }
        },
        // Not optimistic: the copy appears once the server stored all of it.
        expected: () =>
          IMPORTED_TABLES.flatMap((table) =>
            copy[table].map((row): Patch => ({
              op: 'add',
              path: ['data', table, row.id],
              value: row,
            })),
          ),
        afterSuccess: () => {
          setDoc(
            produce(getDoc(), (draft) => {
              for (const table of IMPORTED_TABLES) {
                const target = draft.data[table] as Record<string, unknown>
                for (const row of copy[table]) target[row.id] = row
              }
            }),
          )
        },
        retry: () => importCopy(copy, true),
      })
    }

    /** Re-sends every failed write not followed by a successful one, in order (see runRetry). */
    function retryLastFailed(): Promise<Result> {
      return runRetry(failedWrites)
    }

    const actions: WorkspaceActions = {
      load,
      refresh,
      reset,
      createProject: (input) => createProject(input),
      updateProject,
      deleteProject,
      moveProject,
      createPhase: (input) => createPhase(input),
      updatePhase,
      deletePhase,
      movePhase,
      createTask: (input) => createTask(input),
      updateTask,
      moveTask,
      deleteTask,
      createMilestone: (input) => createMilestone(input),
      updateMilestone,
      deleteMilestone,
      addDependency: (predecessorId, successorId) => addDependency(predecessorId, successorId),
      removeDependency,
      applySchedule,
      updatePreferences,
      exportBackup,
      importBackup,
      retryLastFailed,
    }

    return {
      mode: options.mode,
      status: 'idle',
      loadError: null,
      data: EMPTY_WORKSPACE,
      preferences: confirmedPreferences,
      sync: {
        pending: 0,
        lastError: null,
        lastSavedAt: null,
        lastLoadedAt: null,
        online: environment?.navigator?.onLine ?? true,
        canRetry: false,
      },
      actions,
    }
  })

  // Theme + sidebar cache for the next startup (and the no-flash script in index.html).
  if (storage) {
    const unsubscribe = store.subscribe((state, previous) => {
      const { theme, sidebarCollapsed } = state.preferences
      if (
        theme !== previous.preferences.theme ||
        sidebarCollapsed !== previous.preferences.sidebarCollapsed
      ) {
        writeUiPrefsCache(storage, state.preferences)
      }
    })
    signal?.addEventListener('abort', unsubscribe, { once: true })
  }

  // Cross-device freshness: silent refresh on focus / visibility (throttled), and when back online
  // (which also retries a load that failed, e.g. offline at startup).
  if (environment && !signal?.aborted) {
    const autoRefresh = (force: boolean) => {
      const { status, sync, actions } = store.getState()
      if (status === 'error' && force) {
        void actions.load()
        return
      }
      if (status !== 'ready' || sync.pending > 0) return
      const last = Math.max(lastRefreshAt, sync.lastLoadedAt ?? 0)
      if (!force && now() - last < AUTO_REFRESH_INTERVAL_MS) return
      void actions.refresh({ silent: true })
    }
    const setOnline = (online: boolean) =>
      store.setState((state) => ({ sync: { ...state.sync, online } }))
    const listen = { signal }
    environment.window.addEventListener('focus', () => autoRefresh(false), listen)
    environment.document?.addEventListener(
      'visibilitychange',
      () => {
        if (environment.document?.visibilityState !== 'hidden') autoRefresh(false)
      },
      listen,
    )
    environment.window.addEventListener(
      'online',
      () => {
        setOnline(true)
        autoRefresh(true)
      },
      listen,
    )
    environment.window.addEventListener('offline', () => setOnline(false), listen)
  }

  return store
}

// ---------------------------------------------------------------------------
// Auth store
// ---------------------------------------------------------------------------

export interface AuthStoreOptions {
  mode: DataMode
  /** The service, or a factory called on first use. */
  auth: AuthService | (() => AuthService)
  /**
   * The workspace to load on sign-in and clear on sign-out. With `subscribe`, the auth store also
   * re-checks the session when the server rejects it, and sign-out waits for pending writes.
   */
  workspace: Pick<StoreApi<WorkspaceState>, 'getState'> &
    Partial<Pick<StoreApi<WorkspaceState>, 'subscribe'>>
  /** Aborting it unsubscribes from the auth service and the workspace (HMR, tests). */
  signal?: AbortSignal
  /** Longest wait for pending writes before signing out (default 10 s). */
  signOutFlushTimeoutMs?: number
}

function credentialsError(email: string, password?: string): { ok: false; error: AppError } | null {
  if (!/^\S+@\S+$/.test(trimmed(email))) return invalid('Enter a valid email address.')
  if (password !== undefined && password === '') return invalid('Enter your password.')
  return null
}

/** Resolves once `workspace` has no pending write, or after `timeoutMs`. */
function whenWritesSaved(
  workspace: AuthStoreOptions['workspace'],
  timeoutMs: number,
): Promise<void> {
  const subscribe = workspace.subscribe
  if (!subscribe || workspace.getState().sync.pending === 0) return Promise.resolve()
  return new Promise((resolve) => {
    let unsubscribe = () => {}
    const done = () => {
      clearTimeout(timer)
      unsubscribe()
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    unsubscribe = subscribe((state) => {
      if (state.sync.pending === 0) done()
    })
  })
}

/** Creates an auth store wired to `workspace` (the app uses `useAuthStore`). */
export function createAuthStore(options: AuthStoreOptions) {
  const source = options.auth
  let serviceInstance: AuthService | null = typeof source === 'function' ? null : source
  const service = (): AuthService => (serviceInstance ??= (source as () => AuthService)())
  const workspace = () => options.workspace.getState().actions
  const flushTimeoutMs = options.signOutFlushTimeoutMs ?? 10_000
  let initPromise: Promise<void> | null = null
  /** The user whose data the workspace holds (null = none loaded). */
  let workspaceUserId: string | null = null

  return create<AuthState>()((set, get) => {
    function applyUser(user: AuthUser | null, event?: AuthChangeEvent): void {
      const state = get()
      if (user) {
        if (
          state.status !== 'signed_in' ||
          state.user?.id !== user.id ||
          state.user?.email !== user.email
        ) {
          set({ status: 'signed_in', user })
        }
        if (workspaceUserId !== user.id) {
          if (workspaceUserId !== null) workspace().reset()
          if (get().passwordRecovery && event !== 'password_recovery') {
            set({ passwordRecovery: false })
          }
          workspaceUserId = user.id
          void workspace().load()
        }
        if (event === 'password_recovery' && options.mode === 'supabase') {
          set({ passwordRecovery: true })
        }
      } else {
        if (state.status !== 'signed_out' || state.user !== null || state.passwordRecovery)
          set({ status: 'signed_out', user: null, passwordRecovery: false })
        if (workspaceUserId !== null) {
          workspaceUserId = null
          workspace().reset()
        }
      }
    }

    async function syncUser(): Promise<void> {
      try {
        applyUser(await service().getUser())
      } catch {
        applyUser(null)
      }
    }

    /** Re-reads the session; when it cannot be read (offline) the current state stays. */
    async function recheckSession(): Promise<void> {
      let user: AuthUser | null
      try {
        user = await service().getUser()
      } catch {
        return
      }
      applyUser(user)
    }

    /** The server rejected the session (expired / revoked): see whether it is still valid. */
    function watchSessionRejections(): void {
      const subscribe = options.workspace.subscribe
      if (!subscribe || options.mode !== 'supabase') return
      const unsubscribe = subscribe((state, previous) => {
        const rejected = (error: AppError | null, before: AppError | null) =>
          error !== null && error !== before && error.kind === 'auth'
        if (
          get().status === 'signed_in' &&
          (rejected(state.sync.lastError, previous.sync.lastError) ||
            rejected(state.loadError, previous.loadError))
        ) {
          void recheckSession()
        }
      })
      options.signal?.addEventListener('abort', unsubscribe, { once: true })
    }

    const actions: AuthState['actions'] = {
      init() {
        initPromise ??= (async () => {
          if (options.signal?.aborted) return
          let unsubscribe: () => void
          try {
            unsubscribe = service().onChange((user, event) => applyUser(user, event))
          } catch (error) {
            // No auth client (e.g. it refused the configuration): never a splash forever.
            console.error('[cairn] Authentication could not start.', error)
            applyUser(null)
            return
          }
          options.signal?.addEventListener('abort', unsubscribe, { once: true })
          watchSessionRejections()
          await syncUser()
        })()
        return initPromise
      },
      async signIn(email, password) {
        const problem = credentialsError(email, password)
        if (problem) return problem
        try {
          await service().signIn(trimmed(email), password)
        } catch (error) {
          return failed(toAppError(error))
        }
        await syncUser()
        return OK
      },
      async signUp(email, password) {
        const problem = credentialsError(email, password)
        if (problem) return problem
        try {
          const result = await service().signUp(trimmed(email), password)
          if (!result.needsConfirmation) await syncUser()
          return { ok: true, value: result }
        } catch (error) {
          return failed(toAppError(error))
        }
      },
      async signOut() {
        // Changes made just before signing out are still saved (they would be dropped by the reset).
        await whenWritesSaved(options.workspace, flushTimeoutMs)
        let failure: AppError | null = null
        try {
          await service().signOut()
        } catch (error) {
          failure = toAppError(error)
        }
        await syncUser()
        // Telling the server can fail (offline) after this device already dropped its session:
        // the user is signed out here, which is what they asked for.
        return failure && get().status !== 'signed_out' ? failed(failure) : OK
      },
      async sendPasswordReset(email) {
        const problem = credentialsError(email)
        if (problem) return problem
        try {
          await service().sendPasswordReset(trimmed(email))
          return OK
        } catch (error) {
          return failed(toAppError(error))
        }
      },
      async updatePassword(newPassword) {
        if (typeof newPassword !== 'string' || newPassword === '') {
          return invalid('Enter a new password.')
        }
        try {
          await service().updatePassword(newPassword)
        } catch (error) {
          return failed(toAppError(error))
        }
        set({ passwordRecovery: false })
        return OK
      },
      dismissPasswordRecovery() {
        if (get().passwordRecovery) set({ passwordRecovery: false })
      },
    }

    return {
      mode: options.mode,
      status: options.mode === 'local' ? 'signed_in' : 'loading',
      user: options.mode === 'local' ? { ...LOCAL_USER } : null,
      passwordRecovery: false,
      actions,
    }
  })
}

// ---------------------------------------------------------------------------
// App instances
// ---------------------------------------------------------------------------

const dataMode = getDataMode()
const browserStorage = getBrowserStorage()
let localRepository: LocalRepository | null = null
/** Hot module replacement re-creates the stores: the old ones stop listening. */
const lifetime = new AbortController()
import.meta.hot?.dispose(() => lifetime.abort())

/** Local mode: the stored workspace could not be read and a new one started. Tell the user. */
function reportUnreadableLocalData({ backupKey, raw }: UnreadableLocalData): void {
  notify.error("Your saved data couldn't be read", {
    id: 'cairn-unreadable-local-data',
    duration: Number.POSITIVE_INFINITY,
    description: backupKey
      ? 'A copy was kept in this browser and a new, empty workspace was started.'
      : "This browser's storage is too full to keep a copy, and your next change replaces it. Download it now to keep it.",
    action: {
      label: 'Download copy',
      onClick: () =>
        downloadTextFile(
          `cairn-unreadable-data-${todayInTimeZone(getBrowserTimeZone())}.json`,
          raw,
          'application/json',
        ),
    },
  })
}

function defaultRepository(): Repository {
  if (dataMode === 'supabase') return new SupabaseRepository(getSupabaseClient())
  if (!localRepository) {
    localRepository = new LocalRepository({
      storage: browserStorage ?? createMemoryStorage(),
      onUnreadableData: reportUnreadableLocalData,
    })
    if (!browserStorage) {
      notify.error("This browser isn't keeping your data", {
        id: 'cairn-no-local-storage',
        duration: Number.POSITIVE_INFINITY,
        description:
          'Site storage is blocked, so your changes last only until this tab is closed. Allow site data for this page to keep them.',
      })
    }
  }
  return localRepository
}

/** The workspace store (data, preferences, sync state, actions). */
export const useWorkspaceStore = createWorkspaceStore({
  mode: dataMode,
  repository: defaultRepository,
  storage: browserStorage,
  environment: typeof window === 'undefined' ? null : { window, document, navigator },
  signal: lifetime.signal,
})

/** The auth store. Call `actions.init()` once at startup (idempotent). */
export const useAuthStore = createAuthStore({
  mode: dataMode,
  auth: () => createAuthService(dataMode),
  workspace: useWorkspaceStore,
  signal: lifetime.signal,
})

if (dataMode === 'local' && isTestHooksEnabled() && typeof window !== 'undefined') {
  installTestHooks(defaultRepository() as LocalRepository, {
    onReset: () => useWorkspaceStore.getState().actions.load(),
  })
}

/** Non-hook access for event handlers and non-React modules. */
export const getWorkspaceActions = (): WorkspaceActions => useWorkspaceStore.getState().actions
