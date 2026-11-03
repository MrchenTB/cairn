import { describe, expect, it, vi } from 'vitest'
import { makeDependency, makeProject, makeTask, makeWorkspace } from '@/domain/testFactories'
import type { Result, ScheduleChange, ScheduleMode, Task, WorkspaceData } from '@/domain/types'
import { computeReschedulePlan, createPlanner, type PlannerEnv } from './planner'
import type {
  RescheduleDecision,
  RescheduleExecutor,
  RescheduleOutcome,
  RescheduleRequest,
} from './rescheduleStore'

/**
 * A fake store: `applySchedule` validates like the real one (due ≥ start), applies the dates to
 * `data` and can be told to fail remotely. The preview dialog is simulated by `answer`.
 */
function setup(options: {
  mode?: ScheduleMode
  tasks: Task[]
  links?: Array<[string, string]>
  answer?: RescheduleDecision | 'cancel'
  failRemote?: boolean
}) {
  const project = makeProject({ id: 'p', scheduleMode: options.mode ?? 'manual' })
  let data: WorkspaceData = makeWorkspace({
    projects: [project],
    tasks: options.tasks,
    dependencies: (options.links ?? []).map(([predecessorId, successorId]) =>
      makeDependency({ id: `${predecessorId}>${successorId}`, projectId: 'p', predecessorId, successorId }),
    ),
  })
  const writes: ScheduleChange[][] = []
  const requests: RescheduleRequest[] = []
  const warnings: Array<{ message: string; description?: string; review?: () => void }> = []

  const applySchedule = vi.fn(async (changes: readonly ScheduleChange[]): Promise<Result> => {
    for (const change of changes) {
      if (change.startDate && change.dueDate && change.dueDate < change.startDate) {
        return { ok: false, error: { kind: 'validation', message: "Due date can't be before the start date." } }
      }
    }
    writes.push([...changes])
    if (options.failRemote) {
      return { ok: false, error: { kind: 'network', message: 'Offline' } }
    }
    const tasks = { ...data.tasks }
    for (const { taskId, startDate, dueDate } of changes) {
      tasks[taskId] = { ...tasks[taskId], startDate, dueDate }
    }
    data = { ...data, tasks }
    return { ok: true, value: undefined }
  })

  const requestReschedule = vi.fn(
    async (request: RescheduleRequest, execute: RescheduleExecutor): Promise<RescheduleOutcome> => {
      requests.push(request)
      const answer = options.answer ?? 'cancel'
      if (answer === 'cancel') return { status: 'cancelled' }
      // What the dialog would show, computed from the live data like the real dialog does.
      const plan = computeReschedulePlan(request, data)
      const writesForAnswer = answer === 'only' && plan.change ? [plan.change] : plan.writes
      const result = await execute(answer, writesForAnswer)
      return result.ok
        ? { status: 'written', decision: answer }
        : { status: 'failed', error: result.error }
    },
  )

  const env: PlannerEnv = {
    getData: () => data,
    applySchedule,
    warn: (message, opts) => warnings.push({ message, description: opts.description, review: opts.action?.onClick }),
    requestReschedule,
  }
  return { planner: createPlanner(env), writes, requests, warnings, applySchedule, data: () => data }
}

// A (Nov 2–4) → B (Nov 5–6) → C (Nov 7–9): no conflicts to begin with.
function chain() {
  return [
    makeTask({ id: 'A', projectId: 'p', title: 'Alpha', startDate: '2026-11-02', dueDate: '2026-11-04' }),
    makeTask({ id: 'B', projectId: 'p', title: 'Beta', startDate: '2026-11-05', dueDate: '2026-11-06' }),
    makeTask({ id: 'C', projectId: 'p', title: 'Gamma', startDate: '2026-11-07', dueDate: '2026-11-09' }),
  ]
}
const links: Array<[string, string]> = [
  ['A', 'B'],
  ['B', 'C'],
]
const delayA: ScheduleChange = { taskId: 'A', startDate: '2026-11-04', dueDate: '2026-11-06' }

describe('planScheduleChange — Manual', () => {
  it('writes only the change and warns about the new conflict with a Review action', async () => {
    const h = setup({ tasks: chain(), links })
    const outcome = await h.planner.planScheduleChange(delayA, { source: 'gantt' })
    expect(outcome).toEqual({ status: 'written' })
    expect(h.writes).toEqual([[delayA]])
    expect(h.requests).toEqual([])
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0].message).toBe('1 dependency conflict')
    expect(h.warnings[0].description).toBe('“Beta” starts before “Alpha” finishes.')
    // Review → resolve-all preview for the project.
    h.warnings[0].review?.()
    await vi.waitFor(() => expect(h.requests).toEqual([{ kind: 'resolve', projectId: 'p' }]))
  })

  it('does not warn when no NEW conflict appears', async () => {
    const h = setup({ tasks: chain(), links })
    await h.planner.planScheduleChange({ taskId: 'C', startDate: '2026-11-10', dueDate: '2026-11-12' })
    expect(h.warnings).toEqual([])
  })

  it('validation errors write nothing and report the message (no toast)', async () => {
    const h = setup({ tasks: chain(), links })
    const outcome = await h.planner.planScheduleChange({ taskId: 'A', startDate: '2026-11-05', dueDate: '2026-11-01' })
    expect(outcome).toMatchObject({ status: 'invalid', error: { kind: 'validation' } })
    expect(h.applySchedule).not.toHaveBeenCalled()
    expect(h.warnings).toEqual([])
  })

  it('unknown task → invalid; same dates → unchanged without a write', async () => {
    const h = setup({ tasks: chain(), links })
    expect((await h.planner.planScheduleChange({ taskId: 'nope', startDate: null, dueDate: null })).status).toBe('invalid')
    expect(
      await h.planner.planScheduleChange({ taskId: 'A', startDate: '2026-11-02', dueDate: '2026-11-04' }),
    ).toEqual({ status: 'unchanged' })
    expect(h.applySchedule).not.toHaveBeenCalled()
  })

  it('a remote failure resolves "failed" and does not warn', async () => {
    const h = setup({ tasks: chain(), links, failRemote: true })
    const outcome = await h.planner.planScheduleChange(delayA)
    expect(outcome).toMatchObject({ status: 'failed', error: { kind: 'network' } })
    expect(h.warnings).toEqual([])
  })
})

describe('planScheduleChange — Auto', () => {
  it('without shifts it writes directly (no preview)', async () => {
    const h = setup({ mode: 'auto', tasks: chain(), links })
    const outcome = await h.planner.planScheduleChange({ taskId: 'C', startDate: '2026-11-08', dueDate: '2026-11-10' })
    expect(outcome).toEqual({ status: 'written' })
    expect(h.requests).toEqual([])
    expect(h.writes).toEqual([[{ taskId: 'C', startDate: '2026-11-08', dueDate: '2026-11-10' }]])
  })

  it('with shifts it opens the preview; Cancel writes nothing', async () => {
    const h = setup({ mode: 'auto', tasks: chain(), links, answer: 'cancel' })
    const outcome = await h.planner.planScheduleChange(delayA, { source: 'modal' })
    expect(outcome).toEqual({ status: 'cancelled' })
    expect(h.requests).toEqual([{ kind: 'change', projectId: 'p', change: delayA, source: 'modal' }])
    expect(h.applySchedule).not.toHaveBeenCalled()
    expect(h.data().tasks.A.startDate).toBe('2026-11-02')
  })

  it('"Apply N changes" writes the change and every shift in ONE atomic call', async () => {
    const h = setup({ mode: 'auto', tasks: chain(), links, answer: 'apply' })
    const outcome = await h.planner.planScheduleChange(delayA)
    expect(outcome).toEqual({ status: 'written' })
    expect(h.applySchedule).toHaveBeenCalledTimes(1)
    expect(h.writes).toEqual([
      [
        delayA,
        // B keeps its 2-day duration and starts the day after A ends; C follows B.
        { taskId: 'B', startDate: '2026-11-07', dueDate: '2026-11-08' },
        { taskId: 'C', startDate: '2026-11-09', dueDate: '2026-11-11' },
      ],
    ])
    expect(h.warnings).toEqual([])
  })

  it('"Only move this task" writes just the change and then warns about the conflict', async () => {
    const h = setup({ mode: 'auto', tasks: chain(), links, answer: 'only' })
    const outcome = await h.planner.planScheduleChange(delayA)
    expect(outcome).toEqual({ status: 'written' })
    expect(h.writes).toEqual([[delayA]])
    expect(h.warnings.map((w) => w.message)).toEqual(['1 dependency conflict'])
  })

  it('a failed apply resolves "failed"', async () => {
    const h = setup({ mode: 'auto', tasks: chain(), links, answer: 'apply', failRemote: true })
    expect((await h.planner.planScheduleChange(delayA)).status).toBe('failed')
  })

  it('moving a successor before its predecessor cannot be auto-fixed: written, then warned', async () => {
    const h = setup({ mode: 'auto', tasks: chain(), links })
    const outcome = await h.planner.planScheduleChange({ taskId: 'B', startDate: '2026-11-03', dueDate: '2026-11-04' })
    expect(outcome).toEqual({ status: 'written' })
    expect(h.requests).toEqual([])
    expect(h.warnings.map((w) => w.message)).toEqual(['1 dependency conflict'])
  })
})

describe('reviewConflicts / reviewNewDependency', () => {
  it('resolve-all applies every shift for the project', async () => {
    const tasks = chain()
    tasks[1] = { ...tasks[1], startDate: '2026-11-03', dueDate: '2026-11-04' } // B overlaps A
    const h = setup({ tasks, links, answer: 'apply' })
    expect(await h.planner.reviewConflicts('p')).toEqual({ status: 'written' })
    // B moves after A; C (Nov 7) already starts after B's new end (Nov 6), so it stays.
    expect(h.writes).toEqual([[{ taskId: 'B', startDate: '2026-11-05', dueDate: '2026-11-06' }]])
  })

  it('a new violated dependency: Auto previews the shifts, Manual warns', async () => {
    const tasks = [
      makeTask({ id: 'A', projectId: 'p', title: 'Alpha', startDate: '2026-11-02', dueDate: '2026-11-06' }),
      makeTask({ id: 'B', projectId: 'p', title: 'Beta', startDate: '2026-11-04', dueDate: '2026-11-05' }),
    ]
    const auto = setup({ mode: 'auto', tasks, links: [['A', 'B']], answer: 'apply' })
    expect(await auto.planner.reviewNewDependency('A>B')).toEqual({ status: 'written' })
    expect(auto.requests).toEqual([{ kind: 'dependency', projectId: 'p', dependencyId: 'A>B' }])
    expect(auto.writes).toEqual([[{ taskId: 'B', startDate: '2026-11-07', dueDate: '2026-11-08' }]])

    const manual = setup({ tasks, links: [['A', 'B']] })
    expect(await manual.planner.reviewNewDependency('A>B')).toEqual({ status: 'unchanged' })
    expect(manual.warnings.map((w) => w.message)).toEqual(['1 dependency conflict'])
    expect(manual.applySchedule).not.toHaveBeenCalled()
  })

  it('a satisfied new dependency needs nothing', async () => {
    const h = setup({ mode: 'auto', tasks: chain(), links })
    expect(await h.planner.reviewNewDependency('A>B')).toEqual({ status: 'unchanged' })
    expect(h.requests).toEqual([])
    expect(h.warnings).toEqual([])
  })
})

describe('computeReschedulePlan', () => {
  it('reports a deleted task instead of throwing', () => {
    const data = makeWorkspace({ projects: [makeProject({ id: 'p' })] })
    const plan = computeReschedulePlan(
      { kind: 'change', projectId: 'p', change: delayA, source: 'gantt' },
      data,
    )
    expect(plan.error).toBe('This task no longer exists.')
    expect(plan.writes).toEqual([])
  })
})
