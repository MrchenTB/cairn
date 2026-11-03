/**
 * Input validation shared by forms, the store (before optimistic writes), the local
 * repository, and backup import. Uses zod v4.
 */
import { z } from 'zod'
import { isISODate } from './dates'
import { stronglyConnectedComponents } from './graph'
import {
  BACKUP_FORMAT_VERSION,
  DEPENDENCY_TYPES,
  DESCRIPTION_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PROJECT_COLORS,
  PROJECT_STATUSES,
  SCHEDULE_MODES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  THEME_PREFERENCES,
  TITLE_MAX_LENGTH,
} from './types'
import type { AppError, BackupData, BackupFile, ISODate, Result } from './types'

function validationError(message: string, cause?: unknown): AppError {
  return cause === undefined
    ? { kind: 'validation', message }
    : { kind: 'validation', message, cause }
}

/** Length in characters (code points), like PostgreSQL's char_length. */
function characterCount(value: string): number {
  let count = 0
  for (const _ of value) count++
  return count
}

function exceeds(value: string, max: number): boolean {
  // UTF-16 length is an upper bound of the code-point count: only count when it matters.
  return value.length > max && characterCount(value) > max
}

// No lookbehind: regex literals are not transpiled and older Safari cannot parse it.
const SURROGATE = /[\uD800-\uDFFF]/
const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g

/** PostgreSQL text cannot hold NUL, and its JSON input rejects unpaired UTF-16 surrogates. */
export function hasUnstorableCharacters(value: string): boolean {
  if (value.includes('\u0000')) return true
  // A surrogate left over once the valid pairs are removed is unpaired.
  return SURROGATE.test(value) && SURROGATE.test(value.replace(SURROGATE_PAIR, ''))
}

/**
 * Trimmed, 1..max chars, storable text. Returns a validation AppError or null. Callers store the
 * trimmed value (the database limits the stored length).
 */
export function validateName(value: string, max: number, label: string): AppError | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed === '') return validationError(`${label} is required.`)
  if (exceeds(trimmed, max)) {
    return validationError(`${label} must be at most ${max.toLocaleString('en-US')} characters.`)
  }
  if (hasUnstorableCharacters(trimmed)) {
    return validationError(`${label} contains an unsupported character.`)
  }
  return null
}
/** Both optional; when both set, due >= start. Also checks ISO format. */
export function validateDateRange(
  start: ISODate | null | undefined,
  due: ISODate | null | undefined,
): AppError | null {
  if (start != null && !isISODate(start)) return validationError('Start date is not a valid date.')
  if (due != null && !isISODate(due)) return validationError('Due date is not a valid date.')
  if (start != null && due != null && due < start) {
    return validationError("Due date can't be before the start date.")
  }
  return null
}
export function validateDescription(value: string | null | undefined): AppError | null {
  if (value == null) return null
  if (typeof value !== 'string') return validationError('Description must be text.')
  if (exceeds(value, DESCRIPTION_MAX_LENGTH)) {
    return validationError(
      `Description must be at most ${DESCRIPTION_MAX_LENGTH.toLocaleString('en-US')} characters.`,
    )
  }
  if (hasUnstorableCharacters(value)) {
    return validationError('Description contains an unsupported character.')
  }
  return null
}

// ---------------------------------------------------------------------------
// Backup file
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1, 'Missing id')
const sortOrderSchema = z
  .string()
  .min(1, 'Missing sort order')
  .refine(
    (value) => !hasUnstorableCharacters(value),
    'Sort order contains an unsupported character',
  )
const timestampSchema = z.iso.datetime({ offset: true, error: 'Invalid timestamp' })
const dateSchema = z.string().refine(isISODate, 'Invalid date (expected YYYY-MM-DD)')
// Trimmed first, like every other write: the database limits the stored (untrimmed) length.
const nameSchema = (max: number, label: string) =>
  z
    .string()
    .trim()
    .refine((value) => validateName(value, max, label) === null, {
      error: (issue) => validateName(issue.input as string, max, label)?.message ?? 'Invalid name',
    })
const descriptionSchema = z
  .string()
  .refine((value) => validateDescription(value) === null, {
    error: (issue) => validateDescription(issue.input as string)?.message ?? 'Invalid description',
  })
  .nullable()

const projectSchema = z.object({
  id: idSchema,
  name: nameSchema(NAME_MAX_LENGTH, 'Project name'),
  description: descriptionSchema,
  status: z.enum(PROJECT_STATUSES),
  color: z.enum(PROJECT_COLORS),
  startDate: dateSchema.nullable(),
  dueDate: dateSchema.nullable(),
  scheduleMode: z.enum(SCHEDULE_MODES),
  sortOrder: sortOrderSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

const phaseSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  name: nameSchema(NAME_MAX_LENGTH, 'Phase name'),
  sortOrder: sortOrderSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

const taskSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  phaseId: idSchema.nullable(),
  parentTaskId: idSchema.nullable(),
  title: nameSchema(TITLE_MAX_LENGTH, 'Task title'),
  description: descriptionSchema,
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  startDate: dateSchema.nullable(),
  dueDate: dateSchema.nullable(),
  sortOrder: sortOrderSchema,
  completedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

const milestoneSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  phaseId: idSchema.nullable(),
  name: nameSchema(NAME_MAX_LENGTH, 'Milestone name'),
  date: dateSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

const dependencySchema = z.object({
  id: idSchema,
  projectId: idSchema,
  predecessorId: idSchema,
  successorId: idSchema,
  type: z.enum(DEPENDENCY_TYPES),
  createdAt: timestampSchema,
})

const preferencesSchema = z.object({
  theme: z.enum(THEME_PREFERENCES),
  sidebarCollapsed: z.boolean(),
  timezone: z.string().min(1),
  weekStartsOn: z.literal([0, 1]),
})

const backupFileSchema = z.object({
  app: z.literal('cairn'),
  formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  exportedAt: timestampSchema,
  data: z.object({
    projects: z.array(projectSchema),
    phases: z.array(phaseSchema),
    tasks: z.array(taskSchema),
    milestones: z.array(milestoneSchema),
    dependencies: z.array(dependencySchema),
  }),
  // Preferences are informational in a backup: missing or unreadable ones become null.
  preferences: preferencesSchema.nullable().optional().catch(null),
})

/** At most this many problems are spelled out in the error message (all are in `cause`). */
const MAX_REPORTED_PROBLEMS = 5

function quote(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return `"${clean.length > 40 ? `${clean.slice(0, 39)}…` : clean}"`
}

/** Short, never-throwing rendering of an unexpected header value. */
function describeValue(value: unknown): string {
  if (value === undefined) return 'missing'
  if (typeof value === 'string') return quote(value)
  const printable = value === null || typeof value === 'number' || typeof value === 'boolean'
  return printable ? String(value) : `of type ${typeof value}`
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = ''
  path.forEach((segment, i) => {
    // 'data.tasks[2].title' reads as 'tasks[2].title'; a problem with `data` itself keeps its name.
    if (i === 0 && segment === 'data' && path.length > 1) return
    if (typeof segment === 'number') out += `[${segment}]`
    else out += out === '' ? String(segment) : `.${String(segment)}`
  })
  return out
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

function invalidBackup(problems: readonly string[]): Result<BackupFile> {
  const shown = problems.slice(0, MAX_REPORTED_PROBLEMS)
  const hidden = problems.length - shown.length
  const more = hidden > 0 ? ` …and ${hidden} more ${hidden === 1 ? 'problem' : 'problems'}.` : ''
  return {
    ok: false,
    error: validationError(`This backup file is invalid. ${shown.join(' ')}${more}`, {
      problems: [...problems],
    }),
  }
}

/**
 * Parses and validates an exported backup (JSON already parsed). Checks app/formatVersion,
 * every entity's shape, referential integrity inside the file (tasks → projects/phases/parents,
 * dependencies → tasks in the same project, one-level subtasks) and returns a typed BackupFile
 * that the database accepts as is. Never throws.
 *
 * Failures are `{ kind: 'validation' }` errors whose message lists the first few problems;
 * `error.cause.problems` holds all of them. Unknown extra fields are dropped and names/titles
 * are returned trimmed (as the app stores them).
 */
export function parseBackupFile(input: unknown): Result<BackupFile> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: validationError("This file isn't a Cairn backup.") }
  }
  const header = input as { app?: unknown; formatVersion?: unknown }
  if (header.app !== 'cairn') {
    return { ok: false, error: validationError("This file isn't a Cairn backup.") }
  }
  if (header.formatVersion !== BACKUP_FORMAT_VERSION) {
    return {
      ok: false,
      error: validationError(
        `Unsupported backup format version ${describeValue(header.formatVersion)} (this version of Cairn reads version ${BACKUP_FORMAT_VERSION}).`,
      ),
    }
  }

  const parsed = backupFileSchema.safeParse(input)
  if (!parsed.success) {
    return invalidBackup(
      parsed.error.issues.map((issue) => {
        const where = formatPath(issue.path)
        return sentence(where ? `${where}: ${issue.message}` : issue.message)
      }),
    )
  }

  const { app, formatVersion, exportedAt, data, preferences } = parsed.data
  const problems = findIntegrityProblems(data)
  if (problems.length > 0) return invalidBackup(problems)
  return {
    ok: true,
    value: { app, formatVersion, exportedAt, data, preferences: preferences ?? null },
  }
}

/** Referential integrity inside a shape-valid backup (mirrors the database constraints). */
function findIntegrityProblems(data: BackupData): string[] {
  const problems: string[] = []

  const indexById = <T extends { id: string }>(
    rows: readonly T[],
    kind: string,
  ): Map<string, T> => {
    const byId = new Map<string, T>()
    for (const row of rows) {
      if (byId.has(row.id)) problems.push(`Duplicate ${kind} id ${quote(row.id)}.`)
      else byId.set(row.id, row)
    }
    return byId
  }
  const projects = indexById(data.projects, 'project')
  const phases = indexById(data.phases, 'phase')
  const tasks = indexById(data.tasks, 'task')
  indexById(data.milestones, 'milestone')
  indexById(data.dependencies, 'dependency')

  for (const project of data.projects) {
    if (project.startDate && project.dueDate && project.dueDate < project.startDate) {
      problems.push(`Project ${quote(project.name)} is due before it starts.`)
    }
  }
  for (const phase of data.phases) {
    if (!projects.has(phase.projectId)) {
      problems.push(`Phase ${quote(phase.name)} belongs to a project that isn't in the file.`)
    }
  }

  const checkPhase = (label: string, projectId: string, phaseId: string | null) => {
    if (phaseId === null) return
    const phase = phases.get(phaseId)
    if (!phase) problems.push(`${label} refers to a phase that isn't in the file.`)
    else if (phase.projectId !== projectId)
      problems.push(`${label} refers to a phase of another project.`)
  }

  for (const task of data.tasks) {
    const label = `Task ${quote(task.title)}`
    if (!projects.has(task.projectId)) {
      problems.push(`${label} belongs to a project that isn't in the file.`)
    }
    checkPhase(label, task.projectId, task.phaseId)
    if (task.parentTaskId !== null) {
      const parent = tasks.get(task.parentTaskId)
      if (task.parentTaskId === task.id) problems.push(`${label} is its own parent.`)
      else if (!parent) problems.push(`${label} refers to a parent task that isn't in the file.`)
      else if (parent.projectId !== task.projectId) {
        problems.push(`${label} has a parent task in another project.`)
      } else if (parent.parentTaskId !== null) {
        problems.push(
          `${label} is nested more than one level deep (only one level of subtasks is supported).`,
        )
      }
    }
    if (task.startDate && task.dueDate && task.dueDate < task.startDate) {
      problems.push(`${label} is due before it starts.`)
    }
  }

  for (const milestone of data.milestones) {
    const label = `Milestone ${quote(milestone.name)}`
    if (!projects.has(milestone.projectId)) {
      problems.push(`${label} belongs to a project that isn't in the file.`)
    }
    checkPhase(label, milestone.projectId, milestone.phaseId)
  }

  // Dependencies: endpoints exist, same project, no self/hierarchy/duplicate edges, no cycles.
  const nodeIndex = new Map<string, number>()
  const nodeTitles: string[] = []
  const successors: number[][] = []
  const nodeOf = (taskId: string, title: string): number => {
    let node = nodeIndex.get(taskId)
    if (node === undefined) {
      node = successors.length
      nodeIndex.set(taskId, node)
      nodeTitles.push(title)
      successors.push([])
    }
    return node
  }
  const pairs = new Set<string>()
  for (const dependency of data.dependencies) {
    const predecessor = tasks.get(dependency.predecessorId)
    const successor = tasks.get(dependency.successorId)
    if (!predecessor || !successor) {
      problems.push("A dependency refers to a task that isn't in the file.")
      continue
    }
    const label = `The dependency ${quote(predecessor.title)} → ${quote(successor.title)}`
    if (predecessor.id === successor.id) {
      problems.push(`Task ${quote(predecessor.title)} depends on itself.`)
    } else if (predecessor.projectId !== successor.projectId) {
      problems.push(`${label} links tasks of different projects.`)
    } else if (dependency.projectId !== predecessor.projectId) {
      problems.push(`${label} is filed under the wrong project.`)
    } else if (
      predecessor.parentTaskId === successor.id ||
      successor.parentTaskId === predecessor.id
    ) {
      problems.push(`${label} links a task to its own parent or subtask.`)
    } else if (pairs.has(`${predecessor.id}\u0000${successor.id}`)) {
      problems.push(`${label} appears more than once.`)
    } else {
      pairs.add(`${predecessor.id}\u0000${successor.id}`)
      const from = nodeOf(predecessor.id, predecessor.title)
      successors[from].push(nodeOf(successor.id, successor.title))
    }
  }
  const component = stronglyConnectedComponents(successors)
  const cycles = new Map<number, string[]>()
  component.forEach((id, node) => {
    const members = cycles.get(id)
    if (members) members.push(nodeTitles[node])
    else cycles.set(id, [nodeTitles[node]])
  })
  for (const members of cycles.values()) {
    if (members.length < 2) continue
    const names = members.slice(0, 3).map(quote).join(', ')
    problems.push(`Dependencies form a cycle between ${names}${members.length > 3 ? ', …' : ''}.`)
  }

  return problems
}
