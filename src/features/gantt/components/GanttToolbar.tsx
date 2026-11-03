/**
 * Gantt controls rendered into the project view bar (via <ViewBarActions>): conflicts chip
 * (hidden at zero), dependency mode (Manual / Auto), Today (T) and Day / Week / Month.
 */
import { useState } from 'react'
import { ArrowRight, ChevronDown, TriangleAlert, Workflow } from 'lucide-react'
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
}

export function GanttToolbar(props: GanttToolbarProps) {
  return (
    <>
      <ConflictsChip {...props} />
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
}

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
          className="text-danger hover:bg-danger-subtle hover:text-danger data-[state=open]:bg-danger-subtle data-[state=open]:text-danger"
        >
          <TriangleAlert aria-hidden />
          {plural(conflicts.length, 'conflict')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-0">
        <div className="px-3 pt-3 pb-2">
          <p className="text-ui font-semibold text-fg">Dependency conflicts</p>
          <p className="mt-0.5 text-meta text-fg-secondary">
            These tasks start before a task they depend on has finished.
          </p>
        </div>
        <ul className="max-h-72 overflow-y-auto px-1 pb-1" aria-label="Conflicts">
          {conflicts.map((conflict) => {
            const predecessor = tasksById[conflict.predecessorId]
            const successor = tasksById[conflict.successorId]
            return (
              <li key={conflict.dependencyId}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    onOpenConflict(conflict.successorId)
                  }}
                  className={cn(
                    'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover',
                    insetFocus,
                  )}
                >
                  <span className="flex w-full min-w-0 items-center gap-1.5 text-ui text-fg">
                    <span className="truncate">{predecessor?.title ?? 'Task'}</span>
                    <ArrowRight className="size-3 shrink-0 text-fg-tertiary" aria-hidden />
                    <span className="sr-only">has to finish before</span>
                    <span className="truncate font-medium">{successor?.title ?? 'Task'}</span>
                  </span>
                  <span className="text-meta text-fg-tertiary tabular-nums">
                    Needs to start {formatDateSmart(conflict.requiredStart, today)} or later ·
                    starts {formatDateSmart(conflict.actualStart, today)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <div className="flex items-center justify-between gap-3 border-t border-subtle px-3 py-2">
          <span className="text-meta text-fg-tertiary">
            {scheduleMode === 'manual'
              ? 'Manual mode never moves tasks on its own.'
              : 'Auto mode moves successors when you edit.'}
          </span>
          <Button
            size="xs"
            variant="secondary"
            onClick={() => {
              setOpen(false)
              onResolveAll()
            }}
          >
            Resolve all…
          </Button>
        </div>
      </PopoverContent>
    </Popover>
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
            {MODE_LABELS[mode]}
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
