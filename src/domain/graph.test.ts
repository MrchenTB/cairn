import { describe, expect, it } from 'vitest'
import { stronglyConnectedComponents } from './graph'

/** Groups node indices by component id (each group sorted, groups sorted by first node). */
function groups(adjacency: number[][]): number[][] {
  const component = stronglyConnectedComponents(adjacency)
  const byId = new Map<number, number[]>()
  component.forEach((id, node) => byId.set(id, [...(byId.get(id) ?? []), node]))
  return [...byId.values()].sort((a, b) => a[0] - b[0])
}

describe('stronglyConnectedComponents', () => {
  it('puts every node of an acyclic graph in its own component', () => {
    expect(groups([[1, 2], [3], [3], []])).toEqual([[0], [1], [2], [3]])
    expect(groups([])).toEqual([])
  })

  it('finds cycles of any length, including several and nested ones', () => {
    // 0 ⇄ 1, 2 → 3 → 4 → 2, 4 → 5, 5 isolated afterwards
    expect(groups([[1], [0, 2], [3], [4], [2, 5], []])).toEqual([[0, 1], [2, 3, 4], [5]])
    // two cycles joined into one component: 0→1→0 and 1→2→1
    expect(groups([[1], [0, 2], [1]])).toEqual([[0, 1, 2]])
  })

  it('does not treat a self-loop as a multi-node component', () => {
    expect(groups([[0, 1], []])).toEqual([[0], [1]])
  })

  it('handles a 100,000-node chain closed into a cycle without overflowing the stack', () => {
    const n = 100_000
    const adjacency = Array.from({ length: n }, (_, i) => [(i + 1) % n])
    const component = stronglyConnectedComponents(adjacency)
    expect(new Set(component).size).toBe(1)
  })
})
