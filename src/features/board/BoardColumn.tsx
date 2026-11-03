import { memo, useCallback, useId, useMemo, useRef } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Plus } from 'lucide-react'
import { StatusIcon } from '@/components/task/StatusIcon'
import { STATUS_LABELS } from '@/components/task/labels'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import type { ISODate, Result, TaskStatus } from '@/domain/types'
import { cn } from '@/lib/utils'
import { AddTaskComposer } from './AddTaskComposer'
import { SortableBoardCard } from './BoardCard'
import { columnDroppableId, type BoardCard, type ColumnStep } from './boardModel'

export interface BoardColumnProps {
  status: TaskStatus
  /** Cards in display order (during a drag: the drag preview order). */
  cards: readonly BoardCard[]
  /** The dragged card is currently in this column. */
  isDropTarget: boolean
  /** Text shown when the column has no cards. */
  emptyText: string
  showPhase: boolean
  today: ISODate
  onOpen: (taskId: string) => void
  onStatusChange: (taskId: string, status: TaskStatus) => void
  onStep: (taskId: string, step: ColumnStep) => void
  onCreate: (status: TaskStatus, title: string) => Promise<Result<unknown>>
  /** Header "+": the full Task Modal pre-set to this column. */
  onNewTask: (status: TaskStatus) => void
}

/** Drop target: the hover tint layered over the column surface (design §5.5). */
const dropTint = 'bg-[image:linear-gradient(var(--bg-hover),var(--bg-hover))]'

/**
 * One fixed column: header (status glyph, name, count, "+"), the sortable card list in its own
 * vertical scroll, and the inline "+ Add task" composer right after the last card.
 */
export const BoardColumn = memo(function BoardColumn({
  status,
  cards,
  isDropTarget,
  emptyText,
  showPhase,
  today,
  onOpen,
  onStatusChange,
  onStep,
  onCreate,
  onNewTask,
}: BoardColumnProps) {
  const label = STATUS_LABELS[status]
  const headingId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const { setNodeRef } = useDroppable({
    id: columnDroppableId(status),
    data: { type: 'column', status },
  })
  const ids = useMemo(() => cards.map((card) => card.task.id), [cards])

  const create = useCallback((title: string) => onCreate(status, title), [onCreate, status])
  const revealNewCard = useCallback(() => {
    // The optimistic card is rendered by the next frame; bring the end of the list into view.
    requestAnimationFrame(() => {
      const scroller = scrollRef.current
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    })
  }, [])

  return (
    <section
      aria-labelledby={headingId}
      data-column={status}
      className={cn('flex min-h-0 min-w-0 flex-col rounded-lg bg-muted', isDropTarget && dropTint)}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3">
        <StatusIcon status={status} decorative />
        <h2
          id={headingId}
          className="flex min-w-0 items-baseline gap-2 text-ui font-semibold text-fg"
        >
          {/* Explicit spaces: the heading names the region "To Do 3 tasks". */}
          <span className="truncate">{label}</span>{' '}
          <span className="text-meta font-normal text-fg-tertiary tabular-nums">
            {cards.length} <span className="sr-only">{cards.length === 1 ? 'task' : 'tasks'}</span>
          </span>
        </h2>
        <Tooltip content={`New task in ${label}…`}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label={`New task in ${label}`}
            aria-haspopup="dialog"
            onClick={() => onNewTask(status)}
          >
            <Plus />
          </Button>
        </Tooltip>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto rounded-b-lg">
        {/* The droppable fills the scroller (empty columns and the space below the last card
            accept drops; being inside the scroller lets dnd-kit auto-scroll it). */}
        <div ref={setNodeRef} className="flex min-h-full flex-col px-2">
          <SortableContext id={status} items={ids} strategy={verticalListSortingStrategy}>
            <ul role="list" className="flex flex-col gap-2 pt-0.5">
              {cards.map((card, index) => (
                <SortableBoardCard
                  key={card.task.id}
                  task={card.task}
                  phase={card.phase}
                  subtasksDone={card.subtasks.done}
                  subtasksTotal={card.subtasks.total}
                  showPhase={showPhase}
                  today={today}
                  isFirst={index === 0}
                  isLast={index === cards.length - 1}
                  onOpen={onOpen}
                  onStatusChange={onStatusChange}
                  onStep={onStep}
                />
              ))}
              {cards.length === 0 ? (
                <li
                  aria-hidden
                  className="flex h-20 shrink-0 items-center justify-center rounded-lg border border-dashed border-default px-3 text-center text-meta text-fg-tertiary"
                >
                  {emptyText}
                </li>
              ) : null}
            </ul>
          </SortableContext>
          {/* Follows the last card; sticks to the bottom once the column overflows. */}
          <div
            className={cn(
              'sticky bottom-0 z-[1] -mx-2 bg-muted px-2 pt-1.5 pb-2',
              isDropTarget && dropTint,
            )}
          >
            <AddTaskComposer columnLabel={label} onCreate={create} onCreated={revealNewCard} />
          </div>
        </div>
      </div>
    </section>
  )
})
