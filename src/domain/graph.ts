/**
 * Small directed-graph helpers shared by scheduling and backup validation (domain-internal).
 * Nodes are dense indices 0..n-1; `adjacency[u]` lists the targets of u's outgoing edges.
 */

/**
 * Strongly connected components (Tarjan, iterative so long dependency chains cannot overflow
 * the call stack). Returns the component id of every node; two nodes share an id exactly when
 * each can reach the other, so an edge u → v (u ≠ v) lies on a cycle iff
 * component[u] === component[v]. Self-loops are not detected here; callers drop them first.
 */
export function stronglyConnectedComponents(adjacency: readonly (readonly number[])[]): Int32Array {
  const n = adjacency.length
  const index = new Int32Array(n).fill(-1)
  const low = new Int32Array(n)
  const onStack = new Uint8Array(n)
  const component = new Int32Array(n).fill(-1)
  const stack: number[] = []
  const frames: number[] = [] // node of each active DFS frame
  const nextEdge = new Int32Array(n) // per node: next outgoing edge to visit
  let counter = 0
  let components = 0

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue
    index[root] = low[root] = counter++
    stack.push(root)
    onStack[root] = 1
    frames.push(root)
    while (frames.length > 0) {
      const v = frames[frames.length - 1]
      const edges = adjacency[v]
      if (nextEdge[v] < edges.length) {
        const w = edges[nextEdge[v]++]
        if (index[w] === -1) {
          index[w] = low[w] = counter++
          stack.push(w)
          onStack[w] = 1
          frames.push(w)
        } else if (onStack[w] && index[w] < low[v]) {
          low[v] = index[w]
        }
        continue
      }
      frames.pop()
      if (low[v] === index[v]) {
        let w: number
        do {
          w = stack.pop() as number
          onStack[w] = 0
          component[w] = components
        } while (w !== v)
        components++
      }
      if (frames.length > 0) {
        const parent = frames[frames.length - 1]
        if (low[v] < low[parent]) low[parent] = low[v]
      }
    }
  }
  return component
}
