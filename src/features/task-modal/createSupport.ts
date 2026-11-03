/**
 * Create-mode helpers that outlive one modal instance:
 * - the last project a task was created in (per device), the default for global "New task";
 * - "create a project first": the draft typed so far is kept while the project dialog is open and
 *   restored into a new create session for the project that was just created.
 */
import type { NewTaskDefaults } from '@/app/uiStore'
import { readJSON, writeJSON } from '@/lib/storage'
import type { TaskFormValues } from './formModel'

const LAST_PROJECT_KEY = 'cairn:new-task-project'

/** Project id of the last successful create on this device (may no longer exist). */
export function getLastProjectId(): string | null {
  const value = readJSON(LAST_PROJECT_KEY)
  return typeof value === 'string' && value !== '' ? value : null
}

export function setLastProjectId(projectId: string): void {
  writeJSON(LAST_PROJECT_KEY, projectId)
}

interface PendingProjectCreate {
  /** Projects that existed when the user chose "Create project". */
  knownProjectIds: ReadonlySet<string>
  defaults: NewTaskDefaults
  draft: TaskFormValues
}

let pending: PendingProjectCreate | null = null
/** Drafts to restore, keyed by the defaults object handed to openNewTask. */
const restoredDrafts = new WeakMap<NewTaskDefaults, TaskFormValues>()

/** Remembers the create form while the user creates a project from it. */
export function rememberDraftForProjectCreate(entry: PendingProjectCreate): void {
  pending = entry
}

/** Takes (and clears) the remembered draft, if any. */
export function takePendingProjectCreate(): PendingProjectCreate | null {
  const entry = pending
  pending = null
  return entry
}

/** New defaults for a project that was just created, with the remembered draft attached. */
export function defaultsWithDraft(
  defaults: NewTaskDefaults,
  projectId: string,
  draft: TaskFormValues,
): NewTaskDefaults {
  const next: NewTaskDefaults = { ...defaults, projectId, phaseId: null, parentTaskId: null }
  restoredDrafts.set(next, { ...draft, phaseId: null })
  return next
}

/** The draft to start a create session with (set by defaultsWithDraft). */
export function draftFor(defaults: NewTaskDefaults): TaskFormValues | undefined {
  return restoredDrafts.get(defaults)
}
