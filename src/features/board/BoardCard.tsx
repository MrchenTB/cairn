import { memo, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Ellipsis,
  ListTree,
  SquareArrowOutUpRight,
} from 'lucide-react'
import { DueLabel } from '@/components/task/DueLabel'
import { PriorityIcon } from '@/components/task/PriorityIcon'
import { StatusIcon } from '@/components/task/StatusIcon'
import { StatusMenu } from '@/components/task/StatusMenu'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { insetFocus } from '@/components/ui/styles'
import { Tooltip } from '@/components/ui/tooltip'
import type { ISODate, Phase, Task, TaskStatus } from '@/domain/types'
import { cn } from '@/lib/utils'
import { describeCard, type ColumnStep } from './boardModel'

/** Card surface shared by the sortable card and the drag overlay (design §5.5). */
const cardSurface = 'relative rounded-lg border border-default bg-surface px-3 py-2.5 select-none'

/** Sortable transition: within the 120–200 ms motion budget, on the "move" easing token. */
const SORTABLE_TRANSITION = { duration: 160, easing: 'var(--ease-move)' }

interface CardContentProps {
  task: Task
  phase: Phase | null
  subtasksDone: number
  subtasksTotal: number
  showPhase: boolean
  /** Leading status control (menu trigger on the board, plain glyph in the overlay). */
  status: ReactNode
  /** Top-right actions (⋯ menu); omitted in the overlay. */
  actions?: ReactNode
  /** Keeps the layout but hides the content (the drag placeholder). */
  hidden?: boolean
}

/**
 * Visual card content: status + title (2-line clamp), then the meta row — priority (hidden when
 * none), due date, subtask summary "2/5", phase chip. Pointer events pass through to the card's
 * activator except on the controls. Title and meta are aria-hidden: the activator carries the
 * title as its name and the meta as a sentence (see `describeCard`).
 */
function CardContent({
  task,
  phase,
  subtasksDone,
  subtasksTotal,
  showPhase,
  status,
  actions,
  hidden = false,
}: CardContentProps) {
  const chip = showPhase ? phase : null
  const hasMeta = task.priority !== 'none' || task.dueDate !== null || subtasksTotal > 0 || chip
  return (
    <div className={cn('pointer-events-none relative', hidden && 'invisible')}>
      <div className="flex items-start gap-1.5">
        <div className="pointer-events-auto -my-0.5 -ml-1 flex shrink-0">{status}</div>
        {/* pr-5 keeps the title clear of the ⋯ button (also in the overlay, so sizes match). */}
        <p
          aria-hidden
          className="line-clamp-2 min-w-0 flex-1 pr-5 text-ui font-medium break-words text-fg"
        >
          {task.title}
        </p>
      </div>
      {hasMeta ? (
        <div
          aria-hidden
          className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-meta text-fg-tertiary"
        >
          {task.priority !== 'none' ? (
            <PriorityIcon priority={task.priority} size={14} decorative />
          ) : null}
          <DueLabel dueDate={task.dueDate} status={task.status} />
          {subtasksTotal > 0 ? (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <ListTree className="size-3.5 shrink-0" strokeWidth={1.5} />
              {subtasksDone}/{subtasksTotal}
            </span>
          ) : null}
          {chip ? (
            <span className="inline-flex h-5 max-w-40 min-w-0 items-center rounded-full border border-default px-1.5">
              <span className="truncate">{chip.name}</span>
            </span>
          ) : null}
        </div>
      ) : null}
      {actions ? (
        <div className="pointer-events-auto absolute -top-1 -right-1.5">{actions}</div>
      ) : null}
    </div>
  )
}

interface CardMenuProps {
  title: string
  canMoveUp: boolean
  canMoveDown: boolean
  onOpen: () => void
  onStep: (step: ColumnStep) => void
}

/** ⋯ menu: open the task, or reorder it in its column without dragging (WCAG 2.5.7). */
function CardMenu({ title, canMoveUp, canMoveDown, onOpen, onStep }: CardMenuProps) {
  // Opening the Task Modal moves focus into the dialog; don't pull it back to this trigger.
  const opening = useRef(false)
  return (
    <DropdownMenu>
      <Tooltip content="More actions">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`More actions for ${title}`}
            className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="w-52"
        onCloseAutoFocus={(event) => {
          if (opening.current) event.preventDefault()
          opening.current = false
        }}
      >
        <DropdownMenuItem
          onSelect={() => {
            opening.current = true
            onOpen()
          }}
        >
          <SquareArrowOutUpRight />
          Open task
          <DropdownMenuShortcut aria-hidden>↵</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Move in column</DropdownMenuLabel>
        <DropdownMenuItem disabled={!canMoveUp} onSelect={() => onStep('top')}>
          <ArrowUpToLine />
          Move to top
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canMoveUp} onSelect={() => onStep('up')}>
          <ArrowUp />
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canMoveDown} onSelect={() => onStep('down')}>
          <ArrowDown />
          Move down
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canMoveDown} onSelect={() => onStep('bottom')}>
          <ArrowDownToLine />
          Move to bottom
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export interface SortableBoardCardProps {
  task: Task
  phase: Phase | null
  subtasksDone: number
  subtasksTotal: number
  showPhase: boolean
  today: ISODate
  isFirst: boolean
  isLast: boolean
  onOpen: (taskId: string) => void
  onStatusChange: (taskId: string, status: TaskStatus) => void
  onStep: (taskId: string, step: ColumnStep) => void
}

/**
 * A draggable board card. The whole card is one activator (`role="button"`): click or Enter opens
 * the Task Modal, Space picks it up for keyboard dragging, a pointer drag moves it. The status
 * menu and the ⋯ menu sit above the activator as sibling controls (no nested interactive
 * elements) and never start a drag.
 */
export const SortableBoardCard = memo(function SortableBoardCard({
  task,
  phase,
  subtasksDone,
  subtasksTotal,
  showPhase,
  today,
  isFirst,
  isLast,
  onOpen,
  onStatusChange,
  onStep,
}: SortableBoardCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { type: 'card' },
    attributes: { roleDescription: 'draggable task' },
    transition: SORTABLE_TRANSITION,
  })
  const descriptionId = useId()
  const description = describeCard(
    { task, phase, subtasks: { done: subtasksDone, total: subtasksTotal } },
    today,
    { showPhase },
  )

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    listeners?.onKeyDown?.(event)
    if (event.defaultPrevented || isDragging || event.target !== event.currentTarget) return
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      onOpen(task.id)
    }
  }

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-task-id={task.id}
      className={cn(
        cardSurface,
        'group',
        isDragging
          ? 'border-dashed border-accent/50 bg-selected'
          : 'transition-[border-color,box-shadow] duration-fast hover:border-strong hover:shadow-panel hover:duration-instant',
      )}
    >
      <div
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        onKeyDown={onKeyDown}
        onClick={() => onOpen(task.id)}
        data-card-activator={task.id}
        aria-label={task.title}
        aria-describedby={[description ? descriptionId : null, attributes['aria-describedby']]
          .filter(Boolean)
          .join(' ')}
        // Base :focus-visible ring, drawn inside the card edge (columns clip overflow).
        className={cn('absolute -inset-px rounded-lg', insetFocus)}
      />
      <CardContent
        task={task}
        phase={phase}
        subtasksDone={subtasksDone}
        subtasksTotal={subtasksTotal}
        showPhase={showPhase}
        hidden={isDragging}
        status={
          <StatusMenu value={task.status} onChange={(status) => onStatusChange(task.id, status)} />
        }
        actions={
          <CardMenu
            title={task.title}
            canMoveUp={!isFirst}
            canMoveDown={!isLast}
            onOpen={() => onOpen(task.id)}
            onStep={(step) => onStep(task.id, step)}
          />
        }
      />
      {description ? (
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
      ) : null}
    </li>
  )
})

export interface BoardCardOverlayProps {
  task: Task
  phase: Phase | null
  subtasksDone: number
  subtasksTotal: number
  showPhase: boolean
}

/** The card as it follows the pointer: lifted (drag shadow, 1.02 scale), never rotated. */
export function BoardCardOverlay(props: BoardCardOverlayProps) {
  return (
    <div className={cn(cardSurface, 'scale-[1.02] cursor-grabbing bg-elevated shadow-drag')}>
      <CardContent
        {...props}
        status={
          <span className="flex size-6 items-center justify-center">
            <StatusIcon status={props.task.status} decorative />
          </span>
        }
      />
    </div>
  )
}
