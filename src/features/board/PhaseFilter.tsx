import { useId } from 'react'
import { Layers, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip } from '@/components/ui/tooltip'
import type { Phase } from '@/domain/types'
import { cn } from '@/lib/utils'
import { ALL_PHASES, NO_PHASE } from './boardModel'

export interface PhaseFilterProps {
  /** Resolved filter: ALL_PHASES, NO_PHASE or a phase id. */
  value: string
  phases: readonly Phase[]
  onChange: (value: string) => void
}

/** View-bar phase filter ("All phases" by default) with a one-click clear when active. */
export function PhaseFilter({ value, phases, onChange }: PhaseFilterProps) {
  const active = value !== ALL_PHASES
  const labelId = useId()
  const valueId = useId()
  return (
    <div className="flex items-center gap-0.5">
      <span id={labelId} className="sr-only">
        Phase filter
      </span>
      <Select value={value} onValueChange={onChange}>
        {/* A combobox takes no name from its content: name it "Phase filter <current value>". */}
        <SelectTrigger
          variant="ghost"
          aria-labelledby={`${labelId} ${valueId}`}
          className={cn('h-7 max-w-56 gap-1.5 font-medium', active && 'bg-active text-fg')}
        >
          <Layers className="size-3.5 shrink-0 text-fg-tertiary" aria-hidden />
          <SelectValue id={valueId} />
        </SelectTrigger>
        <SelectContent align="end" className="min-w-48">
          <SelectItem value={ALL_PHASES}>All phases</SelectItem>
          <SelectItem value={NO_PHASE}>No phase</SelectItem>
          <SelectSeparator />
          {phases.map((phase) => (
            <SelectItem key={phase.id} value={phase.id}>
              {phase.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {active ? (
        <Tooltip content="Show all phases">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear phase filter"
            onClick={() => onChange(ALL_PHASES)}
          >
            <X />
          </Button>
        </Tooltip>
      ) : null}
    </div>
  )
}
