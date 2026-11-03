/**
 * Drag-and-drop wiring for the List view (dnd-kit core + sortable).
 *
 * - Top-level tasks: one sortable container per outline group; while the pointer crosses into
 *   another (expanded) group the task is previewed there (multi-container pattern). Dropping on
 *   a collapsed group's header puts it at the end of that group.
 * - Subtasks: reordered among their siblings only (no cross-parent drag in V1).
 * - Keyboard (Space/Enter, arrows, Space/Enter, Esc): reorders within the current container;
 *   moving to another phase uses the row menu ("Move to phase").
 * The drop is turned into a MoveTaskInput by the pure helpers in ./listDnd and written through
 * the store (optimistic, so the list never flickers back).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  closestCenter,
  KeyboardSensor,
  pointerWithin,
  PointerSensor,
  rectIntersection,
  useSensor,
  useSensors,
  type ClientRect,
  type Collision,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DroppableContainer,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import type { MoveTaskInput } from '@/domain/types'
import { POINTER_ACTIVATION } from '@/features/projects/dnd'
import {
  findContainer,
  moveToContainer,
  resolveSubtaskDrop,
  resolveTopLevelDrop,
  type Containers,
} from './listDnd'

/** Custom `data` of the List droppables (sortable items also carry `sortable`). */
export interface ListDragData {
  type: 'task' | 'subtask' | 'group'
  containerId: string
  /** Subtasks: their parent. */
  parentId?: string
  sortable?: { containerId: UniqueIdentifier; index: number; items: UniqueIdentifier[] }
}

export type ListDragState =
  | {
      kind: 'task'
      activeId: string
      initial: Containers
      current: Containers
      /** The group the pointer is over (drop target highlight). */
      overContainer: string | null
    }
  | { kind: 'subtask'; activeId: string; parentId: string; siblings: readonly string[] }

function dataOf(entry: { data: { current?: unknown } } | null | undefined): ListDragData | undefined {
  return entry?.data.current as ListDragData | undefined
}

/**
 * Arrow keys move to the nearest item of the same kind in the same container (skipping the
 * current drop target, like dnd-kit's sortableKeyboardCoordinates), so keyboard dragging stays
 * inside its group or parent.
 */
export const listKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  if (event.code !== 'ArrowDown' && event.code !== 'ArrowUp') return undefined
  event.preventDefault()
  const { active, collisionRect, droppableRects, droppableContainers, over } = context
  const activeData = dataOf(active)
  if (!active || !collisionRect || !activeData?.sortable) return undefined
  const down = event.code === 'ArrowDown'
  const candidates: { id: UniqueIdentifier; rect: ClientRect; index: number }[] = []
  for (const entry of droppableContainers.getEnabled()) {
    const data = dataOf(entry)
    if (!data?.sortable || data.type !== activeData.type) continue
    if (data.containerId !== activeData.containerId) continue
    const rect = droppableRects.get(entry.id)
    if (!rect) continue
    if (down ? rect.top <= collisionRect.top : rect.top >= collisionRect.top) continue
    candidates.push({ id: entry.id, rect, index: data.sortable.index })
  }
  candidates.sort(
    (a, b) => Math.abs(a.rect.top - collisionRect.top) - Math.abs(b.rect.top - collisionRect.top),
  )
  let target = candidates[0]
  if (target && target.id === over?.id && candidates.length > 1) target = candidates[1]
  if (!target) return undefined
  const afterActive = target.id !== active.id && target.index > activeData.sortable.index
  return {
    x: target.rect.left,
    y: afterActive ? target.rect.top + target.rect.height - collisionRect.height : target.rect.top,
  }
}

interface UseListDndOptions {
  /** Group containers (top-level task ids per group) as currently rendered from the store. */
  containers: Containers
  /** Subtask ids of a parent, in order. */
  subtaskIds: (parentId: string) => readonly string[]
  /** Collapsed groups don't preview a dragged task; dropping on them appends. */
  isCollapsed: (containerId: string) => boolean
  onMove: (input: MoveTaskInput) => void
}

export function useListDnd({ containers, subtaskIds, isCollapsed, onMove }: UseListDndOptions) {
  const [drag, setDrag] = useState<ListDragState | null>(null)
  // The handlers read and write the latest state synchronously (pointer events can outrun renders).
  const stateRef = useRef<ListDragState | null>(null)
  const lastOverId = useRef<UniqueIdentifier | null>(null)
  const recentlyMoved = useRef(false)
  const options = useRef({ subtaskIds, isCollapsed, onMove })
  useEffect(() => {
    options.current = { subtaskIds, isCollapsed, onMove }
  })

  const commit = (next: ListDragState | null) => {
    stateRef.current = next
    setDrag(next)
  }

  const previewContainers = drag?.kind === 'task' ? drag.current : null
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      recentlyMoved.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [previewContainers])

  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const activeData = dataOf(args.active)
    if (!activeData) return closestCenter(args)
    const same = (entry: DroppableContainer) => {
      const data = dataOf(entry)
      return data?.type === activeData.type && data.containerId === activeData.containerId
    }

    // Keyboard drags (no pointer) and subtasks stay inside their container.
    if (!args.pointerCoordinates || activeData.type === 'subtask') {
      const siblings = args.droppableContainers.filter(same)
      return args.pointerCoordinates
        ? closestCenter({ ...args, droppableContainers: siblings })
        : rectIntersection({ ...args, droppableContainers: siblings })
    }

    // Top-level task under the pointer: rows first, then a group (→ its nearest row, if shown).
    const allowed = args.droppableContainers.filter((entry) => {
      const type = dataOf(entry)?.type
      return type === 'task' || type === 'group'
    })
    const scoped = { ...args, droppableContainers: allowed }
    const hits = pointerWithin(scoped)
    const pool: Collision[] = hits.length > 0 ? hits : rectIntersection(scoped)
    const typeOf = (id: UniqueIdentifier) => dataOf(allowed.find((entry) => entry.id === id))?.type
    const rowHit = pool.find((hit) => typeOf(hit.id) === 'task')
    let result: Collision[] = []
    if (rowHit) {
      result = [rowHit]
    } else if (pool.length > 0) {
      const groupId = pool[0].id
      const rows = allowed.filter((entry) => {
        const data = dataOf(entry)
        return data?.type === 'task' && data.containerId === groupId
      })
      result = rows.length > 0 ? closestCenter({ ...args, droppableContainers: rows }) : [pool[0]]
    }
    if (result.length > 0) {
      lastOverId.current = result[0].id
      return result
    }
    // Layout shifted after a container change: keep the dragged item as its own target.
    if (recentlyMoved.current) lastOverId.current = args.active.id
    return lastOverId.current !== null ? [{ id: lastOverId.current }] : []
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: POINTER_ACTIVATION }),
    useSensor(KeyboardSensor, { coordinateGetter: listKeyboardCoordinates }),
  )

  const onDragStart = ({ active }: DragStartEvent) => {
    const data = dataOf(active)
    const activeId = String(active.id)
    lastOverId.current = active.id
    if (data?.type === 'subtask' && data.parentId) {
      commit({
        kind: 'subtask',
        activeId,
        parentId: data.parentId,
        siblings: options.current.subtaskIds(data.parentId),
      })
    } else {
      const containerId = findContainer(containers, activeId)
      commit({
        kind: 'task',
        activeId,
        initial: containers,
        current: containers,
        overContainer: containerId,
      })
    }
  }

  const onDragOver = ({ active, over }: DragOverEvent) => {
    const state = stateRef.current
    if (!state || state.kind !== 'task') return
    const overId = over ? String(over.id) : null
    const from = findContainer(state.current, state.activeId)
    const to = findContainer(state.current, overId)
    if (to !== state.overContainer) {
      commit({ ...state, overContainer: to })
    }
    if (!over || !overId || !from || !to || from === to || options.current.isCollapsed(to)) return
    const overIsGroup = overId === to
    const dragged = active.rect.current.translated
    const placeAfter =
      !overIsGroup &&
      dragged !== null &&
      dragged.top + dragged.height / 2 > over.rect.top + over.rect.height / 2
    recentlyMoved.current = true
    commit({
      ...state,
      overContainer: to,
      current: moveToContainer(state.current, state.activeId, to, overIsGroup ? null : overId, placeAfter),
    })
  }

  const onDragEnd = ({ over }: DragEndEvent) => {
    const state = stateRef.current
    commit(null)
    lastOverId.current = null
    if (!state) return
    const overId = over ? String(over.id) : null
    const input =
      state.kind === 'task'
        ? resolveTopLevelDrop({
            taskId: state.activeId,
            initial: state.initial,
            current: state.current,
            overId,
          })
        : resolveSubtaskDrop({ taskId: state.activeId, siblings: state.siblings, overId })
    if (input) options.current.onMove(input)
  }

  const onDragCancel = () => {
    commit(null)
    lastOverId.current = null
  }

  return {
    drag,
    /** Containers to render (the drag preview while a top-level task is dragged). */
    containers: previewContainers ?? containers,
    sensors,
    collisionDetection,
    handlers: { onDragStart, onDragOver, onDragEnd, onDragCancel },
  }
}
