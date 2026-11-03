import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  makeDependency,
  makeMilestone,
  makePhase,
  makeProject,
  makeTask,
} from '@/domain/testFactories'
import type { AppErrorKind, BackupData, Task, TaskPatch } from '@/domain/types'
import { RepositoryError } from './errors'
import {
  createMemoryStorage,
  installTestHooks,
  LOCAL_STORAGE_KEY,
  LocalRepository,
  type CairnTestHooks,
  type StorageLike,
} from './localRepository'

let storage: StorageLike
let repo: LocalRepository
let tick: number

const clock = () => new Date(Date.UTC(2026, 10, 2, 9, 0, tick++)).toISOString()

beforeEach(() => {
  tick = 0
  storage = createMemoryStorage()
  repo = new LocalRepository({ storage, now: clock })
})

async function expectError(promise: Promise<unknown>, kind: AppErrorKind, message?: RegExp) {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(RepositoryError)
  expect((error as RepositoryError).kind).toBe(kind)
  if (message) expect((error as RepositoryError).message).toMatch(message)
}

/** p1 with phases ph1/ph2; p2 (another project). */
async function seed() {
  await repo.insertProject(makeProject({ id: 'p1', sortOrder: 'a0' }))
  await repo.insertProject(makeProject({ id: 'p2', sortOrder: 'a1' }))
  await repo.insertPhase(makePhase({ id: 'ph1', projectId: 'p1', sortOrder: 'a0' }))
  await repo.insertPhase(makePhase({ id: 'ph2', projectId: 'p1', sortOrder: 'a1' }))
}

const task = (id: string, overrides: Partial<Task> = {}) =>
  makeTask({ id, projectId: 'p1', sortOrder: `a${id.length}`, ...overrides })

async function stored() {
  return repo.loadWorkspace()
}
async function storedTask(id: string) {
  return (await stored()).tasks.find((t) => t.id === id)
}

describe('persistence and copies', () => {
  it('stores under cairn:local:workspace:v1 and survives a new instance', async () => {
    await seed()
    expect(storage.getItem(LOCAL_STORAGE_KEY)).toContain('"p1"')
    const other = new LocalRepository({ storage })
    const snapshot = await other.loadWorkspace()
    expect(snapshot.projects.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
    expect(snapshot.phases).toHaveLength(2)
    expect(snapshot.preferences).toBeNull()
  })

  it('never shares objects with callers', async () => {
    await seed()
    const input = task('t1', { title: 'Original' })
    const result = await repo.insertTask(input)
    input.title = 'mutated input'
    result.title = 'mutated result'
    const snapshot = await stored()
    snapshot.tasks[0].title = 'mutated snapshot'
    expect((await storedTask('t1'))?.title).toBe('Original')
  })

  it('sets server-owned timestamps itself', async () => {
    await seed()
    const result = await repo.insertTask(
      task('t1', {
        createdAt: '2000-01-01T00:00:00Z',
        status: 'done',
        completedAt: '1999-01-01T00:00:00Z',
      }),
    )
    expect(result.createdAt).toMatch(/^2026-11-02T09:00/)
    expect(result.updatedAt).toBe(result.createdAt)
    // Like the database: a plain insert never carries completed_at, the trigger stamps it.
    expect(result.completedAt).toBe(result.createdAt)
  })

  it('sets unreadable data aside instead of overwriting it', async () => {
    storage.setItem(LOCAL_STORAGE_KEY, '{not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await stored()).projects).toEqual([])
    await repo.insertProject(makeProject({ id: 'fresh' }))
    expect((await stored()).projects.map((p) => p.id)).toEqual(['fresh'])
    warn.mockRestore()
  })
})

describe('constraints', () => {
  beforeEach(seed)

  it('validates names, descriptions, enums, dates and sort keys', async () => {
    await expectError(repo.insertProject(makeProject({ name: '   ' })), 'validation', /name/i)
    await expectError(repo.insertProject(makeProject({ name: 'x'.repeat(201) })), 'validation')
    await expectError(repo.insertTask(task('t1', { title: '' })), 'validation', /title/i)
    await expectError(
      repo.insertTask(task('t1', { description: 'x'.repeat(10_001) })),
      'validation',
    )
    await expectError(
      repo.insertTask(task('t1', { status: 'blocked' as Task['status'] })),
      'validation',
    )
    await expectError(
      repo.insertTask(task('t1', { startDate: '2026-11-05', dueDate: '2026-11-04' })),
      'validation',
      /before the start/,
    )
    await expectError(repo.insertTask(task('t1', { dueDate: '2026-02-30' })), 'validation')
    await expectError(repo.insertTask(task('t1', { sortOrder: '' })), 'validation')
    await expectError(
      repo.insertMilestone(makeMilestone({ projectId: 'p1', date: 'tomorrow' })),
      'validation',
    )
  })

  it('rejects duplicate ids and missing or foreign references', async () => {
    await repo.insertTask(task('t1'))
    await expectError(repo.insertTask(task('t1')), 'conflict')
    await expectError(repo.insertTask(task('t2', { projectId: 'nope' })), 'validation')
    // phase of another project (composite FK)
    await repo.insertPhase(makePhase({ id: 'other-phase', projectId: 'p2' }))
    await expectError(repo.insertTask(task('t3', { phaseId: 'other-phase' })), 'validation')
    await expectError(repo.insertPhase(makePhase({ projectId: 'nope' })), 'validation')
  })

  it('reports missing rows as not_found', async () => {
    await expectError(repo.updateTask('nope', { title: 'x' }), 'not_found')
    await expectError(repo.deleteTask('nope', { keepSubtasks: false }), 'not_found')
    await expectError(repo.updateProject('nope', { name: 'x' }), 'not_found')
    await expectError(repo.deletePhase('nope'), 'not_found')
    await expectError(repo.deleteMilestone('nope'), 'not_found')
    await expectError(repo.deleteDependency('nope'), 'not_found')
  })

  it('keeps id and project immutable', async () => {
    await repo.insertTask(task('t1'))
    await expectError(
      repo.updateTask('t1', { projectId: 'p2' } as TaskPatch),
      'validation',
      /another project/,
    )
    expect((await storedTask('t1'))?.projectId).toBe('p1')
  })
})

describe('triggers', () => {
  beforeEach(seed)

  it('maintains completed_at and updated_at', async () => {
    const created = await repo.insertTask(task('t1'))
    expect(created.completedAt).toBeNull()
    const done = await repo.updateTask('t1', { status: 'done' })
    expect(done.completedAt).toBe(done.updatedAt)
    expect(done.updatedAt > created.updatedAt).toBe(true)
    const renamed = await repo.updateTask('t1', { title: 'Still done', status: 'done' })
    expect(renamed.completedAt).toBe(done.completedAt)
    const reopened = await repo.updateTask('t1', { status: 'in_progress' })
    expect(reopened.completedAt).toBeNull()
    expect(created.createdAt).toBe(reopened.createdAt)
  })

  it('allows one level of subtasks in the same project only', async () => {
    await repo.insertTask(task('parent'))
    await repo.insertTask(task('child', { parentTaskId: 'parent' }))
    await expectError(
      repo.insertTask(task('grandchild', { parentTaskId: 'child' })),
      'validation',
      /one level/,
    )
    await repo.insertTask(makeTask({ id: 'elsewhere', projectId: 'p2' }))
    await expectError(
      repo.insertTask(task('cross', { parentTaskId: 'elsewhere' })),
      'validation',
      /same project/,
    )
    await expectError(repo.updateTask('parent', { parentTaskId: 'parent' }), 'validation')
    await repo.insertTask(task('other'))
    // a task that has subtasks cannot become a subtask
    await expectError(
      repo.updateTask('parent', { parentTaskId: 'other' }),
      'validation',
      /has subtasks/,
    )
  })

  it('rejects a parent change when the task depends on the new parent', async () => {
    await repo.insertTask(task('a'))
    await repo.insertTask(task('b'))
    await repo.insertDependency(
      makeDependency({ projectId: 'p1', predecessorId: 'a', successorId: 'b' }),
    )
    await expectError(repo.updateTask('b', { parentTaskId: 'a' }), 'validation', /depend/)
  })

  it('keeps a subtask in its parent phase', async () => {
    await repo.insertTask(task('parent', { phaseId: 'ph1' }))
    const child = await repo.insertTask(task('child', { parentTaskId: 'parent', phaseId: 'ph2' }))
    expect(child.phaseId).toBe('ph1')
    // a direct phase change of a subtask is forced back to the parent's phase
    expect((await repo.updateTask('child', { phaseId: 'ph2' })).phaseId).toBe('ph1')
    // the parent's phase change moves its subtasks
    await repo.updateTask('parent', { phaseId: 'ph2' })
    expect((await storedTask('child'))?.phaseId).toBe('ph2')
    // becoming a subtask adopts the new parent's phase
    await repo.insertTask(task('loner', { phaseId: null }))
    expect((await repo.updateTask('loner', { parentTaskId: 'parent' })).phaseId).toBe('ph2')
  })
})

describe('dependencies', () => {
  beforeEach(async () => {
    await seed()
    for (const id of ['a', 'b', 'c']) await repo.insertTask(task(id))
    await repo.insertTask(task('child', { parentTaskId: 'a' }))
    await repo.insertTask(makeTask({ id: 'x', projectId: 'p2' }))
  })
  const dep = (predecessorId: string, successorId: string, projectId = 'p1') =>
    makeDependency({ projectId, predecessorId, successorId })

  it('accepts a valid edge and stamps created_at', async () => {
    const created = await repo.insertDependency(dep('a', 'b'))
    expect(created.createdAt).toMatch(/^2026-11-02T09:00/)
  })

  it('rejects self, cross-project, parent/subtask, duplicate and cyclic edges', async () => {
    await expectError(repo.insertDependency(dep('a', 'a')), 'validation', /itself/)
    await expectError(repo.insertDependency(dep('a', 'x')), 'validation', /same project/)
    await expectError(repo.insertDependency(dep('child', 'a')), 'validation', /parent/)
    await repo.insertDependency(dep('a', 'b'))
    await expectError(repo.insertDependency(dep('a', 'b')), 'conflict')
    await repo.insertDependency(dep('b', 'c'))
    await expectError(repo.insertDependency(dep('c', 'a')), 'validation', /circular/)
    expect((await stored()).dependencies).toHaveLength(2)
  })
})

describe('cascades', () => {
  beforeEach(async () => {
    await seed()
    await repo.insertTask(task('parent', { phaseId: 'ph1', sortOrder: 'a1' }))
    await repo.insertTask(task('s1', { parentTaskId: 'parent', sortOrder: 'a0' }))
    await repo.insertTask(task('s2', { parentTaskId: 'parent', sortOrder: 'a1' }))
    await repo.insertTask(task('other', { phaseId: 'ph1', sortOrder: 'a2' }))
    await repo.insertMilestone(
      makeMilestone({ id: 'm1', projectId: 'p1', phaseId: 'ph1', date: '2026-12-01' }),
    )
    await repo.insertDependency(
      makeDependency({ id: 'd1', projectId: 'p1', predecessorId: 'parent', successorId: 'other' }),
    )
    await repo.insertDependency(
      makeDependency({ id: 'd2', projectId: 'p1', predecessorId: 's1', successorId: 'other' }),
    )
    await repo.insertTask(makeTask({ id: 'keep-me', projectId: 'p2' }))
  })

  it('deleting a project removes its phases, tasks, milestones and dependencies', async () => {
    await repo.deleteProject('p1')
    const snapshot = await stored()
    expect(snapshot.projects.map((p) => p.id)).toEqual(['p2'])
    expect(snapshot.phases).toEqual([])
    expect(snapshot.tasks.map((t) => t.id)).toEqual(['keep-me'])
    expect(snapshot.milestones).toEqual([])
    expect(snapshot.dependencies).toEqual([])
  })

  it('deleting a phase ungroups its tasks and milestones', async () => {
    await repo.deletePhase('ph1')
    const snapshot = await stored()
    expect(snapshot.phases.map((p) => p.id)).toEqual(['ph2'])
    expect(
      snapshot.tasks.filter((t) => t.projectId === 'p1').every((t) => t.phaseId === null),
    ).toBe(true)
    expect(snapshot.milestones[0].phaseId).toBeNull()
  })

  it('deleting a task removes its subtasks and their dependencies', async () => {
    await repo.deleteTask('parent', { keepSubtasks: false })
    const snapshot = await stored()
    expect(snapshot.tasks.map((t) => t.id).sort()).toEqual(['keep-me', 'other'])
    expect(snapshot.dependencies).toEqual([])
  })

  it('keepSubtasks promotes them with the given keys, atomically', async () => {
    await expectError(
      repo.deleteTask('parent', { keepSubtasks: true, promotedSortOrders: { s1: 'a10' } }),
      'validation',
      /do not match/,
    )
    expect(await storedTask('parent')).toBeDefined()

    await repo.deleteTask('parent', {
      keepSubtasks: true,
      promotedSortOrders: { s1: 'a1V', s2: 'a1k' },
    })
    const snapshot = await stored()
    expect(await storedTask('parent')).toBeUndefined()
    expect(await storedTask('s1')).toMatchObject({
      parentTaskId: null,
      sortOrder: 'a1V',
      phaseId: 'ph1',
    })
    expect(await storedTask('s2')).toMatchObject({ parentTaskId: null, sortOrder: 'a1k' })
    expect(snapshot.dependencies.map((d) => d.id)).toEqual(['d2'])
  })
})

describe('atomic multi-row operations', () => {
  beforeEach(async () => {
    await seed()
    await repo.insertTask(task('a', { startDate: '2026-11-02', dueDate: '2026-11-03' }))
    await repo.insertTask(task('b', { startDate: '2026-11-04', dueDate: '2026-11-05' }))
  })

  it('applySchedule updates all tasks and returns them', async () => {
    const updated = await repo.applySchedule([
      { taskId: 'a', startDate: '2026-11-10', dueDate: '2026-11-11' },
      { taskId: 'b', startDate: null, dueDate: '2026-11-20' },
    ])
    expect(updated.map((t) => [t.id, t.startDate, t.dueDate])).toEqual([
      ['a', '2026-11-10', '2026-11-11'],
      ['b', null, '2026-11-20'],
    ])
  })

  it('applySchedule changes nothing when one change is invalid or missing', async () => {
    const before = await stored()
    await expectError(
      repo.applySchedule([
        { taskId: 'a', startDate: '2026-11-10', dueDate: '2026-11-11' },
        { taskId: 'b', startDate: '2026-11-20', dueDate: '2026-11-19' },
      ]),
      'validation',
    )
    await expectError(
      repo.applySchedule([
        { taskId: 'a', startDate: '2026-11-10', dueDate: '2026-11-11' },
        { taskId: 'missing', startDate: null, dueDate: null },
      ]),
      'not_found',
    )
    await expectError(
      repo.applySchedule([
        { taskId: 'a', startDate: null, dueDate: null },
        { taskId: 'a', startDate: null, dueDate: null },
      ]),
      'validation',
      /more than once/,
    )
    expect(await stored()).toEqual(before)
  })

  it('importWorkspace inserts everything or nothing', async () => {
    const data: BackupData = {
      projects: [makeProject({ id: 'np', sortOrder: 'b0' })],
      phases: [makePhase({ id: 'nph', projectId: 'np' })],
      tasks: [
        makeTask({ id: 'nc', projectId: 'np', parentTaskId: 'nt', phaseId: null }),
        makeTask({
          id: 'nt',
          projectId: 'np',
          phaseId: 'nph',
          status: 'done',
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
      milestones: [makeMilestone({ id: 'nm', projectId: 'np', date: '2026-12-01' })],
      dependencies: [],
    }
    const before = await stored()
    const broken = {
      ...data,
      tasks: [...data.tasks, makeTask({ id: 'bad', projectId: 'np', title: ' ' })],
    }
    await expectError(repo.importWorkspace(broken), 'validation')
    const outside = { ...data, phases: [makePhase({ id: 'x', projectId: 'p1' })] }
    await expectError(repo.importWorkspace(outside), 'validation', /not part of the import/)
    expect(await stored()).toEqual(before)

    expect(await repo.importWorkspace(data)).toEqual({
      projects: 1,
      phases: 1,
      tasks: 2,
      milestones: 1,
      dependencies: 0,
    })
    // parents are inserted first; the subtask follows its parent's phase; completion time kept
    expect(await storedTask('nc')).toMatchObject({ parentTaskId: 'nt', phaseId: 'nph' })
    expect((await storedTask('nt'))?.completedAt).toBe('2026-01-01T00:00:00.000Z')
    // ids already present → conflict, nothing inserted
    await expectError(repo.importWorkspace(data), 'conflict')
    expect((await stored()).projects).toHaveLength(3)
  })
})

describe('preferences', () => {
  it('upserts one row and validates it', async () => {
    const preferences = {
      theme: 'dark',
      sidebarCollapsed: true,
      timezone: 'Asia/Taipei',
      weekStartsOn: 0,
    } as const
    expect(await repo.upsertPreferences(preferences)).toEqual(preferences)
    expect(await repo.upsertPreferences({ ...preferences, theme: 'light' })).toMatchObject({
      theme: 'light',
    })
    expect((await stored()).preferences?.theme).toBe('light')
    await expectError(
      repo.upsertPreferences({ ...preferences, weekStartsOn: 3 as 0 }),
      'validation',
    )
  })
})

describe('test hooks', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('failNextWrites rejects writes with a network error and stores nothing', async () => {
    await seed()
    repo.failNextWrites(2)
    await expectError(repo.insertTask(task('t1')), 'network')
    await expectError(repo.updateProject('p1', { name: 'Renamed' }), 'network')
    // reads are not affected
    expect((await stored()).tasks).toEqual([])
    await repo.insertTask(task('t1'))
    expect(await storedTask('t1')).toBeDefined()
  })

  it('setLatency delays every call', async () => {
    vi.useFakeTimers()
    repo.setLatency(100)
    let done = false
    const pending = repo.loadWorkspace().then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(99)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(done).toBe(true)
  })

  it('reset clears data and test settings; installTestHooks exposes them', async () => {
    await seed()
    const target: { __cairnTest?: CairnTestHooks } = {}
    const onReset = vi.fn()
    const hooks = installTestHooks(repo, { target, onReset })
    expect(target.__cairnTest).toBe(hooks)
    hooks.failNextWrites(5)
    await hooks.reset()
    expect(onReset).toHaveBeenCalledOnce()
    expect((await stored()).projects).toEqual([])
    await repo.insertProject(makeProject({ id: 'after-reset' }))
    expect((await stored()).projects).toHaveLength(1)
  })
})
