import { describe, expect, it } from 'vitest'
import {
  buildChildrenIndex,
  buildProjectOutline,
  canBecomeSubtaskOf,
  isLeafTask,
  subtasksOf,
  topLevelTasks,
} from './hierarchy'
import { makeDependency, makeMilestone, makePhase, makeProject, makeTask } from './testFactories'
import type { OutlineGroup } from './hierarchy'

const project = makeProject({ id: 'p1' })
const other = makeProject({ id: 'p2' })

const titles = (group: OutlineGroup) => group.tasks.map((t) => t.task.title)

describe('task helpers', () => {
  const tasks = [
    makeTask({ projectId: 'p1', id: 'b', title: 'B', sortOrder: 'a2', phaseId: 'ph1' }),
    makeTask({ projectId: 'p1', id: 'a', title: 'A', sortOrder: 'a1' }),
    makeTask({ projectId: 'p1', id: 'a-2', parentTaskId: 'a', sortOrder: 'a2' }),
    makeTask({ projectId: 'p1', id: 'a-1', parentTaskId: 'a', sortOrder: 'a1' }),
    makeTask({ projectId: 'p2', id: 'z', sortOrder: 'a0' }),
  ]

  it('buildChildrenIndex groups and sorts children', () => {
    const index = buildChildrenIndex(tasks)
    expect([...index.keys()]).toEqual(['a'])
    expect(index.get('a')?.map((t) => t.id)).toEqual(['a-1', 'a-2'])
  })

  it('isLeafTask', () => {
    expect(isLeafTask('a', tasks)).toBe(false)
    expect(isLeafTask('b', tasks)).toBe(true)
    expect(isLeafTask('a-1', tasks)).toBe(true)
  })

  it('topLevelTasks: one ordering space per project across phases', () => {
    expect(topLevelTasks(tasks, 'p1').map((t) => t.id)).toEqual(['a', 'b'])
    expect(topLevelTasks(tasks, 'p2').map((t) => t.id)).toEqual(['z'])
    expect(topLevelTasks(tasks, 'nope')).toEqual([])
  })

  it('subtasksOf sorts siblings', () => {
    expect(subtasksOf(tasks, 'a').map((t) => t.id)).toEqual(['a-1', 'a-2'])
    expect(subtasksOf(tasks, 'b')).toEqual([])
  })
})

describe('canBecomeSubtaskOf', () => {
  const parent = makeTask({ projectId: 'p1', id: 'parent' })
  const child = makeTask({ projectId: 'p1', id: 'child', parentTaskId: 'parent' })
  const plain = makeTask({ projectId: 'p1', id: 'plain' })
  const elsewhere = makeTask({ projectId: 'p2', id: 'elsewhere' })
  const tasks = [parent, child, plain, elsewhere]

  it('accepts a leaf top-level task under another top-level task', () => {
    expect(canBecomeSubtaskOf(plain, parent, tasks)).toEqual({ ok: true, value: undefined })
    expect(canBecomeSubtaskOf(child, parent, tasks).ok).toBe(true) // already there
  })

  it('rejects itself, other projects, nested parents and tasks with subtasks', () => {
    const cases: Array<[ReturnType<typeof canBecomeSubtaskOf>, RegExp]> = [
      [canBecomeSubtaskOf(plain, plain, tasks), /own subtask/],
      [canBecomeSubtaskOf(plain, elsewhere, tasks), /same project/],
      [canBecomeSubtaskOf(plain, child, tasks), /top-level/],
      [canBecomeSubtaskOf(parent, plain, tasks), /has subtasks/],
    ]
    for (const [result, message] of cases) {
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe('validation')
        expect(result.error.message).toMatch(message)
      }
    }
  })

  it('with dependencies: rejects a parent the task is linked to by a dependency (either way)', () => {
    const plainToParent = makeDependency({
      projectId: 'p1',
      predecessorId: 'plain',
      successorId: 'parent',
    })
    const parentToPlain = makeDependency({
      projectId: 'p1',
      predecessorId: 'parent',
      successorId: 'plain',
    })
    const unrelated = makeDependency({ projectId: 'p1', predecessorId: 'plain', successorId: 'x' })
    for (const dependency of [plainToParent, parentToPlain]) {
      const result = canBecomeSubtaskOf(plain, parent, tasks, [dependency])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe('validation')
        expect(result.error.message).toMatch(/Remove that dependency first/)
      }
    }
    expect(canBecomeSubtaskOf(plain, parent, tasks, [unrelated]).ok).toBe(true)
    expect(canBecomeSubtaskOf(plain, parent, tasks, []).ok).toBe(true)
    // Without the dependencies argument the rule is not checked (existing callers).
    expect(canBecomeSubtaskOf(plain, parent, tasks).ok).toBe(true)
  })
})

describe('buildProjectOutline', () => {
  it('without phases: a single null-phase group with sorted tasks and subtasks', () => {
    const outline = buildProjectOutline(
      project,
      [],
      [
        makeTask({ projectId: 'p1', id: 't2', title: 'Second', sortOrder: 'a2' }),
        makeTask({ projectId: 'p1', id: 't1', title: 'First', sortOrder: 'a1' }),
        makeTask({ projectId: 'p1', title: 'Sub B', parentTaskId: 't1', sortOrder: 'a5' }),
        makeTask({ projectId: 'p1', title: 'Sub A', parentTaskId: 't1', sortOrder: 'a3' }),
      ],
      [],
    )
    expect(outline.project).toBe(project)
    expect(outline.hasPhases).toBe(false)
    expect(outline.groups).toHaveLength(1)
    expect(outline.groups[0].phase).toBeNull()
    expect(titles(outline.groups[0])).toEqual(['First', 'Second'])
    expect(outline.groups[0].tasks[0].subtasks.map((t) => t.title)).toEqual(['Sub A', 'Sub B'])
    expect(outline.groups[0].tasks[1].subtasks).toEqual([])
  })

  it('with phases: null group first (even when empty), then phases in order, empty ones included', () => {
    const design = makePhase({ projectId: 'p1', id: 'design', name: 'Design', sortOrder: 'a1' })
    const build = makePhase({ projectId: 'p1', id: 'build', name: 'Build', sortOrder: 'a2' })
    const ship = makePhase({ projectId: 'p1', id: 'ship', name: 'Ship', sortOrder: 'a3' })
    const outline = buildProjectOutline(
      project,
      [ship, build, design, makePhase({ projectId: 'p2', name: 'Other' })],
      [
        makeTask({ projectId: 'p1', title: 'Build 2', phaseId: 'build', sortOrder: 'a4' }),
        makeTask({ projectId: 'p1', title: 'Design 1', phaseId: 'design', sortOrder: 'a1' }),
        makeTask({ projectId: 'p1', title: 'Build 1', phaseId: 'build', sortOrder: 'a2' }),
      ],
      [],
    )
    expect(outline.hasPhases).toBe(true)
    expect(outline.groups.map((g) => g.phase?.name ?? null)).toEqual([
      null,
      'Design',
      'Build',
      'Ship',
    ])
    expect(titles(outline.groups[0])).toEqual([])
    expect(titles(outline.groups[1])).toEqual(['Design 1'])
    expect(titles(outline.groups[2])).toEqual(['Build 1', 'Build 2'])
    expect(titles(outline.groups[3])).toEqual([])
  })

  it('sends tasks of unknown phases to the null group and ignores other projects', () => {
    const outline = buildProjectOutline(
      project,
      [makePhase({ projectId: 'p1', id: 'known' })],
      [
        makeTask({ projectId: 'p1', title: 'Lost', phaseId: 'deleted-phase', sortOrder: 'a2' }),
        makeTask({ projectId: 'p1', title: 'Loose', sortOrder: 'a1' }),
        makeTask({ projectId: 'p1', title: 'Known', phaseId: 'known' }),
        makeTask({ projectId: 'p2', title: 'Foreign' }),
      ],
      [],
    )
    expect(titles(outline.groups[0])).toEqual(['Loose', 'Lost'])
    expect(titles(outline.groups[1])).toEqual(['Known'])
  })

  it('keeps subtasks under their parent and never loses orphans', () => {
    const outline = buildProjectOutline(
      project,
      [makePhase({ projectId: 'p1', id: 'ph' })],
      [
        makeTask({
          projectId: 'p1',
          id: 'parent',
          title: 'Parent',
          phaseId: 'ph',
          sortOrder: 'a1',
        }),
        // Out-of-sync phaseId: still shown under its parent.
        makeTask({ projectId: 'p1', title: 'Child', parentTaskId: 'parent', phaseId: null }),
        makeTask({ projectId: 'p1', title: 'Orphan', parentTaskId: 'deleted', sortOrder: 'a3' }),
        makeTask({
          projectId: 'p1',
          id: 'mid',
          title: 'Mid',
          parentTaskId: 'parent',
          sortOrder: 'a2',
        }),
        makeTask({ projectId: 'p1', title: 'Too deep', parentTaskId: 'mid', sortOrder: 'a4' }),
      ],
      [],
    )
    expect(titles(outline.groups[1])).toEqual(['Parent'])
    expect(outline.groups[1].tasks[0].subtasks.map((t) => t.title)).toEqual(['Child', 'Mid'])
    expect(titles(outline.groups[0])).toEqual(['Orphan', 'Too deep'])
  })

  it('lists milestones in their group by date, then name', () => {
    const phase = makePhase({ projectId: 'p1', id: 'ph' })
    const outline = buildProjectOutline(
      project,
      [phase],
      [],
      [
        makeMilestone({ projectId: 'p1', name: 'Launch', date: '2026-12-01' }),
        makeMilestone({ projectId: 'p1', name: 'Beta', date: '2026-11-15' }),
        makeMilestone({ projectId: 'p1', name: 'Alpha', date: '2026-11-15' }),
        makeMilestone({ projectId: 'p1', name: 'Review', date: '2026-11-20', phaseId: 'ph' }),
        makeMilestone({ projectId: 'p1', name: 'Gone phase', date: '2026-11-01', phaseId: 'x' }),
        makeMilestone({ projectId: 'p2', name: 'Foreign', date: '2026-11-01' }),
      ],
    )
    expect(outline.groups[0].milestones.map((m) => m.name)).toEqual([
      'Gone phase',
      'Alpha',
      'Beta',
      'Launch',
    ])
    expect(outline.groups[1].milestones.map((m) => m.name)).toEqual(['Review'])
  })

  it('handles a project with nothing in it', () => {
    const outline = buildProjectOutline(other, [], [], [])
    expect(outline).toEqual({
      project: other,
      hasPhases: false,
      groups: [{ phase: null, tasks: [], milestones: [] }],
    })
  })
})
