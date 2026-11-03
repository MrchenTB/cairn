import { describe, expect, it } from 'vitest'
import { buildProjectOutline } from '@/domain/hierarchy'
import { makePhase, makeProject, makeTask } from '@/domain/testFactories'
import {
  ALL_PHASES,
  NO_PHASE,
  buildBoard,
  columnDroppableId,
  describeCard,
  entryIndex,
  findColumn,
  keyboardTarget,
  moveCardInColumns,
  moveForBoardDrop,
  nearestCard,
  parseColumnDroppableId,
  phaseIdForNewTask,
  positionIn,
  resolvePhaseFilter,
  stepDrop,
  toColumnIds,
  type BoardColumnIds,
} from './boardModel'

/**
 * Project order a < b < c < d < e < f < g; the board shows it split by status:
 *   To Do: a, c, e   In Progress: b, f   Done: (empty)   (d and g are subtasks / other project)
 */
const columns: BoardColumnIds = { todo: ['a', 'c', 'e'], in_progress: ['b', 'f'], done: [] }
const projectOrder = ['a', 'b', 'c', 'e', 'f']

describe('moveForBoardDrop — same column (reorder only)', () => {
  it('moves to the bottom: neighbours are the last card and null, and status is never sent', () => {
    const move = moveForBoardDrop(
      { activeId: 'a', overColumn: 'todo', overIndex: 2 },
      columns,
      projectOrder,
    )
    expect(move).toEqual({ taskId: 'a', afterId: 'e', beforeId: null })
    expect(move).not.toHaveProperty('status')
  })

  it('moves to the top: afterId is null and beforeId is the first other card', () => {
    const move = moveForBoardDrop(
      { activeId: 'e', overColumn: 'todo', overIndex: 0 },
      columns,
      projectOrder,
    )
    expect(move).toEqual({ taskId: 'e', afterId: null, beforeId: 'a' })
  })

  it('moves into the middle between the two neighbours seen in the column', () => {
    const move = moveForBoardDrop(
      { activeId: 'e', overColumn: 'todo', overIndex: 1 },
      columns,
      projectOrder,
    )
    expect(move).toEqual({ taskId: 'e', afterId: 'a', beforeId: 'c' })
  })

  it('returns null when the card is dropped where it already is', () => {
    for (const [activeId, overIndex] of [
      ['a', 0],
      ['c', 1],
      ['e', 2],
    ] as const) {
      expect(
        moveForBoardDrop({ activeId, overColumn: 'todo', overIndex }, columns, projectOrder),
      ).toBeNull()
    }
    // A single card in its column has nowhere else to go.
    const single: BoardColumnIds = { todo: ['a'], in_progress: [], done: [] }
    expect(
      moveForBoardDrop({ activeId: 'a', overColumn: 'todo', overIndex: 0 }, single, ['a']),
    ).toBeNull()
  })

  it('never sends status, phase or parent for a reorder', () => {
    const move = moveForBoardDrop(
      { activeId: 'b', overColumn: 'in_progress', overIndex: 1 },
      columns,
      projectOrder,
    )
    expect(move).toEqual({ taskId: 'b', afterId: 'f', beforeId: null })
    expect(Object.keys(move ?? {}).sort()).toEqual(['afterId', 'beforeId', 'taskId'])
  })
})

describe('moveForBoardDrop — other column (status + neighbours there)', () => {
  it('drops at the top of another column', () => {
    expect(
      moveForBoardDrop(
        { activeId: 'c', overColumn: 'in_progress', overIndex: 0 },
        columns,
        projectOrder,
      ),
    ).toEqual({ taskId: 'c', status: 'in_progress', afterId: null, beforeId: 'b' })
  })

  it('drops in the middle of another column', () => {
    expect(
      moveForBoardDrop(
        { activeId: 'a', overColumn: 'in_progress', overIndex: 1 },
        columns,
        projectOrder,
      ),
    ).toEqual({ taskId: 'a', status: 'in_progress', afterId: 'b', beforeId: 'f' })
  })

  it('drops at the bottom of another column', () => {
    expect(
      moveForBoardDrop({ activeId: 'f', overColumn: 'todo', overIndex: 3 }, columns, projectOrder),
    ).toEqual({ taskId: 'f', status: 'todo', afterId: 'e', beforeId: null })
  })

  it('drops into an empty column keeping the card’s place in the project order', () => {
    // c sits between b and e in the project order: only the status changes.
    expect(
      moveForBoardDrop({ activeId: 'c', overColumn: 'done', overIndex: 0 }, columns, projectOrder),
    ).toEqual({ taskId: 'c', status: 'done', afterId: 'b', beforeId: 'e' })
    // First and last of the project order.
    expect(
      moveForBoardDrop({ activeId: 'a', overColumn: 'done', overIndex: 0 }, columns, projectOrder),
    ).toEqual({ taskId: 'a', status: 'done', afterId: null, beforeId: 'b' })
    expect(
      moveForBoardDrop({ activeId: 'f', overColumn: 'done', overIndex: 5 }, columns, projectOrder),
    ).toEqual({ taskId: 'f', status: 'done', afterId: 'e', beforeId: null })
  })

  it('falls back to the column neighbours (null, null) when the card is not in the project order', () => {
    expect(
      moveForBoardDrop({ activeId: 'a', overColumn: 'done', overIndex: 0 }, columns, []),
    ).toEqual({
      taskId: 'a',
      status: 'done',
      afterId: null,
      beforeId: null,
    })
  })

  it('works on filtered (sub-)columns: neighbours are the visible cards', () => {
    // Phase-filtered view: only c and b are visible.
    const filtered: BoardColumnIds = { todo: ['c'], in_progress: ['b'], done: [] }
    expect(
      moveForBoardDrop(
        { activeId: 'c', overColumn: 'in_progress', overIndex: 1 },
        filtered,
        projectOrder,
      ),
    ).toEqual({ taskId: 'c', status: 'in_progress', afterId: 'b', beforeId: null })
  })
})

describe('moveForBoardDrop — robustness', () => {
  it('clamps out-of-range and non-finite indexes', () => {
    expect(
      moveForBoardDrop(
        { activeId: 'a', overColumn: 'in_progress', overIndex: 99 },
        columns,
        projectOrder,
      ),
    ).toEqual({ taskId: 'a', status: 'in_progress', afterId: 'f', beforeId: null })
    expect(
      moveForBoardDrop(
        { activeId: 'a', overColumn: 'in_progress', overIndex: -4 },
        columns,
        projectOrder,
      ),
    ).toEqual({ taskId: 'a', status: 'in_progress', afterId: null, beforeId: 'b' })
    expect(
      moveForBoardDrop(
        { activeId: 'a', overColumn: 'in_progress', overIndex: Number.NaN },
        columns,
        projectOrder,
      ),
    ).toEqual({ taskId: 'a', status: 'in_progress', afterId: null, beforeId: 'b' })
  })

  it('returns null for unknown cards and for column ids', () => {
    expect(
      moveForBoardDrop({ activeId: 'zz', overColumn: 'todo', overIndex: 0 }, columns, projectOrder),
    ).toBeNull()
    expect(
      moveForBoardDrop(
        { activeId: columnDroppableId('todo'), overColumn: 'done', overIndex: 0 },
        columns,
        projectOrder,
      ),
    ).toBeNull()
  })
})

describe('column helpers', () => {
  it('finds the column of a card or of a column droppable id', () => {
    expect(findColumn(columns, 'f')).toBe('in_progress')
    expect(findColumn(columns, columnDroppableId('done'))).toBe('done')
    expect(findColumn(columns, 'nope')).toBeNull()
    expect(findColumn(columns, 42)).toBeNull()
    expect(parseColumnDroppableId('column:in_progress')).toBe('in_progress')
    expect(parseColumnDroppableId('column:archived')).toBeNull()
    expect(parseColumnDroppableId('a')).toBeNull()
  })

  it('moves a card across columns at an index among the other cards', () => {
    expect(moveCardInColumns(columns, 'c', 'in_progress', 1)).toEqual({
      todo: ['a', 'e'],
      in_progress: ['b', 'c', 'f'],
      done: [],
    })
    expect(moveCardInColumns(columns, 'c', 'done', 7)).toEqual({
      todo: ['a', 'e'],
      in_progress: ['b', 'f'],
      done: ['c'],
    })
    expect(moveCardInColumns(columns, 'a', 'todo', 2)).toEqual({
      ...columns,
      todo: ['c', 'e', 'a'],
    })
    expect(moveCardInColumns(columns, 'zz', 'done', 0)).toBe(columns)
  })

  it('steps a card within its column (menu alternative to dragging)', () => {
    expect(stepDrop(columns, 'c', 'up')).toEqual({
      activeId: 'c',
      overColumn: 'todo',
      overIndex: 0,
    })
    expect(stepDrop(columns, 'c', 'down')).toEqual({
      activeId: 'c',
      overColumn: 'todo',
      overIndex: 2,
    })
    expect(stepDrop(columns, 'e', 'top')).toEqual({
      activeId: 'e',
      overColumn: 'todo',
      overIndex: 0,
    })
    expect(stepDrop(columns, 'a', 'bottom')).toEqual({
      activeId: 'a',
      overColumn: 'todo',
      overIndex: 2,
    })
    expect(stepDrop(columns, 'a', 'up')).toBeNull()
    expect(stepDrop(columns, 'a', 'top')).toBeNull()
    expect(stepDrop(columns, 'e', 'down')).toBeNull()
    expect(stepDrop(columns, 'zz', 'down')).toBeNull()
    // Down from the top = after the next card.
    const drop = stepDrop(columns, 'a', 'down')
    expect(drop && moveForBoardDrop(drop, columns, projectOrder)).toEqual({
      taskId: 'a',
      afterId: 'c',
      beforeId: 'e',
    })
  })

  it('reports 1-based positions', () => {
    expect(positionIn(columns, 'e')).toEqual({ column: 'todo', position: 3, count: 3 })
    expect(positionIn(columns, 'zz')).toBeNull()
  })
})

describe('nearestCard', () => {
  const rects: Record<string, { top: number; height: number }> = {
    a: { top: 0, height: 60 },
    c: { top: 70, height: 80 },
    e: { top: 160, height: 60 },
  }
  const rectOf = (id: string) => rects[id] ?? null

  it('picks the card whose vertical centre is nearest', () => {
    expect(nearestCard(['a', 'c', 'e'], -50, rectOf)).toBe('a')
    expect(nearestCard(['a', 'c', 'e'], 100, rectOf)).toBe('c')
    expect(nearestCard(['a', 'c', 'e'], 500, rectOf)).toBe('e')
    // Tie (a's centre 30, c's centre 110, y = 70): the first one wins.
    expect(nearestCard(['a', 'c'], 70, rectOf)).toBe('a')
  })

  it('skips unmeasured cards and returns null when there is nothing to aim at', () => {
    expect(nearestCard(['zz', 'e'], 0, rectOf)).toBe('e')
    expect(nearestCard(['zz'], 0, rectOf)).toBeNull()
    expect(nearestCard([], 0, rectOf)).toBeNull()
  })
})

describe('entryIndex (a card dragged in from another column)', () => {
  const ids = ['b', 'f']
  const f = { top: 100, height: 60 } // f spans 100–160, middle 130

  it('enters before the card under the pointer, wherever on it the pointer is', () => {
    expect(entryIndex(ids, 'f', f, { pointerY: 101 })).toBe(1)
    expect(entryIndex(ids, 'f', f, { pointerY: 155 })).toBe(1)
  })

  it('enters after a card the pointer is below (space under the last card, gaps)', () => {
    expect(entryIndex(ids, 'f', f, { pointerY: 170 })).toBe(2)
    expect(entryIndex(ids, 'b', { top: 0, height: 60 }, { pointerY: 64 })).toBe(1)
  })

  it('keyboard: before the target unless the dragged card is below its middle', () => {
    expect(entryIndex(ids, 'f', f, { draggedTop: 100 })).toBe(1)
    expect(entryIndex(ids, 'f', f, { draggedTop: 131 })).toBe(2)
  })

  it('an empty column or an unknown target appends', () => {
    expect(entryIndex([], columnDroppableId('done'), { top: 0, height: 800 }, { pointerY: 5 })).toBe(
      0,
    )
    expect(entryIndex(ids, columnDroppableId('in_progress'), null, { pointerY: 5 })).toBe(2)
    expect(entryIndex(ids, 'zz', f, { pointerY: 5 })).toBe(2)
    expect(entryIndex(ids, 'f', null, { pointerY: 5 })).toBe(2)
  })
})

describe('keyboardTarget', () => {
  const rects: Record<string, { top: number; height: number }> = {
    a: { top: 0, height: 60 },
    c: { top: 70, height: 80 },
    e: { top: 160, height: 60 },
    b: { top: 0, height: 60 },
    f: { top: 200, height: 60 },
  }
  const rectOf = (id: string) => rects[id] ?? null

  it('moves up and down inside the column the card is over', () => {
    expect(keyboardTarget(columns, 'a', 'a', 'down', 30, rectOf)).toBe('c')
    expect(keyboardTarget(columns, 'a', 'c', 'down', 100, rectOf)).toBe('e')
    expect(keyboardTarget(columns, 'a', 'e', 'down', 190, rectOf)).toBeNull()
    expect(keyboardTarget(columns, 'a', 'c', 'up', 100, rectOf)).toBe('a')
    expect(keyboardTarget(columns, 'a', 'a', 'up', 30, rectOf)).toBeNull()
  })

  it('moves left/right to the vertically closest card of the adjacent column', () => {
    expect(keyboardTarget(columns, 'e', 'e', 'right', 190, rectOf)).toBe('f')
    expect(keyboardTarget(columns, 'a', 'a', 'right', 30, rectOf)).toBe('b')
    expect(keyboardTarget(columns, 'b', 'b', 'left', 30, rectOf)).toBe('a')
    expect(keyboardTarget(columns, 'a', 'a', 'left', 30, rectOf)).toBeNull()
  })

  it('targets an empty column itself', () => {
    expect(keyboardTarget(columns, 'f', 'f', 'right', 230, rectOf)).toBe(columnDroppableId('done'))
    // Over an empty column, up/down use the dragged card's own position there.
    const moved: BoardColumnIds = { todo: ['a', 'c', 'e'], in_progress: ['b'], done: ['f'] }
    expect(keyboardTarget(moved, 'f', columnDroppableId('done'), 'down', 0, rectOf)).toBeNull()
    expect(keyboardTarget(moved, 'f', columnDroppableId('done'), 'left', 0, rectOf)).toBe('b')
  })
})

describe('buildBoard', () => {
  const project = makeProject({ id: 'p' })
  const design = makePhase({ id: 'ph-design', projectId: 'p', name: 'Design', sortOrder: 'a0' })
  const build = makePhase({ id: 'ph-build', projectId: 'p', name: 'Build', sortOrder: 'a1' })
  const tasks = [
    // Code-unit order: 'Zz' < 'a0' < 'a1' < 'a2' < 'b0' (localeCompare would get this wrong).
    makeTask({ id: 't-b0', projectId: 'p', sortOrder: 'b0', status: 'todo' }),
    makeTask({ id: 't-zz', projectId: 'p', sortOrder: 'Zz', status: 'todo', phaseId: 'ph-build' }),
    makeTask({
      id: 't-a1',
      projectId: 'p',
      sortOrder: 'a1',
      status: 'in_progress',
      phaseId: 'ph-design',
    }),
    makeTask({ id: 't-a0', projectId: 'p', sortOrder: 'a0', status: 'todo', phaseId: 'ph-design' }),
    makeTask({ id: 't-a2', projectId: 'p', sortOrder: 'a2', status: 'done' }),
    // Subtasks of t-a0 (one done) — never cards themselves.
    makeTask({
      id: 's1',
      projectId: 'p',
      parentTaskId: 't-a0',
      sortOrder: 'a0',
      status: 'done',
      phaseId: 'ph-design',
    }),
    makeTask({
      id: 's2',
      projectId: 'p',
      parentTaskId: 't-a0',
      sortOrder: 'a1',
      phaseId: 'ph-design',
    }),
    // Another project.
    makeTask({ id: 'x', projectId: 'other', sortOrder: 'a0' }),
  ]
  const outline = buildProjectOutline(project, [build, design], tasks, [])

  it('shows top-level tasks only, split by status, in the project sortOrder', () => {
    const model = buildBoard(outline)
    expect(toColumnIds(model.columns)).toEqual({
      todo: ['t-zz', 't-a0', 't-b0'],
      in_progress: ['t-a1'],
      done: ['t-a2'],
    })
    expect(model.projectOrder).toEqual(['t-zz', 't-a0', 't-a1', 't-a2', 't-b0'])
    expect(model.totalTasks).toBe(5)
  })

  it('carries the phase and the subtask summary of each card', () => {
    const card = buildBoard(outline).columns.todo.find((c) => c.task.id === 't-a0')
    expect(card?.phase?.name).toBe('Design')
    expect(card?.subtasks).toEqual({ done: 1, total: 2 })
    const plain = buildBoard(outline).columns.todo.find((c) => c.task.id === 't-b0')
    expect(plain?.phase).toBeNull()
    expect(plain?.subtasks).toEqual({ done: 0, total: 0 })
  })

  it('filters by phase without changing the project order', () => {
    expect(toColumnIds(buildBoard(outline, 'ph-design').columns)).toEqual({
      todo: ['t-a0'],
      in_progress: ['t-a1'],
      done: [],
    })
    expect(toColumnIds(buildBoard(outline, NO_PHASE).columns)).toEqual({
      todo: ['t-b0'],
      in_progress: [],
      done: ['t-a2'],
    })
    const filtered = buildBoard(outline, 'ph-build')
    expect(filtered.projectOrder).toHaveLength(5)
    expect(filtered.totalTasks).toBe(5)
  })
})

describe('phase filter', () => {
  const phases = [makePhase({ id: 'ph1', projectId: 'p' })]

  it('resolves the URL value against the project phases', () => {
    expect(resolvePhaseFilter(null, phases)).toBe(ALL_PHASES)
    expect(resolvePhaseFilter('ph1', phases)).toBe('ph1')
    expect(resolvePhaseFilter(NO_PHASE, phases)).toBe(NO_PHASE)
    expect(resolvePhaseFilter('deleted-phase', phases)).toBe(ALL_PHASES)
    expect(resolvePhaseFilter('ph1', [])).toBe(ALL_PHASES)
  })

  it('gives new tasks the filtered phase', () => {
    expect(phaseIdForNewTask(ALL_PHASES)).toBeNull()
    expect(phaseIdForNewTask(NO_PHASE)).toBeNull()
    expect(phaseIdForNewTask('ph1')).toBe('ph1')
  })
})

describe('describeCard', () => {
  const phase = makePhase({ id: 'ph', projectId: 'p', name: 'Design' })

  it('describes priority, due date bucket, subtasks and phase', () => {
    const task = makeTask({
      projectId: 'p',
      priority: 'high',
      dueDate: '2026-11-02',
      status: 'todo',
    })
    expect(describeCard({ task, phase, subtasks: { done: 2, total: 5 } }, '2026-11-03')).toBe(
      'Priority: High. Overdue, due Nov 2, 2026. 2 of 5 subtasks done. Phase: Design.',
    )
    expect(
      describeCard({ task, phase, subtasks: { done: 0, total: 0 } }, '2026-11-02', {
        showPhase: false,
      }),
    ).toBe('Priority: High. Due today, Nov 2, 2026.')
  })

  it('never calls a done task overdue and is empty without meta', () => {
    const done = makeTask({ projectId: 'p', dueDate: '2026-10-01', status: 'done' })
    expect(
      describeCard({ task: done, phase: null, subtasks: { done: 0, total: 0 } }, '2026-11-03'),
    ).toBe('Due Oct 1, 2026.')
    const bare = makeTask({ projectId: 'p' })
    expect(
      describeCard({ task: bare, phase: null, subtasks: { done: 0, total: 0 } }, '2026-11-03'),
    ).toBe('')
  })
})
