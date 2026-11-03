/**
 * Client stores (zustand). `useWorkspaceStore` holds the normalised workspace; `useAuthStore`
 * holds the session and loads/clears the workspace on sign-in/out.
 *
 * Every write follows the contract in ./contracts.ts:
 *   validate (domain rules; failure → { kind: 'validation' }, no state change, no toast)
 *   → apply optimistically with Immer `produceWithPatches` (field-level patches)
 *   → persist through the Repository
 *   → success: reconcile with the stored rows (only entities that still exist)
 *   → failure: apply THIS change's inverse patches, set sync.lastError/canRetry, toast + Retry.
 *
 * Writes are sent one at a time in the order they were made (a FIFO queue), so the server
 * applies them in the user's order (create-then-edit never races) while the UI stays instant.
 * Several changes can be pending at once; to keep their rollbacks exact:
 * - rolling back change A skips any path a LATER pending change also wrote (that value is the
 *   newest intent) and hands A's original value to that later change, so if it fails too the
 *   field returns to its last saved value;
 * - reconciling A's stored row skips fields a later pending change wrote, updating that
 *   change's rollback value to the stored one instead.
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
import { isISODate, isValidTimeZone } from '@/domain/dates'
import { canBecomeSubtaskOf } from '@/domain/hierarchy'
import {
  bySortOrder,
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
  parseBackupFile,
  validateDateRange,
  validateDescription,
  validateName,
} from '@/domain/validation'
import { notify } from '@/lib/notify'
import { createAuthService, LOCAL_USER } from './auth'
import { getDataMode, isTestHooksEnabled } from './config'
import type {
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
  getBrowserStorage,
  installTestHooks,
  LocalRepository,
  type StorageLike,
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

/** The toast API the store needs (injectable for tests). */
export type Notifier = Pick<typeof notify, 'error'>

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
  /** Inverse patches of THIS write; their paths are the paths the write touched. */
  inverse: Patch[]
}

/** A stored row to merge into the state at `path` (['data', table, id] or ['preferences']). */
interface RowUpdate {
  path: readonly string[]
  row: object
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

function sortOrderError(value: unknown): AppError | null {
  if (value === undefined || (typeof value === 'string' && value !== '')) return null
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

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null
  return () => (promise ??= fn())
}

/** Mirrors `keyForPlacement`'s neighbour resolution: index of the gap the item goes into. */
function placementGap(sorted: readonly Ordered[], placement: Placement): number {
  const { afterId, beforeId } = placement
  if (afterId === null) return 0
  if (typeof afterId === 'string') {
    const index = sorted.findIndex((item) => item.id === afterId)
    if (index >= 0) return index + 1
  }
  if (typeof beforeId === 'string') {
    const index = sorted.findIndex((item) => item.id === beforeId)
    if (index >= 0) return index
  }
  return sorted.length
}

/** True when `item` already sits where `placement` would put it (a drop in place). */
function isAlreadyPlaced(
  item: Ordered,
  siblings: readonly Ordered[],
  placement: Placement,
): boolean {
  const sorted = sortByOrder(siblings)
  const gap = placementGap(sorted, placement)
  const before = gap > 0 ? sorted[gap - 1] : null
  const after = gap < sorted.length ? sorted[gap] : null
  return (
    (before === null || bySortOrder(before, item) < 0) &&
    (after === null || bySortOrder(item, after) < 0)
  )
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

function linkedByDependency(
  dependencies: Record<string, Dependency>,
  a: string,
  b: string,
): boolean {
  return Object.values(dependencies).some(
    (d) =>
      (d.predecessorId === a && d.successorId === b) ||
      (d.predecessorId === b && d.successorId === a),
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
  persist: (repository: Repository) => Promise<T>
  /** Stored rows to merge on success. */
  reconcile?: (value: T) => RowUpdate[]
  afterSuccess?: (value: T) => void
  onFailure?: (error: AppError) => void
  /** Re-runs the action (Retry). */
  retry: () => Promise<Result<unknown>>
  /** Background housekeeping: never toasts and never touches lastError / lastSavedAt. */
  background?: boolean
}

/** Creates an independent workspace store (the app uses `useWorkspaceStore`; tests make their own). */
export function createWorkspaceStore(options: WorkspaceStoreOptions) {
  const notifier = options.notify ?? notify
  const now = options.now ?? (() => Date.now())
  const randomId = options.randomId ?? (() => crypto.randomUUID())
  const storage = options.storage === undefined ? getBrowserStorage() : options.storage
  const environment = options.environment ?? null
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
  let lastFailedRetry: (() => Promise<Result<unknown>>) | null = null
  let lastRefreshAt = 0
  let preferencesSeeded = false
  let resyncWhenIdle = false

  const store = create<WorkspaceState>()((set, get) => {
    const isoNow = () => new Date(now()).toISOString()
    const getDoc = (): Doc => ({ data: get().data, preferences: get().preferences })
    const setDoc = (doc: Doc) => set({ data: doc.data, preferences: doc.preferences })

    function updateSync(patch: Partial<SyncState>): void {
      set((state) => ({ sync: { ...state.sync, ...patch } }))
      if (resyncWhenIdle && get().sync.pending === 0) {
        resyncWhenIdle = false
        queueMicrotask(() => void refresh({ silent: true }))
      }
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
      if (index < 0) return null // a fresh snapshot replaced the data meanwhile
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

    function onWriteFailed<T>(spec: WriteSpec<T>, error: AppError): void {
      spec.onFailure?.(error)
      if (spec.background) {
        updateSync({ pending: get().sync.pending - 1 })
        return
      }
      // Someone else changed the data (other device): fetch the current state once idle.
      if (error.kind === 'not_found' || error.kind === 'conflict') resyncWhenIdle = true
      const retryable = isRetryable(error)
      const retry = retryable ? once(spec.retry) : null
      lastFailedRetry = retry
      updateSync({ pending: get().sync.pending - 1, lastError: error, canRetry: retryable })
      notifier.error(`Couldn't ${spec.label}`, {
        id: SYNC_ERROR_TOAST_ID,
        description: error.message,
        action: retry ? { label: 'Retry', onClick: () => void runRetry(retry) } : undefined,
      })
    }

    function onWriteSucceeded<T>(spec: WriteSpec<T>): void {
      if (spec.background) {
        updateSync({ pending: get().sync.pending - 1 })
        return
      }
      lastFailedRetry = null
      updateSync({
        pending: get().sync.pending - 1,
        lastSavedAt: now(),
        lastError: null,
        canRetry: false,
      })
    }

    /** The write pipeline (see the header comment). Resolves after the server answered. */
    function write<T>(spec: WriteSpec<T>): Promise<Result<T>> {
      const startEpoch = epoch
      writeSeq += 1
      let pending: PendingWrite | null = null
      if (spec.recipe) {
        const [next, patches, inverse] = produceWithPatches(getDoc(), spec.recipe)
        if (patches.length > 0) {
          pending = { inverse }
          pendingWrites.push(pending)
          setDoc(next)
        }
      }
      updateSync({ pending: get().sync.pending + 1 })

      return enqueue(async (): Promise<Result<T>> => {
        if (startEpoch !== epoch) {
          return failed({
            kind: 'auth',
            message: 'You were signed out before this change was saved.',
          })
        }
        let value: T
        try {
          value = await spec.persist(repository())
        } catch (thrown) {
          const error = toAppError(thrown)
          if (startEpoch === epoch) {
            const later = settle(pending)
            if (pending && later) rollback(pending, later)
            onWriteFailed(spec, error)
          }
          return failed(error)
        }
        if (startEpoch === epoch) {
          const later = settle(pending)
          if (later && spec.reconcile) reconcile(spec.reconcile(value), later)
          spec.afterSuccess?.(value)
          onWriteSucceeded(spec)
        }
        return { ok: true, value }
      })
    }

    async function runRetry(retry: () => Promise<Result<unknown>>): Promise<Result> {
      if (lastFailedRetry === retry) {
        lastFailedRetry = null
        updateSync({ canRetry: false })
      }
      const result = await retry()
      if (!result.ok && result.error.kind === 'validation') {
        // The retried change no longer fits the current data; there is no form to show it.
        notifier.error("Couldn't retry", {
          id: SYNC_ERROR_TOAST_ID,
          description: result.error.message,
        })
      }
      return toVoid(result)
    }

    // -- loading ---------------------------------------------------------------

    function applySnapshot(snapshot: WorkspaceSnapshot): void {
      pendingWrites.length = 0 // the snapshot is authoritative
      const preferences = snapshot.preferences ?? defaultPreferences()
      confirmedPreferences = preferences
      set({ data: toWorkspaceData(snapshot), preferences })
    }

    /** First run on this account: save the default preferences once (never over existing ones). */
    function seedPreferences(snapshot: WorkspaceSnapshot): void {
      if (snapshot.preferences !== null || preferencesSeeded) return
      preferencesSeeded = true
      const defaults = get().preferences
      void write<Preferences>({
        label: 'save preferences',
        background: true,
        persist: (repo) => repo.upsertPreferences(defaults),
        reconcile: (stored) => [{ path: ['preferences'], row: stored }],
        afterSuccess: (stored) => {
          confirmedPreferences = stored
        },
        onFailure: () => {
          preferencesSeeded = false
        },
        retry: async () => OK,
      })
    }

    async function load(): Promise<Result> {
      const token = ++loadToken
      lastRefreshAt = now()
      set({ status: 'loading', loadError: null })
      try {
        const snapshot = await repository().loadWorkspace()
        if (token !== loadToken) return OK
        applySnapshot(snapshot)
        set((state) => ({
          status: 'ready',
          loadError: null,
          sync: { ...state.sync, lastLoadedAt: now() },
        }))
        seedPreferences(snapshot)
        return OK
      } catch (thrown) {
        if (token !== loadToken) return OK
        const error = toAppError(thrown)
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
        set((state) => ({ status: 'ready', sync: { ...state.sync, lastLoadedAt: now() } }))
        seedPreferences(snapshot)
        return OK
      } catch (thrown) {
        const error = toAppError(thrown)
        if (token !== loadToken) return OK
        if (!silent) {
          set((state) => ({ status: 'ready', sync: { ...state.sync, lastError: error } }))
          notifier.error("Couldn't refresh", {
            id: SYNC_ERROR_TOAST_ID,
            description: error.message,
          })
        }
        return failed(error)
      }
    }

    function reset(): void {
      epoch += 1
      loadToken += 1
      pendingWrites.length = 0
      lastFailedRetry = null
      preferencesSeeded = false
      resyncWhenIdle = false
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
        retry: () => createProject(input, project.id),
      })
    }

    async function updateProject(id: string, patch: ProjectPatch): Promise<Result> {
      const current = own(get().data.projects, id)
      if (!current) return missing('project')
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
      if (isAlreadyPlaced(project, siblings, placement)) return OK
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
        retry: () => createPhase(input, phase.id),
      })
    }

    async function updatePhase(id: string, patch: PhasePatch): Promise<Result> {
      const current = own(get().data.phases, id)
      if (!current) return missing('phase')
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
      if (isAlreadyPlaced(phase, siblings, placement)) return OK
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
      const verdict = canBecomeSubtaskOf(task, parent, Object.values(data.tasks))
      if (!verdict.ok) return verdict.error
      if (linkedByDependency(data.dependencies, task.id, parentId)) {
        return {
          kind: 'validation',
          message: "A task can't depend on its own parent. Remove that dependency first.",
        }
      }
      return null
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
        retry: () => createTask(input, task.id),
      })
    }

    /**
     * Validates title/dates/hierarchy. A parent change appends the task at the end of its new
     * sibling list (unless `sortOrder` is given) and moves it into the new parent's phase; a
     * top-level task's phase change also moves its subtasks. A subtask's phase always follows its
     * parent (a different `phaseId` for a subtask is ignored, like the database does).
     */
    async function updateTask(id: string, patch: TaskPatch): Promise<Result> {
      const data = get().data
      const task = own(data.tasks, id)
      if (!task) return missing('task')
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
      if (parentChanged || !isAlreadyPlaced(task, siblings, placement)) {
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
          persist: (repo) =>
            repo.deleteTask(
              id,
              keep ? { keepSubtasks: true, promotedSortOrders: promoted } : { keepSubtasks: false },
            ),
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
        retry: () => createMilestone(input, milestone.id),
      })
    }

    async function updateMilestone(id: string, patch: MilestonePatch): Promise<Result> {
      const data = get().data
      const current = own(data.milestones, id)
      if (!current) return missing('milestone')
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

    async function updatePreferences(patch: Partial<Preferences>): Promise<Result> {
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
      const changes = changedFields(get().preferences, patch)
      if (isEmpty(changes)) return OK
      return toVoid(
        await write<Preferences>({
          label: 'save preferences',
          recipe: (draft) => {
            Object.assign(draft.preferences, changes)
          },
          // Saved value = last stored preferences + this change (never another pending change).
          persist: (repo) => repo.upsertPreferences({ ...confirmedPreferences, ...changes }),
          reconcile: (stored) => [{ path: ['preferences'], row: stored }],
          afterSuccess: (stored) => {
            confirmedPreferences = stored
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

    /** Fresh ids everywhere; projects appended after the existing ones in their original order. */
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
          phaseId: ref(maps.phases, task.phaseId),
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
      const copy = remapBackup(parsed.value.data)
      return write<ImportSummary>({
        label: 'import the backup',
        persist: (repo) => repo.importWorkspace(copy),
        // Not optimistic: the copy appears once the server stored all of it.
        afterSuccess: () => {
          setDoc(
            produce(getDoc(), (draft) => {
              for (const table of [
                'projects',
                'phases',
                'tasks',
                'milestones',
                'dependencies',
              ] as const) {
                const target = draft.data[table] as Record<string, unknown>
                for (const row of copy[table]) target[row.id] = row
              }
            }),
          )
        },
        retry: () => importBackup(file),
      })
    }

    async function retryLastFailed(): Promise<Result> {
      const retry = lastFailedRetry
      if (!retry) return OK
      return runRetry(retry)
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
    store.subscribe((state, previous) => {
      const { theme, sidebarCollapsed } = state.preferences
      if (
        theme !== previous.preferences.theme ||
        sidebarCollapsed !== previous.preferences.sidebarCollapsed
      ) {
        writeUiPrefsCache(storage, state.preferences)
      }
    })
  }

  // Cross-device freshness: silent refresh on focus / visibility (throttled), and when back online.
  if (environment) {
    const autoRefresh = (force: boolean) => {
      const { status, sync, actions } = store.getState()
      if (status !== 'ready' || sync.pending > 0) return
      const last = Math.max(lastRefreshAt, sync.lastLoadedAt ?? 0)
      if (!force && now() - last < AUTO_REFRESH_INTERVAL_MS) return
      void actions.refresh({ silent: true })
    }
    const setOnline = (online: boolean) =>
      store.setState((state) => ({ sync: { ...state.sync, online } }))
    environment.window.addEventListener('focus', () => autoRefresh(false))
    environment.document?.addEventListener('visibilitychange', () => {
      if (environment.document?.visibilityState !== 'hidden') autoRefresh(false)
    })
    environment.window.addEventListener('online', () => {
      setOnline(true)
      autoRefresh(true)
    })
    environment.window.addEventListener('offline', () => setOnline(false))
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
  /** The workspace to load on sign-in and clear on sign-out. */
  workspace: Pick<StoreApi<WorkspaceState>, 'getState'>
}

function credentialsError(email: string, password?: string): { ok: false; error: AppError } | null {
  if (!/^\S+@\S+$/.test(trimmed(email))) return invalid('Enter a valid email address.')
  if (password !== undefined && password === '') return invalid('Enter your password.')
  return null
}

/** Creates an auth store wired to `workspace` (the app uses `useAuthStore`). */
export function createAuthStore(options: AuthStoreOptions) {
  const source = options.auth
  let serviceInstance: AuthService | null = typeof source === 'function' ? null : source
  const service = (): AuthService => (serviceInstance ??= (source as () => AuthService)())
  const workspace = () => options.workspace.getState().actions
  let initPromise: Promise<void> | null = null
  /** The user whose data the workspace holds (null = none loaded). */
  let workspaceUserId: string | null = null

  return create<AuthState>()((set, get) => {
    function applyUser(user: AuthUser | null): void {
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
          workspaceUserId = user.id
          void workspace().load()
        }
      } else {
        if (state.status !== 'signed_out' || state.user !== null)
          set({ status: 'signed_out', user: null })
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

    const actions: AuthState['actions'] = {
      init() {
        initPromise ??= (async () => {
          service().onChange((user) => applyUser(user))
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
        try {
          await service().signOut()
          return OK
        } catch (error) {
          return failed(toAppError(error))
        } finally {
          await syncUser()
        }
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
    }

    return {
      mode: options.mode,
      status: options.mode === 'local' ? 'signed_in' : 'loading',
      user: options.mode === 'local' ? { ...LOCAL_USER } : null,
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

function defaultRepository(): Repository {
  if (dataMode === 'supabase') return new SupabaseRepository(getSupabaseClient())
  localRepository ??= new LocalRepository({ storage: browserStorage ?? undefined })
  return localRepository
}

/** The workspace store (data, preferences, sync state, actions). */
export const useWorkspaceStore = createWorkspaceStore({
  mode: dataMode,
  repository: defaultRepository,
  storage: browserStorage,
  environment: typeof window === 'undefined' ? null : { window, document, navigator },
})

/** The auth store. Call `actions.init()` once at startup (idempotent). */
export const useAuthStore = createAuthStore({
  mode: dataMode,
  auth: () => createAuthService(dataMode),
  workspace: useWorkspaceStore,
})

if (dataMode === 'local' && isTestHooksEnabled() && typeof window !== 'undefined') {
  installTestHooks(defaultRepository() as LocalRepository, {
    onReset: () => useWorkspaceStore.getState().actions.load(),
  })
}

/** Non-hook access for event handlers and non-React modules. */
export const getWorkspaceActions = (): WorkspaceActions => useWorkspaceStore.getState().actions
