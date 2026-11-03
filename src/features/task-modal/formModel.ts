/**
 * Task Modal form model (pure, no React): the editable fields, their validation (through the
 * domain validators) and the writes that Save performs.
 *
 * Edit mode keeps only the fields the user touched (`TaskFormEdits`) on top of the live task, so
 * a change that arrives from elsewhere (another device, a view behind the modal) still shows in
 * the fields the user did not touch, and Save never writes back stale values.
 */
import type { NewTaskDefaults } from '@/app/uiStore'
import {
  DESCRIPTION_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  type ISODate,
  type NewTaskInput,
  type ScheduleChange,
  type Task,
  type TaskPatch,
  type TaskPriority,
  type TaskStatus,
} from '@/domain/types'
import { validateDateRange, validateDescription, validateName } from '@/domain/validation'

/** The fields that Save writes together. */
export interface TaskFormValues {
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  phaseId: string | null
  startDate: ISODate | null
  dueDate: ISODate | null
}

/** Fields the user changed in edit mode (absent = follow the task). */
export type TaskFormEdits = Partial<TaskFormValues>

export interface TaskFormErrors {
  title: string | null
  description: string | null
  /** Date range problem (due before start). */
  dates: string | null
}

/** Show the description counter from this many characters on. */
export const DESCRIPTION_COUNTER_FROM = Math.floor(DESCRIPTION_MAX_LENGTH * 0.9)

/** Titles are single-line: pasted line breaks become spaces. */
export function sanitizeTitle(value: string): string {
  return value.replace(/[\r\n]+/g, ' ')
}

/** Empty / whitespace-only descriptions are stored as null (same rule as the store). */
export function normalizeDescription(value: string): string | null {
  return value.trim() === '' ? null : value
}

/** Characters as the database counts them (code points). */
export function characterCount(value: string): number {
  let count = 0
  for (const _ of value) count++
  return count
}

export function valuesFromTask(task: Task): TaskFormValues {
  return {
    title: task.title,
    description: task.description ?? '',
    status: task.status,
    priority: task.priority,
    phaseId: task.phaseId,
    startDate: task.startDate,
    dueDate: task.dueDate,
  }
}

/** The values the form shows: the task with the user's edits on top. */
export function mergeEdits(task: Task, edits: TaskFormEdits): TaskFormValues {
  const values = { ...valuesFromTask(task), ...edits }
  // A subtask's phase always follows its parent; it is never edited here.
  if (task.parentTaskId !== null) values.phaseId = task.phaseId
  return values
}

export function validateTaskForm(values: TaskFormValues): TaskFormErrors {
  return {
    title: validateName(values.title, TITLE_MAX_LENGTH, 'Task title')?.message ?? null,
    description: validateDescription(normalizeDescription(values.description))?.message ?? null,
    dates: validateDateRange(values.startDate, values.dueDate)?.message ?? null,
  }
}

export function hasErrors(errors: TaskFormErrors): boolean {
  return errors.title !== null || errors.description !== null || errors.dates !== null
}

export interface TaskSaveDiff {
  /** New dates (both fields), written through planScheduleChange; null when unchanged. */
  schedule: ScheduleChange | null
  /** Every other changed field, written with updateTask. */
  patch: TaskPatch
}

/** What Save has to write for `edits` on top of `task` (only fields that really change). */
export function diffTask(task: Task, edits: TaskFormEdits): TaskSaveDiff {
  const patch: TaskPatch = {}
  if (edits.title !== undefined) {
    const title = edits.title.trim()
    if (title !== task.title) patch.title = title
  }
  if (edits.description !== undefined) {
    const description = normalizeDescription(edits.description)
    if (description !== (task.description ?? null)) patch.description = description
  }
  if (edits.status !== undefined && edits.status !== task.status) patch.status = edits.status
  if (edits.priority !== undefined && edits.priority !== task.priority) {
    patch.priority = edits.priority
  }
  if (
    edits.phaseId !== undefined &&
    task.parentTaskId === null &&
    edits.phaseId !== task.phaseId
  ) {
    patch.phaseId = edits.phaseId
  }
  const startDate = edits.startDate !== undefined ? edits.startDate : task.startDate
  const dueDate = edits.dueDate !== undefined ? edits.dueDate : task.dueDate
  const schedule =
    startDate !== task.startDate || dueDate !== task.dueDate
      ? { taskId: task.id, startDate, dueDate }
      : null
  return { schedule, patch }
}

export function isUnchanged(diff: TaskSaveDiff): boolean {
  return diff.schedule === null && Object.keys(diff.patch).length === 0
}

/** Create-mode starting values from the opener's defaults (a subtask takes its parent's phase). */
export function initialCreateValues(
  defaults: NewTaskDefaults,
  parent: Pick<Task, 'phaseId'> | null | undefined,
): TaskFormValues {
  return {
    title: '',
    description: '',
    status: defaults.status ?? 'todo',
    priority: defaults.priority ?? 'none',
    phaseId: parent ? parent.phaseId : (defaults.phaseId ?? null),
    startDate: defaults.startDate ?? null,
    dueDate: defaults.dueDate ?? null,
  }
}

/** True when the create form differs from its starting values (something would be lost). */
export function isCreateDirty(values: TaskFormValues, initial: TaskFormValues): boolean {
  return (
    values.title.trim() !== '' ||
    values.description.trim() !== '' ||
    values.status !== initial.status ||
    values.priority !== initial.priority ||
    values.phaseId !== initial.phaseId ||
    values.startDate !== initial.startDate ||
    values.dueDate !== initial.dueDate
  )
}

/** The createTask payload for the create form. */
export function buildNewTaskInput(
  values: TaskFormValues,
  context: {
    projectId: string
    parentTaskId: string | null
    placement?: NewTaskDefaults['placement']
  },
): NewTaskInput {
  const input: NewTaskInput = {
    projectId: context.projectId,
    title: values.title.trim(),
    description: normalizeDescription(values.description),
    status: values.status,
    priority: values.priority,
    startDate: values.startDate,
    dueDate: values.dueDate,
    phaseId: values.phaseId,
    parentTaskId: context.parentTaskId,
  }
  if (context.placement) input.placement = context.placement
  return input
}
