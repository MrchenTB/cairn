/**
 * Auto-schedule preview (PRD §4.7, design-research §5.6 "衝突處理"). Mounted once in the app shell
 * because the planner is used from every view (Gantt, Task Modal, List). The plan is recomputed
 * live from the store, so what the dialog lists is exactly what "Apply" writes — in ONE atomic
 * applySchedule call. Cancel / Esc writes nothing.
 */
import { useMemo, useRef, useState } from 'react'
import { ArrowRight, CalendarClock, TriangleAlert } from 'lucide-react'
import { StatusIcon } from '@/components/task/StatusIcon'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToday, useWorkspaceData } from '@/data/hooks'
import { formatDateRange } from '@/domain/dates'
import type { ScheduleShift } from '@/domain/scheduling'
import type { ISODate, Task, WorkspaceData } from '@/domain/types'
import { cn } from '@/lib/utils'
import { computeReschedulePlan, type ReschedulePlan } from './planner'
import {
  useRescheduleStore,
  type ActiveReschedule,
  type RescheduleDecision,
} from './rescheduleStore'

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function dateText(start: ISODate | null, due: ISODate | null, today: ISODate): string {
  return formatDateRange(start, due, today) || 'No dates'
}

export function RescheduleDialogHost() {
  const active = useRescheduleStore((s) => s.active)
  // Keep the last request rendered while the dialog animates out.
  const lastRef = useRef<ActiveReschedule | null>(null)
  if (active) lastRef.current = active
  const shown = active ?? lastRef.current
  return (
    <Dialog
      open={active !== null}
      onOpenChange={(open) => {
        if (!open) active?.settle({ status: 'cancelled' })
      }}
    >
      {shown ? <RescheduleDialogContent key={shown.id} active={shown} /> : null}
    </Dialog>
  )
}

function RescheduleDialogContent({ active }: { active: ActiveReschedule }) {
  const data = useWorkspaceData()
  const today = useToday()
  const plan = useMemo(() => computeReschedulePlan(active.request, data), [active.request, data])
  const [busy, setBusy] = useState<RescheduleDecision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)

  const run = async (decision: RescheduleDecision) => {
    if (busy) return
    setBusy(decision)
    setError(null)
    const writes = decision === 'only' && plan.change ? [plan.change] : plan.writes
    const result = await active.execute(decision, writes)
    if (result.ok) {
      active.settle({ status: 'written', decision })
    } else if (result.error.kind === 'validation') {
      setError(result.error.message)
      setBusy(null)
    } else {
      // The store rolled the change back and showed "Couldn't save · Retry".
      active.settle({ status: 'failed', error: result.error })
    }
  }

  const cancel = () => {
    if (!busy) active.settle({ status: 'cancelled' })
  }

  const kind = active.request.kind
  const changedTask = plan.change ? data.tasks[plan.change.taskId] : undefined
  const count = plan.writes.length
  const nothingToDo = plan.error === null && plan.shifts.length === 0

  return (
    <DialogContent
      size="lg"
      showClose={!busy}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        primaryRef.current?.focus()
      }}
      onEscapeKeyDown={(event) => {
        if (busy) event.preventDefault()
      }}
      onInteractOutside={(event) => {
        if (busy) event.preventDefault()
      }}
    >
      <DialogHeader>
        <DialogTitle>{titleFor(kind, nothingToDo)}</DialogTitle>
        <DialogDescription>{summaryFor(active, plan, data, changedTask, today)}</DialogDescription>
      </DialogHeader>

      <DialogBody className="pb-3">
        {plan.error ? (
          <p role="alert" className="flex items-center gap-2 text-ui text-danger">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            {plan.error}
          </p>
        ) : (
          <>
            {plan.change && changedTask ? (
              <div className="mb-3 rounded-lg border border-default bg-muted px-3 py-2">
                <p className="mb-1 text-meta font-medium text-fg-tertiary">Your change</p>
                <ShiftLine
                  task={changedTask}
                  from={{ startDate: changedTask.startDate, dueDate: changedTask.dueDate }}
                  to={{ startDate: plan.change.startDate, dueDate: plan.change.dueDate }}
                  today={today}
                />
              </div>
            ) : null}
            {plan.shifts.length > 0 ? (
              <section aria-label="Tasks that move">
                <p className="mb-1.5 text-meta font-semibold text-fg-tertiary">
                  {kind === 'change' ? 'Dependent tasks that move later' : 'Tasks that move later'}
                </p>
                <ul className="flex flex-col">
                  {plan.shifts.map((shift) => (
                    <ShiftRow key={shift.taskId} shift={shift} data={data} today={today} />
                  ))}
                </ul>
              </section>
            ) : (
              <p className="text-ui text-fg-secondary">
                {kind === 'change'
                  ? 'No other tasks need to move anymore.'
                  : 'Every successor already starts after its predecessors finish.'}
              </p>
            )}
            <p className="mt-3 flex gap-2 text-meta text-fg-tertiary">
              <CalendarClock className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>
                Auto-schedule counts calendar days, weekends included. Dependent tasks keep their
                duration and only ever move later
                {kind === 'change' ? '; the task you edited stays where you put it.' : '.'}
              </span>
            </p>
            {error ? (
              <p role="alert" className="mt-2 text-meta text-danger">
                {error}
              </p>
            ) : null}
          </>
        )}
      </DialogBody>

      <DialogFooter bordered>
        {plan.error ? (
          <Button ref={primaryRef} variant="secondary" size="md" onClick={cancel}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="md" onClick={cancel} disabled={busy !== null}>
              {kind === 'dependency' ? 'Keep current dates' : 'Cancel'}
            </Button>
            {kind === 'change' && plan.shifts.length > 0 ? (
              <Button
                variant="secondary"
                size="md"
                onClick={() => void run('only')}
                loading={busy === 'only'}
                disabled={busy !== null}
              >
                Only move this task
              </Button>
            ) : null}
            {count > 0 ? (
              <Button
                ref={primaryRef}
                variant="primary"
                size="md"
                onClick={() => void run('apply')}
                loading={busy === 'apply'}
                disabled={busy !== null}
              >
                {count === 1 && kind === 'change' ? 'Apply change' : `Apply ${plural(count, 'change')}`}
              </Button>
            ) : (
              <Button ref={primaryRef} variant="secondary" size="md" onClick={cancel}>
                Close
              </Button>
            )}
          </>
        )}
      </DialogFooter>
    </DialogContent>
  )
}

function titleFor(kind: ActiveReschedule['request']['kind'], nothingToDo: boolean): string {
  if (kind === 'change') return nothingToDo ? 'Change dates' : 'Move dependent tasks?'
  if (kind === 'dependency') return 'Reschedule for the new dependency?'
  return nothingToDo ? 'No conflicts to resolve' : 'Resolve dependency conflicts'
}

function summaryFor(
  active: ActiveReschedule,
  plan: ReschedulePlan,
  data: WorkspaceData,
  changedTask: Task | undefined,
  today: ISODate,
): string {
  const moved = plural(plan.shifts.length, 'dependent task')
  const request = active.request
  if (request.kind === 'change') {
    if (!changedTask || !plan.change) return 'The task was changed or deleted meanwhile.'
    const target = dateText(plan.change.startDate, plan.change.dueDate, today)
    return plan.shifts.length > 0
      ? `Moving “${changedTask.title}” to ${target} also moves ${moved} later.`
      : `“${changedTask.title}” moves to ${target}.`
  }
  if (request.kind === 'dependency') {
    const dependency = data.dependencies[request.dependencyId]
    const predecessor = dependency ? data.tasks[dependency.predecessorId] : undefined
    const successor = dependency ? data.tasks[dependency.successorId] : undefined
    if (!predecessor || !successor) return 'The dependency was removed meanwhile.'
    return `“${successor.title}” has to start after “${predecessor.title}” finishes. Auto mode can move ${plural(plan.shifts.length, 'task')} later.`
  }
  return plan.shifts.length > 0
    ? `${plural(plan.shifts.length, 'task')} move later so every successor starts after its predecessors finish.`
    : 'Nothing needs to move.'
}

function ShiftRow({
  shift,
  data,
  today,
}: {
  shift: ScheduleShift
  data: WorkspaceData
  today: ISODate
}) {
  const task = data.tasks[shift.taskId]
  if (!task) return null
  return (
    <li className="border-t border-subtle py-1.5 first:border-t-0">
      <ShiftLine task={task} from={shift.from} to={shift.to} today={today} delta={shift.deltaDays} />
    </li>
  )
}

function ShiftLine({
  task,
  from,
  to,
  today,
  delta,
}: {
  task: Task
  from: { startDate: ISODate | null; dueDate: ISODate | null }
  to: { startDate: ISODate | null; dueDate: ISODate | null }
  today: ISODate
  delta?: number
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_3.5rem] items-center gap-3">
      <span className="flex min-w-0 items-center gap-2">
        <StatusIcon status={task.status} size={14} />
        <span className="truncate text-ui text-fg">{task.title}</span>
      </span>
      <span className="flex items-center gap-1.5 text-meta whitespace-nowrap tabular-nums">
        <span className="text-fg-tertiary line-through decoration-fg-disabled">
          <span className="sr-only">From </span>
          {dateText(from.startDate, from.dueDate, today)}
        </span>
        <ArrowRight className="size-3 text-fg-tertiary" aria-hidden />
        <span className="font-medium text-fg">
          <span className="sr-only">to </span>
          {dateText(to.startDate, to.dueDate, today)}
        </span>
      </span>
      <span
        className={cn(
          'justify-self-end text-meta font-medium whitespace-nowrap tabular-nums',
          delta ? 'text-accent-text' : 'text-fg-tertiary',
        )}
      >
        {delta ? (
          <>
            <span aria-hidden>+{delta}d</span>
            <span className="sr-only">{plural(delta, 'day')} later</span>
          </>
        ) : null}
      </span>
    </div>
  )
}
