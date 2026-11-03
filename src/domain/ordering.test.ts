import { describe, expect, it } from 'vitest'
import {
  bySortOrder,
  compareSortKeys,
  isAtPlacement,
  keyAtEnd,
  keyAtStart,
  keyBetween,
  keyForPlacement,
  keysBetween,
  keysForPlacement,
  sortByOrder,
  type Ordered,
} from './ordering'
import { seededRandom } from './testFactories'

const item = (id: string, sortOrder: string): Ordered => ({ id, sortOrder })
const ids = (items: readonly Ordered[]) => sortByOrder(items).map((i) => i.id)

/** Inserts `id` with keyForPlacement and returns the new sibling list. */
function insert(
  list: Ordered[],
  id: string,
  placement: { afterId?: string | null; beforeId?: string | null },
): Ordered[] {
  return [...list, item(id, keyForPlacement(list, placement))]
}

function expectStrictlySorted(keys: readonly string[]) {
  for (let i = 1; i < keys.length; i++) expect(keys[i - 1] < keys[i]).toBe(true)
}

describe('comparison', () => {
  it('compares by code unit, not locale', () => {
    expect(compareSortKeys('a0', 'a1')).toBe(-1)
    expect(compareSortKeys('a1', 'a0')).toBe(1)
    expect(compareSortKeys('a0', 'a0')).toBe(0)
    // 'Z' (0x5a) sorts before 'a' (0x61); localeCompare would say otherwise.
    expect(compareSortKeys('Zz', 'a0')).toBe(-1)
    expect('Zz'.localeCompare('a0')).toBe(1)
  })

  it('bySortOrder breaks ties by id', () => {
    const list = [item('b', 'a1'), item('c', 'a0'), item('a', 'a1')]
    expect([...list].sort(bySortOrder).map((i) => i.id)).toEqual(['c', 'a', 'b'])
  })

  it('sortByOrder returns a new array and leaves the input alone', () => {
    const list = [item('x', 'a2'), item('y', 'a1')]
    const sorted = sortByOrder(list)
    expect(sorted.map((i) => i.id)).toEqual(['y', 'x'])
    expect(list.map((i) => i.id)).toEqual(['x', 'y'])
    expect(sorted).not.toBe(list)
  })
})

describe('keyBetween / keysBetween', () => {
  it('creates keys at open ends and in between', () => {
    expect(keyBetween(null, null)).toBe('a0')
    expect(keyBetween(undefined, undefined)).toBe('a0')
    expect(keyBetween('a0', null) > 'a0').toBe(true)
    expect(keyBetween(null, 'a0') < 'a0').toBe(true)
    const mid = keyBetween('a0', 'a1')
    expect(mid > 'a0' && mid < 'a1').toBe(true)
  })

  it('accepts bounds in either order', () => {
    const mid = keyBetween('a1', 'a0')
    expect(mid > 'a0' && mid < 'a1').toBe(true)
  })

  it('handles equal bounds (duplicate keys) by sorting just after them', () => {
    const key = keyBetween('a0', 'a0')
    expect(key > 'a0').toBe(true)
    expect(key < 'a1').toBe(true)
  })

  it('works with keys the library would reject', () => {
    for (const [lo, hi] of [
      ['a', 'b'],
      ['1', '2'],
      ['a', 'a0'],
      ['zzz', null],
      [null, 'a'],
      ['A', 'B'],
      ['task-1', 'task-2'],
      ['a0', 'b'],
    ] as const) {
      const key = keyBetween(lo, hi)
      if (lo !== null) expect(key > lo).toBe(true)
      if (hi !== null) expect(key < hi).toBe(true)
    }
  })

  it('keysBetween returns n distinct sorted keys inside the bounds', () => {
    for (const [lo, hi] of [
      [null, null],
      ['a0', null],
      [null, 'a0'],
      ['a0', 'a1'],
      ['a', 'b'],
      ['a0', 'a0'],
    ] as const) {
      const keys = keysBetween(lo, hi, 25)
      expect(keys).toHaveLength(25)
      expectStrictlySorted(keys)
      if (lo !== null) expect(keys[0] > lo).toBe(true)
      if (hi !== null && hi !== lo) expect(keys[24] < hi).toBe(true)
    }
  })

  it('keysBetween with n <= 0 or invalid n returns []', () => {
    expect(keysBetween(null, null, 0)).toEqual([])
    expect(keysBetween(null, null, -3)).toEqual([])
    expect(keysBetween(null, null, Number.NaN)).toEqual([])
    expect(keysBetween('a0', 'a1', 2.9)).toHaveLength(2)
  })
})

describe('keyAtEnd / keyAtStart', () => {
  it('sorts after / before every item, whatever the input order', () => {
    const list = [item('b', 'a3'), item('a', 'a1'), item('c', 'Zz')]
    expect(keyAtEnd(list) > 'a3').toBe(true)
    expect(keyAtStart(list) < 'Zz').toBe(true)
  })

  it('starts a fresh list at a0', () => {
    expect(keyAtEnd([])).toBe('a0')
    expect(keyAtStart([])).toBe('a0')
  })

  it('copes with hand-written keys', () => {
    const list = [item('a', 'a'), item('b', 'b')]
    expect(keyAtEnd(list) > 'b').toBe(true)
    expect(keyAtStart(list) < 'a').toBe(true)
  })
})

describe('keyForPlacement', () => {
  const abc = [item('A', 'a0'), item('B', 'a1'), item('C', 'a2')]

  it('places directly after afterId', () => {
    expect(ids(insert(abc, 'X', { afterId: 'A' }))).toEqual(['A', 'X', 'B', 'C'])
    expect(ids(insert(abc, 'X', { afterId: 'C' }))).toEqual(['A', 'B', 'C', 'X'])
  })

  it('places directly before beforeId', () => {
    expect(ids(insert(abc, 'X', { beforeId: 'A' }))).toEqual(['X', 'A', 'B', 'C'])
    expect(ids(insert(abc, 'X', { beforeId: 'C' }))).toEqual(['A', 'B', 'X', 'C'])
  })

  it('uses both hints when they agree', () => {
    expect(ids(insert(abc, 'X', { afterId: 'B', beforeId: 'C' }))).toEqual(['A', 'B', 'X', 'C'])
  })

  it('null afterId = first, null beforeId = last, nothing = append', () => {
    expect(ids(insert(abc, 'X', { afterId: null }))).toEqual(['X', 'A', 'B', 'C'])
    expect(ids(insert(abc, 'X', { beforeId: null }))).toEqual(['A', 'B', 'C', 'X'])
    expect(ids(insert(abc, 'X', {}))).toEqual(['A', 'B', 'C', 'X'])
    expect(ids(insert(abc, 'X', { afterId: null, beforeId: 'A' }))).toEqual(['X', 'A', 'B', 'C'])
    expect(ids(insert(abc, 'X', { afterId: 'C', beforeId: null }))).toEqual(['A', 'B', 'C', 'X'])
  })

  it('accepts siblings in any order', () => {
    const shuffled = [abc[2], abc[0], abc[1]]
    expect(ids(insert(shuffled, 'X', { afterId: 'A' }))).toEqual(['A', 'X', 'B', 'C'])
  })

  it('prefers afterId when the hints contradict each other', () => {
    expect(ids(insert(abc, 'X', { afterId: 'C', beforeId: 'A' }))).toEqual(['A', 'B', 'C', 'X'])
    expect(ids(insert(abc, 'X', { afterId: 'A', beforeId: 'A' }))).toEqual(['A', 'X', 'B', 'C'])
    expect(ids(insert(abc, 'X', { afterId: null, beforeId: null }))).toEqual(['X', 'A', 'B', 'C'])
  })

  it('falls back gracefully for unknown ids', () => {
    expect(ids(insert(abc, 'X', { afterId: 'nope', beforeId: 'B' }))).toEqual(['A', 'X', 'B', 'C'])
    expect(ids(insert(abc, 'X', { afterId: 'nope' }))).toEqual(['A', 'B', 'C', 'X'])
    expect(ids(insert(abc, 'X', { beforeId: 'nope' }))).toEqual(['A', 'B', 'C', 'X'])
    expect(ids(insert(abc, 'X', { afterId: 'nope', beforeId: null }))).toEqual(['A', 'B', 'C', 'X'])
  })

  it('works for an empty destination', () => {
    expect(keyForPlacement([], {})).toBe('a0')
    expect(keyForPlacement([], { afterId: null, beforeId: null })).toBe('a0')
    expect(keyForPlacement([], { afterId: 'gone' })).toBe('a0')
  })

  it('lands next to the hinted neighbours inside a filtered subsequence (Board column)', () => {
    // Full project order: T1(todo) D1(done) T2(todo) D2(done) T3(todo).
    const all = [
      item('T1', 'a0'),
      item('D1', 'a1'),
      item('T2', 'a2'),
      item('D2', 'a3'),
      item('T3', 'a4'),
    ]
    const todo = new Set(['T1', 'T2', 'T3', 'X'])
    const column = (list: Ordered[]) => ids(list).filter((id) => todo.has(id))
    expect(column(insert(all, 'X', { afterId: 'T1', beforeId: 'T2' }))).toEqual([
      'T1',
      'X',
      'T2',
      'T3',
    ])
    expect(column(insert(all, 'X', { afterId: null, beforeId: 'T1' }))).toEqual([
      'X',
      'T1',
      'T2',
      'T3',
    ])
    expect(column(insert(all, 'X', { afterId: 'T3', beforeId: null }))).toEqual([
      'T1',
      'T2',
      'T3',
      'X',
    ])
    expect(column(insert(all, 'X', { beforeId: 'T3' }))).toEqual(['T1', 'T2', 'X', 'T3'])
  })

  it('a drop at the top of a filtered group lands directly before its first item', () => {
    // Full project order: T1(todo) D1(done) T2(todo) D2(done) T3(todo); the Done column is D1, D2.
    const all = [
      item('T1', 'a0'),
      item('D1', 'a1'),
      item('T2', 'a2'),
      item('D2', 'a3'),
      item('T3', 'a4'),
    ]
    // Top of the Done column: nothing above it in the column (afterId null), D1 below.
    // The rest of the project order (List view, other columns) must not change.
    expect(ids(insert(all, 'X', { afterId: null, beforeId: 'D1' }))).toEqual([
      'T1',
      'X',
      'D1',
      'T2',
      'D2',
      'T3',
    ])
    // Mirror image: the bottom of the column already lands directly after its last item.
    expect(ids(insert(all, 'X', { afterId: 'D2', beforeId: null }))).toEqual([
      'T1',
      'D1',
      'T2',
      'D2',
      'X',
      'T3',
    ])
    // With nothing known to anchor to, null afterId still means first.
    expect(ids(insert(all, 'X', { afterId: null, beforeId: 'gone' }))[0]).toBe('X')
  })

  it('drops into any filtered group land at the hinted spot, next to a hinted neighbour (property test)', () => {
    const random = seededRandom(9)
    for (let round = 0; round < 500; round++) {
      const list = keysBetween(null, null, Math.floor(random() * 8)).map((key, i) =>
        item(`I${i}`, key),
      )
      const group = list.filter(() => random() < 0.5) // a Board column or a List phase group
      const gap = Math.floor(random() * (group.length + 1))
      const afterId = gap > 0 ? group[gap - 1].id : null
      const beforeId = gap < group.length ? group[gap].id : null
      const order = ids(insert(list, 'X', { afterId, beforeId }))
      const inGroup = order.filter((id) => id === 'X' || group.some((g) => g.id === id))
      expect(inGroup.indexOf('X')).toBe(gap)
      const x = order.indexOf('X')
      if (afterId !== null || beforeId !== null) {
        expect(order[x - 1] === afterId || order[x + 1] === beforeId).toBe(true)
      }
    }
  })

  it('handles duplicate keys around the gap', () => {
    const dup = [item('A', 'a0'), item('B', 'a1'), item('C', 'a1'), item('D', 'a2')]
    // After B: no key fits between B and C (equal), so X goes right after the run B, C.
    expect(ids(insert(dup, 'X', { afterId: 'B' }))).toEqual(['A', 'B', 'C', 'X', 'D'])
    // Before C: X goes right before the run B, C.
    expect(ids(insert(dup, 'X', { beforeId: 'C' }))).toEqual(['A', 'X', 'B', 'C', 'D'])
    const allSame = [item('A', 'a0'), item('B', 'a0'), item('C', 'a0')]
    expect(ids(insert(allSame, 'X', { afterId: 'A' }))).toEqual(['A', 'B', 'C', 'X'])
    expect(ids(insert(allSame, 'X', { beforeId: 'B' }))).toEqual(['X', 'A', 'B', 'C'])
  })

  it('handles hand-written (invalid) keys', () => {
    const list = [item('A', 'a'), item('B', 'b'), item('C', 'c')]
    expect(ids(insert(list, 'X', { afterId: 'A' }))).toEqual(['A', 'X', 'B', 'C'])
    expect(ids(insert(list, 'X', { beforeId: 'A' }))).toEqual(['X', 'A', 'B', 'C'])
    expect(ids(insert(list, 'X', { afterId: 'C' }))).toEqual(['A', 'B', 'C', 'X'])
    const mixed = [item('A', 'a0'), item('B', 'b'), item('C', 'zzz')]
    expect(ids(insert(mixed, 'X', { afterId: 'A' }))).toEqual(['A', 'X', 'B', 'C'])
    expect(ids(insert(mixed, 'X', { afterId: 'B' }))).toEqual(['A', 'B', 'X', 'C'])
    expect(ids(insert(mixed, 'X', { afterId: 'C' }))).toEqual(['A', 'B', 'C', 'X'])
  })

  it('never throws, even on corrupt input', () => {
    const corrupt = [
      item('A', ''),
      { id: 'B', sortOrder: undefined } as unknown as Ordered,
      null as unknown as Ordered,
    ]
    expect(typeof keyForPlacement(corrupt, { afterId: 'A' })).toBe('string')
    expect(typeof keyForPlacement([item('A', '')], { beforeId: 'A' })).toBe('string')
    expect(typeof keyForPlacement(abc, undefined as unknown as { afterId?: string })).toBe('string')
    expect(typeof keyForPlacement(null as unknown as Ordered[], {})).toBe('string')
  })

  it('stays sorted after 200 inserts at the same spot', () => {
    let afterFirst = [item('A', keyBetween(null, null))]
    afterFirst = insert(afterFirst, 'B', { afterId: 'A' })
    let beforeLast = [...afterFirst]
    const expectedAfterFirst = ['A', 'B']
    const expectedBeforeLast = ['A', 'B']
    for (let i = 0; i < 200; i++) {
      // Always directly after A (each new item pushes the previous ones right).
      afterFirst = insert(afterFirst, `X${i}`, { afterId: 'A', beforeId: expectedAfterFirst[1] })
      expectedAfterFirst.splice(1, 0, `X${i}`)
      // Always directly before B (each new item lands after the previous ones).
      beforeLast = insert(beforeLast, `Y${i}`, { beforeId: 'B' })
      expectedBeforeLast.splice(expectedBeforeLast.length - 1, 0, `Y${i}`)
    }
    expect(ids(afterFirst)).toEqual(expectedAfterFirst)
    expect(ids(beforeLast)).toEqual(expectedBeforeLast)
    expectStrictlySorted(sortByOrder(afterFirst).map((i) => i.sortOrder))
    expectStrictlySorted(sortByOrder(beforeLast).map((i) => i.sortOrder))
    // Keys stay short enough for an indexed text column.
    for (const entry of [...afterFirst, ...beforeLast])
      expect(entry.sortOrder.length).toBeLessThan(64)
  })

  it('stays sorted after 200 prepends and appends', () => {
    let list: Ordered[] = []
    const expected: string[] = []
    for (let i = 0; i < 200; i++) {
      list = insert(list, `F${i}`, { afterId: null })
      expected.unshift(`F${i}`)
      list = insert(list, `L${i}`, { beforeId: null })
      expected.push(`L${i}`)
    }
    expect(ids(list)).toEqual(expected)
    expectStrictlySorted(sortByOrder(list).map((i) => i.sortOrder))
  })

  it('keeps a consistent order under random placements (property test)', () => {
    const random = seededRandom(42)
    let list: Ordered[] = []
    const expected: string[] = []
    for (let i = 0; i < 500; i++) {
      const id = `N${i}`
      const gap = Math.floor(random() * (expected.length + 1))
      const mode = random()
      const placement =
        mode < 0.4
          ? { afterId: gap === 0 ? null : expected[gap - 1] }
          : mode < 0.8
            ? { beforeId: gap === expected.length ? null : expected[gap] }
            : {
                afterId: gap === 0 ? null : expected[gap - 1],
                beforeId: gap === expected.length ? null : expected[gap],
              }
      list = insert(list, id, placement)
      expected.splice(gap, 0, id)
    }
    expect(ids(list)).toEqual(expected)
    const keys = sortByOrder(list).map((i) => i.sortOrder)
    expectStrictlySorted(keys)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('keysForPlacement', () => {
  it('returns a sorted block for the resolved gap', () => {
    const list = [item('A', 'a0'), item('B', 'a1')]
    const keys = keysForPlacement(list, { afterId: 'A' }, 3)
    expect(keys).toHaveLength(3)
    const next = [...list, ...keys.map((key, i) => item(`S${i}`, key))]
    expect(ids(next)).toEqual(['A', 'S0', 'S1', 'S2', 'B'])
  })

  it('handles an empty list and n = 0', () => {
    expect(keysForPlacement([], {}, 2)).toHaveLength(2)
    expect(keysForPlacement([item('A', 'a0')], { afterId: 'A' }, 0)).toEqual([])
  })
})

describe('isAtPlacement', () => {
  // Full order T1 D1 T2 (the Done column is D1 alone; the To Do column is T1, T2).
  const all = [item('T1', 'a0'), item('D1', 'a1'), item('T2', 'a2')]
  const without = (id: string) => all.filter((i) => i.id !== id)
  const at = (id: string, placement: Parameters<typeof isAtPlacement>[2]) =>
    isAtPlacement(all.find((i) => i.id === id) as Ordered, without(id), placement)

  it('anchors to a known neighbour exactly like keyForPlacement', () => {
    expect(at('D1', { afterId: 'T1' })).toBe(true)
    expect(at('D1', { beforeId: 'T2' })).toBe(true)
    expect(at('D1', { afterId: 'T1', beforeId: 'T2' })).toBe(true)
    expect(at('T2', { afterId: 'T1' })).toBe(false) // D1 sits in between
    // Top of a filtered group: directly before its first item, not "first in the project".
    expect(at('D1', { afterId: null, beforeId: 'T2' })).toBe(true)
    expect(at('T1', { afterId: null, beforeId: 'T2' })).toBe(false)
  })

  it('null afterId = first, null beforeId / nothing / unknown ids = last', () => {
    expect(at('T1', { afterId: null })).toBe(true)
    expect(at('D1', { afterId: null })).toBe(false)
    expect(at('T1', { afterId: null, beforeId: 'gone' })).toBe(true)
    expect(at('T2', { beforeId: null })).toBe(true)
    expect(at('T2', {})).toBe(true)
    expect(at('T2', { afterId: 'gone' })).toBe(true)
    expect(at('D1', {})).toBe(false)
    expect(isAtPlacement(item('X', 'a0'), [], {})).toBe(true)
  })

  it('is true exactly when keyForPlacement would keep the item in its gap (property test)', () => {
    const random = seededRandom(17)
    for (let round = 0; round < 500; round++) {
      const list = keysBetween(null, null, 1 + Math.floor(random() * 7)).map((key, i) =>
        item(`I${i}`, key),
      )
      const moved = list[Math.floor(random() * list.length)]
      const siblings = list.filter((i) => i.id !== moved.id)
      const pick = () => {
        const r = random()
        if (r < 0.2) return null
        if (r < 0.3) return undefined
        if (r < 0.35) return 'gone'
        return siblings.length > 0 ? siblings[Math.floor(random() * siblings.length)].id : null
      }
      const placement = { afterId: pick(), beforeId: pick() }
      const placed = { ...moved, sortOrder: keyForPlacement(siblings, placement) }
      const before = ids([...siblings, moved])
      const after = ids([...siblings, placed])
      expect(isAtPlacement(moved, siblings, placement)).toBe(
        JSON.stringify(before) === JSON.stringify(after),
      )
    }
  })
})
