/// <reference lib="dom" />
/**
 * B1, B2, B3, B5: backup and restore through Settings → Data (export is a real download, import
 * goes through the app's `import_workspace` RPC), and a 2,000-task import through the RPC itself.
 * Results are read back over REST with the user's own token.
 */
import {
  buildImport,
  bulkSpec,
  countRows,
  createTestProject,
  errorText,
  exportBackup,
  expect,
  importBackup,
  recordMetric,
  rest,
  test,
  tokenFor,
  type Seeded,
  type UserKey,
} from './support.ts'

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } })

const COMPLETED = '2026-11-03T08:30:00+00:00'

/** One project with every kind of thing a backup has to carry. */
function richProject(label: string): Promise<Seeded> {
  return createTestProject('A', {
    label,
    phases: [
      { name: 'Design', color: 'blue' },
      { name: 'Build', color: 'teal' },
      { name: 'Plain' },
    ],
    tasks: [
      {
        key: 'p',
        title: 'Parent task',
        phase: 'Build',
        status: 'in_progress',
        priority: 'high',
        start: '2026-11-05',
        due: '2026-11-12',
        description: 'Parent description',
      },
      { key: 's', title: 'Subtask', parent: 'p', phase: 'Build', priority: 'low' },
      { key: 'o', title: 'Finished task', status: 'done', completedAt: COMPLETED },
      { key: 'd', title: 'Design task', phase: 'Design', start: '2026-11-02', due: '2026-11-03' },
    ],
    milestones: [{ key: 'm', name: 'Beta release', date: '2026-12-01', phase: 'Build' }],
    deps: [['p', 'o']],
  })
}

interface Backup {
  app: string
  formatVersion: number
  data: {
    projects: { id: string; name: string }[]
    phases: { id: string; projectId: string; name: string; color: string | null }[]
    tasks: {
      id: string
      projectId: string
      phaseId: string | null
      parentTaskId: string | null
      title: string
      description: string | null
      status: string
      priority: string
      startDate: string | null
      dueDate: string | null
      completedAt: string | null
    }[]
    milestones: {
      id: string
      projectId: string
      phaseId: string | null
      name: string
      date: string
    }[]
    dependencies: { projectId: string; predecessorId: string; successorId: string }[]
  }
}

const sameInstant = (a: string | null, b: string | null) =>
  a !== null && b !== null && Date.parse(a) === Date.parse(b)

async function rows<Row>(token: string, path: string): Promise<Row[]> {
  const answer = await rest(token, path)
  expect(answer.status, path).toBe(200)
  return answer.body as Row[]
}

async function tableSnapshot(token: string): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {}
  for (const table of ['projects', 'phases', 'tasks', 'milestones', 'task_dependencies']) {
    out[table] = await rows(token, `${table}?select=*&order=id.asc`)
  }
  return out
}

test.describe('backup and restore (B)', () => {
  test('B1: the exported JSON holds the projects, phases with colours, tasks, subtasks, milestones and dependencies', async ({
    device,
  }) => {
    const seeded = await richProject('B1')
    const page = await device('A')
    const backup = JSON.parse(await exportBackup(page)) as Backup

    expect(backup.app).toBe('cairn')
    expect(backup.formatVersion).toBe(1)
    const { data } = backup
    expect(data.projects.map((p) => p.name)).toEqual([seeded.name])
    expect(data.projects[0].id).toBe(seeded.projectId)

    const color = (name: string) => data.phases.find((p) => p.name === name)?.color
    expect(data.phases).toHaveLength(3)
    expect(color('Design')).toBe('blue')
    expect(color('Build')).toBe('teal')
    expect(color('Plain')).toBeNull()

    expect(data.tasks).toHaveLength(4)
    const task = (title: string) => data.tasks.find((t) => t.title === title)!
    const parent = task('Parent task')
    expect(parent).toMatchObject({
      status: 'in_progress',
      priority: 'high',
      startDate: '2026-11-05',
      dueDate: '2026-11-12',
      description: 'Parent description',
      parentTaskId: null,
    })
    expect(parent.phaseId).toBe(seeded.ids.Build)
    expect(task('Subtask').parentTaskId).toBe(parent.id)
    expect(task('Subtask').priority).toBe('low')
    expect(task('Finished task').status).toBe('done')
    expect(sameInstant(task('Finished task').completedAt, COMPLETED), 'completed_at').toBe(true)
    expect(task('Design task')).toMatchObject({ startDate: '2026-11-02', dueDate: '2026-11-03' })

    expect(data.milestones).toHaveLength(1)
    expect(data.milestones[0]).toMatchObject({ name: 'Beta release', date: '2026-12-01' })
    expect(data.milestones[0].phaseId).toBe(seeded.ids.Build)
    expect(data.dependencies).toHaveLength(1)
    expect(data.dependencies[0]).toMatchObject({
      predecessorId: parent.id,
      successorId: task('Finished task').id,
    })
  })

  test('B2: importing the backup into the other account gives the same counts, colours and completion time', async ({
    device,
  }) => {
    const seeded = await richProject('B2')
    const source = await device('A')
    const text = await exportBackup(source)

    const target = await device('B')
    const message = await importBackup(target, text)
    expect(message).toContain('Added 1 project, 3 phases, 4 tasks, 1 milestone and 1 dependency')

    const tokenA = await tokenFor('A')
    const tokenB = await tokenFor('B')
    const [original] = await rows<{ id: string; name: string }>(
      tokenA,
      `projects?id=eq.${seeded.projectId}&select=*`,
    )
    const copies = await rows<{ id: string; name: string; color: string }>(
      tokenB,
      'projects?select=*',
    )
    expect(copies).toHaveLength(1)
    expect(copies[0].name).toBe(original.name)
    expect(copies[0].id).not.toBe(original.id)
    const copyId = copies[0].id

    for (const [table, expected] of [
      ['phases', 3],
      ['tasks', 4],
      ['milestones', 1],
      ['task_dependencies', 1],
    ] as const) {
      expect(await countRows(tokenB, table, `project_id=eq.${copyId}`), table).toBe(expected)
    }

    const phases = await rows<{ id: string; name: string; color: string | null }>(
      tokenB,
      `phases?project_id=eq.${copyId}&select=id,name,color`,
    )
    expect(Object.fromEntries(phases.map((p) => [p.name, p.color]))).toEqual({
      Design: 'blue',
      Build: 'teal',
      Plain: null,
    })

    type TaskCols = Record<string, string | null>
    const columns =
      'id,title,description,status,priority,start_date,due_date,completed_at,parent_task_id,phase_id'
    const before = await rows<TaskCols>(
      tokenA,
      `tasks?project_id=eq.${seeded.projectId}&select=${columns}`,
    )
    const after = await rows<TaskCols>(tokenB, `tasks?project_id=eq.${copyId}&select=${columns}`)
    for (const original of before) {
      const copy = after.find((t) => t.title === original.title)!
      expect(copy, String(original.title)).toBeDefined()
      for (const field of ['description', 'status', 'priority', 'start_date', 'due_date']) {
        expect(copy[field], `${original.title}.${field}`).toBe(original[field])
      }
      if (original.completed_at) {
        expect(sameInstant(copy.completed_at, original.completed_at), 'completed_at').toBe(true)
      } else {
        expect(copy.completed_at).toBeNull()
      }
    }
    const parentCopy = after.find((t) => t.title === 'Parent task')!
    expect(after.find((t) => t.title === 'Subtask')!.parent_task_id).toBe(parentCopy.id)
    expect(phases.find((p) => p.name === 'Build')!.id).toBe(parentCopy.phase_id)

    const links = await rows<{ predecessor_id: string; successor_id: string }>(
      tokenB,
      `task_dependencies?project_id=eq.${copyId}&select=predecessor_id,successor_id`,
    )
    expect(links).toEqual([
      {
        predecessor_id: parentCopy.id,
        successor_id: after.find((t) => t.title === 'Finished task')!.id,
      },
    ])
    // Account A still has exactly its own project.
    expect(await countRows(tokenA, 'projects')).toBe(1)
  })

  test('B3: importing over existing data adds copies and leaves the originals untouched', async ({
    device,
  }) => {
    const seeded = await richProject('B3')
    const page = await device('A')
    const tokenA = await tokenFor('A')
    const before = await tableSnapshot(tokenA)

    const text = await exportBackup(page)
    const message = await importBackup(page, text)
    expect(message).toContain('as new copies')

    const after = await tableSnapshot(tokenA)
    expect(after.projects).toHaveLength(2)
    expect(after.phases).toHaveLength(6)
    expect(after.tasks).toHaveLength(8)
    expect(after.milestones).toHaveLength(2)
    expect(after.task_dependencies).toHaveLength(2)

    // Every original row is still there, identical (updated_at included).
    for (const [table, originals] of Object.entries(before)) {
      for (const original of originals) {
        const now = after[table].find((row) => row.id === original.id)
        expect(now, `${table} ${String(original.id)}`).toEqual(original)
      }
    }
    // The copies are new rows with the same names.
    const copy = after.projects.find((p) => p.id !== seeded.projectId)!
    expect(copy.name).toBe(seeded.name)
    expect(after.tasks.filter((t) => t.project_id === copy.id)).toHaveLength(4)
  })

  test('B5: importing 2,000 tasks in one call: it works, or it fails whole and leaves nothing behind', async () => {
    test.setTimeout(300_000)
    const user: UserKey = 'A'
    const token = await tokenFor(user)
    const { data, projectId } = buildImport(bulkSpec('B5 bulk', 2000))

    const started = performance.now()
    const answer = await rest(token, 'rpc/import_workspace', {
      method: 'POST',
      body: { p_data: data },
      timeoutMs: 240_000,
    })
    const ms = performance.now() - started

    const tasks = await countRows(token, 'tasks', `project_id=eq.${projectId}`)
    const projects = await countRows(token, 'projects', `id=eq.${projectId}`)
    if (answer.status === 200) {
      expect(answer.body).toMatchObject({ projects: 1, tasks: 2000 })
      expect(tasks).toBe(2000)
      expect(projects).toBe(1)
      recordMetric({
        id: 'B5',
        name: 'import 2,000 tasks (one RPC)',
        value: ms,
        unit: 'ms',
        note: 'imported',
      })
    } else {
      // A clean failure: a reason is given, and not one row of it was kept.
      expect(errorText(answer.body)).not.toBe('')
      expect(tasks, 'tasks left behind by a failed import').toBe(0)
      expect(projects, 'project left behind by a failed import').toBe(0)
      recordMetric({
        id: 'B5',
        name: 'import 2,000 tasks (one RPC)',
        value: ms,
        unit: 'ms',
        note: `FAILED whole, HTTP ${answer.status}: ${errorText(answer.body)}`,
      })
    }
  })
})
