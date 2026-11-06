/**
 * Core domain types shared by every layer (domain logic, data layer, UI).
 *
 * Conventions
 * - Calendar dates (project/task/milestone dates) are `ISODate` strings ('YYYY-MM-DD').
 *   They carry NO time zone and must never be turned into a `Date` for logic except
 *   through the helpers in `src/domain/dates.ts`.
 * - Moments in time (created/updated/completed) are `Timestamp` strings (ISO 8601 with offset).
 * - `sortOrder` values are fractional-index keys (see `src/domain/ordering.ts`). Compare them
 *   with plain `<` / `>` string comparison, NEVER `localeCompare`.
 * - Field names are camelCase here; the Supabase layer maps them to snake_case columns.
 */

/** Calendar date in the form 'YYYY-MM-DD'. */
export type ISODate = string
/** ISO 8601 timestamp with offset, e.g. '2026-11-02T08:30:00.000Z'. */
export type Timestamp = string

export const PROJECT_STATUSES = ['active', 'completed', 'archived'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export const PROJECT_COLORS = [
  'gray',
  'blue',
  'violet',
  'pink',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
] as const
export type ProjectColor = (typeof PROJECT_COLORS)[number]

export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export const SCHEDULE_MODES = ['manual', 'auto'] as const
/** Gantt dependency handling: 'manual' = warn only (default); 'auto' = preview + confirm shifts. */
export type ScheduleMode = (typeof SCHEDULE_MODES)[number]

export const DEPENDENCY_TYPES = ['FS'] as const
/** V1 supports Finish-to-Start only. */
export type DependencyType = (typeof DEPENDENCY_TYPES)[number]

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const
export type ThemePreference = (typeof THEME_PREFERENCES)[number]

export const TITLE_MAX_LENGTH = 500
export const NAME_MAX_LENGTH = 200
export const DESCRIPTION_MAX_LENGTH = 10_000

export interface Project {
  id: string
  name: string
  description: string | null
  status: ProjectStatus
  color: ProjectColor
  startDate: ISODate | null
  dueDate: ISODate | null
  scheduleMode: ScheduleMode
  sortOrder: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** Optional grouping inside a project. A project never has to have phases. */
export interface Phase {
  id: string
  projectId: string
  name: string
  sortOrder: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

/**
 * A task. Hierarchy is limited to ONE level of subtasks:
 * - a task with `parentTaskId` (a subtask) cannot itself have subtasks;
 * - a subtask always belongs to the same project as its parent and carries the
 *   parent's `phaseId` (kept in sync by the data layer and the database);
 * - ordering: top-level tasks share ONE ordering space per project (regardless of phase),
 *   subtasks are ordered among their siblings (same parent).
 * Dates are both optional; when both are set, dueDate >= startDate. Dates are inclusive:
 * a task from 2026-11-02 to 2026-11-04 lasts 3 calendar days.
 */
export interface Task {
  id: string
  projectId: string
  phaseId: string | null
  parentTaskId: string | null
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  startDate: ISODate | null
  dueDate: ISODate | null
  sortOrder: string
  /** Set by the server when status becomes 'done', cleared otherwise. */
  completedAt: Timestamp | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** A single-day marker. Separate from tasks so it never affects progress. */
export interface Milestone {
  id: string
  projectId: string
  phaseId: string | null
  name: string
  date: ISODate
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** Finish-to-Start: `successor` should start after `predecessor` finishes. Same project only. */
export interface Dependency {
  id: string
  projectId: string
  predecessorId: string
  successorId: string
  type: DependencyType
  createdAt: Timestamp
}

export interface Preferences {
  theme: ThemePreference
  sidebarCollapsed: boolean
  /** IANA time zone used to decide what "today" is, e.g. 'Asia/Taipei'. */
  timezone: string
  /** 0 = Sunday, 1 = Monday. */
  weekStartsOn: 0 | 1
}

export interface WorkspaceSnapshot {
  projects: Project[]
  phases: Phase[]
  tasks: Task[]
  milestones: Milestone[]
  dependencies: Dependency[]
  /** null when the user has never saved preferences (use defaults). */
  preferences: Preferences | null
}

/** Normalised in-memory workspace used by the store and every view. */
export interface WorkspaceData {
  projects: Record<string, Project>
  phases: Record<string, Phase>
  tasks: Record<string, Task>
  milestones: Record<string, Milestone>
  dependencies: Record<string, Dependency>
}

// ---------------------------------------------------------------------------
// Inputs / patches
// ---------------------------------------------------------------------------

export interface NewProjectInput {
  name: string
  description?: string | null
  status?: ProjectStatus
  color?: ProjectColor
  startDate?: ISODate | null
  dueDate?: ISODate | null
}
export type ProjectPatch = Partial<
  Pick<
    Project,
    | 'name'
    | 'description'
    | 'status'
    | 'color'
    | 'startDate'
    | 'dueDate'
    | 'scheduleMode'
    | 'sortOrder'
  >
>

export interface NewPhaseInput {
  projectId: string
  name: string
  /** Insert after this phase id; default = append at the end. */
  afterPhaseId?: string | null
}
export type PhasePatch = Partial<Pick<Phase, 'name' | 'sortOrder'>>

export interface NewTaskInput {
  projectId: string
  title: string
  phaseId?: string | null
  parentTaskId?: string | null
  description?: string | null
  status?: TaskStatus
  priority?: TaskPriority
  startDate?: ISODate | null
  dueDate?: ISODate | null
  /**
   * Placement among siblings (top-level tasks of the project, or subtasks of the parent).
   * Default: appended at the end.
   */
  placement?: { afterId?: string | null; beforeId?: string | null }
}
export type TaskPatch = Partial<
  Pick<
    Task,
    | 'title'
    | 'description'
    | 'status'
    | 'priority'
    | 'startDate'
    | 'dueDate'
    | 'phaseId'
    | 'parentTaskId'
    | 'sortOrder'
  >
>

/**
 * Drag-and-drop move (List / Board). The data layer computes the new sortOrder from the
 * neighbours. `afterId` = the sibling that will be directly BEFORE the moved task (null = first),
 * `beforeId` = the sibling directly AFTER it (null = last). Pass whichever you know; both is best.
 * Only the provided container fields change; a Board reorder inside one column passes neither
 * `status` nor `phaseId`, so status/dates are never touched by a pure reorder.
 */
export interface MoveTaskInput {
  taskId: string
  afterId?: string | null
  beforeId?: string | null
  phaseId?: string | null
  parentTaskId?: string | null
  status?: TaskStatus
}

export interface NewMilestoneInput {
  projectId: string
  name: string
  date: ISODate
  phaseId?: string | null
}
export type MilestonePatch = Partial<Pick<Milestone, 'name' | 'date' | 'phaseId'>>

/** One task's new dates, used by Gantt drags and atomic auto-schedule writes. */
export interface ScheduleChange {
  taskId: string
  startDate: ISODate | null
  dueDate: ISODate | null
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AppErrorKind =
  'validation' | 'network' | 'auth' | 'permission' | 'not_found' | 'conflict' | 'unknown'

export interface AppError {
  kind: AppErrorKind
  /** Human readable, safe to show in the UI. */
  message: string
  cause?: unknown
}

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: AppError }

// ---------------------------------------------------------------------------
// Backup / import
// ---------------------------------------------------------------------------

export const BACKUP_FORMAT_VERSION = 1

export interface BackupData {
  projects: Project[]
  phases: Phase[]
  tasks: Task[]
  milestones: Milestone[]
  dependencies: Dependency[]
}

export interface BackupFile {
  app: 'cairn'
  formatVersion: typeof BACKUP_FORMAT_VERSION
  exportedAt: Timestamp
  data: BackupData
  preferences: Preferences | null
}

export interface ImportSummary {
  projects: number
  phases: number
  tasks: number
  milestones: number
  dependencies: number
}
