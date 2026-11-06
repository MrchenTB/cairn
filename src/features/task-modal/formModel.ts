/**
 * Create form model (pure, no React): the editable fields and their validation (through the
 * domain validators). Edit mode saves field by field instead: see autosave/.
 */
import type { NewTaskDefaults } from '@/app/uiStore'
import {
  DESCRIPTION_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  type ISODate,
  type NewTaskInput,
  type TaskPriority,
  type TaskStatus,
} from '@/domain/types'
import { validateDateRange, validateDescription, validateName } from '@/domain/validation'

/** The fields of the create form. */
export interface TaskFormValues {
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  phaseId: string | null
  startDate: ISODate | null
  dueDate: ISODate | null
}

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

/** Create-mode starting values from the opener's defaults. */
export function initialCreateValues(defaults: NewTaskDefaults): TaskFormValues {
  return {
    title: '',
    description: '',
    status: defaults.status ?? 'todo',
    priority: defaults.priority ?? 'none',
    phaseId: defaults.phaseId ?? null,
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
    parentTaskId: null,
  }
  if (context.placement) input.placement = context.placement
  return input
}
