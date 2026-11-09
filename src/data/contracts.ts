/**
 * Data-layer contracts: persistence (Repository), authentication (AuthService) and the
 * public shape of the client stores. UI code depends on these types and on the hooks in
 * `./hooks.ts`; it never talks to Supabase or localStorage directly.
 */
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
  WorkspaceData,
  WorkspaceSnapshot,
} from '@/domain/types'

/** 'supabase' = cloud (Auth + Postgres + RLS); 'local' = this browser only (no keys configured). */
export type DataMode = 'supabase' | 'local'

// ---------------------------------------------------------------------------
// Repository (persistence)
// ---------------------------------------------------------------------------

/**
 * Persistence port. Implementations: SupabaseRepository (cloud) and LocalRepository
 * (localStorage; used when Supabase is not configured and in E2E tests).
 *
 * - Entities are created client-side with ids from `crypto.randomUUID()` so optimistic UI
 *   can use stable ids; the repository returns the stored row (server timestamps).
 * - Every method rejects with a `RepositoryError` (see ./errors.ts) on failure — never
 *   resolves on a failed write.
 * - Cascades mirror the database: deleting a project removes its phases/tasks/milestones/
 *   dependencies; deleting a phase ungroups its tasks/milestones; deleting a task removes its
 *   subtasks (unless promoted) and dependencies.
 */
export interface Repository {
  readonly mode: DataMode
  loadWorkspace(): Promise<WorkspaceSnapshot>

  insertProject(project: Project): Promise<Project>
  updateProject(id: string, patch: ProjectPatch): Promise<Project>
  deleteProject(id: string): Promise<void>

  insertPhase(phase: Phase): Promise<Phase>
  updatePhase(id: string, patch: PhasePatch): Promise<Phase>
  deletePhase(id: string): Promise<void>

  insertTask(task: Task): Promise<Task>
  /** When `phaseId` changes on a parent, the server also updates its subtasks' phaseId. */
  updateTask(id: string, patch: TaskPatch): Promise<Task>
  /**
   * Atomic. keepSubtasks=false: subtasks are deleted too. keepSubtasks=true: each subtask
   * becomes top-level with the sortOrder given in `promotedSortOrders` (taskId → key).
   */
  deleteTask(
    id: string,
    options: { keepSubtasks: boolean; promotedSortOrders?: Record<string, string> },
  ): Promise<void>

  insertMilestone(milestone: Milestone): Promise<Milestone>
  updateMilestone(id: string, patch: MilestonePatch): Promise<Milestone>
  deleteMilestone(id: string): Promise<void>

  insertDependency(dependency: Dependency): Promise<Dependency>
  deleteDependency(id: string): Promise<void>

  /**
   * Atomic multi-task date update (all-or-nothing). Returns the updated tasks it got back, matched
   * by id: a task missing from the answer (e.g. PostgREST `max_rows` cut it) was still updated.
   */
  applySchedule(changes: readonly ScheduleChange[]): Promise<Task[]>

  /** Saves the preferences row (one per user) and returns the stored row. */
  upsertPreferences(
    preferences: Preferences,
    options?: UpsertPreferencesOptions,
  ): Promise<Preferences>

  /** Atomic insert of an already id-remapped backup (all-or-nothing). */
  importWorkspace(data: BackupData): Promise<ImportSummary>
}

export interface UpsertPreferencesOptions {
  /**
   * Only these fields are written when the row exists (other devices' newer values of the other
   * fields stay); a missing row is created from the whole value. Default: every field.
   */
  fields?: readonly (keyof Preferences)[]
  /** Insert only: an existing row is left as it is and returned (first-run defaults). */
  onlyIfMissing?: boolean
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string
  email: string | null
}

/**
 * `unreachable`: a session may be stored on this device, but the server could not be reached to
 * confirm it (offline, a timeout, a gateway error). Not a sign-out: nothing is loaded or cleared,
 * and `retrySession()` (or the library renewing the session by itself) continues.
 */
export type AuthStatus = 'loading' | 'signed_out' | 'signed_in' | 'unreachable'

/**
 * What an auth change was. 'password_recovery' = the user opened a password-reset link: they
 * are signed in and should now choose a new password.
 */
export type AuthChangeEvent =
  | 'initial_session'
  | 'signed_in'
  | 'signed_out'
  | 'token_refreshed'
  | 'user_updated'
  | 'password_recovery'

export interface AuthService {
  readonly mode: DataMode
  getUser(): Promise<AuthUser | null>
  /** Subscribe to sign-in/out/token events. Returns an unsubscribe function. */
  onChange(callback: (user: AuthUser | null, event?: AuthChangeEvent) => void): () => void
  signIn(email: string, password: string): Promise<void>
  /** needsConfirmation = true when the project requires email confirmation before sign-in. */
  signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }>
  signOut(): Promise<void>
  sendPasswordReset(email: string): Promise<void>
  /** Sets a new password for the signed-in user (e.g. after a password-reset link). */
  updatePassword(newPassword: string): Promise<void>
  /**
   * The server rejected the current session: asks it for a new one. Resolves with the user while
   * the session lives on, null once it is over (refused; this device is signed out). Rejects when
   * the server cannot be reached. Services without it just have their session re-read.
   */
  revalidate?(): Promise<AuthUser | null>
}

export interface AuthState {
  mode: DataMode
  status: AuthStatus
  user: AuthUser | null
  /**
   * True after the user arrived through a password-reset link (they are signed in): the UI asks
   * for a new password. Cleared by a successful updatePassword, by dismissPasswordRecovery and
   * by sign-out. Always false in local mode.
   */
  passwordRecovery: boolean
  actions: {
    /** Reads the current session and subscribes to changes. Idempotent. */
    init(): Promise<void>
    signIn(email: string, password: string): Promise<Result>
    signUp(email: string, password: string): Promise<Result<{ needsConfirmation: boolean }>>
    /** Waits (briefly) for pending writes to be saved, then signs out and clears the workspace. */
    signOut(): Promise<Result>
    sendPasswordReset(email: string): Promise<Result>
    /** Validates (non-empty), saves the new password and clears passwordRecovery on success. */
    updatePassword(newPassword: string): Promise<Result>
    /** The user chose not to set a new password now (clears passwordRecovery). */
    dismissPasswordRecovery(): void
    /**
     * Reads the session again after the server could not be reached (status `unreachable`); does
     * nothing in any other status. One request per call; calls made meanwhile share it.
     */
    retrySession(): Promise<void>
  }
}

// ---------------------------------------------------------------------------
// Workspace store
// ---------------------------------------------------------------------------

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SyncState {
  /** Remote writes currently in flight. > 0 → UI shows "Saving…". */
  pending: number
  /**
   * The error to report: the newest failed write still waiting for Retry, otherwise the most
   * recent failed load or refused write not yet followed by a success. A failed write ends only
   * when it is saved, replaced by a newer change of the same data, or shown by a refresh to be
   * stored after all (its answer was lost); a save of other data does not end it. A refused write
   * (it would fail the same way again) ends with the next success or with a refresh.
   */
  lastError: AppError | null
  /** epoch ms of the last successful write */
  lastSavedAt: number | null
  /** epoch ms of the last successful load/refresh */
  lastLoadedAt: number | null
  /** navigator.onLine, kept up to date */
  online: boolean
  /** true while a failed write waits for actions.retryLastFailed() (then lastError is set too) */
  canRetry: boolean
}

/** How a write's failure is reported (the default names only the kind of change). */
export interface WriteOptions {
  /** Toast title: `Couldn't ${label}`, e.g. 'save the title of “Plan”'. */
  label?: string
  /** A second toast action next to Retry, e.g. opening what failed. */
  secondaryAction?: { label: string; onClick: () => void }
}

/**
 * Store actions. Rules every implementation follows:
 * 1. Validate first (domain validators). Validation failures return
 *    `{ ok: false, error: { kind: 'validation' } }` WITHOUT changing state and WITHOUT a toast —
 *    the caller shows inline feedback.
 * 2. Apply the change optimistically to `data` (every view updates instantly).
 * 3. Persist through the Repository. On success, reconcile with the returned rows.
 *    On failure: roll back exactly this change (Immer inverse patches), set sync.lastError,
 *    and show an error toast with a "Retry" action. Never report success for a failed write.
 *    Then re-fetch once idle: a failure without an answer (network, timeout) may still have been
 *    applied, and such a change must show up rather than look lost.
 * 4. The returned promise resolves after the server answered.
 */
export interface WorkspaceActions {
  /** Initial load after sign-in (status: loading → ready | error). */
  load(): Promise<Result>
  /** Re-fetch everything; skipped while writes are pending. silent = no loading state. */
  refresh(options?: { silent?: boolean; reportFailure?: boolean }): Promise<Result>
  /** Clears all data (sign-out). */
  reset(): void

  createProject(input: NewProjectInput): Promise<Result<Project>>
  updateProject(id: string, patch: ProjectPatch): Promise<Result>
  /** Cascades to phases, tasks, milestones and dependencies. Callers confirm first. */
  deleteProject(id: string): Promise<Result>
  /** Reorder in the projects list: place after `afterProjectId` (null = first). */
  moveProject(id: string, afterProjectId: string | null): Promise<Result>

  createPhase(input: NewPhaseInput): Promise<Result<Phase>>
  updatePhase(id: string, patch: PhasePatch): Promise<Result>
  /** Its tasks and milestones become ungrouped (phaseId = null). */
  deletePhase(id: string): Promise<Result>
  /** Place after `afterPhaseId` (null = first). */
  movePhase(id: string, afterPhaseId: string | null): Promise<Result>

  createTask(input: NewTaskInput): Promise<Result<Task>>
  /** Validates title/dates/hierarchy. A parent's phase change also moves its subtasks. */
  updateTask(id: string, patch: TaskPatch, options?: WriteOptions): Promise<Result>
  /** Drag-and-drop reorder / regroup / restatus (see MoveTaskInput). */
  moveTask(input: MoveTaskInput): Promise<Result>
  /** keepSubtasks=true promotes subtasks to top level at the parent's position. */
  deleteTask(id: string, options: { keepSubtasks: boolean }): Promise<Result>

  createMilestone(input: NewMilestoneInput): Promise<Result<Milestone>>
  updateMilestone(id: string, patch: MilestonePatch): Promise<Result>
  deleteMilestone(id: string): Promise<Result>

  /** Validates with `validateNewDependency` (self, duplicate, cycle, cross-project, hierarchy). */
  addDependency(predecessorId: string, successorId: string): Promise<Result<Dependency>>
  removeDependency(id: string): Promise<Result>

  /** Several tasks' dates in ONE atomic write (Gantt drag, auto-schedule apply). */
  applySchedule(changes: readonly ScheduleChange[], options?: WriteOptions): Promise<Result>

  updatePreferences(patch: Partial<Preferences>): Promise<Result>

  /** The backup from what is on the screen (synchronous; may hold changes not saved yet). */
  exportBackup(): BackupFile
  /**
   * The backup from what is SAVED: waits (up to 15 s) for writes in flight, then reads the
   * workspace through the write queue, so it holds every confirmed write and another device's
   * newer changes, and never an unconfirmed or rolled-back change. Fails (no file) when the writes
   * don't finish in time, the read fails, or the session changes meanwhile. Does not touch the
   * store's data, sync state or toasts. `exportedAt` is when the read started: changes made in this
   * tab before it are in the file, changes made after it (saved normally) are not.
   */
  exportSavedBackup(): Promise<Result<BackupFile>>
  /** Imports as NEW copies (fresh ids); never modifies or deletes existing data. */
  importBackup(file: BackupFile): Promise<Result<ImportSummary>>

  /**
   * Re-runs the failed writes still waiting for Retry (usually just the most recent; several
   * after an outage), one at a time in the order they were made, stopping at the first
   * that fails again. A failed write that a newer change of the same fields replaced is never
   * re-sent (it would overwrite that newer change), nor one a refresh showed the server applied.
   */
  retryLastFailed(): Promise<Result>
  /**
   * The user replaced these task fields' failed changes with something that writes nothing (typed
   * the stored value back, discarded a draft): their Retry and toast are withdrawn.
   */
  withdrawFailedChanges(taskId: string, fields: readonly string[]): void
}

export interface WorkspaceState {
  mode: DataMode
  status: LoadStatus
  loadError: AppError | null
  data: WorkspaceData
  preferences: Preferences
  sync: SyncState
  actions: WorkspaceActions
}
