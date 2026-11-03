import type { Active, ClientRect, CollisionDetection, DroppableContainer } from '@dnd-kit/core'
import { describe, expect, it } from 'vitest'
import { createCollisionMemory, detectBoardCollision } from './boardCollision'
import { columnDroppableId, type BoardColumnIds } from './boardModel'

type Args = Parameters<CollisionDetection>[0]

function rect(left: number, top: number, width: number, height: number): ClientRect {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

/** Two columns (x 0–300 and 320–620, a 20 px gap) plus the Done column further right. */
const COLUMN_RECTS: Record<string, ClientRect> = {
  [columnDroppableId('todo')]: rect(0, 0, 300, 800),
  [columnDroppableId('in_progress')]: rect(320, 0, 300, 800),
  [columnDroppableId('done')]: rect(640, 0, 300, 800),
}

function args(
  cards: Record<string, ClientRect>,
  options: {
    pointer: { x: number; y: number } | null
    collisionRect: ClientRect
    activeId: string
  },
): Args {
  const rects = { ...COLUMN_RECTS, ...cards }
  return {
    active: { id: options.activeId } as Active,
    collisionRect: options.collisionRect,
    droppableRects: new Map(Object.entries(rects)),
    droppableContainers: Object.keys(rects).map((id) => ({ id }) as DroppableContainer),
    pointerCoordinates: options.pointer,
  }
}

describe('detectBoardCollision — pointer drags', () => {
  it('keeps the last target in the gap between columns, whichever column the card is in', () => {
    // The dragged card (a, 300 × 60) straddles the gap; rectangle overlap would pick the column it
    // is NOT in (the bigger overlap), flip it there, and flip it back on the next render.
    const pointer = { x: 310, y: 30 }
    const collisionRect = rect(160, 0, 300, 60)
    const inTodo = { a: rect(0, 0, 300, 60), b: rect(320, 0, 300, 50) }
    const inProgress = {
      a: rect(320, 0, 300, 60),
      b: rect(320, 68, 300, 50),
      c: rect(0, 0, 300, 50),
    }
    const memory = createCollisionMemory()
    memory.lastOverId = 'b'

    for (const layout of [inTodo, inProgress, inTodo, inProgress]) {
      const columns: BoardColumnIds =
        layout === inTodo
          ? { todo: ['a'], in_progress: ['b'], done: [] }
          : { todo: ['c'], in_progress: ['a', 'b'], done: [] }
      expect(
        detectBoardCollision(
          args(layout, { pointer, collisionRect, activeId: 'a' }),
          columns,
          memory,
        ),
      ).toEqual([{ id: 'b' }])
    }
    expect(memory.pointer).toEqual(pointer)
  })

  it('targets the card under the pointer', () => {
    const memory = createCollisionMemory()
    const cards = { a: rect(10, 10, 280, 60), b: rect(330, 10, 280, 60), c: rect(330, 80, 280, 60) }
    const columns: BoardColumnIds = { todo: ['a'], in_progress: ['b', 'c'], done: [] }
    const result = detectBoardCollision(
      args(cards, {
        pointer: { x: 400, y: 100 },
        collisionRect: rect(300, 70, 280, 60),
        activeId: 'a',
      }),
      columns,
      memory,
    )
    expect(result).toEqual([{ id: 'c' }])
    expect(memory.lastOverId).toBe('c')
  })

  it('aims a column hit at the card nearest to the pointer, the dragged card included', () => {
    const cards = {
      a: rect(330, 10, 280, 60),
      b: rect(330, 80, 280, 60),
      c: rect(330, 150, 280, 60),
    }
    const columns: BoardColumnIds = { todo: [], in_progress: ['a', 'b', 'c'], done: [] }
    // Below every card (empty space / composer): the last card.
    expect(
      detectBoardCollision(
        args(cards, {
          pointer: { x: 400, y: 400 },
          collisionRect: rect(330, 370, 280, 60),
          activeId: 'x',
        }),
        columns,
        createCollisionMemory(),
      ),
    ).toEqual([{ id: 'c' }])
    // In the gap between a and b, nearer to b's centre.
    expect(
      detectBoardCollision(
        args(cards, {
          pointer: { x: 400, y: 76 },
          collisionRect: rect(330, 46, 280, 60),
          activeId: 'x',
        }),
        columns,
        createCollisionMemory(),
      ),
    ).toEqual([{ id: 'b' }])
    // The dragged card itself (c) is a candidate: below the last card it stays put.
    expect(
      detectBoardCollision(
        args(cards, {
          pointer: { x: 400, y: 260 },
          collisionRect: rect(330, 230, 280, 60),
          activeId: 'c',
        }),
        columns,
        createCollisionMemory(),
      ),
    ).toEqual([{ id: 'c' }])
  })

  it('targets an empty column itself', () => {
    const columns: BoardColumnIds = { todo: ['a'], in_progress: [], done: [] }
    expect(
      detectBoardCollision(
        args(
          { a: rect(10, 10, 280, 60) },
          {
            pointer: { x: 700, y: 300 },
            collisionRect: rect(560, 270, 280, 60),
            activeId: 'a',
          },
        ),
        columns,
        createCollisionMemory(),
      ),
    ).toEqual([{ id: columnDroppableId('done') }])
  })

  it('outside every droppable: the last target, or the dragged card right after a column switch', () => {
    const outside = { pointer: { x: 2000, y: 300 }, collisionRect: rect(1900, 270, 280, 60) }
    const columns: BoardColumnIds = { todo: [], in_progress: ['a'], done: [] }
    const memory = createCollisionMemory()
    expect(detectBoardCollision(args({}, { ...outside, activeId: 'a' }), columns, memory)).toEqual(
      [],
    )
    memory.lastOverId = 'b'
    expect(detectBoardCollision(args({}, { ...outside, activeId: 'a' }), columns, memory)).toEqual([
      { id: 'b' },
    ])
    memory.movedToNewColumn = true
    expect(detectBoardCollision(args({}, { ...outside, activeId: 'a' }), columns, memory)).toEqual([
      { id: 'a' },
    ])
  })
})

describe('detectBoardCollision — keyboard drags (no pointer)', () => {
  it('uses rectangle overlap: the card the coordinate getter placed the dragged card onto', () => {
    const cards = { a: rect(10, 10, 280, 60), b: rect(330, 10, 280, 60), c: rect(330, 80, 280, 60) }
    const columns: BoardColumnIds = { todo: ['a'], in_progress: ['b', 'c'], done: [] }
    const memory = createCollisionMemory()
    expect(
      detectBoardCollision(
        args(cards, { pointer: null, collisionRect: rect(330, 80, 280, 60), activeId: 'a' }),
        columns,
        memory,
      ),
    ).toEqual([{ id: 'c' }])
    expect(memory.pointer).toBeNull()
  })

  it('placed onto an empty column: the column', () => {
    const columns: BoardColumnIds = { todo: ['a'], in_progress: [], done: [] }
    expect(
      detectBoardCollision(
        args(
          { a: rect(10, 10, 280, 60) },
          {
            pointer: null,
            collisionRect: rect(648, 40, 280, 60),
            activeId: 'a',
          },
        ),
        columns,
        createCollisionMemory(),
      ),
    ).toEqual([{ id: columnDroppableId('done') }])
  })
})
