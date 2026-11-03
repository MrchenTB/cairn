import { describe, expect, it } from 'vitest'
import {
  findContainer,
  groupContainerId,
  isGroupContainerId,
  moveToContainer,
  moveToGroupEnd,
  neighbours,
  phaseIdOfContainer,
  reorderWithin,
  resolveSubtaskDrop,
  resolveTopLevelDrop,
  stepMove,
  subtaskContainerId,
  type Containers,
} from './listDnd'

const NONE = groupContainerId(null)
const DESIGN = groupContainerId('design')
const BUILD = groupContainerId('build')

describe('container ids', () => {
  it('round-trips phase ids and recognises group containers', () => {
    expect(NONE).toBe('group:none')
    expect(phaseIdOfContainer(NONE)).toBeNull()
    expect(phaseIdOfContainer(DESIGN)).toBe('design')
    expect(phaseIdOfContainer(subtaskContainerId('t1'))).toBeUndefined()
    expect(isGroupContainerId(DESIGN)).toBe(true)
    expect(isGroupContainerId(subtaskContainerId('t1'))).toBe(false)
    expect(isGroupContainerId(42)).toBe(false)
  })

  it('finds the container of an item, or the container itself', () => {
    const containers: Containers = { [NONE]: ['a'], [DESIGN]: ['b', 'c'] }
    expect(findContainer(containers, 'c')).toBe(DESIGN)
    expect(findContainer(containers, DESIGN)).toBe(DESIGN)
    expect(findContainer(containers, 'zzz')).toBeNull()
    expect(findContainer(containers, null)).toBeNull()
  })
})

describe('neighbours / reorderWithin', () => {
  it('reports the items directly before and after', () => {
    expect(neighbours(['a', 'b', 'c'], 'b')).toEqual({ afterId: 'a', beforeId: 'c' })
    expect(neighbours(['a', 'b', 'c'], 'a')).toEqual({ afterId: null, beforeId: 'b' })
    expect(neighbours(['a'], 'a')).toEqual({ afterId: null, beforeId: null })
  })

  it('moves like a sortable list (the active item takes the index of the item it is over)', () => {
    expect(reorderWithin(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
    expect(reorderWithin(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(reorderWithin(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c'])
    expect(reorderWithin(['a', 'b', 'c'], 'b', 'nope')).toEqual(['a', 'b', 'c'])
  })
})

describe('moveToContainer (drag-over preview)', () => {
  const containers: Containers = { [NONE]: ['a', 'b'], [DESIGN]: ['c', 'd'], [BUILD]: [] }

  it('inserts before or after the hovered item', () => {
    expect(moveToContainer(containers, 'a', DESIGN, 'd', false)).toEqual({
      [NONE]: ['b'],
      [DESIGN]: ['c', 'a', 'd'],
      [BUILD]: [],
    })
    expect(moveToContainer(containers, 'a', DESIGN, 'd', true)[DESIGN]).toEqual(['c', 'd', 'a'])
  })

  it('appends when hovering the group itself (e.g. an empty phase)', () => {
    expect(moveToContainer(containers, 'c', BUILD, null, false)[BUILD]).toEqual(['c'])
  })

  it('does nothing within the same container or for unknown targets', () => {
    expect(moveToContainer(containers, 'a', NONE, 'b', true)).toBe(containers)
    expect(moveToContainer(containers, 'a', 'group:missing', null, false)).toBe(containers)
    expect(moveToContainer(containers, 'zzz', DESIGN, null, false)).toBe(containers)
  })
})

describe('resolveTopLevelDrop', () => {
  const initial: Containers = { [NONE]: ['a', 'b', 'c'], [DESIGN]: ['d', 'e'], [BUILD]: [] }

  it('reorders within a group without touching the phase', () => {
    expect(resolveTopLevelDrop({ taskId: 'a', initial, current: initial, overId: 'c' })).toEqual({
      taskId: 'a',
      afterId: 'c',
      beforeId: null,
    })
    expect(resolveTopLevelDrop({ taskId: 'c', initial, current: initial, overId: 'a' })).toEqual({
      taskId: 'c',
      afterId: null,
      beforeId: 'a',
    })
  })

  it('returns null for a drop in place or outside every target', () => {
    expect(resolveTopLevelDrop({ taskId: 'b', initial, current: initial, overId: 'b' })).toBeNull()
    expect(resolveTopLevelDrop({ taskId: 'b', initial, current: initial, overId: null })).toBeNull()
    // Dropping on its own group keeps the order.
    expect(resolveTopLevelDrop({ taskId: 'b', initial, current: initial, overId: NONE })).toBeNull()
  })

  it('moves to another phase at the previewed position (neighbours as seen in the view)', () => {
    const current = moveToContainer(initial, 'b', DESIGN, 'e', false)
    expect(current[DESIGN]).toEqual(['d', 'b', 'e'])
    expect(resolveTopLevelDrop({ taskId: 'b', initial, current, overId: 'b' })).toEqual({
      taskId: 'b',
      afterId: 'd',
      beforeId: 'e',
      phaseId: 'design',
    })
    // …and can still be reordered inside the new group before the drop.
    expect(resolveTopLevelDrop({ taskId: 'b', initial, current, overId: 'e' })).toEqual({
      taskId: 'b',
      afterId: 'e',
      beforeId: null,
      phaseId: 'design',
    })
  })

  it('moves into "No phase" with phaseId null', () => {
    const current = moveToContainer(initial, 'd', NONE, 'a', false)
    expect(resolveTopLevelDrop({ taskId: 'd', initial, current, overId: 'd' })).toEqual({
      taskId: 'd',
      afterId: null,
      beforeId: 'a',
      phaseId: null,
    })
  })

  it('appends to a group dropped on directly (collapsed or empty, no preview)', () => {
    expect(resolveTopLevelDrop({ taskId: 'a', initial, current: initial, overId: DESIGN })).toEqual({
      taskId: 'a',
      afterId: 'e',
      beforeId: null,
      phaseId: 'design',
    })
    // An empty group has no neighbours to place by: no hints (the caller keeps the task's place).
    expect(resolveTopLevelDrop({ taskId: 'a', initial, current: initial, overId: BUILD })).toEqual({
      taskId: 'a',
      phaseId: 'build',
    })
  })

  it('a task dragged out and back into its group keeps its phase', () => {
    const away = moveToContainer(initial, 'a', DESIGN, null, false)
    const back = moveToContainer(away, 'a', NONE, 'c', true)
    expect(resolveTopLevelDrop({ taskId: 'a', initial, current: back, overId: 'a' })).toEqual({
      taskId: 'a',
      afterId: 'c',
      beforeId: null,
    })
  })
})

describe('resolveSubtaskDrop', () => {
  it('reorders among siblings only', () => {
    expect(resolveSubtaskDrop({ taskId: 's1', siblings: ['s1', 's2', 's3'], overId: 's2' })).toEqual({
      taskId: 's1',
      afterId: 's2',
      beforeId: 's3',
    })
    expect(resolveSubtaskDrop({ taskId: 's3', siblings: ['s1', 's2', 's3'], overId: 's1' })).toEqual({
      taskId: 's3',
      afterId: null,
      beforeId: 's1',
    })
  })

  it('ignores drops in place, on non-siblings or nowhere', () => {
    expect(resolveSubtaskDrop({ taskId: 's1', siblings: ['s1', 's2'], overId: 's1' })).toBeNull()
    expect(resolveSubtaskDrop({ taskId: 's1', siblings: ['s1', 's2'], overId: 'other' })).toBeNull()
    expect(resolveSubtaskDrop({ taskId: 's1', siblings: ['s1', 's2'], overId: null })).toBeNull()
    expect(resolveSubtaskDrop({ taskId: 'x', siblings: ['s1', 's2'], overId: 's1' })).toBeNull()
  })
})

describe('menu moves', () => {
  it('stepMove swaps with the neighbour and stops at the edges', () => {
    expect(stepMove(['a', 'b', 'c'], 'b', -1)).toEqual({ taskId: 'b', afterId: null, beforeId: 'a' })
    expect(stepMove(['a', 'b', 'c'], 'b', 1)).toEqual({ taskId: 'b', afterId: 'c', beforeId: null })
    expect(stepMove(['a', 'b', 'c'], 'a', -1)).toBeNull()
    expect(stepMove(['a', 'b', 'c'], 'c', 1)).toBeNull()
    expect(stepMove(['a'], 'zzz', 1)).toBeNull()
  })

  it('moveToGroupEnd appends to the target phase', () => {
    const containers: Containers = { [NONE]: ['a'], [DESIGN]: ['d', 'e'], [BUILD]: [] }
    expect(moveToGroupEnd(containers, 'a', 'design')).toEqual({
      taskId: 'a',
      phaseId: 'design',
      afterId: 'e',
      beforeId: null,
    })
    expect(moveToGroupEnd(containers, 'a', 'build')).toEqual({ taskId: 'a', phaseId: 'build' })
    expect(moveToGroupEnd(containers, 'd', null)).toEqual({
      taskId: 'd',
      phaseId: null,
      afterId: 'a',
      beforeId: null,
    })
    expect(moveToGroupEnd(containers, 'd', 'design')).toBeNull()
  })
})
