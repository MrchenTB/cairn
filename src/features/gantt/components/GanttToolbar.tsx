/**
 * Gantt controls rendered into the project view bar (via <ViewBarActions>): conflicts chip
 * (hidden at zero), the "Unscheduled n" filter toggle (shown while n > 0 or while it is on, so it
 * can always be turned off), dependency mode (Manual / Auto), Today (T) and Day / Week / Month. Memoised: the chart re-renders on every virtual-row change while
 * scrolling, the toolbar only when its own props change (callbacks must be stable).
 */
import { memo, useState, type Ref } from 'react'
import { ArrowRight, CalendarOff, ChevronDown, TriangleAlert, Workflow } from 'lucide-react'
import type { GanttScale } from '@/app/viewPrefs'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { insetFocus } from '@/components/ui/styles'
import { Tooltip } from '@/components/ui/tooltip'
import { formatDateSmart } from '@/domain/dates'
import type { DependencyConflict } from '@/domain/scheduling'
import type { ISODate, ScheduleMode, Task } from '@/domain/types'
import { cn } from '@/lib/utils'
import { SCALES } from '../model/scale'

const SCALE_OPTIONS = (['day', 'week', 'month'] as const).map((value) => ({
  value,
  label: SCALES[value].label,
}))

const MODE_LABELS: Record<ScheduleMode, string> = { manual: 'Manual', auto: 'Auto' }

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/*
 * The view bar (PageHeader, a `@container/viewbar`) holds the project tabs on the left and these
 * controls on the right; together they need ~830px. Narrower than that the conflicts chip,
 * Unscheduled and the mode menu keep their icon (and count) and lose their words — still read by
 * screen readers, so every control keeps its name.
 */
const compactOnly = '@max-[840px]/viewbar:sr-only'

export interface GanttToolbarProps {
  scale: GanttScale
  onScaleChange: (scale: GanttScale) => void
  onToday: () => void
  scheduleMode: ScheduleMode
  onScheduleModeChange: (mode: ScheduleMode) => void
  conflicts: readonly DependencyConflict[]
  tasksById: Record<string, Task>
  today: ISODate
  onOpenConflict: (successorId: string) => void
  onResolveAll: () => void
  /** Tasks (any level) without dates in the whole project. */
  unscheduledCount: number
  /** Filter mode: the chart lists only the tasks without dates. */
  unscheduledOnly: boolean
  onUnscheduledOnlyChange: (on: boolean) => void
  /** The chart hands keyboard focus back here when a focused row leaves the filtered list. */
  unscheduledToggleRef: Ref<HTMLButtonElement>
}

export const GanttToolbar = memo(function GanttToolbar(props: GanttToolbarProps) {
  return (
    <>
      <ConflictsChip {...props} />
      {props.unscheduledCount > 0 || props.unscheduledOnly ? (
        <Tooltip
          content={props.unscheduledOnly ? 'Show all tasks' : 'Show only tasks without dates'}
        >
          <Button
            ref={props.unscheduledToggleRef}
            variant="ghost"
            size="sm"
            aria-pressed={props.unscheduledOnly}
            aria-label={`Show only unscheduled tasks, ${props.unscheduledCount}`}
            className={cn(props.unscheduledOnly && 'bg-active text-fg')}
            onClick={() => props.onUnscheduledOnlyChange(!props.unscheduledOnly)}
          >
            <CalendarOff aria-hidden />
            <span className={compactOnly}>Unscheduled</span>{' '}
            <span className="text-fg-tertiary tabular-nums">{props.unscheduledCount}</span>
          </Button>
        </Tooltip>
      ) : null}
      <ScheduleModeMenu mode={props.scheduleMode} onChange={props.onScheduleModeChange} />
      <Tooltip content="Scroll to today" shortcut="t">
        <Button variant="ghost" size="sm" onClick={props.onToday}>
          Today
        </Button>
      </Tooltip>
      <SegmentedControl
        aria-label="Timeline scale"
        value={props.scale}
        onValueChange={props.onScaleChange}
        options={SCALE_OPTIONS}
      />
    </>
  )
})

function ConflictsChip({
  conflicts,
  tasksById,
  today,
  scheduleMode,
  onOpenConflict,
  onResolveAll,
}: GanttToolbarProps) {
  const [open, setOpen] = useState(false)
  if (conflicts.length === 0) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          title={plural(conflicts.length, 'dependency conflict')}
          className="text-danger hover:bg-danger-subtle hover:text-danger data-[state=open]:bg-danger-subtle data-[state=open]:text-danger"
        >
          <TriangleAlert aria-hidden />
          <span className="tabular-nums">{conflicts.length}</span>{' '}
          <span className={compactOnly}>{conflicts.length === 1 ? 'conflict' : 'conflicts'}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-0">
        {/* A child component: the list is only built while the popover is open. */}
        <ConflictList
          conflicts={conflicts}
          tasksById={tasksById}
          today={today}
          scheduleMode={scheduleMode}
          onOpenConflict={(successorId) => {
            setOpen(false)
            onOpenConflict(successorId)
          }}
          onResolveAll={() => {
            setOpen(false)
            onResolveAll()
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function ConflictList({
  conflicts,
  tasksById,
  today,
  scheduleMode,
  onOpenConflict,
  onResolveAll,
}: Pick<GanttToolbarProps, 'conflicts' | 'tasksById' | 'today' | 'scheduleMode'> & {
  onOpenConflict: (successorId: string) => void
  onResolveAll: () => void
}) {
  const title = (taskId: string) =>
    Object.hasOwn(tasksById, taskId) ? tasksById[taskId].title : 'Task'
  return (
    <>
      <div className="px-3 pt-3 pb-2">
        <p className="text-ui font-semibold text-fg">Dependency conflicts</p>
        <p className="mt-0.5 text-meta text-fg-secondary">
          These tasks start before a task they depend on has finished.
        </p>
      </div>
      <ul className="max-h-72 overflow-y-auto px-1 pb-1" aria-label="Conflicts">
        {conflicts.map((conflict) => (
          <li key={conflict.dependencyId}>
            <button
              type="button"
              onClick={() => onOpenConflict(conflict.successorId)}
              className={cn(
                'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover',
                insetFocus,
              )}
            >
              {/* Two lines, each with the full width: side by side both names were cut to ~20 characters. */}
              <span className="flex w-full min-w-0 flex-col text-ui text-fg">
                <span className="truncate text-fg-secondary">{title(conflict.predecessorId)}</span>
                <span className="sr-only">has to finish before</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <ArrowRight className="size-3 shrink-0 text-fg-tertiary" aria-hidden />
                  <span className="truncate font-medium">{title(conflict.successorId)}</span>
                </span>
              </span>
              <span className="text-meta text-fg-tertiary tabular-nums">
                Needs to start {formatDateSmart(conflict.requiredStart, today)} or later · starts{' '}
                {formatDateSmart(conflict.actualStart, today)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-3 border-t border-subtle px-3 py-2">
        <span className="text-meta text-fg-tertiary">
          {scheduleMode === 'manual'
            ? 'Manual mode never moves tasks on its own.'
            : 'Auto mode moves successors when you edit.'}
        </span>
        <Button size="xs" variant="secondary" onClick={onResolveAll}>
          Resolve all…
        </Button>
      </div>
    </>
  )
}

function ScheduleModeMenu({
  mode,
  onChange,
}: {
  mode: ScheduleMode
  onChange: (mode: ScheduleMode) => void
}) {
  return (
    <DropdownMenu>
      <Tooltip content="How dependency conflicts are handled">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={`Dependencies: ${MODE_LABELS[mode]}`}>
            <Workflow aria-hidden />
            <span className="@max-[840px]/viewbar:hidden">{MODE_LABELS[mode]}</span>
            <ChevronDown className="size-3.5 text-fg-tertiary" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Dependencies</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) => {
            if (value === 'manual' || value === 'auto') onChange(value)
          }}
        >
          <DropdownMenuRadioItem value="manual" className="h-auto items-start py-1.5">
            <span className="flex flex-col">
              <span>Manual</span>
              <span className="text-meta text-fg-tertiary">
                Warn about conflicts. Never moves other tasks.
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="auto" className="h-auto items-start py-1.5">
            <span className="flex flex-col">
              <span>Auto</span>
              <span className="text-meta text-fg-tertiary">
                Preview, then move dependent tasks later.
              </span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
