import { describe, expect, it, vi } from 'vitest'
import { bySortOrder } from '@/domain/ordering'
import {
  makeDependency,
  makeMilestone,
  makePhase,
  makeProject,
  makeTask,
} from '@/domain/testFactories'
import type {
  BackupFile,
  Dependency,
  Milestone,
  MilestonePatch,
  Phase,
  PhasePatch,
  Project,
  ProjectPatch,
  Task,
  TaskPatch,
  WorkspaceSnapshot,
} from '@/domain/types'
import { parseBackupFile } from '@/domain/validation'
import type { WorkspaceState } from './contracts'
import { DEFAULT_PREFERENCES, EMPTY_WORKSPACE } from './defaults'
import { NETWORK_ERROR_MESSAGE, RepositoryError } from './errors'
import { createMemoryStorage, LocalRepository, type StorageLike } from './localRepository'
import {
  AUTO_REFRESH_INTERVAL_MS,
  createAuthStore,
  createWorkspaceStore,
  SYNC_ERROR_TOAST_ID,
  UI_PREFS_STORAGE_KEY,
  UNSAVED_ON_RESET_TOAST_ID,
  type WorkspaceEnvironment,
} from './store'

// ---------------------------------------------------------------------------
// Harness: a real LocalRepository (in-memory storage) behind an isolated store.
// ---------------------------------------------------------------------------

interface Rows {
  projects?: Project[]
  phases?: Phase[]
  tasks?: Task[]
  milestones?: Milestone[]
  dependencies?: Dependency[]
}

async function seed(repo: LocalRepository, rows: Rows) {
  for (const row of rows.projects ?? []) await repo.insertProject(row)
  for (const row of rows.phases ?? []) await repo.insertPhase(row)
  const tasks = [...(rows.tasks ?? [])].sort(
    (a, b) => Number(!!a.parentTaskId) - Number(!!b.parentTaskId),
  )
  for (const row of tasks) await repo.insertTask(row)
  for (const row of rows.milestones ?? []) await repo.insertMilestone(row)
  for (const row of rows.dependencies ?? []) await repo.insertDependency(row)
}

interface SetupOptions {
  rows?: Rows
  repo?: LocalRepository
  storage?: StorageLike
  uiStorage?: StorageLike
  environment?: WorkspaceEnvironment
  now?: () => number
  randomId?: () => string
  load?: boolean
  signal?: AbortSignal
}

/** Server clock far from the client clock, so reconciled timestamps are always recognisable. */
let serverTick = 0
const serverClock = () => new Date(Date.UTC(2030, 0, 1, 0, 0, 0, ++serverTick)).toISOString()

async function setup(options: SetupOptions = {}) {
  const storage = options.storage ?? createMemoryStorage()
  const repo = options.repo ?? new LocalRepository({ storage, now: serverClock })
  if (options.rows) await seed(repo, options.rows)
  const notifier = { error: vi.fn(), dismiss: vi.fn(), success: vi.fn() }
  let sequence = 0
  const store = createWorkspaceStore({
    mode: 'local',
    repository: repo,
    notify: notifier,
    storage: options.uiStorage ?? null,
    environment: options.environment,
    now: options.now,
    randomId: options.randomId ?? (() => `new-${++sequence}`),
    signal: options.signal,
  })
  const harness = {
    store,
    repo,
    storage,
    notifier,
    actions: store.getState().actions,
    state: (): WorkspaceState => store.getState(),
  }
  if (options.load !== false) {
    await harness.actions.load()
    await idle(harness)
  }
  return harness
}

type Harness = Awaited<ReturnType<typeof setup>>

async function idle(h: { state: () => WorkspaceState }) {
  await vi.waitFor(() => expect(h.state().sync.pending).toBe(0))
}

/** p1 (phases ph1, ph2; tasks a, b in ph1 and c, d in ph2) and an empty p2. */
function workspaceRows(): Rows {
  return {
    projects: [
      makeProject({ id: 'p1', name: 'Alpha', sortOrder: 'a0' }),
      makeProject({ id: 'p2', name: 'Beta', sortOrder: 'a1' }),
    ],
    phases: [
      makePhase({ id: 'ph1', projectId: 'p1', name: 'Plan', sortOrder: 'a0' }),
      makePhase({ id: 'ph2', projectId: 'p1', name: 'Build', sortOrder: 'a1' }),
    ],
    tasks: [
      makeTask({ id: 'a', projectId: 'p1', phaseId: 'ph1', title: 'A', sortOrder: 'a0' }),
      makeTask({ id: 'b', projectId: 'p1', phaseId: 'ph1', title: 'B', sortOrder: 'a1' }),
      makeTask({ id: 'c', projectId: 'p1', phaseId: 'ph2', title: 'C', sortOrder: 'a2' }),
      makeTask({ id: 'd', projectId: 'p1', phaseId: 'ph2', title: 'D', sortOrder: 'a3' }),
    ],
  }
}

const sortedIds = (rows: readonly (Task | Project | Phase)[]) =>
  [...rows].sort(bySortOrder).map((row) => row.id)
const topLevel = (h: Harness, projectId = 'p1') =>
  sortedIds(
    Object.values(h.state().data.tasks).filter((t) => t.projectId === projectId && !t.parentTaskId),
  )
const storedSnapshot = (h: Harness): Promise<WorkspaceSnapshot> =>
  new LocalRepository({ storage: h.storage }).loadWorkspace()
const storedTask = async (h: Harness, id: string) =>
  (await storedSnapshot(h)).tasks.find((t) => t.id === id)

// ---------------------------------------------------------------------------

describe('load', () => {
  it('goes idle → loading → ready and normalises the snapshot', async () => {
    const h = await setup({ rows: workspaceRows(), load: false })
    expect(h.state().status).toBe('idle')
    const loading = h.actions.load()
    expect(h.state().status).toBe('loading')
    expect(await loading).toEqual({ ok: true, value: undefined })
    expect(h.state().status).toBe('ready')
    expect(Object.keys(h.state().data.tasks).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(h.state().sync.lastLoadedAt).not.toBeNull()
  })

  it('reports a failed load as status error and recovers through refresh()', async () => {
    const h = await setup({ rows: workspaceRows(), load: false })
    vi.spyOn(h.repo, 'loadWorkspace').mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const result = await h.actions.load()
    expect(result).toMatchObject({ ok: false, error: { kind: 'network' } })
    expect(h.state()).toMatchObject({ status: 'error', loadError: { kind: 'network' } })
    expect(await h.actions.refresh()).toEqual({ ok: true, value: undefined })
    expect(h.state()).toMatchObject({ status: 'ready', loadError: null })
  })

  it('saves default preferences once when the account has none', async () => {
    const repo = new LocalRepository({ storage: createMemoryStorage() })
    const upsert = vi.spyOn(repo, 'upsertPreferences')
    const h = await setup({ repo })
    expect(upsert).toHaveBeenCalledOnce()
    // insert only: preferences another device saved meanwhile are never overwritten
    expect(upsert).toHaveBeenCalledWith({ ...DEFAULT_PREFERENCES }, { onlyIfMissing: true })
    expect((await repo.loadWorkspace()).preferences).toEqual(DEFAULT_PREFERENCES)
    await h.actions.load()
    await idle(h)
    expect(upsert).toHaveBeenCalledOnce()
    // background housekeeping is not reported as a user save
    expect(h.state().sync.lastSavedAt).toBeNull()
  })

  it('never overwrites existing preferences (new device with a different cache)', async () => {
    const stored = {
      theme: 'dark',
      sidebarCollapsed: true,
      timezone: 'Europe/Paris',
      weekStartsOn: 0,
    } as const
    const repo = new LocalRepository({ storage: createMemoryStorage() })
    await repo.upsertPreferences(stored)
    const upsert = vi.spyOn(repo, 'upsertPreferences')
    const uiStorage = createMemoryStorage({
      [UI_PREFS_STORAGE_KEY]: JSON.stringify({ theme: 'light', sidebarCollapsed: false }),
    })
    const h = await setup({ repo, uiStorage, load: false })
    expect(h.state().preferences.theme).toBe('light') // cached value before the load
    await h.actions.load()
    await idle(h)
    expect(h.state().preferences).toEqual(stored)
    expect(upsert).not.toHaveBeenCalled()
    expect(JSON.parse(uiStorage.getItem(UI_PREFS_STORAGE_KEY) ?? '')).toEqual({
      theme: 'dark',
      sidebarCollapsed: true,
    })
  })
})

describe('optimistic writes', () => {
  it('apply instantly, then reconcile with the stored row', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.setLatency(20)
    const saving = h.actions.updateTask('a', { title: '  Renamed  ' })
    expect(h.state().data.tasks.a.title).toBe('Renamed')
    expect(h.state().sync.pending).toBe(1)
    expect(await saving).toEqual({ ok: true, value: undefined })
    expect(h.state().sync).toMatchObject({ pending: 0, lastError: null, canRetry: false })
    expect(h.state().sync.lastSavedAt).not.toBeNull()
    expect(h.state().data.tasks.a).toEqual(await storedTask(h, 'a'))
  })

  it('a failed write is rolled back exactly, with a Retry toast', async () => {
    const h = await setup({ rows: workspaceRows() })
    const before = h.state().data.tasks.a
    h.repo.failNextWrites(1)
    const result = await h.actions.updateTask('a', { title: 'Lost', status: 'done' })
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'network', message: NETWORK_ERROR_MESSAGE },
    })
    expect(h.state().data.tasks.a).toEqual(before)
    expect(h.state().sync).toMatchObject({
      pending: 0,
      canRetry: true,
      lastError: { kind: 'network' },
    })
    expect(h.notifier.error).toHaveBeenCalledOnce()
    const [title, options] = h.notifier.error.mock.calls[0]
    expect(title).toBe("Couldn't update task")
    expect(options).toMatchObject({
      id: SYNC_ERROR_TOAST_ID,
      description: NETWORK_ERROR_MESSAGE,
      action: { label: 'Retry' },
    })
  })

  it('two concurrent writes, the first fails: only the first is rolled back', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(1)
    const first = h.actions.updateTask('a', { title: 'A2' })
    const second = h.actions.updateTask('b', { title: 'B2' })
    expect([h.state().data.tasks.a.title, h.state().data.tasks.b.title]).toEqual(['A2', 'B2'])
    expect(h.state().sync.pending).toBe(2)
    const [r1, r2] = await Promise.all([first, second])
    expect([r1.ok, r2.ok]).toEqual([false, true])
    expect([h.state().data.tasks.a.title, h.state().data.tasks.b.title]).toEqual(['A', 'B2'])
    expect([(await storedTask(h, 'a'))?.title, (await storedTask(h, 'b'))?.title]).toEqual([
      'A',
      'B2',
    ])
    expect(h.state().sync.pending).toBe(0)
  })

  it('two concurrent writes, the second fails: only the second is rolled back', async () => {
    const h = await setup({ rows: workspaceRows() })
    const original = h.repo.updateTask.bind(h.repo)
    vi.spyOn(h.repo, 'updateTask')
      .mockImplementationOnce((id, patch) => original(id, patch))
      .mockRejectedValueOnce(new RepositoryError('network', NETWORK_ERROR_MESSAGE))
    const [r1, r2] = await Promise.all([
      h.actions.updateTask('a', { title: 'A2' }),
      h.actions.updateTask('b', { title: 'B2' }),
    ])
    expect([r1.ok, r2.ok]).toEqual([true, false])
    expect([h.state().data.tasks.a.title, h.state().data.tasks.b.title]).toEqual(['A2', 'B'])
    expect([(await storedTask(h, 'a'))?.title, (await storedTask(h, 'b'))?.title]).toEqual([
      'A2',
      'B',
    ])
  })

  describe('two pending writes to the same field', () => {
    it('the older fails: the newer value stays (it is what the server ends up with)', async () => {
      const h = await setup({ rows: workspaceRows() })
      h.repo.setLatency(20)
      h.repo.failNextWrites(1)
      const older = h.actions.updateTask('a', { status: 'in_progress' })
      const newer = h.actions.updateTask('a', { status: 'done' })
      expect((await older).ok).toBe(false)
      // no flicker back to the old value while the newer write is still on its way
      expect(h.state().data.tasks.a.status).toBe('done')
      expect((await newer).ok).toBe(true)
      const stored = await storedTask(h, 'a')
      expect(stored?.status).toBe('done')
      expect(h.state().data.tasks.a).toEqual(stored)
    })

    it('both fail: the field returns to the last saved value', async () => {
      const h = await setup({ rows: workspaceRows() })
      const before = h.state().data.tasks.a
      h.repo.failNextWrites(2)
      await Promise.all([
        h.actions.updateTask('a', { status: 'in_progress' }),
        h.actions.updateTask('a', { status: 'done', title: 'Both lost' }),
      ])
      expect(h.state().data.tasks.a).toEqual(before)
    })

    it('the older succeeds and the newer fails: the older (stored) value comes back', async () => {
      const h = await setup({ rows: workspaceRows() })
      const original = h.repo.updateTask.bind(h.repo)
      let failNewer = () => {}
      const update = vi
        .spyOn(h.repo, 'updateTask')
        .mockImplementationOnce((id, patch) => original(id, patch))
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              failNewer = () => reject(new RepositoryError('network', NETWORK_ERROR_MESSAGE))
            }),
        )
      const older = h.actions.updateTask('a', { status: 'in_progress' })
      const newer = h.actions.updateTask('a', { status: 'done' })
      expect((await older).ok).toBe(true)
      // the older write's stored row must not overwrite the newer pending value
      expect(h.state().data.tasks.a.status).toBe('done')
      expect(h.state().data.tasks.a.completedAt).not.toBeNull()
      await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2))
      failNewer()
      expect((await newer).ok).toBe(false)
      const stored = await storedTask(h, 'a')
      expect(stored?.status).toBe('in_progress')
      expect(h.state().data.tasks.a).toEqual(stored)
    })

    it('a deleted entity is not resurrected by the reconcile of an earlier write', async () => {
      const h = await setup({ rows: workspaceRows() })
      h.repo.setLatency(5)
      await Promise.all([
        h.actions.updateTask('a', { title: 'Edited' }),
        h.actions.deleteTask('a', { keepSubtasks: false }),
      ])
      expect(h.state().data.tasks.a).toBeUndefined()
      expect(await storedTask(h, 'a')).toBeUndefined()
    })
  })

  it('a create followed at once by an edit reaches the server in order', async () => {
    const h = await setup({ rows: workspaceRows() })
    // A slow insert: without in-order sending, the edit would arrive first and fail.
    const insert = h.repo.insertTask.bind(h.repo)
    vi.spyOn(h.repo, 'insertTask').mockImplementation(async (task) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return insert(task)
    })
    const created = h.actions.createTask({ projectId: 'p1', title: 'Fresh' })
    const edited = h.actions.updateTask('new-1', { priority: 'high' })
    expect((await created).ok).toBe(true)
    expect((await edited).ok).toBe(true)
    expect(await storedTask(h, 'new-1')).toMatchObject({ title: 'Fresh', priority: 'high' })
  })
})

describe('retry', () => {
  it('retryLastFailed re-runs the failed write (same id for creates)', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(1)
    const failed = await h.actions.createTask({ projectId: 'p1', title: 'Retry me' })
    expect(failed.ok).toBe(false)
    expect(h.state().data.tasks['new-1']).toBeUndefined()
    expect(h.state().sync.canRetry).toBe(true)

    expect(await h.actions.retryLastFailed()).toEqual({ ok: true, value: undefined })
    expect(h.state().data.tasks['new-1']).toMatchObject({ title: 'Retry me' })
    expect(await storedTask(h, 'new-1')).toBeDefined()
    expect(h.state().sync).toMatchObject({ lastError: null, canRetry: false })
    // nothing left to retry
    expect(await h.actions.retryLastFailed()).toEqual({ ok: true, value: undefined })
    expect(Object.keys(h.state().data.tasks)).not.toContain('new-2')
  })

  it("the toast's Retry action re-runs the write once", async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(1)
    await h.actions.updateTask('a', { title: 'Second try' })
    const { action } = h.notifier.error.mock.calls[0][1] as { action: { onClick: () => void } }
    action.onClick()
    action.onClick()
    await vi.waitFor(async () => expect((await storedTask(h, 'a'))?.title).toBe('Second try'))
    await idle(h)
    expect(h.state().data.tasks.a.title).toBe('Second try')
    expect(h.state().sync).toMatchObject({ lastError: null, canRetry: false })
  })

  it('a successful write clears the last error', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(1)
    await h.actions.updateTask('a', { title: 'x' })
    expect(h.state().sync.lastError).not.toBeNull()
    await h.actions.updateTask('b', { title: 'y' })
    expect(h.state().sync).toMatchObject({ lastError: null, canRetry: false })
  })

  it('server rejections that would fail again offer no Retry and trigger a resync', async () => {
    const h = await setup({ rows: workspaceRows() })
    // another device deletes task "a"
    await new LocalRepository({ storage: h.storage }).deleteTask('a', { keepSubtasks: false })
    const result = await h.actions.updateTask('a', { title: 'gone' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'not_found' } })
    expect(h.state().sync.canRetry).toBe(false)
    expect(h.notifier.error.mock.calls[0][1]).toMatchObject({ action: undefined })
    await vi.waitFor(() => expect(h.state().data.tasks.a).toBeUndefined())
  })
})

describe('validation', () => {
  it('returns { kind: validation } without state change, toast or write', async () => {
    const h = await setup({
      rows: {
        ...workspaceRows(),
        tasks: [
          ...(workspaceRows().tasks ?? []),
          makeTask({ id: 'sub', projectId: 'p1', parentTaskId: 'a', sortOrder: 'a0' }),
        ],
        dependencies: [
          makeDependency({ id: 'ab', projectId: 'p1', predecessorId: 'a', successorId: 'b' }),
        ],
      },
    })
    const writes = [
      'insertTask',
      'insertProject',
      'updateTask',
      'applySchedule',
      'insertDependency',
      'upsertPreferences',
      'insertMilestone',
    ] as const
    const spies = writes.map((method) => vi.spyOn(h.repo, method))
    const data = h.state().data
    const preferences = h.state().preferences

    const results = [
      await h.actions.createTask({ projectId: 'p1', title: '   ' }),
      await h.actions.createTask({ projectId: 'missing', title: 'x' }),
      await h.actions.createTask({ projectId: 'p1', title: 'x', parentTaskId: 'sub' }),
      await h.actions.createProject({ name: 'x'.repeat(201) }),
      await h.actions.updateTask('b', { startDate: '2026-11-10', dueDate: '2026-11-01' }),
      await h.actions.updateTask('c', { parentTaskId: 'sub' }),
      await h.actions.updateTask('b', { parentTaskId: 'a' }), // b depends on a
      await h.actions.moveTask({ taskId: 'a', parentTaskId: 'c' }), // a has a subtask
      await h.actions.applySchedule([
        { taskId: 'a', startDate: '2026-11-10', dueDate: '2026-11-09' },
      ]),
      await h.actions.addDependency('a', 'a'),
      await h.actions.addDependency('b', 'a'), // cycle
      await h.actions.addDependency('a', 'sub'), // parent/subtask
      await h.actions.updatePreferences({ timezone: 'Mars/Olympus_Mons' }),
      await h.actions.createMilestone({ projectId: 'p1', name: 'M', date: '2026-02-30' }),
    ]
    for (const result of results)
      expect(result).toMatchObject({ ok: false, error: { kind: 'validation' } })
    expect(h.state().data).toBe(data)
    expect(h.state().preferences).toBe(preferences)
    expect(h.notifier.error).not.toHaveBeenCalled()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    expect(h.state().sync).toMatchObject({ pending: 0, lastError: null })
  })

  it('unknown ids are not_found (no toast); no-op changes skip the write', async () => {
    const h = await setup({ rows: workspaceRows() })
    const update = vi.spyOn(h.repo, 'updateTask')
    expect(await h.actions.updateTask('nope', { title: 'x' })).toMatchObject({
      error: { kind: 'not_found' },
    })
    expect(await h.actions.deleteProject('nope')).toMatchObject({ error: { kind: 'not_found' } })
    expect(await h.actions.updateTask('a', { title: 'A', status: 'todo' })).toEqual({
      ok: true,
      value: undefined,
    })
    expect(
      await h.actions.applySchedule([{ taskId: 'a', startDate: null, dueDate: null }]),
    ).toEqual({ ok: true, value: undefined })
    expect(update).not.toHaveBeenCalled()
    expect(h.notifier.error).not.toHaveBeenCalled()
  })
})

describe('phase colours', () => {
  it('createPhase takes an optional colour; updatePhase sets it, null returns to the project colour', async () => {
    const h = await setup({ rows: workspaceRows() })
    const plain = await h.actions.createPhase({ projectId: 'p1', name: 'Plain' })
    const teal = await h.actions.createPhase({ projectId: 'p1', name: 'Teal', color: 'teal' })
    if (!plain.ok || !teal.ok) throw new Error('create failed')
    expect(plain.value.color).toBeNull()
    expect(teal.value.color).toBe('teal')
    expect((await h.actions.updatePhase(plain.value.id, { color: 'violet' })).ok).toBe(true)
    expect(h.state().data.phases[plain.value.id].color).toBe('violet')
    expect((await storedSnapshot(h)).phases.find((p) => p.id === plain.value.id)?.color).toBe(
      'violet',
    )
    expect((await h.actions.updatePhase(plain.value.id, { color: null })).ok).toBe(true)
    expect(h.state().data.phases[plain.value.id].color).toBeNull()
  })

  it('refuses red and unknown colours without touching the data', async () => {
    const h = await setup({ rows: workspaceRows() })
    const before = h.state().data.phases.ph1
    for (const color of ['red', 'chartreuse', '#fff']) {
      const result = await h.actions.updatePhase('ph1', { color: color as never })
      expect(result).toMatchObject({ ok: false, error: { kind: 'validation' } })
      expect(
        (await h.actions.createPhase({ projectId: 'p1', name: 'X', color: color as never })).ok,
      ).toBe(false)
    }
    expect(h.state().data.phases.ph1).toEqual(before)
  })

  it('deleting a phase puts its tasks back on the project colour (no phase, no phase colour)', async () => {
    const h = await setup({ rows: workspaceRows() })
    await h.actions.updatePhase('ph1', { color: 'pink' })
    await h.actions.deletePhase('ph1')
    expect(h.state().data.phases.ph1).toBeUndefined()
    expect(Object.values(h.state().data.tasks).every((t) => t.phaseId !== 'ph1')).toBe(true)
  })
})

describe('ordering', () => {
  it('createTask honours placement among top-level tasks; createPhase/moveProject place correctly', async () => {
    const h = await setup({ rows: workspaceRows() })
    await h.actions.createTask({
      projectId: 'p1',
      title: 'Between',
      placement: { afterId: 'a', beforeId: 'b' },
    })
    await h.actions.createTask({ projectId: 'p1', title: 'Last' })
    expect(topLevel(h)).toEqual(['a', 'new-1', 'b', 'c', 'd', 'new-2'])

    await h.actions.createPhase({ projectId: 'p1', name: 'Middle', afterPhaseId: 'ph1' })
    await h.actions.createPhase({ projectId: 'p1', name: 'End' })
    const phases = Object.values(h.state().data.phases).filter((p) => p.projectId === 'p1')
    expect(sortedIds(phases)).toEqual(['ph1', 'new-3', 'ph2', 'new-4'])
    await h.actions.movePhase('new-4', null)
    expect(sortedIds(Object.values(h.state().data.phases))[0]).toBe('new-4')

    await h.actions.moveProject('p2', null)
    expect(sortedIds(Object.values(h.state().data.projects))).toEqual(['p2', 'p1'])
    expect(sortedIds((await storedSnapshot(h)).projects)).toEqual(['p2', 'p1'])
  })

  it('moveTask across List phase groups computes the key among destination siblings', async () => {
    const h = await setup({ rows: workspaceRows() })
    await h.actions.moveTask({ taskId: 'a', phaseId: 'ph2', afterId: 'c', beforeId: 'd' })
    expect(topLevel(h)).toEqual(['b', 'c', 'a', 'd'])
    const group = (phaseId: string) =>
      sortedIds(Object.values(h.state().data.tasks).filter((t) => t.phaseId === phaseId))
    expect(group('ph1')).toEqual(['b'])
    expect(group('ph2')).toEqual(['c', 'a', 'd'])
    expect(h.state().data.tasks.a.status).toBe('todo')

    // top of the "Plan" group
    await h.actions.moveTask({ taskId: 'd', phaseId: 'ph1', beforeId: 'b' })
    expect(group('ph1')).toEqual(['d', 'b'])
    // ungroup (null phase)
    await h.actions.moveTask({ taskId: 'c', phaseId: null, afterId: null })
    expect(topLevel(h)[0]).toBe('c')
    expect(h.state().data.tasks.c.phaseId).toBeNull()

    // the stored order matches
    const stored = await storedSnapshot(h)
    expect(sortedIds(stored.tasks)).toEqual(topLevel(h))
  })

  it('moveTask between Board columns changes status and order only as asked', async () => {
    const h = await setup({
      rows: {
        projects: [makeProject({ id: 'p1' })],
        tasks: [
          makeTask({
            id: 't1',
            projectId: 'p1',
            status: 'todo',
            sortOrder: 'a0',
            dueDate: '2026-11-20',
          }),
          makeTask({ id: 't2', projectId: 'p1', status: 'in_progress', sortOrder: 'a1' }),
          makeTask({ id: 't3', projectId: 'p1', status: 'todo', sortOrder: 'a2' }),
          makeTask({ id: 't4', projectId: 'p1', status: 'in_progress', sortOrder: 'a3' }),
          makeTask({ id: 's1', projectId: 'p1', parentTaskId: 't1', sortOrder: 'a0' }),
        ],
      },
    })
    const column = (status: Task['status']) =>
      sortedIds(
        Object.values(h.state().data.tasks).filter((t) => !t.parentTaskId && t.status === status),
      )

    await h.actions.moveTask({ taskId: 't1', status: 'in_progress', afterId: 't2', beforeId: 't4' })
    expect(column('in_progress')).toEqual(['t2', 't1', 't4'])
    expect(column('todo')).toEqual(['t3'])
    expect(h.state().data.tasks.t1).toMatchObject({
      status: 'in_progress',
      completedAt: null,
      dueDate: '2026-11-20',
    })

    await h.actions.moveTask({ taskId: 't3', status: 'done' })
    expect(column('done')).toEqual(['t3'])
    expect(h.state().data.tasks.t3.completedAt).toEqual(expect.any(String))

    // pure reorder inside a column: only sortOrder is sent
    const update = vi.spyOn(h.repo, 'updateTask')
    await h.actions.moveTask({ taskId: 't4', beforeId: 't2' })
    expect(column('in_progress')).toEqual(['t4', 't2', 't1'])
    expect(update).toHaveBeenCalledWith('t4', { sortOrder: expect.any(String) })

    // dropping a card where it already is writes nothing
    await h.actions.moveTask({ taskId: 't4', beforeId: 't2' })
    expect(update).toHaveBeenCalledOnce()

    const stored = await storedSnapshot(h)
    expect(stored.tasks.find((t) => t.id === 't1')?.status).toBe('in_progress')
    expect(sortedIds(stored.tasks.filter((t) => !t.parentTaskId))).toEqual(topLevel(h))
  })

  it('moveTask re-parents a subtask among the new siblings in the new parent phase', async () => {
    const h = await setup({
      rows: {
        ...workspaceRows(),
        tasks: [
          ...(workspaceRows().tasks ?? []),
          makeTask({ id: 's1', projectId: 'p1', parentTaskId: 'a', sortOrder: 'a0' }),
          makeTask({ id: 's2', projectId: 'p1', parentTaskId: 'c', sortOrder: 'a0' }),
        ],
      },
    })
    await h.actions.moveTask({ taskId: 's1', parentTaskId: 'c', afterId: null })
    expect(h.state().data.tasks.s1).toMatchObject({ parentTaskId: 'c', phaseId: 'ph2' })
    const children = sortedIds(
      Object.values(h.state().data.tasks).filter((t) => t.parentTaskId === 'c'),
    )
    expect(children).toEqual(['s1', 's2'])
    expect(await storedTask(h, 's1')).toMatchObject({ parentTaskId: 'c', phaseId: 'ph2' })
  })
})

describe('hierarchy', () => {
  it('subtasks inherit and follow their parent phase; a re-parented task goes last', async () => {
    const h = await setup({ rows: workspaceRows() })
    const sub = await h.actions.createTask({
      projectId: 'p1',
      title: 'Sub',
      parentTaskId: 'a',
      phaseId: 'ph2',
    })
    expect(sub.ok && sub.value.phaseId).toBe('ph1')

    await h.actions.updateTask('d', { parentTaskId: 'a' })
    expect(h.state().data.tasks.d).toMatchObject({ parentTaskId: 'a', phaseId: 'ph1' })
    const children = sortedIds(
      Object.values(h.state().data.tasks).filter((t) => t.parentTaskId === 'a'),
    )
    expect(children).toEqual(['new-1', 'd'])

    const saving = h.actions.updateTask('a', { phaseId: 'ph2' })
    expect(h.state().data.tasks.d.phaseId).toBe('ph2') // optimistic cascade
    await saving
    expect((await storedTask(h, 'd'))?.phaseId).toBe('ph2')
    expect((await storedTask(h, 'new-1'))?.phaseId).toBe('ph2')

    // promoting back to top level appends at the end of the project's top-level tasks
    await h.actions.updateTask('d', { parentTaskId: null })
    expect(topLevel(h).at(-1)).toBe('d')
  })

  it('deleteTask with keepSubtasks promotes them in order at the parent position', async () => {
    const h = await setup({
      rows: {
        projects: [makeProject({ id: 'p1' })],
        phases: [makePhase({ id: 'ph1', projectId: 'p1' })],
        tasks: [
          makeTask({ id: 'x', projectId: 'p1', sortOrder: 'a0' }),
          makeTask({ id: 'P', projectId: 'p1', phaseId: 'ph1', sortOrder: 'a1' }),
          makeTask({ id: 'y', projectId: 'p1', sortOrder: 'a2' }),
          makeTask({ id: 's3', projectId: 'p1', parentTaskId: 'P', sortOrder: 'a2' }),
          makeTask({ id: 's1', projectId: 'p1', parentTaskId: 'P', sortOrder: 'a0' }),
          makeTask({ id: 's2', projectId: 'p1', parentTaskId: 'P', sortOrder: 'a1' }),
        ],
        dependencies: [
          makeDependency({ id: 'Py', projectId: 'p1', predecessorId: 'P', successorId: 'y' }),
          makeDependency({ id: 's1x', projectId: 'p1', predecessorId: 's1', successorId: 'x' }),
        ],
      },
    })
    const deleting = h.actions.deleteTask('P', { keepSubtasks: true })
    expect(topLevel(h)).toEqual(['x', 's1', 's2', 's3', 'y'])
    expect(await deleting).toEqual({ ok: true, value: undefined })
    expect(topLevel(h)).toEqual(['x', 's1', 's2', 's3', 'y'])
    for (const id of ['s1', 's2', 's3']) {
      expect(h.state().data.tasks[id]).toMatchObject({ parentTaskId: null, phaseId: 'ph1' })
    }
    expect(Object.keys(h.state().data.dependencies)).toEqual(['s1x'])
    const stored = await storedSnapshot(h)
    expect(sortedIds(stored.tasks)).toEqual(['x', 's1', 's2', 's3', 'y'])
    expect(stored.dependencies.map((d) => d.id)).toEqual(['s1x'])
  })

  it('deleteTask without keepSubtasks removes the subtasks and their dependencies', async () => {
    const h = await setup({
      rows: {
        projects: [makeProject({ id: 'p1' })],
        tasks: [
          makeTask({ id: 'x', projectId: 'p1', sortOrder: 'a0' }),
          makeTask({ id: 'P', projectId: 'p1', sortOrder: 'a1' }),
          makeTask({ id: 's1', projectId: 'p1', parentTaskId: 'P', sortOrder: 'a0' }),
        ],
        dependencies: [
          makeDependency({ id: 's1x', projectId: 'p1', predecessorId: 's1', successorId: 'x' }),
        ],
      },
    })
    await h.actions.deleteTask('P', { keepSubtasks: false })
    expect(Object.keys(h.state().data.tasks)).toEqual(['x'])
    expect(h.state().data.dependencies).toEqual({})
    expect((await storedSnapshot(h)).tasks.map((t) => t.id)).toEqual(['x'])
  })

  it('deletePhase ungroups and deleteProject cascades', async () => {
    const h = await setup({
      rows: {
        ...workspaceRows(),
        milestones: [
          makeMilestone({ id: 'm1', projectId: 'p1', phaseId: 'ph1', date: '2026-12-01' }),
        ],
        dependencies: [
          makeDependency({ id: 'ab', projectId: 'p1', predecessorId: 'a', successorId: 'b' }),
        ],
      },
    })
    await h.actions.deletePhase('ph1')
    expect(h.state().data.tasks.a.phaseId).toBeNull()
    expect(h.state().data.milestones.m1.phaseId).toBeNull()
    expect((await storedTask(h, 'a'))?.phaseId).toBeNull()

    await h.actions.deleteProject('p1')
    const { data } = h.state()
    expect(Object.keys(data.projects)).toEqual(['p2'])
    expect([data.phases, data.tasks, data.milestones, data.dependencies]).toEqual([{}, {}, {}, {}])
    const stored = await storedSnapshot(h)
    expect([stored.tasks, stored.milestones, stored.dependencies]).toEqual([[], [], []])
  })
})

describe('dependencies and schedule', () => {
  it('addDependency / applySchedule / removeDependency round trip', async () => {
    const h = await setup({ rows: workspaceRows() })
    const added = await h.actions.addDependency('a', 'b')
    expect(added).toMatchObject({
      ok: true,
      value: { projectId: 'p1', predecessorId: 'a', successorId: 'b', type: 'FS' },
    })
    const result = await h.actions.applySchedule([
      { taskId: 'a', startDate: '2026-11-02', dueDate: '2026-11-04' },
      { taskId: 'b', startDate: '2026-11-05', dueDate: '2026-11-06' },
    ])
    expect(result.ok).toBe(true)
    expect(h.state().data.tasks.b).toMatchObject({ startDate: '2026-11-05', dueDate: '2026-11-06' })
    expect(await storedTask(h, 'b')).toMatchObject({
      startDate: '2026-11-05',
      dueDate: '2026-11-06',
    })
    if (added.ok) await h.actions.removeDependency(added.value.id)
    expect(h.state().data.dependencies).toEqual({})
  })

  it('a failed schedule write rolls every task back', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(1)
    await h.actions.applySchedule([
      { taskId: 'a', startDate: '2026-11-02', dueDate: '2026-11-04' },
      { taskId: 'b', startDate: '2026-11-05', dueDate: null },
    ])
    expect([h.state().data.tasks.a.startDate, h.state().data.tasks.b.startDate]).toEqual([
      null,
      null,
    ])
    expect(h.notifier.error.mock.calls[0][0]).toBe("Couldn't reschedule tasks")
  })
})

describe('preferences', () => {
  it('saves only the last stored preferences plus this change', async () => {
    const h = await setup()
    h.repo.failNextWrites(1)
    await Promise.all([
      h.actions.updatePreferences({ theme: 'dark' }),
      h.actions.updatePreferences({ weekStartsOn: 0 }),
    ])
    expect(h.state().preferences).toMatchObject({ theme: 'system', weekStartsOn: 0 })
    expect((await h.repo.loadWorkspace()).preferences).toMatchObject({
      theme: 'system',
      weekStartsOn: 0,
    })
  })

  it('never saves a later pending change as part of an earlier write', async () => {
    const h = await setup()
    const original = h.repo.upsertPreferences.bind(h.repo)
    vi.spyOn(h.repo, 'upsertPreferences')
      .mockImplementationOnce((preferences) => original(preferences))
      .mockRejectedValueOnce(new RepositoryError('network', NETWORK_ERROR_MESSAGE))
    await Promise.all([
      h.actions.updatePreferences({ theme: 'dark' }),
      h.actions.updatePreferences({ sidebarCollapsed: true }), // fails
    ])
    expect(h.state().preferences).toMatchObject({ theme: 'dark', sidebarCollapsed: false })
    expect((await h.repo.loadWorkspace()).preferences).toMatchObject({
      theme: 'dark',
      sidebarCollapsed: false,
    })
  })

  it('caches theme and sidebar state for the next startup', async () => {
    const uiStorage = createMemoryStorage({
      [UI_PREFS_STORAGE_KEY]: JSON.stringify({ theme: 'dark', sidebarCollapsed: true, junk: 1 }),
    })
    const h = await setup({ uiStorage, load: false })
    expect(h.state().preferences).toMatchObject({ theme: 'dark', sidebarCollapsed: true })
    await h.actions.load()
    await idle(h)
    // the first-run defaults keep the cached choices
    expect((await h.repo.loadWorkspace()).preferences).toMatchObject({
      theme: 'dark',
      sidebarCollapsed: true,
    })
    await h.actions.updatePreferences({ theme: 'light', sidebarCollapsed: false })
    expect(JSON.parse(uiStorage.getItem(UI_PREFS_STORAGE_KEY) ?? '')).toEqual({
      theme: 'light',
      sidebarCollapsed: false,
    })
  })
})

describe('backup', () => {
  const backup = (): BackupFile => ({
    app: 'cairn',
    formatVersion: 1,
    exportedAt: '2026-10-01T00:00:00.000Z',
    preferences: null,
    data: {
      projects: [
        makeProject({ id: 'X', name: 'Xray', sortOrder: 'a5' }),
        makeProject({ id: 'Y', name: 'Yankee', sortOrder: 'a1' }),
      ],
      phases: [makePhase({ id: 'PH', projectId: 'X', name: 'Phase' })],
      tasks: [
        makeTask({ id: 'T2', projectId: 'X', phaseId: 'PH', parentTaskId: 'T1', title: 'child' }),
        makeTask({
          id: 'T1',
          projectId: 'X',
          phaseId: 'PH',
          title: 'parent',
          status: 'done',
          completedAt: '2026-09-01T00:00:00.000Z',
        }),
        makeTask({ id: 'T4', projectId: 'X', title: 'next' }),
        makeTask({ id: 'T3', projectId: 'Y', title: 'other' }),
      ],
      milestones: [makeMilestone({ id: 'M', projectId: 'X', phaseId: 'PH', date: '2026-12-01' })],
      dependencies: [
        makeDependency({ id: 'D', projectId: 'X', predecessorId: 'T1', successorId: 'T4' }),
      ],
    },
  })

  it('importBackup remaps every id, appends projects in order and merges after the server', async () => {
    const h = await setup({
      rows: { projects: [makeProject({ id: 'E', name: 'Existing', sortOrder: 'a9' })] },
      randomId: () => crypto.randomUUID(),
    })
    const existing = h.state().data.projects.E
    h.repo.setLatency(5)
    const importing = h.actions.importBackup(backup())
    expect(Object.keys(h.state().data.projects)).toEqual(['E']) // not optimistic
    const result = await importing
    expect(result).toEqual({
      ok: true,
      value: { projects: 2, phases: 1, tasks: 4, milestones: 1, dependencies: 1 },
    })

    const { data } = h.state()
    expect(data.projects.E).toBe(existing)
    const projects = Object.values(data.projects).sort(bySortOrder)
    expect(projects.map((p) => p.name)).toEqual(['Existing', 'Yankee', 'Xray'])

    const oldIds = new Set(['X', 'Y', 'PH', 'T1', 'T2', 'T3', 'T4', 'M', 'D'])
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    for (const table of ['projects', 'phases', 'tasks', 'milestones', 'dependencies'] as const) {
      for (const row of Object.values(data[table])) {
        if (row.id === 'E') continue
        expect(oldIds.has(row.id)).toBe(false)
        expect(row.id).toMatch(uuid)
      }
    }
    const byTitle = (title: string) =>
      Object.values(data.tasks).find((t) => t.title === title) as Task
    const xray = projects[2]
    const phase = Object.values(data.phases)[0]
    expect(phase.projectId).toBe(xray.id)
    expect(byTitle('parent')).toMatchObject({
      projectId: xray.id,
      phaseId: phase.id,
      completedAt: '2026-09-01T00:00:00.000Z',
    })
    expect(byTitle('child')).toMatchObject({
      parentTaskId: byTitle('parent').id,
      phaseId: phase.id,
    })
    expect(byTitle('other').projectId).toBe(projects[1].id)
    expect(Object.values(data.milestones)[0]).toMatchObject({
      projectId: xray.id,
      phaseId: phase.id,
    })
    expect(Object.values(data.dependencies)[0]).toMatchObject({
      projectId: xray.id,
      predecessorId: byTitle('parent').id,
      successorId: byTitle('next').id,
    })

    // the server holds exactly the same rows
    const stored = await storedSnapshot(h)
    expect(stored.tasks.map((t) => t.id).sort()).toEqual(Object.keys(data.tasks).sort())

    // importing again creates another independent copy
    await h.actions.importBackup(backup())
    expect(Object.keys(h.state().data.projects)).toHaveLength(5)
  })

  it('rejects an invalid backup without writing', async () => {
    const h = await setup()
    const importSpy = vi.spyOn(h.repo, 'importWorkspace')
    const broken = backup()
    broken.data.tasks[0] = { ...broken.data.tasks[0], parentTaskId: 'missing' }
    expect(await h.actions.importBackup(broken)).toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    })
    expect(importSpy).not.toHaveBeenCalled()
    expect(h.notifier.error).not.toHaveBeenCalled()
  })

  it('a hostile backup (__proto__ and constructor as keys and ids) pollutes nothing', async () => {
    const h = await setup({ randomId: () => crypto.randomUUID() })
    const polluted = '{"polluted":true}'
    const hostile = JSON.stringify(backup())
      .replaceAll('"id":"X"', '"id":"__proto__"')
      .replaceAll('"projectId":"X"', '"projectId":"__proto__"')
      .replaceAll('"id":"T1"', '"id":"constructor"')
      .replaceAll('"parentTaskId":"T1"', '"parentTaskId":"constructor"')
      .replaceAll('"predecessorId":"T1"', '"predecessorId":"constructor"')
      .replaceAll('"name":"Xray"', `"__proto__":${polluted},"name":"Xray"`)
      .replace('"app":', `"__proto__":${polluted},"constructor":{"prototype":${polluted}},"app":`)
    const parsed = parseBackupFile(JSON.parse(hostile))
    if (!parsed.ok) throw new Error(parsed.error.message)

    expect(await h.actions.importBackup(parsed.value)).toMatchObject({
      ok: true,
      value: { projects: 2, tasks: 4, dependencies: 1 },
    })
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
    const { projects, tasks } = h.state().data
    expect(Object.keys(projects)).not.toContain('__proto__')
    expect(Object.keys(tasks)).not.toContain('constructor')
    for (const project of Object.values(projects)) {
      expect(Object.getPrototypeOf(project)).toBe(Object.prototype)
      expect((project as { polluted?: unknown }).polluted).toBeUndefined()
    }
  })

  it('exportBackup produces a valid backup of the current workspace', async () => {
    const h = await setup({ rows: workspaceRows() })
    const file = h.actions.exportBackup()
    const parsed = parseBackupFile(JSON.parse(JSON.stringify(file)))
    expect(parsed.ok).toBe(true)
    expect(file.data.tasks).toHaveLength(4)
    expect(file.preferences).toEqual(h.state().preferences)
    // round trip: importing an export duplicates the workspace
    expect(await h.actions.importBackup(file)).toMatchObject({
      ok: true,
      value: { projects: 2, tasks: 4 },
    })
  })
})

describe('refresh', () => {
  class GatedRepository extends LocalRepository {
    gate: Promise<void> | null = null
    override async loadWorkspace() {
      const snapshot = await super.loadWorkspace() // read at the start of the refresh
      if (this.gate) await this.gate
      return snapshot
    }
  }

  it('discards a refresh when a write started after it began', async () => {
    const storage = createMemoryStorage()
    const repo = new GatedRepository({ storage })
    const h = await setup({ repo, storage, rows: workspaceRows() })
    const loadedAt = h.state().sync.lastLoadedAt
    let release = () => {}
    repo.gate = new Promise((resolve) => {
      release = resolve
    })
    const refreshing = h.actions.refresh({ silent: true })
    const created = await h.actions.createTask({ projectId: 'p1', title: 'Written meanwhile' })
    release()
    expect(await refreshing).toEqual({ ok: true, value: undefined })
    expect(created.ok && h.state().data.tasks[created.value.id]).toBeTruthy()
    expect(h.state().sync.lastLoadedAt).toBe(loadedAt)
  })

  it("applies another device's changes when nothing was written meanwhile", async () => {
    const h = await setup({ rows: workspaceRows() })
    await new LocalRepository({ storage: h.storage }).insertProject(
      makeProject({ id: 'remote', sortOrder: 'b0' }),
    )
    await h.actions.refresh({ silent: true })
    expect(h.state().data.projects.remote).toBeDefined()
  })

  it('is skipped while writes are pending; non-silent refresh shows loading', async () => {
    const h = await setup({ rows: workspaceRows() })
    const load = vi.spyOn(h.repo, 'loadWorkspace')
    h.repo.setLatency(10)
    const writing = h.actions.updateTask('a', { title: 'busy' })
    expect(await h.actions.refresh({ silent: true })).toEqual({ ok: true, value: undefined })
    expect(load).not.toHaveBeenCalled()
    await writing
    const refreshing = h.actions.refresh()
    expect(h.state().status).toBe('loading')
    await refreshing
    expect(h.state().status).toBe('ready')
    expect(load).toHaveBeenCalledOnce()
  })

  it('refreshes on focus/visibility at most every 30 s, and when back online', async () => {
    const win = new EventTarget()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    let clock = 1_000_000
    const h = await setup({
      rows: workspaceRows(),
      environment: { window: win, document: doc, navigator: { onLine: true } },
      now: () => clock,
    })
    const load = vi.spyOn(h.repo, 'loadWorkspace')
    clock += 10_000
    win.dispatchEvent(new Event('focus'))
    expect(load).not.toHaveBeenCalled()

    clock += AUTO_REFRESH_INTERVAL_MS
    win.dispatchEvent(new Event('focus'))
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(load).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(h.state().sync.lastLoadedAt).toBe(clock))

    clock += AUTO_REFRESH_INTERVAL_MS
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(load).toHaveBeenCalledOnce()
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(load).toHaveBeenCalledTimes(2)
    await idle(h)

    win.dispatchEvent(new Event('offline'))
    expect(h.state().sync.online).toBe(false)
    win.dispatchEvent(new Event('online')) // forced, even inside the 30 s window
    expect(h.state().sync.online).toBe(true)
    expect(load).toHaveBeenCalledTimes(3)
  })
})

describe('reset', () => {
  it('clears everything and ignores answers to earlier requests', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.setLatency(10)
    const writing = h.actions.updateTask('a', { title: 'late' })
    h.actions.reset()
    expect(h.state()).toMatchObject({ status: 'idle', data: EMPTY_WORKSPACE, loadError: null })
    expect(h.state().sync).toMatchObject({ pending: 0, lastError: null, lastLoadedAt: null })
    await writing
    expect(h.state().data).toBe(EMPTY_WORKSPACE)
    expect(h.state().sync.pending).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Review findings (each test failed before its fix)
// ---------------------------------------------------------------------------

const OK = { ok: true, value: undefined }

class GatedLoadRepository extends LocalRepository {
  gate: Promise<void> | null = null
  reads = 0
  override async loadWorkspace() {
    const snapshot = await super.loadWorkspace() // read at the start of the call
    this.reads += 1
    if (this.gate) await this.gate
    return snapshot
  }
}

function gate() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('placement uses the same neighbour rule as keyForPlacement', () => {
  it('a drop in place at the top of a column writes nothing', async () => {
    // X (in progress) · item · B: the To Do column shows item, B.
    const h = await setup({
      rows: {
        projects: [makeProject({ id: 'p1' })],
        tasks: [
          makeTask({ id: 'X', projectId: 'p1', status: 'in_progress', sortOrder: 'a0' }),
          makeTask({ id: 'item', projectId: 'p1', sortOrder: 'a1' }),
          makeTask({ id: 'B', projectId: 'p1', sortOrder: 'a2' }),
        ],
      },
    })
    const update = vi.spyOn(h.repo, 'updateTask')
    expect(await h.actions.moveTask({ taskId: 'item', afterId: null, beforeId: 'B' })).toEqual(OK)
    expect(update).not.toHaveBeenCalled()
  })

  it('a drop at the top of a column lands directly before its first card', async () => {
    // item · X (in progress) · B
    const h = await setup({
      rows: {
        projects: [makeProject({ id: 'p1' })],
        tasks: [
          makeTask({ id: 'item', projectId: 'p1', sortOrder: 'a0' }),
          makeTask({ id: 'X', projectId: 'p1', status: 'in_progress', sortOrder: 'a1' }),
          makeTask({ id: 'B', projectId: 'p1', sortOrder: 'a2' }),
        ],
      },
    })
    await h.actions.moveTask({ taskId: 'item', afterId: null, beforeId: 'B' })
    expect(topLevel(h)).toEqual(['X', 'item', 'B'])
    expect(sortedIds((await storedSnapshot(h)).tasks)).toEqual(['X', 'item', 'B'])
  })
})

describe('preferences across devices', () => {
  const cloud = {
    theme: 'light',
    sidebarCollapsed: false,
    timezone: 'Pacific/Chatham',
    weekStartsOn: 0,
  } as const

  it('a change made before the workspace loads is saved on top of the cloud values', async () => {
    const repo = new LocalRepository({ storage: createMemoryStorage() })
    await repo.upsertPreferences(cloud)
    const h = await setup({ repo, load: false })
    const saving = h.actions.updatePreferences({ sidebarCollapsed: true })
    expect(h.state().preferences.sidebarCollapsed).toBe(true) // applied at once
    await h.actions.load()
    expect(await saving).toEqual(OK)
    await idle(h)
    const expected = { ...cloud, sidebarCollapsed: true }
    expect(h.state().preferences).toEqual(expected)
    expect((await repo.loadWorkspace()).preferences).toEqual(expected)
  })

  it("saving one preference never overwrites another device's newer values", async () => {
    const storage = createMemoryStorage()
    const deviceA = await setup({ storage })
    const deviceB = await setup({ storage }) // loaded now, not refreshed afterwards
    expect(await deviceA.actions.updatePreferences({ timezone: 'Pacific/Chatham' })).toEqual(OK)
    expect(await deviceB.actions.updatePreferences({ theme: 'dark' })).toEqual(OK)
    const stored = (await deviceA.repo.loadWorkspace()).preferences
    expect(stored).toMatchObject({ timezone: 'Pacific/Chatham', theme: 'dark' })
    expect(deviceB.state().preferences).toEqual(stored)
  })

  it('first-run defaults never overwrite preferences another device saved meanwhile', async () => {
    const storage = createMemoryStorage()
    class Racing extends LocalRepository {
      override async loadWorkspace() {
        const snapshot = await super.loadWorkspace() // no preferences yet…
        await new LocalRepository({ storage }).upsertPreferences(cloud) // …then another device saves
        return snapshot
      }
    }
    const h = await setup({ repo: new Racing({ storage }), storage })
    expect((await h.repo.loadWorkspace()).preferences).toEqual(cloud)
    expect(h.state().preferences).toEqual(cloud)
  })
})

describe('preferences changed before the workspace loaded', () => {
  it('the answer waits for a load that works: a failed first load loses nothing', async () => {
    const h = await setup({ rows: workspaceRows(), load: false })
    vi.spyOn(h.repo, 'loadWorkspace').mockRejectedValueOnce(
      new RepositoryError('network', NETWORK_ERROR_MESSAGE),
    )
    expect((await h.actions.load()).ok).toBe(false)
    let answered: unknown = null
    const pending = h.actions.updatePreferences({ weekStartsOn: 0 }).then((result) => {
      answered = result
    })
    await settled()
    // applied on screen at once; nothing is claimed as saved while the workspace is unknown
    expect(h.state().preferences.weekStartsOn).toBe(0)
    expect(answered).toBeNull()
    expect(
      (await new LocalRepository({ storage: h.storage }).loadWorkspace()).preferences,
    ).toBeNull()

    expect((await h.actions.load()).ok).toBe(true)
    await pending
    await idle(h)
    expect(answered).toEqual(OK)
    expect((await storedSnapshot(h)).preferences?.weekStartsOn).toBe(0)
    expect(h.state().sync.lastError).toBeNull()
  })
})

describe('loading', () => {
  it('a successful load clears the error of a failed one (but not a failed write)', async () => {
    const h = await setup({ rows: workspaceRows(), load: false })
    vi.spyOn(h.repo, 'loadWorkspace').mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await h.actions.load()
    expect(h.state().sync.lastError).toMatchObject({ kind: 'network' })
    expect(await h.actions.load()).toEqual(OK)
    expect(h.state().sync.lastError).toBeNull()

    h.repo.failNextWrites(1)
    await h.actions.updateTask('a', { title: 'x' })
    await h.actions.refresh({ silent: true })
    expect(h.state().sync).toMatchObject({ lastError: { kind: 'network' }, canRetry: true })
  })

  it('a refresh the user asked for reports a failure without a loading state; the next one clears it', async () => {
    const h = await setup({ rows: workspaceRows() })
    const statuses: string[] = []
    h.store.subscribe((state) => statuses.push(state.status))
    vi.spyOn(h.repo, 'loadWorkspace').mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const result = await h.actions.refresh({ silent: true, reportFailure: true })
    expect(result.ok).toBe(false)
    expect(h.state().sync).toMatchObject({ lastError: { kind: 'network' }, canRetry: false })
    expect(statuses).not.toContain('loading')

    expect(await h.actions.refresh({ silent: true, reportFailure: true })).toEqual(OK)
    expect(h.state().sync.lastError).toBeNull()
  })

  it('a reported refresh failure never replaces a failed write awaiting Retry', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(1)
    await h.actions.updateTask('a', { title: 'x' })
    const writeError = h.state().sync.lastError
    vi.spyOn(h.repo, 'loadWorkspace').mockRejectedValueOnce(
      new RepositoryError('unknown', 'The server is down.'),
    )
    await h.actions.refresh({ silent: true, reportFailure: true })
    expect(h.state().sync).toMatchObject({ lastError: writeError, canRetry: true })
  })

  it('a background refresh failure stays quiet', async () => {
    const h = await setup({ rows: workspaceRows() })
    vi.spyOn(h.repo, 'loadWorkspace').mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect((await h.actions.refresh({ silent: true })).ok).toBe(false)
    expect(h.state().sync.lastError).toBeNull()
  })

  it('a write made while the workspace (re)loads is neither lost nor reverted', async () => {
    const storage = createMemoryStorage()
    const repo = new GatedLoadRepository({ storage })
    const h = await setup({ repo, storage, rows: workspaceRows() })
    const { promise, release } = gate()
    repo.gate = promise
    const reads = repo.reads
    const loading = h.actions.load()
    await vi.waitFor(() => expect(repo.reads).toBe(reads + 1)) // the snapshot has been read
    const saving = h.actions.updateTask('a', { title: 'During load' })
    release()
    expect(await loading).toEqual(OK)
    expect(await saving).toEqual(OK)
    await idle(h)
    expect(h.state().data.tasks.a.title).toBe('During load')
    expect(h.state().data.tasks.a).toEqual(await storedTask(h, 'a'))
  })

  it('retries a failed load when the browser comes back online', async () => {
    const win = new EventTarget()
    const h = await setup({
      rows: workspaceRows(),
      environment: { window: win, navigator: { onLine: false } },
      load: false,
    })
    vi.spyOn(h.repo, 'loadWorkspace').mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await h.actions.load()
    expect(h.state().status).toBe('error')
    win.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(h.state().status).toBe('ready'))
    expect(Object.keys(h.state().data.tasks)).toHaveLength(4)
  })

  it('stops listening for focus/online once its signal is aborted', async () => {
    const win = new EventTarget()
    const controller = new AbortController()
    let clock = 1_000_000
    const h = await setup({
      rows: workspaceRows(),
      environment: { window: win, navigator: { onLine: true } },
      now: () => clock,
      signal: controller.signal,
    })
    const load = vi.spyOn(h.repo, 'loadWorkspace')
    controller.abort()
    clock += AUTO_REFRESH_INTERVAL_MS * 2
    win.dispatchEvent(new Event('focus'))
    win.dispatchEvent(new Event('offline'))
    win.dispatchEvent(new Event('online'))
    expect(load).not.toHaveBeenCalled()
    expect(h.state().sync.online).toBe(true)
  })
})

describe('server answers', () => {
  it('a malformed answer to a saved write never leaves it pending', async () => {
    const h = await setup({ rows: workspaceRows() })
    const original = h.repo.updateTask.bind(h.repo)
    vi.spyOn(h.repo, 'updateTask').mockImplementationOnce(async (id, patch) => {
      await original(id, patch) // stored, but the answer is unusable
      return undefined as unknown as Task
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await h.actions.updateTask('a', { title: 'Saved' })).toEqual(OK)
    expect(error).toHaveBeenCalledOnce()
    expect(h.state().sync).toMatchObject({ pending: 0, lastError: null })
    // the canonical row is fetched again
    await vi.waitFor(() =>
      expect(h.state().data.tasks.a).toEqual(expect.objectContaining({ title: 'Saved' })),
    )
  })

  it('applySchedule keeps the dates of tasks the server answer left out (max_rows)', async () => {
    const h = await setup({ rows: workspaceRows() })
    const original = h.repo.applySchedule.bind(h.repo)
    vi.spyOn(h.repo, 'applySchedule').mockImplementationOnce(async (changes) =>
      (await original(changes)).slice(0, 1),
    )
    expect(
      await h.actions.applySchedule([
        { taskId: 'a', startDate: '2026-11-02', dueDate: '2026-11-04' },
        { taskId: 'b', startDate: '2026-11-05', dueDate: '2026-11-06' },
      ]),
    ).toEqual(OK)
    expect(h.state().data.tasks.b).toMatchObject({ startDate: '2026-11-05', dueDate: '2026-11-06' })
    expect(h.state().data.tasks.a).toEqual(await storedTask(h, 'a'))
    expect(h.state().sync.pending).toBe(0)
  })

  it('deleting something another device already deleted succeeds quietly', async () => {
    const h = await setup({ rows: workspaceRows() })
    await new LocalRepository({ storage: h.storage }).deleteTask('a', { keepSubtasks: false })
    expect(await h.actions.deleteTask('a', { keepSubtasks: false })).toEqual(OK)
    expect(h.state().data.tasks.a).toBeUndefined()
    expect(h.notifier.error).not.toHaveBeenCalled()
    expect(h.state().sync.lastError).toBeNull()
  })

  it('keepSubtasks never deletes subtasks this device has not seen yet', async () => {
    const h = await setup({ rows: workspaceRows() })
    // another device adds a subtask to "a"
    await new LocalRepository({ storage: h.storage }).insertTask(
      makeTask({ id: 'remote-sub', projectId: 'p1', parentTaskId: 'a', sortOrder: 'a0' }),
    )
    const result = await h.actions.deleteTask('a', { keepSubtasks: true })
    expect(result).toMatchObject({ ok: false, error: { kind: 'validation' } })
    expect(await storedTask(h, 'a')).toBeDefined()
    expect(await storedTask(h, 'remote-sub')).toBeDefined()
    // the rejection shows this device is behind: it fetches the current state
    await vi.waitFor(() => expect(h.state().data.tasks['remote-sub']).toBeDefined())
    expect(h.state().data.tasks.a).toBeDefined()
  })
})

describe('sign-out and stale retries', () => {
  it("a stale toast's Retry does nothing once the workspace was reset", async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(1)
    await h.actions.createProject({ name: 'Private' })
    const { action } = h.notifier.error.mock.calls[0][1] as { action: { onClick: () => void } }
    h.actions.reset() // signed out; another account may sign in next
    expect(h.notifier.dismiss).toHaveBeenCalledWith(SYNC_ERROR_TOAST_ID)
    await h.actions.load()
    const insert = vi.spyOn(h.repo, 'insertProject')
    action.onClick()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(insert).not.toHaveBeenCalled()
    expect(Object.values(h.state().data.projects).map((p) => p.name)).not.toContain('Private')
  })

  it('a reset with unsaved changes says so', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.setLatency(20)
    const saving = h.actions.updateTask('a', { title: 'In flight' })
    h.actions.reset()
    expect(h.notifier.error).toHaveBeenCalledWith(
      expect.stringMatching(/changes/i),
      expect.objectContaining({ id: UNSAVED_ON_RESET_TOAST_ID }),
    )
    await saving
  })

  it('a reset right after a load (only housekeeping pending) says nothing', async () => {
    const h = await setup({ load: false })
    h.repo.setLatency(20)
    await h.actions.load() // the first-run preferences are being saved in the background
    expect(h.state().sync.pending).toBe(1)
    h.actions.reset()
    expect(h.notifier.error).not.toHaveBeenCalled()
  })
})

describe('import retries', () => {
  const file = (): BackupFile => ({
    app: 'cairn',
    formatVersion: 1,
    exportedAt: '2026-10-01T00:00:00.000Z',
    preferences: null,
    data: {
      projects: [makeProject({ id: 'X', name: 'Xray' }), makeProject({ id: 'Y', name: 'Yankee' })],
      phases: [makePhase({ id: 'PH', projectId: 'X' })],
      tasks: [
        makeTask({ id: 'T1', projectId: 'X', phaseId: 'PH', title: 'parent' }),
        // a hand-edited file: the subtask claims no phase although its parent has one
        makeTask({ id: 'T2', projectId: 'X', parentTaskId: 'T1', phaseId: null, title: 'child' }),
      ],
      milestones: [],
      dependencies: [],
    },
  })

  it('retrying an import whose answer was lost never creates a second copy', async () => {
    const h = await setup({ randomId: () => crypto.randomUUID() })
    const original = h.repo.importWorkspace.bind(h.repo)
    vi.spyOn(h.repo, 'importWorkspace').mockImplementationOnce(async (data) => {
      await original(data) // stored…
      throw new RepositoryError('network', NETWORK_ERROR_MESSAGE) // …but the answer never arrived
    })
    expect((await h.actions.importBackup(file())).ok).toBe(false)
    expect(await h.actions.retryLastFailed()).toEqual(OK)
    await idle(h)
    const stored = await storedSnapshot(h)
    expect(stored.projects).toHaveLength(2)
    await vi.waitFor(() =>
      expect(Object.keys(h.state().data.projects).sort()).toEqual(
        stored.projects.map((p) => p.id).sort(),
      ),
    )
  })

  it("an imported subtask takes its parent's phase, as the server stores it", async () => {
    const h = await setup({ randomId: () => crypto.randomUUID() })
    expect((await h.actions.importBackup(file())).ok).toBe(true)
    const tasks = Object.values(h.state().data.tasks)
    const parent = tasks.find((t) => t.title === 'parent') as Task
    const child = tasks.find((t) => t.title === 'child') as Task
    expect(child.phaseId).toBe(parent.phaseId)
    expect((await storedTask(h, child.id))?.phaseId).toBe(parent.phaseId)
  })
})

// ---------------------------------------------------------------------------
// Second review (each test failed before its fix)
// ---------------------------------------------------------------------------

type ToastAction = { action?: { onClick: () => void } }
const lastToastAction = (h: Harness) =>
  (h.notifier.error.mock.calls.at(-1)?.[1] as ToastAction | undefined)?.action
const settled = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('Retry never overwrites newer changes', () => {
  it("a failed change's toast Retry does nothing once a newer change of that field was saved", async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(1)
    await h.actions.updateTask('a', { title: 'Old attempt' })
    const retry = lastToastAction(h)
    expect(retry).toBeDefined()
    expect(await h.actions.updateTask('a', { title: 'Newer' })).toEqual(OK)
    // the superseded failure's toast goes away instead of offering a harmful Retry
    expect(h.notifier.dismiss).toHaveBeenCalledWith(SYNC_ERROR_TOAST_ID)
    retry?.onClick()
    await settled()
    await idle(h)
    expect(h.state().data.tasks.a.title).toBe('Newer')
    expect((await storedTask(h, 'a'))?.title).toBe('Newer')
  })

  it('retryLastFailed skips a failed change that a newer, still pending change replaced', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(1)
    await h.actions.updateTask('a', { title: 'Old attempt' })
    expect(h.state().sync.canRetry).toBe(true)
    h.repo.setLatency(20)
    const newer = h.actions.updateTask('a', { title: 'Newer' })
    expect(h.state().sync.canRetry).toBe(false)
    expect(await h.actions.retryLastFailed()).toEqual(OK)
    expect(await newer).toEqual(OK)
    await idle(h)
    expect(h.state().data.tasks.a.title).toBe('Newer')
    expect((await storedTask(h, 'a'))?.title).toBe('Newer')
  })

  describe('a create typed again after it failed', () => {
    const titled = (h: Harness, title: string) =>
      Object.values(h.state().data.tasks).filter((task) => task.title === title)
    const storedTitled = async (h: Harness, title: string) =>
      (await storedSnapshot(h)).tasks.filter((task) => task.title === title)

    it("replaces the failed one: the old toast's Retry goes away and never makes a second copy", async () => {
      const h = await setup({ rows: workspaceRows() })
      h.repo.failNextWrites(1)
      expect((await h.actions.createTask({ projectId: 'p1', title: 'Again' })).ok).toBe(false)
      const retry = lastToastAction(h)
      expect(retry).toBeDefined()
      expect((await h.actions.createTask({ projectId: 'p1', title: 'Again' })).ok).toBe(true)
      expect(h.notifier.dismiss).toHaveBeenCalledWith(SYNC_ERROR_TOAST_ID)
      expect(h.state().sync.canRetry).toBe(false)
      retry?.onClick()
      await settled()
      await idle(h)
      expect(titled(h, 'Again')).toHaveLength(1)
      expect(await storedTitled(h, 'Again')).toHaveLength(1)
    })

    it('replaces the failed one even while the new copy is still being saved', async () => {
      const h = await setup({ rows: workspaceRows() })
      h.repo.failNextWrites(1)
      await h.actions.createTask({ projectId: 'p1', title: 'Again' })
      const retry = lastToastAction(h)
      h.repo.setLatency(20)
      const second = h.actions.createTask({ projectId: 'p1', title: 'Again' })
      retry?.onClick()
      expect((await second).ok).toBe(true)
      await settled()
      await idle(h)
      expect(await storedTitled(h, 'Again')).toHaveLength(1)
    })

    it('a different title, project, phase or parent is a different task: its Retry stays', async () => {
      const h = await setup({ rows: workspaceRows() })
      h.repo.failNextWrites(1)
      await h.actions.createTask({ projectId: 'p1', title: 'Same words' })
      const retry = lastToastAction(h)
      await h.actions.createTask({ projectId: 'p1', title: 'Other words' })
      await h.actions.createTask({ projectId: 'p2', title: 'Same words' })
      await h.actions.createTask({ projectId: 'p1', phaseId: 'ph1', title: 'Same words' })
      await h.actions.createTask({ projectId: 'p1', parentTaskId: 'a', title: 'Same words' })
      retry?.onClick()
      // the failed one, plus the three different tasks with the same words
      await vi.waitFor(async () => expect(await storedTitled(h, 'Same words')).toHaveLength(4))
      await idle(h)
      expect(titled(h, 'Same words')).toHaveLength(4)
    })

    it('typed again while still failing: one Retry stores it once', async () => {
      const h = await setup({ rows: workspaceRows() })
      h.repo.failNextWrites(2)
      await h.actions.createTask({ projectId: 'p1', title: 'Again' })
      await h.actions.createTask({ projectId: 'p1', title: 'Again' })
      expect(h.state().sync.canRetry).toBe(true)
      expect(await h.actions.retryLastFailed()).toEqual(OK)
      await idle(h)
      expect(titled(h, 'Again')).toHaveLength(1)
      expect(await storedTitled(h, 'Again')).toHaveLength(1)
    })
  })

  it('an unrelated change keeps the toast Retry of a failed one working', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(1)
    await h.actions.applySchedule([{ taskId: 'a', startDate: '2026-11-02', dueDate: '2026-11-03' }])
    const retry = lastToastAction(h)
    await h.actions.applySchedule([{ taskId: 'b', startDate: '2026-11-05', dueDate: '2026-11-06' }])
    retry?.onClick()
    await vi.waitFor(async () =>
      expect(await storedTask(h, 'a')).toMatchObject({ startDate: '2026-11-02' }),
    )
    await idle(h)
    expect(h.state().data.tasks.a).toMatchObject({ startDate: '2026-11-02', dueDate: '2026-11-03' })
    expect(await storedTask(h, 'b')).toMatchObject({ startDate: '2026-11-05' })
  })
})

describe('Retry after several failures in a row', () => {
  it('re-sends every change that failed since the last save, in order', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(3)
    expect((await h.actions.createTask({ projectId: 'p1', title: 'Offline task' })).ok).toBe(false)
    expect((await h.actions.updateTask('b', { priority: 'high' })).ok).toBe(false)
    expect((await h.actions.updatePreferences({ weekStartsOn: 0 })).ok).toBe(false)
    expect(h.state().sync.canRetry).toBe(true)
    expect(await h.actions.retryLastFailed()).toEqual(OK)
    await idle(h)
    const stored = await storedSnapshot(h)
    expect(stored.tasks.find((t) => t.id === 'new-1')).toMatchObject({ title: 'Offline task' })
    expect(stored.tasks.find((t) => t.id === 'b')?.priority).toBe('high')
    expect(stored.preferences?.weekStartsOn).toBe(0)
    expect(h.state().data.tasks['new-1']).toBeDefined()
    expect(h.state().sync).toMatchObject({ lastError: null, canRetry: false })
  })

  it('a change that depends on an earlier failed one is saved after it', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.setLatency(5)
    h.repo.failNextWrites(2)
    // made back to back: the edit was already on its way when the create failed
    const created = h.actions.createTask({ projectId: 'p1', title: 'Draft' })
    const edited = h.actions.updateTask('new-1', { title: 'Final' })
    expect((await created).ok).toBe(false)
    expect((await edited).ok).toBe(false)
    expect(await h.actions.retryLastFailed()).toEqual(OK)
    await idle(h)
    expect(await storedTask(h, 'new-1')).toMatchObject({ title: 'Final' })
    expect(h.state().data.tasks['new-1']).toMatchObject({ title: 'Final' })
  })

  it('an edit made while its create was in flight is kept for Retry when only the create failed', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.setLatency(5)
    h.repo.failNextWrites(1) // the server never got the create, so the edit finds no such task
    const created = h.actions.createTask({ projectId: 'p1', title: 'Draft' })
    const edited = h.actions.updateTask('new-1', { priority: 'high' })
    expect((await created).ok).toBe(false)
    expect((await edited).ok).toBe(false)
    // the failure on screen is the create's (not "Task not found") and it offers Retry
    expect(h.state().sync.lastError?.kind).toBe('network')
    expect(h.state().sync.canRetry).toBe(true)
    expect(lastToastAction(h)).toBeDefined()
    expect(h.notifier.error.mock.calls.at(-1)?.[0]).toBe("Couldn't update task")
    expect(h.notifier.error.mock.calls.at(-1)?.[1]).toMatchObject({
      description: NETWORK_ERROR_MESSAGE,
    })
    // Retry creates the task and then applies the edit: nothing the user did is lost
    expect(await h.actions.retryLastFailed()).toEqual(OK)
    await idle(h)
    expect(await storedTask(h, 'new-1')).toMatchObject({ title: 'Draft', priority: 'high' })
    expect(h.state().data.tasks['new-1']).toMatchObject({ title: 'Draft', priority: 'high' })
    expect(h.state().sync).toMatchObject({ lastError: null, canRetry: false })
  })

  it('an edit of a task whose create failed for good (validation) is not offered a Retry', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.setLatency(5)
    vi.spyOn(h.repo, 'insertTask').mockRejectedValueOnce(
      new RepositoryError('validation', 'The title is not allowed.'),
    )
    const created = h.actions.createTask({ projectId: 'p1', title: 'Draft' })
    const edited = h.actions.updateTask('new-1', { priority: 'high' })
    expect((await created).ok).toBe(false)
    expect((await edited).ok).toBe(false)
    expect(h.state().sync.canRetry).toBe(false)
    expect(lastToastAction(h)).toBeUndefined()
  })

  it('stops at a change that fails again and continues from it next time', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(2)
    await h.actions.updateTask('a', { title: 'First' })
    await h.actions.updateTask('b', { title: 'Second' })
    h.repo.failNextWrites(1)
    expect((await h.actions.retryLastFailed()).ok).toBe(false)
    expect((await storedTask(h, 'b'))?.title).toBe('B') // not sent before "First" is saved
    expect(h.state().sync.canRetry).toBe(true)
    expect(await h.actions.retryLastFailed()).toEqual(OK)
    await idle(h)
    expect([(await storedTask(h, 'a'))?.title, (await storedTask(h, 'b'))?.title]).toEqual([
      'First',
      'Second',
    ])
  })

  it('starting a Retry dismisses the failure toast', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(1)
    await h.actions.updateTask('a', { title: 'x' })
    h.notifier.dismiss.mockClear()
    await h.actions.retryLastFailed()
    expect(h.notifier.dismiss).toHaveBeenCalledWith(SYNC_ERROR_TOAST_ID)
  })

  it('a failure a newer pending change of the same field replaced offers no Retry', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.setLatency(10)
    h.repo.failNextWrites(1)
    const older = h.actions.updateTask('a', { title: 'Older' })
    const newer = h.actions.updateTask('a', { title: 'Newer' })
    expect((await older).ok).toBe(false)
    expect(lastToastAction(h)).toBeUndefined()
    expect(h.state().sync.canRetry).toBe(false)
    expect(await newer).toEqual(OK)
    expect((await storedTask(h, 'a'))?.title).toBe('Newer')
  })

  it('says why when a retried change no longer fits; a failure on the way reports itself', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(1)
    await h.actions.updateTask('a', { title: 'Edited offline' })
    // meanwhile the task was deleted on another device (and this device refreshed)
    await new LocalRepository({ storage: h.storage }).deleteTask('a', { keepSubtasks: false })
    await h.actions.refresh({ silent: true })
    h.notifier.error.mockClear()
    expect(await h.actions.retryLastFailed()).toMatchObject({
      ok: false,
      error: { kind: 'not_found' },
    })
    expect(h.notifier.error).toHaveBeenCalledOnce()
    expect(h.notifier.error.mock.calls[0][0]).toBe("Couldn't retry")

    h.repo.failNextWrites(2)
    await h.actions.updateTask('b', { title: 'Twice' })
    h.notifier.error.mockClear()
    expect((await h.actions.retryLastFailed()).ok).toBe(false)
    expect(h.notifier.error).toHaveBeenCalledOnce()
    expect(h.notifier.error.mock.calls[0][0]).toBe("Couldn't update task")
    expect(lastToastAction(h)).toBeDefined() // still retryable
  })
})

describe('creates whose answer was lost', () => {
  it('retrying a create the server already stored succeeds instead of failing as a duplicate', async () => {
    const h = await setup({ rows: workspaceRows() })
    const insert = h.repo.insertTask.bind(h.repo)
    vi.spyOn(h.repo, 'insertTask').mockImplementationOnce(async (task) => {
      await insert(task) // stored…
      throw new RepositoryError('network', NETWORK_ERROR_MESSAGE) // …but the answer never arrived
    })
    expect((await h.actions.createTask({ projectId: 'p1', title: 'Saved once' })).ok).toBe(false)
    h.notifier.error.mockClear()
    expect(await h.actions.retryLastFailed()).toEqual(OK)
    await idle(h)
    expect(h.notifier.error).not.toHaveBeenCalled()
    expect(h.state().sync.lastError).toBeNull()
    expect(h.state().data.tasks['new-1']).toMatchObject({ title: 'Saved once' })
    const stored = await storedSnapshot(h)
    expect(stored.tasks.filter((t) => t.title === 'Saved once')).toHaveLength(1)
  })

  it('adding a dependency another device already added succeeds quietly', async () => {
    const h = await setup({ rows: workspaceRows() })
    await new LocalRepository({ storage: h.storage }).insertDependency(
      makeDependency({ id: 'remote', projectId: 'p1', predecessorId: 'a', successorId: 'b' }),
    )
    const result = await h.actions.addDependency('a', 'b')
    expect(result).toMatchObject({ ok: true, value: { predecessorId: 'a', successorId: 'b' } })
    expect(h.notifier.error).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(Object.keys(h.state().data.dependencies)).toEqual(['remote']))
  })
})

describe('patches only change patchable fields', () => {
  it('rejects moving a row to another project or changing its id, before any write', async () => {
    const h = await setup({
      rows: {
        ...workspaceRows(),
        milestones: [makeMilestone({ id: 'm1', projectId: 'p1', date: '2026-12-01' })],
      },
    })
    const writes = ['updateTask', 'updateProject', 'updatePhase', 'updateMilestone'] as const
    const spies = writes.map((method) => vi.spyOn(h.repo, method))
    const data = h.state().data
    const results = [
      await h.actions.updateTask('a', { title: 'X', projectId: 'p2' } as TaskPatch),
      await h.actions.updateTask('a', { id: 'a2' } as TaskPatch),
      await h.actions.updateProject('p1', { id: 'p9' } as ProjectPatch),
      await h.actions.updatePhase('ph1', { projectId: 'p2' } as PhasePatch),
      await h.actions.updateMilestone('m1', { projectId: 'p2' } as MilestonePatch),
    ]
    for (const result of results)
      expect(result).toMatchObject({ ok: false, error: { kind: 'validation' } })
    expect(h.state().data).toBe(data)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    expect(h.notifier.error).not.toHaveBeenCalled()
  })

  it('ignores fields outside the patch type (e.g. a whole row passed as the patch)', async () => {
    const h = await setup({ rows: workspaceRows() })
    const update = vi.spyOn(h.repo, 'updateTask')
    const task = h.state().data.tasks.a
    const stale = { ...task, title: 'Renamed', createdAt: 'x', updatedAt: 'y', completedAt: 'z' }
    expect(await h.actions.updateTask('a', stale as TaskPatch)).toEqual(OK)
    expect(update).toHaveBeenLastCalledWith('a', { title: 'Renamed' })
    expect(
      await h.actions.updateTask('a', { title: 'Again', bogus: 1 } as unknown as TaskPatch),
    ).toEqual(OK)
    expect(h.state().data.tasks.a).not.toHaveProperty('bogus')
    expect(h.state().data.tasks.a).toEqual(await storedTask(h, 'a'))
  })
})

// ---------------------------------------------------------------------------
// Third review (the findings' tests failed before their fixes; the guards beside them pin what
// must not change: a real failure keeps its Retry, offline waits for the network)
// ---------------------------------------------------------------------------

describe('a failure without an answer', () => {
  it('is followed by a resync, so a change the server did store shows up (no second copy)', async () => {
    const h = await setup({ rows: workspaceRows() })
    const insert = h.repo.insertTask.bind(h.repo)
    vi.spyOn(h.repo, 'insertTask').mockImplementationOnce(async (task) => {
      await insert(task) // stored…
      throw new RepositoryError('network', NETWORK_ERROR_MESSAGE) // …but the answer was lost
    })
    const result = await h.actions.createTask({ projectId: 'p1', title: 'Answer lost' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'network' } })
    // Whether the server applied it is unknown: the store asks instead of showing it as missing
    // (the user would then create it a second time).
    await vi.waitFor(() =>
      expect(h.state().data.tasks['new-1']).toMatchObject({ title: 'Answer lost' }),
    )
    // it was saved after all: the failure (its toast, error and Retry) is withdrawn
    await vi.waitFor(() =>
      expect(h.state().sync).toMatchObject({ lastError: null, canRetry: false }),
    )
    expect(h.notifier.dismiss).toHaveBeenCalledWith(SYNC_ERROR_TOAST_ID)
    expect(await h.actions.retryLastFailed()).toEqual(OK)
    await idle(h)
    const stored = await storedSnapshot(h)
    expect(stored.tasks.filter((t) => t.title === 'Answer lost')).toHaveLength(1)
    expect(h.state().data.tasks['new-1']).toEqual(stored.tasks.find((t) => t.id === 'new-1'))
  })

  it('withdraws only the failures the server shows as applied', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(1)
    expect((await h.actions.updateTask('a', { title: 'Really failed' })).ok).toBe(false)
    const update = h.repo.updateTask.bind(h.repo)
    vi.spyOn(h.repo, 'updateTask').mockImplementationOnce(async (id, patch) => {
      await update(id, patch)
      throw new RepositoryError('network', NETWORK_ERROR_MESSAGE)
    })
    expect((await h.actions.updateTask('b', { priority: 'urgent', status: 'done' })).ok).toBe(false)
    await vi.waitFor(() =>
      expect(h.state().data.tasks.b).toMatchObject({ priority: 'urgent', status: 'done' }),
    )
    await idle(h)
    // "b" was stored; "a" was not and keeps its Retry
    expect(h.state().data.tasks.a.title).toBe('A')
    expect(h.state().sync.canRetry).toBe(true)
    expect(await h.actions.retryLastFailed()).toEqual(OK)
    await idle(h)
    expect((await storedTask(h, 'a'))?.title).toBe('Really failed')
    expect(h.state().sync).toMatchObject({ lastError: null, canRetry: false })
  })

  it('a delete the server shows as done counts as applied', async () => {
    const h = await setup({ rows: workspaceRows() })
    const remove = h.repo.deleteTask.bind(h.repo)
    vi.spyOn(h.repo, 'deleteTask').mockImplementationOnce(async (id, options) => {
      await remove(id, options)
      throw new RepositoryError('network', NETWORK_ERROR_MESSAGE)
    })
    expect((await h.actions.deleteTask('c', { keepSubtasks: false })).ok).toBe(false)
    await vi.waitFor(() => expect(h.state().data.tasks.c).toBeUndefined())
    await vi.waitFor(() => expect(h.state().sync.canRetry).toBe(false))
    expect(h.state().sync.lastError).toBeNull()
  })

  it('a change that really failed stays rolled back after the resync', async () => {
    const h = await setup({ rows: workspaceRows() })
    const load = vi.spyOn(h.repo, 'loadWorkspace')
    h.repo.failNextWrites(1)
    expect((await h.actions.updateTask('a', { title: 'Never stored' })).ok).toBe(false)
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    await idle(h)
    expect(h.state().data.tasks.a.title).toBe('A')
    expect(h.state().sync).toMatchObject({ canRetry: true, lastError: { kind: 'network' } })
  })

  it('offline, it waits for the browser to come back online instead of asking at once', async () => {
    const win = new EventTarget()
    const h = await setup({
      rows: workspaceRows(),
      environment: { window: win, navigator: { onLine: true } },
    })
    win.dispatchEvent(new Event('offline'))
    const load = vi.spyOn(h.repo, 'loadWorkspace')
    h.repo.failNextWrites(1)
    expect((await h.actions.updateTask('a', { title: 'Offline' })).ok).toBe(false)
    await settled()
    expect(load).not.toHaveBeenCalled()
    win.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
  })
})

describe('text the database cannot store', () => {
  it('a sort key or time zone with it is refused before any write', async () => {
    const h = await setup({ rows: workspaceRows() })
    const writes = [vi.spyOn(h.repo, 'updateTask'), vi.spyOn(h.repo, 'upsertPreferences')]
    const data = h.state().data
    for (const result of [
      await h.actions.updateTask('a', { sortOrder: 'a0\u0000' }),
      await h.actions.updateProject('p1', { sortOrder: '\ud800' }),
      await h.actions.updatePhase('ph1', { sortOrder: 'a\u0000' }),
      await h.actions.updatePreferences({ timezone: 'Asia/Taipei\u0000' }),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { kind: 'validation' } })
    }
    expect(h.state().data).toBe(data)
    for (const spy of writes) expect(spy).not.toHaveBeenCalled()
    expect(h.notifier.error).not.toHaveBeenCalled()
  })
})

describe('a failure without an answer, after an unrelated save', () => {
  it('the toast of a change the server shows as applied goes away too', async () => {
    const h = await setup({ rows: workspaceRows() })
    const update = h.repo.updateTask.bind(h.repo)
    vi.spyOn(h.repo, 'updateTask').mockImplementationOnce(async (id, patch) => {
      await update(id, patch)
      throw new RepositoryError('network', NETWORK_ERROR_MESSAGE)
    })
    h.repo.setLatency(5)
    const lost = h.actions.updateTask('a', { title: 'Saved, answer lost' })
    const unrelated = h.actions.updateProject('p1', { name: 'Alpha 2' }) // saved after it
    expect((await lost).ok).toBe(false)
    expect((await unrelated).ok).toBe(true)
    h.notifier.dismiss.mockClear()
    await h.actions.refresh({ silent: true })
    expect(h.state().data.tasks.a.title).toBe('Saved, answer lost')
    expect(h.notifier.dismiss).toHaveBeenCalledWith(SYNC_ERROR_TOAST_ID)
    expect(h.state().sync).toMatchObject({ lastError: null, canRetry: false })
  })
})

describe('an import whose answer was lost (e.g. a long import that timed out)', () => {
  it('shows the stored copy after the failure and withdraws the failure', async () => {
    const h = await setup({ randomId: () => crypto.randomUUID() })
    const original = h.repo.importWorkspace.bind(h.repo)
    vi.spyOn(h.repo, 'importWorkspace').mockImplementationOnce(async (data) => {
      await original(data) // stored…
      throw new RepositoryError('network', NETWORK_ERROR_MESSAGE) // …but the answer never came
    })
    const file: BackupFile = {
      app: 'cairn',
      formatVersion: 1,
      exportedAt: '2026-10-01T00:00:00.000Z',
      preferences: null,
      data: {
        projects: [makeProject({ id: 'X', name: 'Imported' })],
        phases: [],
        tasks: [makeTask({ id: 'T', projectId: 'X', title: 'Imported task', status: 'done' })],
        milestones: [],
        dependencies: [],
      },
    }
    expect((await h.actions.importBackup(file)).ok).toBe(false)
    await vi.waitFor(() =>
      expect(Object.values(h.state().data.projects).map((p) => p.name)).toEqual(['Imported']),
    )
    await vi.waitFor(() =>
      expect(h.state().sync).toMatchObject({ lastError: null, canRetry: false }),
    )
    expect(h.notifier.dismiss).toHaveBeenCalledWith(SYNC_ERROR_TOAST_ID)
    expect((await storedSnapshot(h)).projects).toHaveLength(1)
  })
})

describe('a request the network delivered twice (the browser re-sent it after its connection died)', () => {
  const deliveredTwice = async <T>(send: () => Promise<T>): Promise<T> => {
    await send()
    return send() // the second delivery is the one that answers: refused as a duplicate
  }

  it('a create refused as a duplicate of itself on its first attempt was stored', async () => {
    const h = await setup({ rows: workspaceRows() })
    const insert = h.repo.insertTask.bind(h.repo)
    vi.spyOn(h.repo, 'insertTask').mockImplementationOnce((task) =>
      deliveredTwice(() => insert(task)),
    )
    const result = await h.actions.createTask({ projectId: 'p1', title: 'Delivered twice' })
    expect(result).toMatchObject({ ok: true, value: { title: 'Delivered twice' } })
    await idle(h)
    expect(h.notifier.error).not.toHaveBeenCalled()
    expect(h.state().sync).toMatchObject({ lastError: null, canRetry: false })
    const stored = await storedSnapshot(h)
    expect(stored.tasks.filter((t) => t.title === 'Delivered twice')).toHaveLength(1)
  })

  it('the same holds for a project, a phase and a milestone', async () => {
    const h = await setup({ rows: workspaceRows() })
    const insertProject = h.repo.insertProject.bind(h.repo)
    vi.spyOn(h.repo, 'insertProject').mockImplementationOnce((row) =>
      deliveredTwice(() => insertProject(row)),
    )
    const insertPhase = h.repo.insertPhase.bind(h.repo)
    vi.spyOn(h.repo, 'insertPhase').mockImplementationOnce((row) =>
      deliveredTwice(() => insertPhase(row)),
    )
    const insertMilestone = h.repo.insertMilestone.bind(h.repo)
    vi.spyOn(h.repo, 'insertMilestone').mockImplementationOnce((row) =>
      deliveredTwice(() => insertMilestone(row)),
    )
    expect((await h.actions.createProject({ name: 'Twice' })).ok).toBe(true)
    expect((await h.actions.createPhase({ projectId: 'p1', name: 'Twice' })).ok).toBe(true)
    expect(
      (await h.actions.createMilestone({ projectId: 'p1', name: 'Twice', date: '2026-12-01' })).ok,
    ).toBe(true)
    await idle(h)
    expect(h.notifier.error).not.toHaveBeenCalled()
    const stored = await storedSnapshot(h)
    expect(stored.projects.filter((row) => row.name === 'Twice')).toHaveLength(1)
    expect(stored.phases.filter((row) => row.name === 'Twice')).toHaveLength(1)
    expect(stored.milestones.filter((row) => row.name === 'Twice')).toHaveLength(1)
  })

  it('an import refused as a duplicate of itself on its first attempt was stored, once', async () => {
    const h = await setup({ rows: workspaceRows() })
    const file = h.actions.exportBackup()
    const importWorkspace = h.repo.importWorkspace.bind(h.repo)
    vi.spyOn(h.repo, 'importWorkspace').mockImplementationOnce((copy) =>
      deliveredTwice(() => importWorkspace(copy)),
    )
    const before = (await storedSnapshot(h)).projects.length
    const result = await h.actions.importBackup(file)
    expect(result).toMatchObject({ ok: true, value: { projects: before } })
    await idle(h)
    expect(h.notifier.error).not.toHaveBeenCalled()
    expect((await storedSnapshot(h)).projects).toHaveLength(before * 2)
  })
})

describe('a change the server refused', () => {
  it('stops counting as a sync problem once a refresh has shown the current data', async () => {
    const h = await setup({ rows: workspaceRows() })
    vi.spyOn(h.repo, 'updateTask').mockRejectedValueOnce(
      new RepositoryError('validation', 'The server refused it.'),
    )
    const result = await h.actions.updateTask('a', { title: 'Refused' })
    expect(result.ok).toBe(false)
    expect(h.notifier.error).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(h.state().sync.lastError).toBeNull())
    expect(h.state().sync.canRetry).toBe(false)
    expect(h.state().data.tasks.a.title).not.toBe('Refused')
  })

  it('a failure waiting for Retry keeps counting after that refresh', async () => {
    const h = await setup({ rows: workspaceRows() })
    vi.spyOn(h.repo, 'updateTask').mockRejectedValueOnce(
      new RepositoryError('network', NETWORK_ERROR_MESSAGE),
    )
    expect((await h.actions.updateTask('a', { title: 'Not saved' })).ok).toBe(false)
    await settled()
    await idle(h)
    await settled()
    expect(h.state().sync.lastError).toMatchObject({ kind: 'network' })
    expect(h.state().sync.canRetry).toBe(true)
  })
})

describe('review findings', () => {
  const net = () => new RepositoryError('network', NETWORK_ERROR_MESSAGE)
  async function makeStore(mode: 'local' | 'supabase' = 'local') {
    const repo = new LocalRepository({ storage: createMemoryStorage() })
    await repo.insertProject(makeProject({ id: 'p1' }))
    const store = createWorkspaceStore({
      mode,
      repository: repo,
      notify: { error: vi.fn(), dismiss: vi.fn() },
      storage: null,
      randomId: () => crypto.randomUUID(),
    })
    return { repo, store, actions: store.getState().actions }
  }

  it('two different tasks with one title, failed in turn: Retry stores both', async () => {
    const { repo, store, actions } = await makeStore()
    await actions.load()
    const insert = vi.spyOn(repo, 'insertTask').mockRejectedValueOnce(net())
    await actions.createTask({ projectId: 'p1', title: 'Review', description: 'contract X' })
    insert.mockRejectedValueOnce(net())
    await actions.createTask({ projectId: 'p1', title: 'Review', description: 'budget Y' })
    expect(store.getState().sync.canRetry).toBe(true)
    await actions.retryLastFailed()
    const stored = Object.values((await repo.loadWorkspace()).tasks).map((t) => t.description)
    expect(stored.sort()).toEqual(['budget Y', 'contract X'])
  })

  it('submitting the same new project, phase or milestone again after failures: Retry stores one', async () => {
    const { repo, actions } = await makeStore()
    await actions.load()
    const project = vi.spyOn(repo, 'insertProject')
    const phase = vi.spyOn(repo, 'insertPhase')
    const milestone = vi.spyOn(repo, 'insertMilestone')
    for (const insert of [project, phase, milestone]) {
      insert.mockRejectedValueOnce(net()).mockRejectedValueOnce(net())
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await actions.createProject({ name: 'Launch' })
      await actions.createPhase({ projectId: 'p1', name: 'Design' })
      await actions.createMilestone({ projectId: 'p1', name: 'Beta', date: '2026-12-01' })
    }
    await actions.retryLastFailed()
    const stored = await repo.loadWorkspace()
    expect(Object.values(stored.projects).filter((row) => row.name === 'Launch')).toHaveLength(1)
    expect(Object.values(stored.phases)).toHaveLength(1)
    expect(Object.values(stored.milestones)).toHaveLength(1)
  })

  it('a refused refresh re-checks the session while a failed write awaits Retry', async () => {
    const { repo, store, actions } = await makeStore('supabase')
    const user = { id: 'u1', email: 'a@example.com' }
    const service = {
      mode: 'supabase' as const,
      getUser: vi.fn(async () => user),
      onChange: () => () => undefined,
      signIn: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn(),
      sendPasswordReset: vi.fn(),
      updatePassword: vi.fn(),
    }
    void createAuthStore({ mode: 'supabase', auth: service, workspace: store })
      .getState()
      .actions.init()
    await vi.waitFor(() => expect(store.getState().status).toBe('ready'))
    vi.spyOn(repo, 'updateProject').mockRejectedValueOnce(net())
    await actions.updateProject('p1', { name: 'Renamed' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const checks = service.getUser.mock.calls.length
    vi.spyOn(repo, 'loadWorkspace').mockRejectedValueOnce(new RepositoryError('auth', 'expired'))
    await actions.refresh({ silent: true })
    await vi.waitFor(() => expect(service.getUser.mock.calls.length).toBe(checks + 1))
    // The failed write is still there; a good load shows it as the error again.
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(store.getState().sync.canRetry).toBe(true)
    expect(store.getState().sync.lastError).toMatchObject({ kind: 'network' })
  })
})

describe('Saved toast after Retry', () => {
  it('shows one Saved toast for a single retry', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(1)
    await h.actions.updateTask('a', { title: 'X' })
    expect(h.notifier.success).not.toHaveBeenCalled()
    expect(await h.actions.retryLastFailed()).toEqual(OK)
    expect(h.notifier.success).toHaveBeenCalledOnce()
    expect(h.notifier.success).toHaveBeenCalledWith('Saved')
  })

  it('shows exactly one for a batch of 3', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(3)
    await h.actions.createTask({ projectId: 'p1', title: 'One' })
    await h.actions.updateTask('b', { priority: 'high' })
    await h.actions.updatePreferences({ weekStartsOn: 0 })
    expect(await h.actions.retryLastFailed()).toEqual(OK)
    expect(h.notifier.success).toHaveBeenCalledOnce()
  })

  it('shows nothing when the retry fails again', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(2)
    await h.actions.updateTask('a', { title: 'X' })
    expect((await h.actions.retryLastFailed()).ok).toBe(false)
    expect(h.notifier.success).not.toHaveBeenCalled()
  })

  it('shows nothing when everything was superseded or the batch is empty', async () => {
    const h = await setup({ rows: workspaceRows() })
    expect(await h.actions.retryLastFailed()).toEqual(OK)
    h.repo.failNextWrites(1)
    await h.actions.updateTask('a', { title: 'Old attempt' })
    h.repo.setLatency(20)
    const newer = h.actions.updateTask('a', { title: 'Newer' })
    expect(await h.actions.retryLastFailed()).toEqual(OK)
    await newer
    expect(h.notifier.success).not.toHaveBeenCalled()
  })

  it('shows nothing when the session changed (sign-out) during the retry', async () => {
    const h = await setup({ rows: workspaceRows() })
    h.repo.failNextWrites(1)
    await h.actions.updateTask('a', { title: 'X' })
    h.repo.setLatency(20)
    const retrying = h.actions.retryLastFailed()
    h.actions.reset()
    await retrying
    expect(h.notifier.success).not.toHaveBeenCalled()
  })
})
