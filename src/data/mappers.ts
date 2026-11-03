/**
 * Row (Postgres, snake_case) ↔ domain (camelCase) mapping for every table — the ONLY place
 * that knows column names (docs/architecture.md §4).
 *
 * - `*FromRow` / `*ToRow` are exact inverses (round-trip safe); `user_id` is never mapped back.
 * - Insert payloads omit server-owned columns: `user_id` (default auth.uid()), `created_at`,
 *   `updated_at` and, for tasks, `completed_at` (set by trigger).
 * - Patches are mapped field by field: `undefined` = not part of the update, `null` = clear it.
 */
import type {
  BackupData,
  Dependency,
  ISODate,
  Milestone,
  MilestonePatch,
  Phase,
  PhasePatch,
  Preferences,
  Project,
  ProjectPatch,
  Task,
  TaskPatch,
  Timestamp,
  WorkspaceSnapshot,
} from '@/domain/types'

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: string
  user_id?: string
  name: string
  description: string | null
  status: Project['status']
  color: Project['color']
  start_date: ISODate | null
  due_date: ISODate | null
  schedule_mode: Project['scheduleMode']
  sort_order: string
  created_at: Timestamp
  updated_at: Timestamp
}

export interface PhaseRow {
  id: string
  user_id?: string
  project_id: string
  name: string
  sort_order: string
  created_at: Timestamp
  updated_at: Timestamp
}

export interface TaskRow {
  id: string
  user_id?: string
  project_id: string
  phase_id: string | null
  parent_task_id: string | null
  title: string
  description: string | null
  status: Task['status']
  priority: Task['priority']
  start_date: ISODate | null
  due_date: ISODate | null
  sort_order: string
  completed_at: Timestamp | null
  created_at: Timestamp
  updated_at: Timestamp
}

export interface MilestoneRow {
  id: string
  user_id?: string
  project_id: string
  phase_id: string | null
  name: string
  date: ISODate
  created_at: Timestamp
  updated_at: Timestamp
}

export interface DependencyRow {
  id: string
  user_id?: string
  project_id: string
  predecessor_id: string
  successor_id: string
  type: Dependency['type']
  created_at: Timestamp
}

export interface PreferencesRow {
  user_id?: string
  theme: Preferences['theme']
  sidebar_collapsed: boolean
  timezone: string
  week_starts_on: number
  created_at?: Timestamp
  updated_at?: Timestamp
}

type ServerOwned = 'user_id' | 'created_at' | 'updated_at'
export type ProjectInsert = Omit<ProjectRow, ServerOwned>
export type PhaseInsert = Omit<PhaseRow, ServerOwned>
export type TaskInsert = Omit<TaskRow, ServerOwned | 'completed_at'>
export type MilestoneInsert = Omit<MilestoneRow, ServerOwned>
export type DependencyInsert = Omit<DependencyRow, 'user_id' | 'created_at'>
export type PreferencesUpsert = Omit<PreferencesRow, ServerOwned>

export type ProjectUpdate = Partial<Omit<ProjectInsert, 'id'>>
export type PhaseUpdate = Partial<Pick<PhaseRow, 'name' | 'sort_order'>>
export type TaskUpdate = Partial<Omit<TaskInsert, 'id' | 'project_id'>>
export type MilestoneUpdate = Partial<Pick<MilestoneRow, 'name' | 'date' | 'phase_id'>>

/** Field → column for every patchable field (keeps patches explicit and typo-proof). */
const PROJECT_PATCH_COLUMNS = {
  name: 'name',
  description: 'description',
  status: 'status',
  color: 'color',
  startDate: 'start_date',
  dueDate: 'due_date',
  scheduleMode: 'schedule_mode',
  sortOrder: 'sort_order',
} as const satisfies Record<keyof ProjectPatch, keyof ProjectUpdate>

const PHASE_PATCH_COLUMNS = {
  name: 'name',
  sortOrder: 'sort_order',
} as const satisfies Record<keyof PhasePatch, keyof PhaseUpdate>

const TASK_PATCH_COLUMNS = {
  title: 'title',
  description: 'description',
  status: 'status',
  priority: 'priority',
  startDate: 'start_date',
  dueDate: 'due_date',
  phaseId: 'phase_id',
  parentTaskId: 'parent_task_id',
  sortOrder: 'sort_order',
} as const satisfies Record<keyof TaskPatch, keyof TaskUpdate>

const MILESTONE_PATCH_COLUMNS = {
  name: 'name',
  date: 'date',
  phaseId: 'phase_id',
} as const satisfies Record<keyof MilestonePatch, keyof MilestoneUpdate>

function mapPatch<Patch extends object, Update extends object>(
  patch: Patch,
  columns: Readonly<Record<keyof Patch, keyof Update>>,
): Update {
  const update: Record<string, unknown> = {}
  for (const field of Object.keys(columns) as (keyof Patch)[]) {
    const value = patch[field]
    if (value !== undefined) update[columns[field] as string] = value
  }
  return update as Update
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    color: row.color,
    startDate: row.start_date,
    dueDate: row.due_date,
    scheduleMode: row.schedule_mode,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
export function projectToRow(project: Project): ProjectRow {
  return {
    ...projectToInsert(project),
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  }
}
export function projectToInsert(project: Project): ProjectInsert {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    color: project.color,
    start_date: project.startDate,
    due_date: project.dueDate,
    schedule_mode: project.scheduleMode,
    sort_order: project.sortOrder,
  }
}
export function projectPatchToRow(patch: ProjectPatch): ProjectUpdate {
  return mapPatch<ProjectPatch, ProjectUpdate>(patch, PROJECT_PATCH_COLUMNS)
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export function phaseFromRow(row: PhaseRow): Phase {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
export function phaseToRow(phase: Phase): PhaseRow {
  return { ...phaseToInsert(phase), created_at: phase.createdAt, updated_at: phase.updatedAt }
}
export function phaseToInsert(phase: Phase): PhaseInsert {
  return {
    id: phase.id,
    project_id: phase.projectId,
    name: phase.name,
    sort_order: phase.sortOrder,
  }
}
export function phasePatchToRow(patch: PhasePatch): PhaseUpdate {
  return mapPatch<PhasePatch, PhaseUpdate>(patch, PHASE_PATCH_COLUMNS)
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseId: row.phase_id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    startDate: row.start_date,
    dueDate: row.due_date,
    sortOrder: row.sort_order,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
export function taskToRow(task: Task): TaskRow {
  return {
    ...taskToInsert(task),
    completed_at: task.completedAt,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  }
}
export function taskToInsert(task: Task): TaskInsert {
  return {
    id: task.id,
    project_id: task.projectId,
    phase_id: task.phaseId,
    parent_task_id: task.parentTaskId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    start_date: task.startDate,
    due_date: task.dueDate,
    sort_order: task.sortOrder,
  }
}
export function taskPatchToRow(patch: TaskPatch): TaskUpdate {
  return mapPatch<TaskPatch, TaskUpdate>(patch, TASK_PATCH_COLUMNS)
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export function milestoneFromRow(row: MilestoneRow): Milestone {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseId: row.phase_id,
    name: row.name,
    date: row.date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
export function milestoneToRow(milestone: Milestone): MilestoneRow {
  return {
    ...milestoneToInsert(milestone),
    created_at: milestone.createdAt,
    updated_at: milestone.updatedAt,
  }
}
export function milestoneToInsert(milestone: Milestone): MilestoneInsert {
  return {
    id: milestone.id,
    project_id: milestone.projectId,
    phase_id: milestone.phaseId,
    name: milestone.name,
    date: milestone.date,
  }
}
export function milestonePatchToRow(patch: MilestonePatch): MilestoneUpdate {
  return mapPatch<MilestonePatch, MilestoneUpdate>(patch, MILESTONE_PATCH_COLUMNS)
}

// ---------------------------------------------------------------------------
// Dependencies (insert/delete only; no updated_at)
// ---------------------------------------------------------------------------

export function dependencyFromRow(row: DependencyRow): Dependency {
  return {
    id: row.id,
    projectId: row.project_id,
    predecessorId: row.predecessor_id,
    successorId: row.successor_id,
    type: row.type,
    createdAt: row.created_at,
  }
}
export function dependencyToRow(dependency: Dependency): DependencyRow {
  return { ...dependencyToInsert(dependency), created_at: dependency.createdAt }
}
export function dependencyToInsert(dependency: Dependency): DependencyInsert {
  return {
    id: dependency.id,
    project_id: dependency.projectId,
    predecessor_id: dependency.predecessorId,
    successor_id: dependency.successorId,
    type: dependency.type,
  }
}

// ---------------------------------------------------------------------------
// Preferences (one row per user, upserted on user_id)
// ---------------------------------------------------------------------------

export function preferencesFromRow(row: PreferencesRow): Preferences {
  return {
    theme: row.theme,
    sidebarCollapsed: row.sidebar_collapsed,
    timezone: row.timezone,
    weekStartsOn: Number(row.week_starts_on) === 0 ? 0 : 1,
  }
}
export function preferencesToRow(preferences: Preferences): PreferencesUpsert {
  return {
    theme: preferences.theme,
    sidebar_collapsed: preferences.sidebarCollapsed,
    timezone: preferences.timezone,
    week_starts_on: preferences.weekStartsOn,
  }
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export interface WorkspaceRows {
  projects: readonly ProjectRow[]
  phases: readonly PhaseRow[]
  tasks: readonly TaskRow[]
  milestones: readonly MilestoneRow[]
  dependencies: readonly DependencyRow[]
  preferences: PreferencesRow | null
}

export function snapshotFromRows(rows: WorkspaceRows): WorkspaceSnapshot {
  return {
    projects: rows.projects.map(projectFromRow),
    phases: rows.phases.map(phaseFromRow),
    tasks: rows.tasks.map(taskFromRow),
    milestones: rows.milestones.map(milestoneFromRow),
    dependencies: rows.dependencies.map(dependencyFromRow),
    preferences: rows.preferences ? preferencesFromRow(rows.preferences) : null,
  }
}

/** `import_workspace(p_data)` payload: insert-shaped rows; tasks keep their completion time. */
export interface ImportPayload {
  projects: ProjectInsert[]
  phases: PhaseInsert[]
  tasks: (TaskInsert & { completed_at: Timestamp | null })[]
  milestones: MilestoneInsert[]
  dependencies: DependencyInsert[]
}

export function importPayloadFromBackup(data: BackupData): ImportPayload {
  return {
    projects: data.projects.map(projectToInsert),
    phases: data.phases.map(phaseToInsert),
    tasks: data.tasks.map((task) => ({ ...taskToInsert(task), completed_at: task.completedAt })),
    milestones: data.milestones.map(milestoneToInsert),
    dependencies: data.dependencies.map(dependencyToInsert),
  }
}
