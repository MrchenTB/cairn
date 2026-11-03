import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  getFirstCollision,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
  type KeyboardCoordinateGetter,
  type ScreenReaderInstructions,
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { STATUS_LABELS } from '@/components/task/labels'
import { useUIStore } from '@/app/uiStore'
import { useOpenTask } from '@/app/taskModalRoute'
import { useActions } from '@/data/hooks'
import type { ISODate, MoveTaskInput, TaskStatus } from '@/domain/types'
import { notify } from '@/lib/notify'
import { BoardCardOverlay } from './BoardCard'
import { BoardColumn } from './BoardColumn'
import {
  BOARD_COLUMNS,
  findColumn,
  keyboardTarget,
  moveCardInColumns,
  moveForBoardDrop,
  parseColumnDroppableId,
  phaseIdForNewTask,
  positionIn,
  stepDrop,
  toColumnIds,
  type BoardCard,
  type BoardColumnIds,
  type BoardDirection,
  type BoardModel,
  type ColumnStep,
} from './boardModel'
import { usePrefersReducedMotion } from './useReducedMotion'

const KEY_DIRECTIONS: Record<string, BoardDirection> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

/** Space picks a card up (Enter opens it); Space/Enter drop; Esc or Tab cancel. */
const KEYBOARD_CODES = { start: ['Space'], end: ['Space', 'Enter'], cancel: ['Escape', 'Tab'] }

/** A click (no movement) opens the task; 5 px of movement starts a drag. */
const POINTER_OPTIONS = { activationConstraint: { distance: 5 } }

const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    'Press Enter to open the task. To move it, press Space, use the arrow keys to move it up or down, or to another column, then press Space to drop it. Press Escape to cancel.',
}

/** Overlay settles onto the card's new place (≤ 200 ms, design §3.7); off with reduced motion. */
const DROP_ANIMATION: DropAnimation = {
  duration: 160,
  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } }),
}

const MEASURING = { droppable: { strategy: MeasuringStrategy.Always } }

export interface BoardProps {
  projectId: string
  model: BoardModel
  /** Resolved phase filter (new tasks join the filtered phase). */
  phaseFilter: string
  /** Show the phase chip on cards (false when the board is filtered to one phase). */
  showPhase: boolean
  today: ISODate
}

/**
 * The three-column board with dnd-kit multi-container sorting (pointer + keyboard sensors,
 * DragOverlay, auto-scroll). While dragging, a local copy of the column ids follows the pointer
 * across columns; on drop ONE `moveTask` is sent — the store applies it optimistically in the
 * same tick, so the card never jumps back, and rolls it back (with a Retry toast) on failure.
 */
export function Board({ projectId, model, phaseFilter, showPhase, today }: BoardProps) {
  const actions = useActions()
  const openTask = useOpenTask()
  const reducedMotion = usePrefersReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)

  const baseColumns = useMemo(() => toColumnIds(model.columns), [model])
  const cardsById = useMemo(() => {
    const map = new Map<string, BoardCard>()
    for (const status of BOARD_COLUMNS)
      for (const card of model.columns[status]) map.set(card.task.id, card)
    return map
  }, [model])

  const [dragColumns, setDragColumns] = useState<BoardColumnIds | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const dragRef = useRef<BoardColumnIds | null>(null)
  const lastOverId = useRef<string | null>(null)
  const movedToNewColumn = useRef(false)
  const lastDrop = useRef<{ column: TaskStatus; position: number; count: number } | null>(null)

  // Latest values for the drag handlers / sensors (they outlive a render).
  const latest = useRef({ baseColumns, model, cardsById, openTask })
  useLayoutEffect(() => {
    latest.current = { baseColumns, model, cardsById, openTask }
  })

  const currentColumns = useCallback(
    (): BoardColumnIds => dragRef.current ?? latest.current.baseColumns,
    [],
  )
  const setDrag = useCallback((next: BoardColumnIds | null) => {
    dragRef.current = next
    setDragColumns(next)
  }, [])

  useEffect(() => {
    // After a card switched columns the layout shifts for a frame; see collisionDetection.
    const frame = requestAnimationFrame(() => {
      movedToNewColumn.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [dragColumns])

  // -- actions -----------------------------------------------------------------------------

  const focusCard = useCallback((taskId: string) => {
    const focused = document.activeElement
    if (focused && focused !== document.body) return // focus is somewhere meaningful: keep it
    const activators = rootRef.current?.querySelectorAll<HTMLElement>('[data-card-activator]') ?? []
    for (const element of activators) {
      if (element.dataset.cardActivator === taskId) {
        element.focus()
        return
      }
    }
  }, [])

  const commitMove = useCallback(
    async (move: MoveTaskInput) => {
      const result = await actions.moveTask(move)
      // Remote failures were rolled back and toasted (with Retry) by the store.
      if (!result.ok && result.error.kind === 'validation') {
        notify.error("Couldn't move task", { description: result.error.message })
      }
    },
    [actions],
  )

  const onOpen = useCallback((taskId: string) => latest.current.openTask(taskId), [])

  const onStatusChange = useCallback(
    (taskId: string, status: TaskStatus) => {
      // A status change moves the card to another column (a new element): keep keyboard focus on it.
      const pending = actions.updateTask(taskId, { status })
      requestAnimationFrame(() => focusCard(taskId))
      void pending.then((result) => {
        if (result.ok) return
        if (result.error.kind === 'validation') {
          notify.error("Couldn't change status", { description: result.error.message })
        }
        requestAnimationFrame(() => focusCard(taskId))
      })
    },
    [actions, focusCard],
  )

  const onStep = useCallback(
    (taskId: string, step: ColumnStep) => {
      const { baseColumns: columns, model: current } = latest.current
      const drop = stepDrop(columns, taskId, step)
      const move = drop ? moveForBoardDrop(drop, columns, current.projectOrder) : null
      if (move) void commitMove(move)
    },
    [commitMove],
  )

  const onCreate = useCallback(
    (status: TaskStatus, title: string) =>
      actions.createTask({
        projectId,
        title,
        status,
        phaseId: phaseIdForNewTask(phaseFilter),
        // The end of the project order is the end of this column (and of the List group).
        placement: { beforeId: null },
      }),
    [actions, projectId, phaseFilter],
  )

  const onNewTask = useCallback(
    (status: TaskStatus) =>
      useUIStore
        .getState()
        .openNewTask({ projectId, status, phaseId: phaseIdForNewTask(phaseFilter) }),
    [projectId, phaseFilter],
  )

  // -- drag and drop -----------------------------------------------------------------------

  const coordinateGetter = useCallback<KeyboardCoordinateGetter>(
    (event, { context: { active, over, collisionRect, droppableRects } }) => {
      const direction = KEY_DIRECTIONS[event.code]
      if (!direction) return undefined
      event.preventDefault()
      if (!active || !collisionRect) return undefined
      const activeKey = String(active.id)
      const targetId = keyboardTarget(
        currentColumns(),
        activeKey,
        String(over?.id ?? activeKey),
        direction,
        collisionRect.top + collisionRect.height / 2,
        (id) => droppableRects.get(id) ?? null,
      )
      const rect = targetId ? droppableRects.get(targetId) : undefined
      if (!rect) return undefined
      return { x: rect.left, y: rect.top }
    },
    [currentColumns],
  )

  const keyboardOptions = useMemo(
    () => ({ coordinateGetter, keyboardCodes: KEYBOARD_CODES }),
    [coordinateGetter],
  )
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_OPTIONS),
    useSensor(KeyboardSensor, keyboardOptions),
  )

  /**
   * Pointer first (what is under the cursor), else rectangle overlap (keyboard). A column hit is
   * narrowed to its closest card so the drop index follows the pointer; an empty column stays a
   * valid target. When nothing matches (layout shifting after a column switch) the last target
   * is kept, which prevents flicker between columns.
   */
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const pointerHits = pointerWithin(args)
      const hits = pointerHits.length > 0 ? pointerHits : rectIntersection(args)
      let overId = getFirstCollision(hits, 'id')
      if (overId != null) {
        const column = parseColumnDroppableId(overId)
        if (column) {
          const ids = currentColumns()[column]
          if (ids.length > 0) {
            const closest = closestCenter({
              ...args,
              droppableContainers: args.droppableContainers.filter((container) =>
                ids.includes(String(container.id)),
              ),
            })
            overId = closest[0]?.id ?? overId
          }
        }
        lastOverId.current = String(overId)
        return [{ id: overId }]
      }
      if (movedToNewColumn.current) lastOverId.current = String(args.active.id)
      return lastOverId.current ? [{ id: lastOverId.current }] : []
    },
    [currentColumns],
  )

  const resetDrag = useCallback(() => {
    setDrag(null)
    setActiveId(null)
    lastOverId.current = null
    movedToNewColumn.current = false
  }, [setDrag])

  const onDragStart = useCallback(
    ({ active }: DragStartEvent) => {
      lastDrop.current = null
      setDrag(latest.current.baseColumns)
      setActiveId(String(active.id))
    },
    [setDrag],
  )

  const onDragOver = useCallback(
    ({ active, over }: DragOverEvent) => {
      const columns = dragRef.current
      if (!over || !columns) return
      const activeKey = String(active.id)
      const overKey = String(over.id)
      const from = findColumn(columns, activeKey)
      const to = findColumn(columns, overKey)
      // Same column: the sortable strategy previews the reorder with transforms.
      if (!from || !to || from === to) return
      const target = columns[to]
      let index = target.length
      if (!parseColumnDroppableId(overKey)) {
        const overIndex = target.indexOf(overKey)
        const dragged = active.rect.current.translated
        const below = dragged ? dragged.top > over.rect.top + over.rect.height / 2 : false
        if (overIndex >= 0) index = overIndex + (below ? 1 : 0)
      }
      movedToNewColumn.current = true
      setDrag(moveCardInColumns(columns, activeKey, to, index))
    },
    [setDrag],
  )

  const onDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      const columns = dragRef.current
      const activeKey = String(active.id)
      let move: MoveTaskInput | null = null
      if (over && columns) {
        const overKey = String(over.id)
        let final = columns
        const from = findColumn(final, activeKey)
        const to = findColumn(final, overKey)
        if (from && to && from !== to) {
          // Dropped before a drag-over could move the card (very fast drops).
          const index = parseColumnDroppableId(overKey)
            ? final[to].length
            : final[to].indexOf(overKey)
          final = moveCardInColumns(final, activeKey, to, index < 0 ? final[to].length : index)
        } else if (from && to) {
          const ids = final[to]
          const fromIndex = ids.indexOf(activeKey)
          const toIndex = parseColumnDroppableId(overKey) ? ids.length - 1 : ids.indexOf(overKey)
          if (toIndex >= 0 && toIndex !== fromIndex) {
            final = { ...final, [to]: arrayMove(ids, fromIndex, toIndex) }
          }
        }
        const column = to ?? from
        if (column) {
          const overIndex = final[column].indexOf(activeKey)
          lastDrop.current = { column, position: overIndex + 1, count: final[column].length }
          // Neighbours come from what the user saw; "same column?" from the current status.
          move = moveForBoardDrop(
            { activeId: activeKey, overColumn: column, overIndex },
            latest.current.baseColumns,
            latest.current.model.projectOrder,
          )
        }
      }
      // Optimistic store update first, then drop the drag preview: both land in one render.
      if (move) void commitMove(move)
      resetDrag()
    },
    [commitMove, resetDrag],
  )

  const titleOf = useCallback((id: unknown) => {
    const title = latest.current.cardsById.get(String(id))?.task.title
    return title ? `“${title}”` : 'The task'
  }, [])

  const announcements = useMemo<Announcements>(() => {
    const where = (id: string) => {
      const position = positionIn(currentColumns(), id)
      return position
        ? `${STATUS_LABELS[position.column]}, position ${position.position} of ${position.count}`
        : null
    }
    return {
      onDragStart: ({ active }) => {
        const place = where(String(active.id))
        return `Picked up ${titleOf(active.id)}.${place ? ` ${place}.` : ''}`
      },
      onDragOver: ({ active, over }) => {
        if (!over) return `${titleOf(active.id)} is no longer over a column.`
        const column = findColumn(currentColumns(), String(over.id))
        const ids = column ? currentColumns()[column] : []
        const overKey = String(over.id)
        const inColumn = ids.includes(String(active.id))
        const index = parseColumnDroppableId(overKey) ? ids.length : ids.indexOf(overKey)
        if (!column || index < 0) return undefined
        const count = inColumn ? ids.length : ids.length + 1
        const position = Math.min(index + 1, count)
        return `${titleOf(active.id)} is over ${STATUS_LABELS[column]}, position ${position} of ${count}.`
      },
      onDragEnd: ({ active }) => {
        const drop = lastDrop.current
        return drop
          ? `${titleOf(active.id)} dropped in ${STATUS_LABELS[drop.column]}, position ${drop.position} of ${drop.count}.`
          : `${titleOf(active.id)} dropped. Nothing changed.`
      },
      onDragCancel: ({ active }) => {
        const place = where(String(active.id))
        return `Moving ${titleOf(active.id)} was cancelled.${place ? ` It stays in ${place}.` : ''}`
      },
    }
  }, [currentColumns, titleOf])

  // -- render ------------------------------------------------------------------------------

  const shown = dragColumns ?? baseColumns
  const columnCards = useMemo(() => {
    const result = {} as Record<TaskStatus, BoardCard[]>
    for (const status of BOARD_COLUMNS) {
      result[status] = shown[status].flatMap((id) => {
        const card = cardsById.get(id)
        return card ? [card] : []
      })
    }
    return result
  }, [shown, cardsById])
  const activeCard = activeId ? cardsById.get(activeId) : undefined
  const projectEmpty = model.totalTasks === 0

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      measuring={MEASURING}
      accessibility={{ announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={resetDrag}
    >
      <div ref={rootRef} className="min-h-0 flex-1 overflow-x-auto px-6 pt-2 pb-4">
        <div className="grid h-full min-h-72 grid-cols-[repeat(3,minmax(280px,440px))] gap-3">
          {BOARD_COLUMNS.map((status) => (
            <BoardColumn
              key={status}
              status={status}
              cards={columnCards[status]}
              isDropTarget={activeId !== null && shown[status].includes(activeId)}
              emptyText={projectEmpty && status === 'todo' ? 'No tasks yet' : 'No tasks'}
              showPhase={showPhase}
              today={today}
              onOpen={onOpen}
              onStatusChange={onStatusChange}
              onStep={onStep}
              onCreate={onCreate}
              onNewTask={onNewTask}
            />
          ))}
        </div>
      </div>
      {createPortal(
        <DragOverlay dropAnimation={reducedMotion ? null : DROP_ANIMATION}>
          {activeCard ? (
            <BoardCardOverlay
              task={activeCard.task}
              phase={activeCard.phase}
              subtasksDone={activeCard.subtasks.done}
              subtasksTotal={activeCard.subtasks.total}
              showPhase={showPhase}
            />
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  )
}
