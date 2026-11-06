/**
 * Races between writes, refreshes, failures and a second tab, one regression test per way the
 * randomized runs (store.fuzz.test.ts) or an adversarial reading found to break the data.
 */
import { describe, expect, it, vi } from 'vitest'
import { sortByOrder } from '@/domain/ordering'
import { makeDependency, makePhase, makeProject, makeTask } from '@/domain/testFactories'
import { BACKUP_FORMAT_VERSION, type BackupData, type BackupFile } from '@/domain/types'
import type { WorkspaceState } from './contracts'
import { NETWORK_ERROR_MESSAGE, RepositoryError } from './errors'
import { createMemoryStorage, LocalRepository } from './localRepository'
import { buildTasksCsv, CSV_COLUMNS } from './backup'
import { createWorkspaceStore } from './store'

function makeTab(storage = createMemoryStorage(), prefix = 'new') {
  const repo = new LocalRepository({ storage })
  let sequence = 0
  const notifier = { error: vi.fn(), dismiss: vi.fn() }
  const store = createWorkspaceStore({
    mode: 'local',
    repository: repo,
    notify: notifier,
    storage: null,
    randomId: () => `${prefix}-${++sequence}`,
  })
  return {
    repo,
    storage,
    notifier,
    store,
    actions: store.getState().actions,
    state: (): WorkspaceState => store.getState(),
  }
}

async function seeded() {
  const tab = makeTab()
  await tab.repo.insertProject(makeProject({ id: 'p1', sortOrder: 'a0' }))
  await tab.repo.insertTask(makeTask({ id: 'a', projectId: 'p1', title: 'A', sortOrder: 'a0' }))
  await tab.repo.insertTask(makeTask({ id: 'b', projectId: 'p1', title: 'B', sortOrder: 'a1' }))
  await tab.actions.load()
  await idle(tab)
  return tab
}

async function idle(tab: { state: () => WorkspaceState }) {
  await vi.waitFor(() => expect(tab.state().sync.pending).toBe(0))
}

const stored = (tab: { storage: ReturnType<typeof createMemoryStorage> }) =>
  new LocalRepository({ storage: tab.storage }).loadWorkspace()

describe('the refresh after a failed write', () => {
  it('runs again when a newer write made it discard its snapshot', async () => {
    const tab = await seeded()
    // The create is stored but its answer is lost: only a refresh can show it.
    const insert = tab.repo.insertTask.bind(tab.repo)
    vi.spyOn(tab.repo, 'insertTask').mockImplementationOnce(async (task) => {
      await insert(task)
      throw new RepositoryError('network', NETWORK_ERROR_MESSAGE)
    })
    // The user carries on while that refresh is reading.
    let releaseRead = () => {}
    const load = tab.repo.loadWorkspace.bind(tab.repo)
    const read = vi.spyOn(tab.repo, 'loadWorkspace').mockImplementationOnce(async () => {
      const snapshot = await load()
      await new Promise<void>((resolve) => {
        releaseRead = resolve
      })
      return snapshot
    })
    await tab.actions.createTask({ projectId: 'p1', title: 'Answer lost' })
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    expect(tab.state().data.tasks['new-1']).toBeUndefined()
    await tab.actions.updateTask('a', { title: 'Carried on' })
    releaseRead()

    await vi.waitFor(() =>
      expect(tab.state().data.tasks['new-1']).toMatchObject({ title: 'Answer lost' }),
    )
    expect(tab.state().data.tasks.a.title).toBe('Carried on')
    expect(tab.state().sync).toMatchObject({ lastError: null, canRetry: false })
  })
})

describe('two tabs on the same data', () => {
  async function twoTabs() {
    const a = await seeded()
    const b = makeTab(a.storage, 'other')
    await b.actions.load()
    await idle(b)
    return { a, b }
  }

  it('deleting a task never takes a subtask the other tab added and this one has not seen', async () => {
    const { a, b } = await twoTabs()
    await a.actions.createTask({ projectId: 'p1', title: 'Added elsewhere', parentTaskId: 'b' })
    await idle(a)

    // b still sees no subtasks, so the user was never asked what should happen to them.
    const result = await b.actions.deleteTask('b', { keepSubtasks: false })

    expect(result.ok).toBe(false)
    const rows = await stored(a)
    expect(rows.tasks.map((task) => task.title).sort()).toEqual(['A', 'Added elsewhere', 'B'])
    // Refused, and the refresh shows why: the task is back with the subtask.
    await vi.waitFor(() => expect(b.state().data.tasks.b).toBeDefined())
    await vi.waitFor(() =>
      expect(Object.values(b.state().data.tasks).map((task) => task.title)).toContain(
        'Added elsewhere',
      ),
    )
  })

  it('deleting a task without subtasks still works, also when the other tab deleted it first', async () => {
    const { a, b } = await twoTabs()
    expect((await a.actions.deleteTask('a', { keepSubtasks: false })).ok).toBe(true)
    expect((await b.actions.deleteTask('a', { keepSubtasks: false })).ok).toBe(true)
    expect((await stored(a)).tasks.map((task) => task.id)).toEqual(['b'])
  })
})

describe('a rollback that brings back a sort key a newer row took', () => {
  it('keeps every row, a stable order, and moves that still land next to the neighbour', async () => {
    const tab = await seeded()
    // Delete the last task; before the answer, add a task at the end. The delete then fails.
    tab.repo.failNextWrites(1)
    const deleting = tab.actions.deleteTask('b', { keepSubtasks: false })
    const creating = tab.actions.createTask({ projectId: 'p1', title: 'New' })
    await deleting
    await creating
    await idle(tab)
    await vi.waitFor(async () =>
      expect(Object.keys(tab.state().data.tasks).sort()).toEqual(
        (await stored(tab)).tasks.map((task) => task.id).sort(),
      ),
    )
    const order = () => sortByOrder(Object.values(tab.state().data.tasks)).map((task) => task.id)
    const before = order()
    expect(before).toEqual(['a', 'b', 'new-1'])

    await tab.actions.refresh({ silent: true })
    expect(order()).toEqual(before)
    await tab.actions.moveTask({ taskId: 'a', afterId: 'new-1' })
    expect(order()).toEqual(['b', 'new-1', 'a'])
    await tab.actions.moveTask({ taskId: 'b', afterId: 'new-1' })
    expect(order()).toEqual(['new-1', 'b', 'a'])
  })
})

const AT = '2026-01-01T00:00:00.000Z'

function backupOf(data: Partial<BackupData>): BackupFile {
  return {
    app: 'cairn',
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: AT,
    preferences: null,
    data: { projects: [], phases: [], tasks: [], milestones: [], dependencies: [], ...data },
  }
}

describe('importing', () => {
  it('keeps the order of rows with equal sort keys (their ties were broken by the old ids)', async () => {
    const tab = makeTab()
    await tab.actions.load()
    await idle(tab)
    const projectId = 'p'
    const titles = Array.from({ length: 12 }, (_, i) => `T${String(i).padStart(2, '0')}`)
    const result = await tab.actions.importBackup(
      backupOf({
        projects: [makeProject({ id: projectId, sortOrder: 'a0' })],
        phases: titles.map((name, i) =>
          makePhase({ id: `ph${String(i).padStart(2, '0')}`, projectId, name, sortOrder: 'a0' }),
        ),
        tasks: [
          ...titles.map((title, i) =>
            makeTask({ id: `t${String(i).padStart(2, '0')}`, projectId, title, sortOrder: 'a5' }),
          ),
          ...titles.map((title, i) =>
            makeTask({
              id: `s${String(i).padStart(2, '0')}`,
              projectId,
              title,
              parentTaskId: 't00',
              sortOrder: 'a5',
            }),
          ),
        ],
      }),
    )
    expect(result.ok).toBe(true)
    await idle(tab)
    const { phases, tasks } = tab.state().data
    const names = sortByOrder(Object.values(phases)).map((phase) => phase.name)
    expect(names).toEqual(titles)
    const rows = Object.values(tasks)
    const parent = rows.find((task) => task.title === 'T00' && !task.parentTaskId)
    expect(sortByOrder(rows.filter((task) => !task.parentTaskId)).map((t) => t.title)).toEqual(
      titles,
    )
    expect(
      sortByOrder(rows.filter((task) => task.parentTaskId === parent?.id)).map((t) => t.title),
    ).toEqual(titles)
    // And all that is stored.
    const saved = await stored(tab)
    expect(sortByOrder(saved.phases).map((phase) => phase.name)).toEqual(titles)
  })

  it('takes a large backup with many dependencies without freezing the tab', async () => {
    const tab = makeTab()
    await tab.actions.load()
    await idle(tab)
    const count = 15_000
    const projectId = 'p'
    const result = await tab.actions.importBackup(
      backupOf({
        projects: [makeProject({ id: projectId, sortOrder: 'a0' })],
        tasks: Array.from({ length: count }, (_, i) =>
          makeTask({ id: `t${i}`, projectId, title: `T${i}`, sortOrder: `a${i}` }),
        ),
        dependencies: Array.from({ length: count - 1 }, (_, i) =>
          makeDependency({
            id: `d${i}`,
            projectId,
            predecessorId: `t${i}`,
            successorId: `t${i + 1}`,
          }),
        ),
      }),
    )
    expect(result.ok).toBe(true)
    expect(Object.keys(tab.state().data.dependencies)).toHaveLength(count - 1)
  }, 15_000)

  it('still refuses, all or nothing, a dependency graph that breaks the rules in the repository', async () => {
    const repo = new LocalRepository({ storage: createMemoryStorage() })
    const projectId = 'p'
    const data = (dependencies: BackupData['dependencies']): BackupData => ({
      projects: [makeProject({ id: projectId, sortOrder: 'a0' })],
      phases: [],
      milestones: [],
      tasks: [
        makeTask({ id: 'x', projectId, sortOrder: 'a0' }),
        makeTask({ id: 'y', projectId, sortOrder: 'a1' }),
        makeTask({ id: 'z', projectId, sortOrder: 'a2' }),
        makeTask({ id: 'sub', projectId, parentTaskId: 'x', sortOrder: 'a0' }),
      ],
      dependencies,
    })
    const edge = (id: string, predecessorId: string, successorId: string) =>
      makeDependency({ id, projectId, predecessorId, successorId })

    const refused = [
      [edge('1', 'x', 'y'), edge('2', 'y', 'z'), edge('3', 'z', 'x')], // cycle
      [edge('1', 'x', 'y'), edge('2', 'x', 'y')], // duplicate
      [edge('1', 'x', 'x')], // self
      [edge('1', 'x', 'sub')], // parent and subtask
    ]
    for (const dependencies of refused) {
      await expect(repo.importWorkspace(data(dependencies))).rejects.toBeInstanceOf(RepositoryError)
      expect((await repo.loadWorkspace()).projects).toHaveLength(0)
    }
    await expect(repo.importWorkspace(data([edge('1', 'x', 'y')]))).resolves.toMatchObject({
      dependencies: 1,
    })
  })
})

describe('Retry of a failed delete, after new work was added inside', () => {
  /** The Retry button of the newest failure toast. */
  const clickToastRetry = async (tab: ReturnType<typeof makeTab>) => {
    const [, options] = tab.notifier.error.mock.calls.at(-1) as [
      string,
      { action?: { onClick: () => void } },
    ]
    options.action?.onClick()
    await vi.waitFor(() => expect(tab.state().sync.pending).toBe(0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await idle(tab)
  }

  it('does not take a subtask made after the failure with it', async () => {
    const tab = await seeded()
    tab.repo.failNextWrites(1)
    await tab.actions.deleteTask('b', { keepSubtasks: false })
    expect(tab.state().data.tasks.b).toBeDefined()
    const toastCalls = tab.notifier.error.mock.calls.length
    await tab.actions.createTask({ projectId: 'p1', title: 'Made since', parentTaskId: 'b' })
    await idle(tab)
    expect(tab.notifier.error.mock.calls.length).toBe(toastCalls)

    await clickToastRetry(tab)

    expect((await stored(tab)).tasks.map((task) => task.title).sort()).toEqual([
      'A',
      'B',
      'Made since',
    ])
    expect(tab.notifier.error).toHaveBeenLastCalledWith(
      "Couldn't retry",
      expect.objectContaining({ description: expect.stringMatching(/new subtask/i) as string }),
    )
  })

  it('does not take a task made in the project after the failure with it', async () => {
    const tab = await seeded()
    tab.repo.failNextWrites(1)
    await tab.actions.deleteProject('p1')
    expect(tab.state().data.projects.p1).toBeDefined()
    await tab.actions.createTask({ projectId: 'p1', title: 'Made since' })
    await idle(tab)

    await clickToastRetry(tab)

    expect((await stored(tab)).tasks.map((task) => task.title).sort()).toEqual([
      'A',
      'B',
      'Made since',
    ])
    expect(tab.notifier.error).toHaveBeenLastCalledWith(
      "Couldn't retry",
      expect.objectContaining({ description: expect.stringMatching(/added/i) as string }),
    )
  })

  it('still deletes when nothing was added', async () => {
    const tab = await seeded()
    tab.repo.failNextWrites(1)
    await tab.actions.deleteProject('p1')
    await clickToastRetry(tab)
    const rows = await stored(tab)
    expect(rows.projects).toHaveLength(0)
    expect(rows.tasks).toHaveLength(0)
  })
})

describe('ids in a backup', () => {
  it('colliding with existing rows, across tables or across imports never touch anything', async () => {
    const tab = await seeded()
    const before = await stored(tab)
    // Every id is one the workspace already uses, and all tables share it.
    const file = backupOf({
      projects: [makeProject({ id: 'p1', name: 'Imported', sortOrder: 'a0' })],
      phases: [makePhase({ id: 'a', projectId: 'p1', name: 'Same id as a task', sortOrder: 'a0' })],
      tasks: [
        makeTask({ id: 'a', projectId: 'p1', title: 'Imported A', phaseId: 'a', sortOrder: 'a0' }),
        makeTask({ id: 'p1', projectId: 'p1', title: 'Id of a project', sortOrder: 'a1' }),
      ],
      dependencies: [
        makeDependency({ id: 'a', projectId: 'p1', predecessorId: 'a', successorId: 'p1' }),
      ],
    })
    expect((await tab.actions.importBackup(file)).ok).toBe(true)
    expect((await tab.actions.importBackup(file)).ok).toBe(true)
    await idle(tab)

    const after = await stored(tab)
    for (const original of before.tasks) {
      expect(after.tasks.find((task) => task.id === original.id)).toEqual(original)
    }
    expect(after.projects.find((project) => project.id === 'p1')).toEqual(before.projects[0])
    expect(after.projects).toHaveLength(3)
    expect(after.tasks).toHaveLength(6)
    expect(after.dependencies).toHaveLength(2)
    // Each copy links its own rows.
    for (const dependency of after.dependencies) {
      const from = after.tasks.find((task) => task.id === dependency.predecessorId)
      const to = after.tasks.find((task) => task.id === dependency.successorId)
      expect(from?.title).toBe('Imported A')
      expect(to?.title).toBe('Id of a project')
      expect(from?.projectId).toBe(dependency.projectId)
      expect(to?.projectId).toBe(dependency.projectId)
    }
    expect(new Set(after.tasks.map((task) => task.id)).size).toBe(6)
    expect(tab.state().data.tasks.a.title).toBe('A')
  })
})

describe('a stale tab', () => {
  it('never brings back a row the other tab deleted, whatever it does to it', async () => {
    const a = await seeded()
    const b = makeTab(a.storage, 'other')
    await b.actions.load()
    await idle(b)
    await a.actions.deleteTask('b', { keepSubtasks: false })
    await idle(a)

    expect((await b.actions.updateTask('b', { title: 'Edited late' })).ok).toBe(false)
    await idle(b)
    await vi.waitFor(() => expect(b.state().data.tasks.b).toBeUndefined())
    expect((await stored(a)).tasks.map((task) => task.id)).toEqual(['a'])
  })
})

/** RFC 4180, the way a spreadsheet reads a file. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char !== '"') field += char
      else if (text[i + 1] === '"') {
        field += '"'
        i += 1
      } else quoted = false
    } else if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
    } else field += char
  }
  return rows
}

describe('formula-looking text through export and import', () => {
  const FORMULAS = [
    '=1+1',
    '+1',
    '-2',
    '@SUM(A1)',
    '=HYPERLINK("http://x","y")',
    "=cmd|'/c calc'!A1",
    ' =1+1',
    '＝1+1',
    'multi\n=1+1',
    "'=already",
    'a,b;c',
  ]

  it('is inert in the CSV, in every text column, and unchanged in the app after a JSON round trip', async () => {
    const tab = makeTab()
    await tab.actions.load()
    await idle(tab)
    const project = await tab.actions.createProject({ name: '=project()' })
    if (!project.ok) throw new Error(project.error.message)
    const projectId = project.value.id
    const phase = await tab.actions.createPhase({ projectId, name: '@phase' })
    if (!phase.ok) throw new Error(phase.error.message)
    const parent = await tab.actions.createTask({
      projectId,
      title: '-parent',
      phaseId: phase.value.id,
    })
    if (!parent.ok) throw new Error(parent.error.message)
    for (const title of FORMULAS) {
      const created = await tab.actions.createTask({
        projectId,
        title,
        description: title,
        parentTaskId: parent.value.id,
      })
      expect(created.ok).toBe(true)
    }
    await idle(tab)

    const csv = buildTasksCsv(tab.state().data)
    const [header, ...rows] = parseCsv(csv)
    expect(header).toEqual([...CSV_COLUMNS])
    expect(rows).toHaveLength(FORMULAS.length + 1)
    const active = /^[\s]*[=+\-@＝＋－＠]/
    for (const row of rows) {
      expect(row).toHaveLength(CSV_COLUMNS.length)
      for (const field of row) expect(field).not.toMatch(active)
    }
    // Each cell is the text with at most the one apostrophe in front.
    const titleColumn = CSV_COLUMNS.indexOf('Title')
    const cells = rows.slice(1).map((row) => row[titleColumn])
    const expected = FORMULAS.map((title) => title.trim()).map((title) =>
      active.test(title) ? `'${title}` : title,
    )
    expect(cells.sort()).toEqual(expected.sort())

    // JSON keeps the text exactly; importing does not add or stack apostrophes.
    const other = makeTab(createMemoryStorage(), 'copy')
    await other.actions.load()
    await idle(other)
    const file: BackupFile = JSON.parse(JSON.stringify(tab.actions.exportBackup())) as BackupFile
    expect((await other.actions.importBackup(file)).ok).toBe(true)
    await idle(other)
    const titles = Object.values(other.state().data.tasks).map((task) => task.title)
    expect(titles.sort()).toEqual([...FORMULAS.map((title) => title.trim()), '-parent'].sort())
    expect(buildTasksCsv(other.state().data).split('\r\n').slice(1).join('\r\n')).toEqual(
      buildTasksCsv(tab.state().data).split('\r\n').slice(1).join('\r\n'),
    )
  })
})
