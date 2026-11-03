import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import {
  makeDependency,
  makeMilestone,
  makePhase,
  makeProject,
  makeTask,
} from '@/domain/testFactories'
import type { AppErrorKind } from '@/domain/types'
import { RepositoryError } from './errors'
import { projectToRow, taskToRow, type TaskRow } from './mappers'
import { PAGE_SIZE, SupabaseRepository, toRepositoryError } from './supabaseRepository'

// ---------------------------------------------------------------------------
// A hand-written fake of the supabase-js query builder: records every call and answers
// through a responder function.
// ---------------------------------------------------------------------------

type Op = [name: string, ...args: unknown[]]

interface Call {
  table?: string
  rpc?: string
  args?: unknown
  ops: Op[]
}

interface FakeResponse {
  data?: unknown
  error?: unknown
  count?: number | null
  status?: number
}

type Responder = (call: Call) => FakeResponse | Promise<FakeResponse>

const BUILDER_METHODS = [
  'select',
  'insert',
  'update',
  'upsert',
  'delete',
  'eq',
  'order',
  'range',
  'single',
  'maybeSingle',
  'limit',
] as const

function createFakeClient(respond: Responder = () => ({ data: [] })) {
  const calls: Call[] = []
  const builder = (call: Call) => {
    calls.push(call)
    const query: Record<string, unknown> = {
      then(onFulfilled: (value: unknown) => unknown, onRejected: (reason: unknown) => unknown) {
        return Promise.resolve()
          .then(() => respond(call))
          .then((response) => ({ data: null, error: null, count: null, status: 200, ...response }))
          .then(onFulfilled, onRejected)
      },
    }
    for (const method of BUILDER_METHODS) {
      query[method] = (...args: unknown[]) => {
        call.ops.push([method, ...args])
        return query
      }
    }
    return query
  }
  const client = {
    from: (table: string) => builder({ table, ops: [] }),
    rpc: (rpc: string, args: unknown) => builder({ rpc, args, ops: [] }),
  }
  return { client: client as unknown as SupabaseClient, calls }
}

const op = (call: Call, name: string) => call.ops.find(([method]) => method === name)
const opNames = (call: Call) => call.ops.map(([method]) => method)

/** Serves `rows` honouring .range(from, to), the exact count, and an optional max_rows cap. */
function paged(rows: unknown[], options: { maxRows?: number; withCount?: boolean } = {}) {
  return (call: Call): FakeResponse => {
    const [, from, to] = op(call, 'range') as [string, number, number]
    const end = Math.min(to + 1, from + (options.maxRows ?? Infinity))
    const wantsCount =
      (op(call, 'select')?.[2] as { count?: string } | undefined)?.count === 'exact'
    return {
      data: rows.slice(from, end),
      count: wantsCount && options.withCount !== false ? rows.length : null,
    }
  }
}

async function rejection(promise: Promise<unknown>): Promise<RepositoryError> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(RepositoryError)
  return error as RepositoryError
}

const taskRows = (n: number): TaskRow[] =>
  Array.from({ length: n }, (_, i) =>
    taskToRow(makeTask({ id: `t${String(i).padStart(5, '0')}`, projectId: 'p' })),
  )

describe('loadWorkspace', () => {
  it('loads every table in parallel, ordered and paged with range()', async () => {
    const project = makeProject({ id: 'p' })
    const { client, calls } = createFakeClient((call) => {
      if (call.table === 'projects') return { data: [projectToRow(project)], count: 1 }
      if (call.table === 'user_preferences') {
        return {
          data: [
            {
              user_id: 'u',
              theme: 'dark',
              sidebar_collapsed: false,
              timezone: 'Asia/Taipei',
              week_starts_on: 1,
            },
          ],
          count: 1,
        }
      }
      return { data: [], count: 0 }
    })
    const snapshot = await new SupabaseRepository(client).loadWorkspace()

    expect(calls.map((call) => call.table)).toEqual([
      'projects',
      'phases',
      'tasks',
      'milestones',
      'task_dependencies',
      'user_preferences',
    ])
    for (const call of calls) {
      expect(op(call, 'select')).toEqual(['select', '*', { count: 'exact' }])
      expect(op(call, 'range')).toEqual(['range', 0, PAGE_SIZE - 1])
      expect(op(call, 'order')?.[1]).toBe(call.table === 'user_preferences' ? 'user_id' : 'id')
    }
    expect(snapshot.projects).toEqual([project])
    expect(snapshot.preferences).toEqual({
      theme: 'dark',
      sidebarCollapsed: false,
      timezone: 'Asia/Taipei',
      weekStartsOn: 1,
    })
  })

  it('reports a missing preferences row as null', async () => {
    const { client } = createFakeClient(() => ({ data: [], count: 0 }))
    expect((await new SupabaseRepository(client).loadWorkspace()).preferences).toBeNull()
  })

  it('pages through more than 1000 rows', async () => {
    const rows = taskRows(2500)
    const { client, calls } = createFakeClient((call) =>
      call.table === 'tasks' ? paged(rows)(call) : { data: [], count: 0 },
    )
    const snapshot = await new SupabaseRepository(client).loadWorkspace()
    expect(snapshot.tasks).toHaveLength(2500)
    expect(new Set(snapshot.tasks.map((t) => t.id)).size).toBe(2500)
    const ranges = calls.filter((c) => c.table === 'tasks').map((c) => op(c, 'range')?.slice(1))
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ])
  })

  it('never truncates when the server caps pages below PAGE_SIZE', async () => {
    const rows = taskRows(1000)
    const { client, calls } = createFakeClient((call) =>
      call.table === 'tasks' ? paged(rows, { maxRows: 400 })(call) : { data: [], count: 0 },
    )
    const snapshot = await new SupabaseRepository(client).loadWorkspace()
    expect(snapshot.tasks).toHaveLength(1000)
    const starts = calls.filter((c) => c.table === 'tasks').map((c) => op(c, 'range')?.[1])
    expect(starts).toEqual([0, 400, 800])
  })

  it('stops at a short page when no count is returned', async () => {
    const rows = taskRows(1200)
    const { client, calls } = createFakeClient((call) =>
      call.table === 'tasks' ? paged(rows, { withCount: false })(call) : { data: [] },
    )
    expect((await new SupabaseRepository(client).loadWorkspace()).tasks).toHaveLength(1200)
    expect(calls.filter((c) => c.table === 'tasks')).toHaveLength(2)
  })
})

describe('table writes', () => {
  it('inserts with .insert(payload).select().single() and maps the stored row', async () => {
    const task = makeTask({
      id: 't1',
      projectId: 'p',
      status: 'done',
      completedAt: '2026-01-01T00:00:00Z',
    })
    const stored = { ...taskToRow(task), user_id: 'u', completed_at: '2026-11-02T00:00:00+00:00' }
    const { client, calls } = createFakeClient(() => ({ data: stored }))
    const result = await new SupabaseRepository(client).insertTask(task)

    expect(calls[0].table).toBe('tasks')
    expect(opNames(calls[0])).toEqual(['insert', 'select', 'single'])
    const payload = op(calls[0], 'insert')?.[1] as Record<string, unknown>
    expect(payload).toMatchObject({ id: 't1', project_id: 'p', status: 'done' })
    for (const column of ['user_id', 'created_at', 'updated_at', 'completed_at']) {
      expect(payload).not.toHaveProperty(column)
    }
    expect(result.completedAt).toBe('2026-11-02T00:00:00+00:00')
  })

  it('uses the right table for every entity', async () => {
    const { client, calls } = createFakeClient((call) => ({
      data:
        call.table === 'projects'
          ? projectToRow(makeProject())
          : call.table === 'phases'
            ? {
                id: 'x',
                project_id: 'p',
                name: 'n',
                sort_order: 'a0',
                created_at: '',
                updated_at: '',
              }
            : call.table === 'milestones'
              ? {
                  id: 'm',
                  project_id: 'p',
                  phase_id: null,
                  name: 'n',
                  date: '2026-11-02',
                  created_at: '',
                  updated_at: '',
                }
              : {
                  id: 'd',
                  project_id: 'p',
                  predecessor_id: 'a',
                  successor_id: 'b',
                  type: 'FS',
                  created_at: '',
                },
    }))
    const repo = new SupabaseRepository(client)
    await repo.insertProject(makeProject())
    await repo.insertPhase(makePhase({ projectId: 'p' }))
    await repo.insertMilestone(makeMilestone({ projectId: 'p', date: '2026-11-02' }))
    await repo.insertDependency(
      makeDependency({ projectId: 'p', predecessorId: 'a', successorId: 'b' }),
    )
    expect(calls.map((c) => c.table)).toEqual([
      'projects',
      'phases',
      'milestones',
      'task_dependencies',
    ])
  })

  it('updates field by field filtered by id', async () => {
    const row = taskToRow(makeTask({ id: 't1', projectId: 'p' }))
    const { client, calls } = createFakeClient(() => ({ data: row }))
    await new SupabaseRepository(client).updateTask('t1', {
      title: 'New',
      phaseId: null,
      dueDate: undefined,
    })
    expect(opNames(calls[0])).toEqual(['update', 'eq', 'select', 'single'])
    expect(op(calls[0], 'update')).toEqual(['update', { title: 'New', phase_id: null }])
    expect(op(calls[0], 'eq')).toEqual(['eq', 'id', 't1'])
  })

  it('an empty patch reads the row instead of sending an empty update', async () => {
    const { client, calls } = createFakeClient(() => ({
      data: projectToRow(makeProject({ id: 'p' })),
    }))
    await new SupabaseRepository(client).updateProject('p', {})
    expect(opNames(calls[0])).toEqual(['select', 'eq', 'single'])
  })

  it('an update that matches no row (missing or not owned) is not_found', async () => {
    const { client } = createFakeClient(() => ({
      error: {
        code: 'PGRST116',
        message: 'JSON object requested, multiple (or no) rows returned',
        details: 'The result contains 0 rows',
        hint: null,
      },
      status: 406,
    }))
    const error = await rejection(
      new SupabaseRepository(client).updateMilestone('m', { name: 'x' }),
    )
    expect(error.kind).toBe('not_found')
    expect(error.message).toMatch(/milestone no longer exists/)
  })

  it('deletes by id and reports 0 deleted rows as not_found', async () => {
    let deleted: unknown[] = [{ id: 'p' }]
    const { client, calls } = createFakeClient(() => ({ data: deleted }))
    const repo = new SupabaseRepository(client)
    await repo.deleteProject('p')
    expect(calls[0].table).toBe('projects')
    expect(opNames(calls[0])).toEqual(['delete', 'eq', 'select'])
    expect(op(calls[0], 'eq')).toEqual(['eq', 'id', 'p'])
    deleted = []
    expect((await rejection(repo.deleteDependency('d'))).kind).toBe('not_found')
    expect(calls[1].table).toBe('task_dependencies')
  })

  it('upserts preferences on user_id', async () => {
    const { client, calls } = createFakeClient(() => ({
      data: {
        user_id: 'u',
        theme: 'light',
        sidebar_collapsed: true,
        timezone: 'UTC',
        week_starts_on: 0,
      },
    }))
    const result = await new SupabaseRepository(client).upsertPreferences({
      theme: 'light',
      sidebarCollapsed: true,
      timezone: 'UTC',
      weekStartsOn: 0,
    })
    expect(calls[0].table).toBe('user_preferences')
    expect(op(calls[0], 'upsert')).toEqual([
      'upsert',
      { theme: 'light', sidebar_collapsed: true, timezone: 'UTC', week_starts_on: 0 },
      { onConflict: 'user_id' },
    ])
    expect(opNames(calls[0])).toEqual(['upsert', 'select', 'single'])
    expect(result).toEqual({
      theme: 'light',
      sidebarCollapsed: true,
      timezone: 'UTC',
      weekStartsOn: 0,
    })
  })
})

describe('RPCs', () => {
  it('delete_task with the exact argument names', async () => {
    const { client, calls } = createFakeClient(() => ({ data: null }))
    const repo = new SupabaseRepository(client)
    await repo.deleteTask('t1', { keepSubtasks: true, promotedSortOrders: { s1: 'a1', s2: 'a2' } })
    await repo.deleteTask('t2', { keepSubtasks: false, promotedSortOrders: { ignored: 'x' } })
    expect(calls[0]).toMatchObject({
      rpc: 'delete_task',
      args: {
        p_task_id: 't1',
        p_keep_subtasks: true,
        p_promoted: [
          { id: 's1', sort_order: 'a1' },
          { id: 's2', sort_order: 'a2' },
        ],
      },
    })
    expect(calls[1].args).toEqual({ p_task_id: 't2', p_keep_subtasks: false, p_promoted: [] })
  })

  it('apply_task_schedule sends every key (nulls included) and maps the returned rows', async () => {
    const row = { ...taskToRow(makeTask({ id: 't1', projectId: 'p' })), due_date: '2026-11-09' }
    const { client, calls } = createFakeClient(() => ({ data: [row] }))
    const repo = new SupabaseRepository(client)
    const tasks = await repo.applySchedule([
      { taskId: 't1', startDate: null, dueDate: '2026-11-09' },
    ])
    expect(calls[0]).toMatchObject({
      rpc: 'apply_task_schedule',
      args: { p_changes: [{ id: 't1', start_date: null, due_date: '2026-11-09' }] },
    })
    expect(tasks[0]).toMatchObject({ id: 't1', dueDate: '2026-11-09' })
    expect(await repo.applySchedule([])).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('import_workspace sends snake_case rows and returns the counts', async () => {
    const { client, calls } = createFakeClient(() => ({
      data: { projects: 1, phases: 0, tasks: 2, milestones: 0, dependencies: 0 },
    }))
    const summary = await new SupabaseRepository(client).importWorkspace({
      projects: [makeProject({ id: 'p' })],
      phases: [],
      tasks: [
        makeTask({ id: 'a', projectId: 'p' }),
        makeTask({ id: 'b', projectId: 'p', parentTaskId: 'a' }),
      ],
      milestones: [],
      dependencies: [],
    })
    expect(calls[0].rpc).toBe('import_workspace')
    const payload = (calls[0].args as { p_data: Record<string, Record<string, unknown>[]> }).p_data
    expect(Object.keys(payload).sort()).toEqual([
      'dependencies',
      'milestones',
      'phases',
      'projects',
      'tasks',
    ])
    expect(payload.tasks[1]).toMatchObject({
      id: 'b',
      project_id: 'p',
      parent_task_id: 'a',
      completed_at: null,
    })
    expect(payload.projects[0]).not.toHaveProperty('user_id')
    expect(summary).toEqual({ projects: 1, phases: 0, tasks: 2, milestones: 0, dependencies: 0 })
  })
})

describe('error mapping', () => {
  const cases: [string, unknown, AppErrorKind, RegExp?][] = [
    [
      'fetch failure reported by supabase-js',
      { message: 'TypeError: Failed to fetch', code: '', details: '', hint: '' },
      'network',
      /Network error/,
    ],
    [
      'request timeout',
      {
        message: 'AbortError: signal is aborted',
        code: '',
        details: '',
        hint: 'Request was aborted',
      },
      'network',
    ],
    [
      'duplicate dependency',
      {
        code: '23505',
        message: 'duplicate key value violates unique constraint "task_dependencies_pair_key"',
      },
      'conflict',
      /dependency already exists/,
    ],
    [
      'duplicate from a trigger',
      { code: '23505', message: 'This dependency already exists' },
      'conflict',
      /^This dependency already exists\.$/,
    ],
    [
      'readable trigger message',
      { code: '23514', message: 'This dependency would create a cycle' },
      'validation',
      /^This dependency would create a cycle\.$/,
    ],
    [
      'check constraint',
      {
        code: '23514',
        message: 'new row for relation "tasks" violates check constraint "tasks_due_after_start"',
      },
      'validation',
      /before the start date/,
    ],
    [
      'foreign key',
      {
        code: '23503',
        message:
          'insert or update on table "tasks" violates foreign key constraint "tasks_phase_fk"',
      },
      'validation',
      /no longer exists/,
    ],
    [
      'not null',
      { code: '23502', message: 'null value in column "title" violates not-null constraint' },
      'validation',
      /required/,
    ],
    [
      'bad uuid',
      { code: '22P02', message: 'invalid input syntax for type uuid: "x"' },
      'validation',
    ],
    [
      'bad date',
      { code: '22007', message: 'Dates must use the YYYY-MM-DD format' },
      'validation',
      /YYYY-MM-DD/,
    ],
    [
      'impossible date',
      { code: '22008', message: 'date/time field value out of range: "2026-02-30"' },
      'validation',
      /out of range/,
    ],
    [
      'raise exception',
      { code: 'P0001', message: 'Custom rule failed' },
      'validation',
      /Custom rule failed/,
    ],
    [
      'RPC target missing',
      { code: 'P0002', message: 'Task not found' },
      'not_found',
      /^Task not found\.$/,
    ],
    [
      'RLS / privileges',
      { code: '42501', message: 'permission denied for table tasks' },
      'permission',
      /permission/,
    ],
    [
      'ownership trigger',
      { code: '42501', message: 'Rows cannot be moved to another account' },
      'permission',
      /another account/,
    ],
    ['expired JWT', { code: 'PGRST301', message: 'JWT expired' }, 'auth', /session has expired/],
    ['anything else', { code: 'XX000', message: 'internal error' }, 'unknown'],
  ]

  it.each(cases)('%s', async (_name, error, kind, message) => {
    const { client } = createFakeClient(() => ({ error, status: 400 }))
    const thrown = await rejection(new SupabaseRepository(client).insertProject(makeProject()))
    expect(thrown.kind).toBe(kind)
    if (message) expect(thrown.message).toMatch(message)
    expect(thrown.cause).toBe(error)
  })

  it('maps thrown fetch errors and RPC errors too', async () => {
    const { client } = createFakeClient(() => {
      throw new TypeError('Failed to fetch')
    })
    expect((await rejection(new SupabaseRepository(client).loadWorkspace())).kind).toBe('network')

    const rpcFailure = createFakeClient(() => ({
      error: { code: 'P0002', message: 'Some tasks could not be found. Refresh and try again.' },
    }))
    const error = await rejection(
      new SupabaseRepository(rpcFailure.client).applySchedule([
        { taskId: 'x', startDate: null, dueDate: null },
      ]),
    )
    expect(error).toMatchObject({
      kind: 'not_found',
      message: 'Some tasks could not be found. Refresh and try again.',
    })
  })

  it('uses the HTTP status when there is no code', () => {
    expect(toRepositoryError({ message: '' }, 401).kind).toBe('auth')
    expect(toRepositoryError({ message: '' }, 403).kind).toBe('permission')
    expect(toRepositoryError({ message: 'TypeError: Load failed', code: '' }, 0).kind).toBe(
      'network',
    )
  })
})
