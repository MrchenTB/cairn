/**
 * Row types, insert helpers and error assertions shared by the database tests.
 * Rows are snake_case, exactly as PostgREST returns them.
 */
import { expect } from 'vitest'
import type { DbClient } from './harness.ts'

export const TABLES = [
  'projects',
  'phases',
  'tasks',
  'milestones',
  'task_dependencies',
  'user_preferences',
] as const
export type Table = (typeof TABLES)[number]

/** RPC signatures as `regprocedure` prints them. */
export const RPC_SIGNATURES = [
  'apply_task_schedule(jsonb)',
  'delete_task(uuid,boolean,jsonb)',
  'import_workspace(jsonb)',
] as const

export interface ProjectRow {
  id: string
  user_id: string
  name: string
  description: string | null
  status: string
  color: string
  start_date: string | null
  due_date: string | null
  schedule_mode: string
  sort_order: string
  created_at: Date
  updated_at: Date
}

export interface PhaseRow {
  id: string
  user_id: string
  project_id: string
  name: string
  color: string | null
  sort_order: string
  created_at: Date
  updated_at: Date
}

export interface TaskRow {
  id: string
  user_id: string
  project_id: string
  phase_id: string | null
  parent_task_id: string | null
  title: string
  description: string | null
  status: string
  priority: string
  start_date: string | null
  due_date: string | null
  sort_order: string
  completed_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface MilestoneRow {
  id: string
  user_id: string
  project_id: string
  phase_id: string | null
  name: string
  date: string
  created_at: Date
  updated_at: Date
}

export interface DependencyRow {
  id: string
  user_id: string
  project_id: string
  predecessor_id: string
  successor_id: string
  type: string
  created_at: Date
}

export interface PreferencesRow {
  user_id: string
  theme: string
  sidebar_collapsed: boolean
  timezone: string
  week_starts_on: number
  created_at: Date
  updated_at: Date
}

type Values = Record<string, unknown>

/** `insert into public.<table> (...) values (...) returning *` with bound parameters. */
export async function insertRow<T>(client: DbClient, table: Table, values: Values): Promise<T> {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined)
  const sql =
    entries.length === 0
      ? `insert into public.${table} default values returning *`
      : `insert into public.${table} (${entries.map(([column]) => column).join(', ')}) values (${entries
          .map((_, index) => `$${index + 1}`)
          .join(', ')}) returning *`
  const { rows } = await client.query<T>(
    sql,
    entries.map(([, value]) => value),
  )
  return rows[0]
}

export const makeProject = (client: DbClient, values: Values = {}) =>
  insertRow<ProjectRow>(client, 'projects', { name: 'Project', sort_order: 'a0', ...values })

export const makePhase = (client: DbClient, projectId: string, values: Values = {}) =>
  insertRow<PhaseRow>(client, 'phases', {
    project_id: projectId,
    name: 'Phase',
    sort_order: 'a0',
    ...values,
  })

export const makeTask = (client: DbClient, projectId: string, values: Values = {}) =>
  insertRow<TaskRow>(client, 'tasks', {
    project_id: projectId,
    title: 'Task',
    sort_order: 'a0',
    ...values,
  })

export const makeMilestone = (client: DbClient, projectId: string, values: Values = {}) =>
  insertRow<MilestoneRow>(client, 'milestones', {
    project_id: projectId,
    name: 'Milestone',
    date: '2026-11-02',
    ...values,
  })

export const makeDependency = (
  client: DbClient,
  projectId: string,
  predecessorId: string,
  successorId: string,
  values: Values = {},
) =>
  insertRow<DependencyRow>(client, 'task_dependencies', {
    project_id: projectId,
    predecessor_id: predecessorId,
    successor_id: successorId,
    ...values,
  })

/** A small but complete workspace: phases, a parent with two subtasks, milestone, dependency. */
export async function seedWorkspace(client: DbClient) {
  const project = await makeProject(client, { name: 'Research' })
  const phase = await makePhase(client, project.id, { name: 'Design', sort_order: 'a0' })
  const otherPhase = await makePhase(client, project.id, { name: 'Build', sort_order: 'a1' })
  const parent = await makeTask(client, project.id, { title: 'Parent', phase_id: phase.id })
  const subtaskA = await makeTask(client, project.id, {
    title: 'Subtask A',
    parent_task_id: parent.id,
    sort_order: 'a0',
  })
  const subtaskB = await makeTask(client, project.id, {
    title: 'Subtask B',
    parent_task_id: parent.id,
    sort_order: 'a1',
  })
  const other = await makeTask(client, project.id, { title: 'Other', sort_order: 'a1' })
  const milestone = await makeMilestone(client, project.id, { phase_id: phase.id })
  const dependency = await makeDependency(client, project.id, parent.id, other.id)
  return { project, phase, otherPhase, parent, subtaskA, subtaskB, other, milestone, dependency }
}

/** Reads one row by primary key as the superuser (ignores RLS). */
export async function getRow<T>(admin: DbClient, table: Table, id: string): Promise<T | undefined> {
  const key = table === 'user_preferences' ? 'user_id' : 'id'
  const { rows } = await admin.query<T>(`select * from public.${table} where ${key} = $1`, [id])
  return rows[0]
}

/** Number of rows owned by `userId` in `table`, counted as the superuser. */
async function countOwned(admin: DbClient, table: Table, userId: string): Promise<number> {
  const { rows } = await admin.query<{ count: number }>(
    `select count(*) as count from public.${table} where user_id = $1`,
    [userId],
  )
  return rows[0].count
}

/** Owned row counts for every table, for "nothing changed" assertions. */
export async function countAllOwned(
  admin: DbClient,
  userId: string,
): Promise<Record<Table, number>> {
  const counts = await Promise.all(TABLES.map((table) => countOwned(admin, table, userId)))
  return Object.fromEntries(TABLES.map((table, index) => [table, counts[index]])) as Record<
    Table,
    number
  >
}

/**
 * Every row owned by `userId`, per table, ordered by key (read as the superuser). Equal snapshots
 * mean nothing of that user's data changed, timestamps included.
 */
export async function snapshotOwned(
  admin: DbClient,
  userId: string,
): Promise<Record<Table, Record<string, unknown>[]>> {
  const rows = await Promise.all(
    TABLES.map(async (table) => {
      const key = table === 'user_preferences' ? 'user_id' : 'id'
      const result = await admin.query(
        `select * from public.${table} where user_id = $1 order by ${key}`,
        [userId],
      )
      return result.rows
    }),
  )
  return Object.fromEntries(TABLES.map((table, index) => [table, rows[index]])) as Record<
    Table,
    Record<string, unknown>[]
  >
}

export interface PgError {
  code?: string
  message: string
  detail?: string
}

/** Awaits a promise that must reject with a Postgres error and returns that error. */
export async function catchPgError(promise: Promise<unknown>): Promise<PgError> {
  try {
    await promise
  } catch (error) {
    return error as PgError
  }
  throw new Error('Expected the statement to fail, but it succeeded')
}

/** Asserts that `promise` rejects with SQLSTATE `code` (and a message containing `message`). */
export async function expectPgError(
  promise: Promise<unknown>,
  code: string,
  message?: string | RegExp,
): Promise<void> {
  const error = await catchPgError(promise)
  expect({ code: error.code, message: error.message }).toEqual({
    code,
    message:
      message === undefined
        ? expect.any(String)
        : typeof message === 'string'
          ? expect.stringContaining(message)
          : expect.stringMatching(message),
  })
}
