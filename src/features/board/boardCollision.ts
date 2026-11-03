/**
 * Collision detection for the board's multi-column drag and drop (dnd-kit). No React; unit
 * tested, including the column-gap case that used to loop.
 */
import {
  getFirstCollision,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
} from '@dnd-kit/core'
import { nearestCard, parseColumnDroppableId, type BoardColumnIds } from './boardModel'

/** What the detection remembers between calls during one drag (reset when it ends). */
export interface BoardCollisionMemory {
  /** The last target returned, kept while nothing is under the pointer. */
  lastOverId: string | null
  /** Pointer position at the latest check (null during keyboard drags). */
  pointer: { x: number; y: number } | null
  /** True right after the dragged card switched columns (its layout is still settling). */
  movedToNewColumn: boolean
}

export function createCollisionMemory(): BoardCollisionMemory {
  return { lastOverId: null, pointer: null, movedToNewColumn: false }
}

/**
 * - Pointer drags consider ONLY what is under the pointer. Columns never move sideways, so a card
 *   switching columns cannot change which column the pointer is in. (Rectangle overlap can: a card
 *   straddling the gap between two columns overlaps the column it just left more than the one it
 *   is in, and would flip between them on every render — "Maximum update depth exceeded".)
 * - Keyboard drags have no pointer: the coordinate getter puts the card's rectangle onto its
 *   target, so rectangle overlap finds it.
 * - A column hit (its header, the gaps between cards, the space below them) is aimed at the card
 *   nearest to the pointer — the dragged card included — so the drop index follows the pointer;
 *   an empty column stays the target itself.
 * - Nothing under the pointer (between columns, outside the board): the last target is kept.
 *
 * `columns` = the card ids per column as currently shown (the drag preview); `memory` is updated.
 */
export function detectBoardCollision(
  args: Parameters<CollisionDetection>[0],
  columns: BoardColumnIds,
  memory: BoardCollisionMemory,
): ReturnType<CollisionDetection> {
  const pointer = args.pointerCoordinates
  memory.pointer = pointer
  const hits = pointer ? pointerWithin(args) : rectIntersection(args)
  let overId = getFirstCollision(hits, 'id')
  if (overId != null) {
    const column = parseColumnDroppableId(overId)
    if (column) {
      const { collisionRect } = args
      const y = pointer ? pointer.y : collisionRect.top + collisionRect.height / 2
      const nearest = nearestCard(columns[column], y, (id) => args.droppableRects.get(id) ?? null)
      if (nearest) overId = nearest
    }
    memory.lastOverId = String(overId)
    return [{ id: overId }]
  }
  // Right after a column switch the card's own slot is the safest target.
  if (memory.movedToNewColumn) memory.lastOverId = String(args.active.id)
  return memory.lastOverId ? [{ id: memory.lastOverId }] : []
}
