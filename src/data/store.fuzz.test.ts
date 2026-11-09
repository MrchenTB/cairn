/**
 * Seeded randomized test: drives the REAL store on a REAL LocalRepository with random creates,
 * edits, moves, deletes, links and schedules, under injected failures (nothing stored; stored but
 * the answer lost) and latency, with retries. After every settled step it checks the invariants a
 * user relies on: rollback is exact, nothing dangles, one-level subtasks, dependency rules, due >=
 * start, unique sort keys per ordering space, and memory equals what is stored. A failure prints
 * the seed, the step and the actions so it can be replayed by hand.
 */
import { describe, expect, it, vi } from 'vitest'
import { bySortOrder, sortByOrder } from '@/domain/ordering'
import { wouldCreateCycle } from '@/domain/scheduling'
import {
  PROJECT_COLORS,
  PROJECT_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Result,
  type Task,
  type WorkspaceData,
} from '@/domain/types'
import {
  makeDependency,
  makeMilestone,
  makePhase,
  makeProject,
  makeTask,
} from '@/domain/testFactories'
import type { Repository, WorkspaceActions } from './contracts'
import { NETWORK_ERROR_MESSAGE, RepositoryError } from './errors'
import { createMemoryStorage, LOCAL_STORAGE_KEY, LocalRepository } from './localRepository'
import { createWorkspaceStore } from './store'

// ---------------------------------------------------------------------------
// Random source (mulberry32: same seed, same run)
// ---------------------------------------------------------------------------

function makeRandom(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const chance = (p: number) => next() < p
  const pick = <T>(items: readonly T[]): T | undefined =>
    items.length === 0 ? undefined : items[int(items.length)]
  return { next, int, chance, pick }
}
type Random = ReturnType<typeof makeRandom>

// ---------------------------------------------------------------------------
// A repository with faults: the real one behind it does the storing and the rule checks.
// ---------------------------------------------------------------------------

/** none = normal; refused = nothing stored, network error; lost = stored, answer lost. */
type Fault = 'none' | 'refused' | 'lost'

const READS = new Set(['loadWorkspace'])

interface Faulty {
  repository: Repository
  /** What the next writes do (consumed in order, then `chooseFault`). */
  plan: Fault[]
  chooseFault: () => Fault
  latency: () => number
  /** The next reads fail too (a lost answer the following refresh cannot explain). */
  failReads: number
  /** Faults that fired since the last reset of this list. */
  fired: Fault[]
  inFlight: () => number
}

function withFaults(real: LocalRepository, dropWritesOf?: string): Faulty {
  let inFlight = 0
  const faulty: Faulty = {
    plan: [],
    chooseFault: () => 'none',
    latency: () => 0,
    failReads: 0,
    fired: [],
    inFlight: () => inFlight,
    repository: new Proxy(real, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        return async (...args: unknown[]) => {
          inFlight += 1
          try {
            const ms = faulty.latency()
            if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
            const call = () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)
            if (READS.has(String(property))) {
              if (faulty.failReads === 0) return await call()
              faulty.failReads -= 1
              throw new RepositoryError('network', NETWORK_ERROR_MESSAGE)
            }
            // Sabotage (the self-check below): answers as if stored, stores nothing.
            if (String(property) === dropWritesOf) return args[0]
            const fault = faulty.plan.shift() ?? faulty.chooseFault()
            if (fault !== 'none') faulty.fired.push(fault)
            if (fault === 'refused') throw new RepositoryError('network', NETWORK_ERROR_MESSAGE)
            const answer = await call()
            if (fault === 'lost') throw new RepositoryError('network', NETWORK_ERROR_MESSAGE)
            return answer
          } finally {
            inFlight -= 1
          }
        }
      },
    }) as unknown as Repository,
  }
  return faulty
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const RUN_CLOCK_START = Date.UTC(2026, 5, 1)

function makeTab(
  storage: ReturnType<typeof createMemoryStorage>,
  label: string,
  seed: number,
  dropWritesOf?: string,
) {
  let tick = 0
  let sequence = 0
  const clock = () => RUN_CLOCK_START + ++tick
  const real = new LocalRepository({
    storage,
    now: () => new Date(clock()).toISOString(),
  })
  const faults = withFaults(real, dropWritesOf)
  const toastRetry: { click?: () => void } = {}
  const store = createWorkspaceStore({
    mode: 'local',
    repository: faults.repository,
    notify: {
      error: (_title, options) => {
        toastRetry.click = options?.action?.onClick as (() => void) | undefined
        return ''
      },
      dismiss: vi.fn(),
    },
    storage: null,
    now: clock,
    randomId: () => `${label}-${seed}-${++sequence}`,
  })
  return {
    store,
    faults,
    toastRetry,
    storage,
    actions: store.getState().actions,
    state: () => store.getState(),
  }
}
type Tab = ReturnType<typeof makeTab>

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Until no write is pending, no call is under way and no resync is about to start. */
async function settled(tab: Tab): Promise<void> {
  let quiet = 0
  for (let i = 0; i < 2000 && quiet < 2; i += 1) {
    await macrotask()
    quiet = tab.state().sync.pending === 0 && tab.faults.inFlight() === 0 ? quiet + 1 : 0
  }
  if (quiet < 2) throw new Error('the store never settled')
}

const STAMPS = new Set(['createdAt', 'updatedAt'])

/** The data without server-stamped times (those differ between optimistic and stored rows). */
function comparable(data: WorkspaceData | Record<string, unknown>): unknown {
  return JSON.parse(
    JSON.stringify(data, (key, value: unknown) => (STAMPS.has(key) ? undefined : value)),
    (_key, value: unknown) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
      // Key order says nothing.
      const record = value as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, record[key]]),
      )
    },
  ) as unknown
}

/** Also without the completion time's value: the server stamps it on its own clock. */
function intended(data: WorkspaceData): unknown {
  return JSON.parse(
    JSON.stringify(comparable(data), (key, value: unknown) =>
      key === 'completedAt' ? value !== null : value,
    ),
  ) as unknown
}

/** What is stored, as tables (read by a separate repository: a refresh after a reload). */
async function storedData(storage: Tab['storage']): Promise<WorkspaceData> {
  const snapshot = await new LocalRepository({ storage }).loadWorkspace()
  const byId = <T extends { id: string }>(rows: readonly T[]) =>
    Object.fromEntries(rows.map((row) => [row.id, row]))
  return {
    projects: byId(snapshot.projects),
    phases: byId(snapshot.phases),
    tasks: byId(snapshot.tasks),
    milestones: byId(snapshot.milestones),
    dependencies: byId(snapshot.dependencies),
  }
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

interface InvariantOptions {
  /** Two tabs (or a lost answer raced by a new row) can pick the same key; ties stay ordered. */
  allowEqualSortKeys?: boolean
}

function integrityProblems(data: WorkspaceData, options: InvariantOptions = {}): string[] {
  const problems: string[] = []
  const report = (problem: string) => problems.push(problem)
  const has = (table: Record<string, unknown>, id: string) => Object.hasOwn(table, id)

  for (const name of ['projects', 'phases', 'tasks', 'milestones', 'dependencies'] as const) {
    for (const [key, row] of Object.entries(data[name])) {
      if (row.id !== key) report(`${name}: row ${row.id} is filed under ${key}`)
    }
  }
  const checkDates = (label: string, start: string | null, due: string | null) => {
    if (start !== null && due !== null && due < start)
      report(`${label}: due ${due} < start ${start}`)
  }
  for (const project of Object.values(data.projects)) {
    checkDates(`project ${project.id}`, project.startDate, project.dueDate)
  }
  for (const phase of Object.values(data.phases)) {
    if (!has(data.projects, phase.projectId)) report(`phase ${phase.id}: orphan`)
  }
  for (const task of Object.values(data.tasks)) {
    const label = `task ${task.id}`
    if (!has(data.projects, task.projectId)) report(`${label}: orphan`)
    if (task.phaseId !== null) {
      if (!has(data.phases, task.phaseId)) report(`${label}: dangling phase ${task.phaseId}`)
      else if (data.phases[task.phaseId].projectId !== task.projectId) {
        report(`${label}: phase of another project`)
      }
    }
    if (task.parentTaskId !== null) {
      if (!has(data.tasks, task.parentTaskId)) {
        report(`${label}: dangling parent ${task.parentTaskId}`)
      } else {
        const parent = data.tasks[task.parentTaskId]
        if (parent.parentTaskId !== null) report(`${label}: nested more than one level`)
        if (parent.projectId !== task.projectId) report(`${label}: parent in another project`)
        if (parent.phaseId !== task.phaseId) {
          report(`${label}: phase ${task.phaseId} differs from its parent's ${parent.phaseId}`)
        }
      }
    }
    checkDates(label, task.startDate, task.dueDate)
    if ((task.status === 'done') !== (task.completedAt !== null)) {
      report(`${label}: status ${task.status} with completedAt ${task.completedAt}`)
    }
  }
  for (const milestone of Object.values(data.milestones)) {
    const label = `milestone ${milestone.id}`
    if (!has(data.projects, milestone.projectId)) report(`${label}: orphan`)
    if (milestone.phaseId !== null) {
      if (!has(data.phases, milestone.phaseId)) report(`${label}: dangling phase`)
      else if (data.phases[milestone.phaseId].projectId !== milestone.projectId) {
        report(`${label}: phase of another project`)
      }
    }
  }
  const seenPairs = new Set<string>()
  const edges: { predecessorId: string; successorId: string }[] = []
  for (const dependency of Object.values(data.dependencies)) {
    const label = `dependency ${dependency.id}`
    const { predecessorId, successorId } = dependency
    if (!has(data.tasks, predecessorId) || !has(data.tasks, successorId)) {
      report(`${label}: dangling`)
      continue
    }
    const predecessor = data.tasks[predecessorId]
    const successor = data.tasks[successorId]
    if (predecessorId === successorId) report(`${label}: self`)
    if (predecessor.projectId !== successor.projectId) report(`${label}: across projects`)
    if (dependency.projectId !== predecessor.projectId) report(`${label}: wrong project`)
    if (predecessor.parentTaskId === successorId || successor.parentTaskId === predecessorId) {
      report(`${label}: links a task and its parent`)
    }
    const pair = `${predecessorId}>${successorId}`
    if (seenPairs.has(pair)) report(`${label}: duplicate`)
    seenPairs.add(pair)
    if (wouldCreateCycle(edges, predecessorId, successorId)) report(`${label}: closes a cycle`)
    edges.push({ predecessorId, successorId })
  }
  if (!options.allowEqualSortKeys) {
    const spaces = new Map<string, string[]>()
    const place = (space: string, key: string) => {
      const keys = spaces.get(space)
      if (keys) keys.push(key)
      else spaces.set(space, [key])
    }
    for (const project of Object.values(data.projects)) place('projects', project.sortOrder)
    for (const phase of Object.values(data.phases))
      place(`phases/${phase.projectId}`, phase.sortOrder)
    for (const task of Object.values(data.tasks)) {
      place(
        task.parentTaskId ? `subtasks/${task.parentTaskId}` : `tasks/${task.projectId}`,
        task.sortOrder,
      )
    }
    for (const [space, keys] of spaces) {
      if (new Set(keys).size !== keys.length) {
        report(`${space}: equal sort keys ${keys.join(' ')}`)
      }
    }
  }
  return problems
}

/** The workspace with ids replaced by position: what must survive an export + import. */
function canonicalTree(data: WorkspaceData): unknown {
  const projects = sortByOrder(Object.values(data.projects))
  const stripRow = <T extends object>(row: T, ...fields: (keyof T)[]) => {
    const copy: Partial<T> = { ...row }
    for (const field of fields) delete copy[field]
    return copy
  }
  return projects.map((project) => {
    const phases = sortByOrder(Object.values(data.phases).filter((p) => p.projectId === project.id))
    const phaseIndex = new Map(phases.map((phase, i) => [phase.id, i]))
    const tasks = Object.values(data.tasks).filter((t) => t.projectId === project.id)
    const topLevel = sortByOrder(tasks.filter((t) => t.parentTaskId === null))
    const ordered = topLevel.flatMap((task) => [
      task,
      ...sortByOrder(tasks.filter((t) => t.parentTaskId === task.id)),
    ])
    const taskIndex = new Map(ordered.map((task, i) => [task.id, i]))
    const phaseOf = (id: string | null) => (id === null ? null : phaseIndex.get(id))
    return {
      project: stripRow(project, 'id', 'sortOrder', 'createdAt', 'updatedAt'),
      phases: phases.map((phase) => phase.name),
      tasks: ordered.map((task) => ({
        ...stripRow(
          task,
          'id',
          'projectId',
          'sortOrder',
          'createdAt',
          'updatedAt',
          'phaseId',
          'parentTaskId',
        ),
        phase: phaseOf(task.phaseId),
        parent: task.parentTaskId === null ? null : taskIndex.get(task.parentTaskId),
      })),
      milestones: Object.values(data.milestones)
        .filter((m) => m.projectId === project.id)
        .map((m) => ({ name: m.name, date: m.date, phase: phaseOf(m.phaseId) }))
        .sort((a, b) =>
          `${a.date}|${a.name}|${a.phase}` < `${b.date}|${b.name}|${b.phase}` ? -1 : 1,
        ),
      dependencies: Object.values(data.dependencies)
        .filter((d) => d.projectId === project.id)
        .map((d) => [taskIndex.get(d.predecessorId), taskIndex.get(d.successorId)])
        .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0)),
    }
  })
}

// ---------------------------------------------------------------------------
// Random actions
// ---------------------------------------------------------------------------

const TITLES = [
  'Plan',
  'Ship it',
  '=1+1',
  '@SUM(A1)',
  '-5 items',
  '  spaced out  ',
  '任務 🚀',
  'a,b;"c"',
  'line\nbreak',
  '__proto__',
]

interface Plan {
  name: string
  run: (actions: WorkspaceActions) => Promise<Result<unknown>>
}

/** January 2026 to March 2026 (or null sometimes). */
function randomDate(random: Random): string {
  const month = 1 + random.int(3)
  const day = 1 + random.int(28)
  return `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function randomRange(random: Random): { startDate: string | null; dueDate: string | null } {
  const a = random.chance(0.3) ? null : randomDate(random)
  const b = random.chance(0.3) ? null : randomDate(random)
  if (a === null || b === null || a <= b) return { startDate: a, dueDate: b }
  return { startDate: b, dueDate: a }
}

/** Ids seen earlier that may be gone by now: stale screens and late clicks use them. */
interface Seen {
  projects: string[]
  phases: string[]
  tasks: string[]
  milestones: string[]
  dependencies: string[]
}

function chooseAction(random: Random, data: WorkspaceData, seen: Seen): Plan {
  const remember = (table: keyof Seen, ids: string[]) => {
    for (const id of ids) if (!seen[table].includes(id)) seen[table].push(id)
  }
  const tables = (table: keyof Seen) => Object.keys(data[table])
  for (const table of Object.keys(seen) as (keyof Seen)[]) remember(table, tables(table))

  /** A live id, or (rarely) one that may be deleted. */
  const idOf = (table: keyof Seen): string | undefined =>
    random.chance(0.06) ? random.pick(seen[table]) : random.pick(tables(table))

  const project = idOf('projects')
  const phase = idOf('phases')
  const task = idOf('tasks')
  const other = idOf('tasks')
  const third = idOf('tasks')
  const milestone = idOf('milestones')
  const dependency = idOf('dependencies')
  const phaseOfProject =
    project === undefined
      ? null
      : (random.pick(Object.values(data.phases).filter((p) => p.projectId === project))?.id ?? null)
  const siblingOf = (id: string | undefined) => {
    const row = id !== undefined && Object.hasOwn(data.tasks, id) ? data.tasks[id] : undefined
    return row === undefined
      ? null
      : (random.pick(
          Object.values(data.tasks).filter(
            (t) =>
              t.projectId === row.projectId &&
              t.parentTaskId === row.parentTaskId &&
              t.id !== row.id,
          ),
        )?.id ?? null)
  }
  const samePhase = (id: string | undefined) => {
    const row = id !== undefined && Object.hasOwn(data.tasks, id) ? data.tasks[id] : undefined
    return row === undefined
      ? null
      : (random.pick(Object.values(data.phases).filter((p) => p.projectId === row.projectId))?.id ??
          null)
  }
  const title = random.pick(TITLES) as string
  const range = randomRange(random)
  const noop: Plan = { name: 'nothing', run: async () => ({ ok: true, value: undefined }) }

  const options: [number, () => Plan][] = [
    [
      tables('projects').length < 3 ? 6 : 1,
      () => ({
        name: `createProject ${title}`,
        run: (a) =>
          a.createProject({
            name: title,
            color: random.pick(PROJECT_COLORS),
            status: random.pick(PROJECT_STATUSES),
            ...range,
          }),
      }),
    ],
    [
      1,
      () =>
        project === undefined
          ? noop
          : {
              name: `updateProject ${project}`,
              run: (a) =>
                a.updateProject(
                  project,
                  random.chance(0.5) ? { name: title, description: title } : { ...range },
                ),
            },
    ],
    [
      1,
      () =>
        project === undefined
          ? noop
          : {
              name: `moveProject ${project}`,
              run: (a) =>
                a.moveProject(project, random.pick([null, ...tables('projects')]) ?? null),
            },
    ],
    [
      0.15,
      () =>
        project === undefined
          ? noop
          : { name: `deleteProject ${project}`, run: (a) => a.deleteProject(project) },
    ],
    [
      2,
      () =>
        project === undefined
          ? noop
          : {
              name: `createPhase in ${project}`,
              run: (a) =>
                a.createPhase({
                  projectId: project,
                  name: title,
                  afterPhaseId: random.chance(0.3) ? phaseOfProject : undefined,
                }),
            },
    ],
    [
      1,
      () =>
        phase === undefined
          ? noop
          : { name: `updatePhase ${phase}`, run: (a) => a.updatePhase(phase, { name: title }) },
    ],
    [
      4,
      () =>
        phase === undefined
          ? noop
          : {
              name: `movePhase ${phase}`,
              run: (a) => {
                const row = Object.hasOwn(data.phases, phase) ? data.phases[phase] : undefined
                const after = random.pick(
                  Object.values(data.phases).filter((p) => p.projectId === row?.projectId),
                )
                return a.movePhase(phase, random.chance(0.3) ? null : (after?.id ?? null))
              },
            },
    ],
    [
      0.7,
      () =>
        phase === undefined
          ? noop
          : { name: `deletePhase ${phase}`, run: (a) => a.deletePhase(phase) },
    ],
    [
      8,
      () =>
        project === undefined
          ? noop
          : {
              name: `createTask in ${project} (${title})`,
              run: (a) =>
                a.createTask({
                  projectId: project,
                  title,
                  phaseId: phaseOfProject,
                  parentTaskId: random.chance(0.3) ? task : null,
                  status: random.pick(TASK_STATUSES),
                  priority: random.pick(TASK_PRIORITIES),
                  ...range,
                  placement: random.chance(0.3)
                    ? { afterId: random.chance(0.5) ? other : null }
                    : undefined,
                }),
            },
    ],
    [
      5,
      () =>
        task === undefined
          ? noop
          : {
              name: `updateTask ${task} fields`,
              run: (a) =>
                a.updateTask(
                  task,
                  random.pick([
                    { title },
                    { description: title },
                    { status: random.pick(TASK_STATUSES) },
                    { priority: random.pick(TASK_PRIORITIES) },
                    { startDate: randomDate(random) },
                    { dueDate: randomDate(random) },
                    { startDate: null },
                    { dueDate: null },
                    range,
                  ]) ?? {},
                ),
            },
    ],
    [
      2,
      () =>
        task === undefined
          ? noop
          : {
              name: `updateTask ${task} phase`,
              run: (a) =>
                a.updateTask(task, { phaseId: random.chance(0.3) ? null : samePhase(task) }),
            },
    ],
    [
      2,
      () =>
        task === undefined
          ? noop
          : {
              name: `updateTask ${task} parent -> ${other}`,
              run: (a) => a.updateTask(task, { parentTaskId: random.chance(0.4) ? null : other }),
            },
    ],
    [
      6,
      () =>
        task === undefined
          ? noop
          : {
              name: `moveTask ${task}`,
              run: (a) => {
                const after = siblingOf(task)
                const parent = random.chance(0.15) ? other : undefined
                return a.moveTask({
                  taskId: task,
                  afterId: random.chance(0.5) ? after : undefined,
                  beforeId: random.chance(0.3) ? siblingOf(task) : undefined,
                  phaseId: random.chance(0.2) ? samePhase(task) : undefined,
                  status: random.chance(0.3) ? random.pick(TASK_STATUSES) : undefined,
                  parentTaskId: random.chance(0.1) ? null : parent,
                })
              },
            },
    ],
    [
      2,
      () =>
        task === undefined
          ? noop
          : {
              name: `deleteTask ${task}`,
              run: (a) => a.deleteTask(task, { keepSubtasks: random.chance(0.5) }),
            },
    ],
    [
      1.5,
      () =>
        project === undefined
          ? noop
          : {
              name: `createMilestone in ${project}`,
              run: (a) =>
                a.createMilestone({
                  projectId: project,
                  name: title,
                  date: randomDate(random),
                  phaseId: phaseOfProject,
                }),
            },
    ],
    [
      1,
      () =>
        milestone === undefined
          ? noop
          : {
              name: `updateMilestone ${milestone}`,
              run: (a) => {
                const row = Object.hasOwn(data.milestones, milestone)
                  ? data.milestones[milestone]
                  : undefined
                return a.updateMilestone(milestone, {
                  name: title,
                  date: randomDate(random),
                  phaseId:
                    random.pick(
                      Object.values(data.phases).filter((p) => p.projectId === row?.projectId),
                    )?.id ?? null,
                })
              },
            },
    ],
    [
      0.7,
      () =>
        milestone === undefined
          ? noop
          : { name: `deleteMilestone ${milestone}`, run: (a) => a.deleteMilestone(milestone) },
    ],
    [
      5,
      () =>
        task === undefined || other === undefined
          ? noop
          : { name: `addDependency ${task}>${other}`, run: (a) => a.addDependency(task, other) },
    ],
    [
      1,
      () =>
        dependency === undefined
          ? noop
          : { name: `removeDependency ${dependency}`, run: (a) => a.removeDependency(dependency) },
    ],
    [
      3,
      () => {
        const ids = [...new Set([task, other, third])].filter((id) => id !== undefined)
        return ids.length === 0
          ? noop
          : {
              name: `applySchedule ${ids.join(',')}`,
              run: (a) =>
                a.applySchedule(ids.map((taskId) => ({ taskId, ...randomRange(random) }))),
            }
      },
    ],
    [
      0.7,
      () => ({
        name: 'updatePreferences',
        run: (a) =>
          a.updatePreferences({
            weekStartsOn: random.chance(0.5) ? 0 : 1,
            sidebarCollapsed: random.chance(0.5),
          }),
      }),
    ],
  ]
  const total = options.reduce((sum, [weight]) => sum + weight, 0)
  let roll = random.next() * total
  for (const [weight, build] of options) {
    roll -= weight
    if (roll <= 0) return build()
  }
  return noop
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const SEEDS = [1, 2, 3, 5, 8, 13, 21]
const STEPS = 130

function emptySeen(): Seen {
  return { projects: [], phases: [], tasks: [], milestones: [], dependencies: [] }
}

function expectNoProblems(problems: string[], where: string, trace: readonly string[]): void {
  if (problems.length > 0) {
    throw new Error(
      `${where}\n${problems.join('\n')}\n--- last actions ---\n${trace.slice(-25).join('\n')}`,
    )
  }
}

function expectSame(actual: unknown, expected: unknown, where: string, trace: readonly string[]) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    // toEqual gives the readable diff; the trace says how it got there.
    expect(actual, `${where}\n--- last actions ---\n${trace.slice(-25).join('\n')}`).toEqual(
      expected,
    )
  }
}

/** What the run did, so a run that only bounces off the rules does not look like a pass. */
const applied = new Map<string, number>()

async function runSingleTabSeed(seed: number, dropWritesOf?: string): Promise<void> {
  const random = makeRandom(seed)
  const storage = createMemoryStorage()
  const tab = makeTab(storage, 'x', seed, dropWritesOf)
  await tab.actions.load()
  await settled(tab)
  const seen = emptySeen()
  const trace: string[] = []
  const checkAll = async (where: string, options: InvariantOptions = {}) => {
    const memory = tab.state().data
    expectNoProblems(integrityProblems(memory, options), `${where}: memory`, trace)
    const stored = await storedData(storage)
    expectNoProblems(integrityProblems(stored, options), `${where}: stored`, trace)
    expectSame(comparable(memory), comparable(stored), `${where}: memory != stored`, trace)
  }

  for (let step = 0; step < STEPS; step += 1) {
    const where = `seed ${seed} step ${step}`
    tab.faults.latency = () => (random.chance(0.15) ? 1 + random.int(3) : 0)
    tab.faults.fired = []
    const roll = random.next()
    if (roll < 0.55) {
      // One change at a time, failing in a planned way.
      const plan = chooseAction(random, tab.state().data, seen)
      const fault: Fault = random.chance(0.6) ? 'none' : random.chance(0.6) ? 'refused' : 'lost'
      tab.faults.plan = [fault]
      const unexplained = fault === 'lost' && random.chance(0.35)
      if (unexplained) tab.faults.failReads = 1
      trace.push(`${step} ${plan.name} [${fault}]`)
      const before = comparable(tab.state().data)
      const olderFailures = tab.state().sync.canRetry
      const storedBefore = storage.getItem(LOCAL_STORAGE_KEY)
      const running = plan.run(tab.actions)
      const optimistic = intended(tab.state().data)
      const result = await running
      const sent = tab.faults.plan.length === 0
      if (result.ok && sent) {
        const kind = plan.name.split(' ')[0]
        applied.set(kind, (applied.get(kind) ?? 0) + 1)
      }
      tab.faults.plan = []
      await settled(tab)
      const readFailed = unexplained && tab.faults.failReads === 0
      tab.faults.failReads = 0

      if (!sent || (!result.ok && tab.faults.fired.length === 0)) {
        // Refused before sending or by the rules: nothing changed anywhere.
        if (!result.ok) {
          expectSame(
            comparable(tab.state().data),
            before,
            `${where}: a refused change stuck`,
            trace,
          )
          expect(storage.getItem(LOCAL_STORAGE_KEY), `${where} stored`).toBe(storedBefore)
        }
      } else if (fault === 'refused') {
        // Rollback is exact, nothing stored, the failure is on record, and Retry does it.
        expect(result.ok, `${where}: a failed write reported success\n${trace.join('\n')}`).toBe(
          false,
        )
        expectSame(comparable(tab.state().data), before, `${where}: rollback is not exact`, trace)
        expect(storage.getItem(LOCAL_STORAGE_KEY), `${where} stored`).toBe(storedBefore)
        expect(tab.state().sync.canRetry, `${where} canRetry`).toBe(true)
        expect(tab.state().sync.lastError, `${where} lastError`).not.toBeNull()
        if (random.chance(0.7)) {
          trace.push(`${step} retry`)
          tab.faults.plan = ['none']
          await tab.actions.retryLastFailed()
          tab.faults.plan = []
          await settled(tab)
          // (Older failures waiting for Retry go too and may change the picture.)
          if (!olderFailures) {
            expectSame(intended(tab.state().data), optimistic, `${where}: Retry differs`, trace)
            expect(tab.state().sync.canRetry, `${where} canRetry after Retry`).toBe(false)
            expect(tab.state().sync.lastError, `${where} lastError after Retry`).toBeNull()
          }
        }
      } else if (fault === 'lost' && readFailed) {
        // Stored, but the refresh failed as well: Retry finds it stored and adds nothing.
        trace.push(`${step} retry an unexplained failure`)
        tab.faults.plan = ['none']
        await tab.actions.retryLastFailed()
        tab.faults.plan = []
        await settled(tab)
        if (!olderFailures) {
          expectSame(intended(tab.state().data), optimistic, `${where}: Retry differs`, trace)
          expect(tab.state().sync.canRetry, `${where} canRetry after Retry`).toBe(false)
          expect(tab.state().sync.lastError, `${where} lastError after Retry`).toBeNull()
        }
      } else if (fault === 'lost') {
        // The write was stored: once the refresh shows that, nothing claims it failed.
        expectSame(
          intended(tab.state().data),
          optimistic,
          `${where}: a stored change vanished`,
          trace,
        )
        if (!olderFailures) {
          expect(tab.state().sync.canRetry, `${where} canRetry after lost answer`).toBe(false)
          expect(tab.state().sync.lastError, `${where} lastError after lost answer`).toBeNull()
        }
      } else if (result.ok) {
        expectSame(intended(tab.state().data), optimistic, `${where}: reconcile changed it`, trace)
      }
      // A retried row stored behind this device's back (lost answer, failed refresh) can share a
      // key with an older failure sent again next to it. Ties are legal; see the burst below.
      await checkAll(where, { allowEqualSortKeys: readFailed || olderFailures })
      await normalizeTies(tab)
    } else if (roll < 0.85) {
      // Several changes at once, racing each other and the failures, sometimes a refresh too.
      tab.faults.chooseFault = () =>
        random.chance(0.8) ? 'none' : random.chance(0.7) ? 'refused' : 'lost'
      const count = 2 + random.int(4)
      const running: Promise<unknown>[] = []
      for (let i = 0; i < count; i += 1) {
        const plan = chooseAction(random, tab.state().data, seen)
        trace.push(`${step} burst ${plan.name}`)
        running.push(plan.run(tab.actions))
        if (random.chance(0.15)) {
          trace.push(`${step} burst refresh`)
          running.push(tab.actions.refresh({ silent: true }))
        }
        if (random.chance(0.1)) {
          trace.push(`${step} burst retry`)
          running.push(tab.actions.retryLastFailed())
        }
        if (tab.toastRetry.click && random.chance(0.1)) {
          trace.push(`${step} burst toast retry`)
          tab.toastRetry.click()
        }
        if (random.chance(0.04)) {
          trace.push(`${step} burst load`)
          running.push(tab.actions.load())
        }
        if (random.chance(0.4)) await macrotask()
      }
      await Promise.all(running)
      tab.faults.chooseFault = () => 'none'
      await settled(tab)
      // A rolled back delete or move brings back a key a newer row may have taken meanwhile (the same
      // goes for a stored row whose answer was lost). Ties are legal: they keep a stable order.
      const anyFault = tab.faults.fired.length > 0
      await checkAll(where, { allowEqualSortKeys: anyFault })
      if (anyFault) await normalizeTies(tab)
      if (tab.state().sync.canRetry && random.chance(0.6)) {
        trace.push(`${step} retry all`)
        tab.faults.plan = []
        await tab.actions.retryLastFailed()
        await settled(tab)
        await checkAll(`${where} after retry`, { allowEqualSortKeys: true })
        await normalizeTies(tab)
      }
    } else if (roll < 0.95) {
      // Refresh: what a reload would show.
      trace.push(`${step} refresh`)
      await tab.actions.refresh({ silent: true })
      await settled(tab)
      const fresh = await storedData(storage)
      expect(tab.state().data, `${where} refresh`).toEqual(fresh)
      await checkAll(where)
    } else if (Object.keys(tab.state().data.projects).length > 0) {
      await checkExportImportRoundTrip(tab, `${where} export`, seed * 1000 + step, trace)
    }
  }
  // End state, a reload, and the round trip.
  await tab.actions.refresh({ silent: true })
  await settled(tab)
  await checkAll(`seed ${seed} end`)
  await checkExportImportRoundTrip(tab, `seed ${seed} end export`, seed * 1000 + STEPS, trace)
}

/** Moves one of each pair of tied siblings, the way a user would untie them. */
async function normalizeTies(tab: Tab): Promise<void> {
  for (let guard = 0; guard < 50; guard += 1) {
    const { tasks, projects, phases } = tab.state().data
    const tied = <T extends { id: string; sortOrder: string }>(rows: T[]) => {
      const sorted = [...rows].sort(bySortOrder)
      return sorted.find((row, i) => i > 0 && sorted[i - 1].sortOrder === row.sortOrder)
    }
    let moved = false
    const projectTie = tied(Object.values(projects))
    if (projectTie) {
      await tab.actions.updateProject(projectTie.id, {
        sortOrder: `${projectTie.sortOrder}V`,
      })
      moved = true
    }
    for (const project of Object.keys(projects)) {
      const phaseTie = tied(Object.values(phases).filter((p) => p.projectId === project))
      if (phaseTie) {
        await tab.actions.updatePhase(phaseTie.id, { sortOrder: `${phaseTie.sortOrder}V` })
        moved = true
      }
    }
    const taskRows = Object.values(tasks)
    for (const parent of new Set(taskRows.map((t) => `${t.projectId}/${t.parentTaskId}`))) {
      const taskTie = tied(taskRows.filter((t) => `${t.projectId}/${t.parentTaskId}` === parent))
      if (taskTie) {
        await tab.actions.updateTask(taskTie.id, { sortOrder: `${taskTie.sortOrder}V` })
        moved = true
      }
    }
    await settled(tab)
    if (!moved) return
  }
}

async function checkExportImportRoundTrip(
  tab: Tab,
  where: string,
  seed: number,
  trace: readonly string[],
): Promise<void> {
  const original = tab.state().data
  const fileText = JSON.stringify(tab.actions.exportBackup())
  const other = makeTab(createMemoryStorage(), 'copy', seed)
  await other.actions.load()
  await settled(other)
  const result = await other.actions.importBackup(JSON.parse(fileText))
  if (!result.ok) throw new Error(`${where}: import refused: ${result.error.message}\n${fileText}`)
  await settled(other)
  const imported = other.state().data
  expectSame(
    canonicalTree(imported),
    canonicalTree(original),
    `${where}: round trip differs`,
    trace,
  )
  expectNoProblems(integrityProblems(imported), `${where}: imported`, trace)
  const originalIds = new Set(
    (['projects', 'phases', 'tasks', 'milestones', 'dependencies'] as const).flatMap((name) =>
      Object.keys(original[name]),
    ),
  )
  for (const name of ['projects', 'phases', 'tasks', 'milestones', 'dependencies'] as const) {
    for (const id of Object.keys(imported[name])) {
      expect(originalIds.has(id), `${where}: id ${id} kept`).toBe(false)
    }
  }
}

async function runTwoTabsSeed(seed: number): Promise<void> {
  const random = makeRandom(seed)
  const storage = createMemoryStorage()
  const a = makeTab(storage, 'a', seed)
  const b = makeTab(storage, 'b', seed)
  await a.actions.load()
  await settled(a)
  await b.actions.load()
  await settled(b)
  const seen = emptySeen()
  const trace: string[] = []
  for (let step = 0; step < STEPS; step += 1) {
    const where = `two tabs: seed ${seed} step ${step}`
    const tab = random.chance(0.5) ? a : b
    const label = tab === a ? 'A' : 'B'
    if (random.chance(0.2)) {
      trace.push(`${step} ${label} refresh`)
      await tab.actions.refresh({ silent: true })
    } else {
      const plan = chooseAction(random, tab.state().data, seen)
      trace.push(`${step} ${label} ${plan.name}`)
      const before = storage.getItem(LOCAL_STORAGE_KEY)
      const result = await plan.run(tab.actions)
      if (!result.ok) {
        expect(storage.getItem(LOCAL_STORAGE_KEY), `${where} a refused write stored`).toBe(before)
      }
    }
    await settled(tab)
    const stored = await storedData(storage)
    // Two tabs can pick the same key at the same moment; everything else always holds. (A stale
    // tab's memory may mix fresh rows with old ones until its next refresh; the views cope.)
    expectNoProblems(integrityProblems(stored, { allowEqualSortKeys: true }), where, trace)
  }
  await a.actions.refresh({ silent: true })
  await b.actions.refresh({ silent: true })
  await settled(a)
  await settled(b)
  const stored = await storedData(storage)
  expect(a.state().data).toEqual(stored)
  expect(b.state().data).toEqual(stored)
  expectNoProblems(
    integrityProblems(a.state().data, { allowEqualSortKeys: true }),
    `two tabs: seed ${seed} end`,
    trace,
  )
}

describe('randomized runs of the real store on the real local repository', () => {
  it.each(SEEDS)(
    'one tab with failures, lost answers, latency and retries (seed %i)',
    async (seed) => {
      await runSingleTabSeed(seed)
    },
    60_000,
  )

  it.each(SEEDS.slice(0, 3))(
    'two tabs editing the same data (seed %i)',
    async (seed) => {
      await runTwoTabsSeed(seed)
    },
    60_000,
  )

  it('reached every kind of change', ({ skip }) => {
    if (applied.size === 0) skip() // filtered to one run
    expect([...applied.keys()].sort()).toEqual(
      expect.arrayContaining([
        'addDependency',
        'applySchedule',
        'createMilestone',
        'createPhase',
        'createProject',
        'createTask',
        'deletePhase',
        'deleteTask',
        'moveProject',
        'movePhase',
        'moveTask',
        'removeDependency',
        'updateMilestone',
        'updatePhase',
        'updateProject',
        'updateTask',
      ]),
    )
  })
})

describe('the invariants have teeth', () => {
  it('a repository that answers but does not store is caught', async () => {
    await expect(runSingleTabSeed(1, 'updateTask')).rejects.toThrow(/memory != stored|deeply equal/)
  }, 60_000)

  it('every kind of broken data is reported', () => {
    const project = makeProject({ id: 'p', sortOrder: 'a0' })
    const task = (overrides: Partial<Task> & { id: string }) =>
      makeTask({ projectId: 'p', sortOrder: overrides.id, ...overrides })
    const broken: WorkspaceData = {
      projects: { p: project },
      phases: { ghost: makePhase({ id: 'ghost', projectId: 'gone', sortOrder: 'a0' }) },
      tasks: {
        a: task({ id: 'a', phaseId: 'gone' }),
        b: task({ id: 'b', parentTaskId: 'gone' }),
        c: task({ id: 'c', parentTaskId: 'd' }),
        d: task({ id: 'd', parentTaskId: 'e' }),
        e: task({ id: 'e' }),
        f: task({ id: 'f', startDate: '2026-02-02', dueDate: '2026-02-01' }),
        g: task({ id: 'g', status: 'done', completedAt: null }),
        h: task({ id: 'h', sortOrder: 'e' }),
      },
      milestones: {
        m: makeMilestone({ id: 'm', projectId: 'p', phaseId: 'gone', date: '2026-01-01' }),
      },
      dependencies: {
        d1: makeDependency({ id: 'd1', projectId: 'p', predecessorId: 'a', successorId: 'gone' }),
        d2: makeDependency({ id: 'd2', projectId: 'p', predecessorId: 'e', successorId: 'f' }),
        d3: makeDependency({ id: 'd3', projectId: 'p', predecessorId: 'f', successorId: 'e' }),
        d4: makeDependency({ id: 'd4', projectId: 'p', predecessorId: 'd', successorId: 'e' }),
      },
    }
    expect(integrityProblems(broken).join('\n')).toMatchInlineSnapshot(`
      "phase ghost: orphan
      task a: dangling phase gone
      task b: dangling parent gone
      task c: nested more than one level
      task f: due 2026-02-01 < start 2026-02-02
      task g: status done with completedAt null
      milestone m: dangling phase
      dependency d1: dangling
      dependency d3: closes a cycle
      dependency d4: links a task and its parent
      tasks/p: equal sort keys a e f g e"
    `)
  })
})
