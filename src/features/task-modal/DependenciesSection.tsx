import { useId, useMemo, useRef, useState, type RefObject } from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { Plus, Search, X } from 'lucide-react'
import { StatusIcon } from '@/components/task/StatusIcon'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useActions, useDependencies, usePhases, useProject, useProjectTasks } from '@/data/hooks'
import { buildProjectOutline } from '@/domain/hierarchy'
import { validateNewDependency, type DependencyValidation } from '@/domain/scheduling'
import { searchWorkspace } from '@/domain/search'
import type { Dependency, Phase, Project, Task } from '@/domain/types'
import { reviewNewDependency } from '@/features/gantt/planner'
import { afterDialogsClosed, ignoreEscapeWhileComposing } from './dialogGuards'
import { FieldError, SectionHeading } from './fields'

type Direction = 'blockedBy' | 'blocking'

const LABELS: Record<Direction, { row: string; add: string; remove: (title: string) => string }> = {
  blockedBy: {
    row: 'Blocked by',
    add: 'Add a task that blocks this one',
    remove: (title) => `Remove “${title}” from Blocked by`,
  },
  blocking: {
    row: 'Blocking',
    add: 'Add a task this one blocks',
    remove: (title) => `Remove “${title}” from Blocking`,
  },
}

export interface DependenciesSectionProps {
  task: Task
  /** Opens a linked task in the modal (goes through the unsaved-changes guard). */
  onOpenTask: (taskId: string) => void
}

/**
 * Finish-to-start dependencies of the task: "Blocked by" (predecessors) and "Blocking"
 * (successors). Adding or removing a link saves immediately (not part of the Save form); every
 * candidate is checked with the domain rule (`validateNewDependency`) and an unavailable one says
 * why.
 */
export function DependenciesSection({ task, onOpenTask }: DependenciesSectionProps) {
  const project = useProject(task.projectId)
  const phases = usePhases(task.projectId)
  const projectTasks = useProjectTasks(task.projectId)
  const dependencies = useDependencies(task.projectId)
  const { addDependency, removeDependency } = useActions()
  const [error, setError] = useState<string | null>(null)
  const headingId = useId()
  const errorId = useId()

  const tasksById = useMemo(
    () => Object.fromEntries(projectTasks.map((t) => [t.id, t])) as Record<string, Task>,
    [projectTasks],
  )

  const links = useMemo(() => {
    const byCreation = [...dependencies].sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    )
    const toLink = (dependency: Dependency, otherId: string) => {
      const other = tasksById[otherId]
      return other ? [{ dependency, other }] : []
    }
    return {
      blockedBy: byCreation
        .filter((d) => d.successorId === task.id)
        .flatMap((d) => toLink(d, d.predecessorId)),
      blocking: byCreation
        .filter((d) => d.predecessorId === task.id)
        .flatMap((d) => toLink(d, d.successorId)),
    }
  }, [dependencies, tasksById, task.id])

  const add = async (direction: Direction, otherId: string) => {
    setError(null)
    const result =
      direction === 'blockedBy'
        ? await addDependency(otherId, task.id)
        : await addDependency(task.id, otherId)
    if (!result.ok) {
      // Remote failures are toasted (with Retry) by the store and rolled back.
      if (result.error.kind === 'validation') setError(result.error.message)
      return
    }
    // A link that is already violated: Auto mode previews the shifts, Manual mode warns.
    await reviewNewDependency(result.value.id)
  }

  const remove = async (dependency: Dependency) => {
    setError(null)
    const result = await removeDependency(dependency.id)
    if (!result.ok && result.error.kind === 'validation') setError(result.error.message)
  }

  return (
    <section aria-labelledby={headingId}>
      <SectionHeading id={headingId} title="Dependencies" aside="Finish-to-start" />
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5">
        {(['blockedBy', 'blocking'] as const).map((direction) => (
          <DependencyRow
            key={direction}
            direction={direction}
            task={task}
            project={project}
            phases={phases}
            projectTasks={projectTasks}
            tasksById={tasksById}
            dependencies={dependencies}
            links={links[direction]}
            onAdd={(otherId) => add(direction, otherId)}
            onRemove={(dependency) => void remove(dependency)}
            onOpenTask={onOpenTask}
          />
        ))}
      </div>
      <FieldError id={errorId}>{error}</FieldError>
    </section>
  )
}

interface DependencyRowProps {
  direction: Direction
  task: Task
  project: Project | undefined
  phases: readonly Phase[]
  projectTasks: readonly Task[]
  tasksById: Record<string, Task>
  dependencies: readonly Dependency[]
  links: Array<{ dependency: Dependency; other: Task }>
  /** Resolves once the link was written and reviewed (the Auto-mode preview closed). */
  onAdd: (otherId: string) => Promise<void>
  onRemove: (dependency: Dependency) => void
  onOpenTask: (taskId: string) => void
}

function DependencyRow({
  direction,
  links,
  onAdd,
  onRemove,
  onOpenTask,
  ...picker
}: DependencyRowProps) {
  const labels = LABELS[direction]
  const labelId = useId()
  const removeButtons = useRef(new Map<string, HTMLButtonElement>())
  const addButton = useRef<HTMLButtonElement>(null)

  const add = async (otherId: string) => {
    await onAdd(otherId)
    // The Auto-mode preview opens while the picker closes, so it has nothing to give focus back
    // to: once it is gone, keep keyboard users in this row.
    const button = addButton.current
    const modal = button?.closest('[role="dialog"]') ?? null
    afterDialogsClosed(
      () => {
        const active = document.activeElement
        if ((!active || active === document.body) && button?.isConnected) {
          button.focus({ preventScroll: true })
        }
      },
      { except: modal },
    )
  }

  const remove = (index: number) => {
    // The chip and its focused × disappear: keep keyboard focus in this row (the next chip, the
    // previous one, else "Add").
    const neighbour = links[index + 1] ?? links[index - 1]
    const target =
      (neighbour && removeButtons.current.get(neighbour.dependency.id)) ?? addButton.current
    target?.focus({ preventScroll: true })
    onRemove(links[index].dependency)
  }

  return (
    <>
      <span id={labelId} className="flex h-7 items-center text-meta text-fg-secondary">
        {labels.row}
      </span>
      <ul aria-labelledby={labelId} className="flex min-w-0 flex-wrap items-center gap-1.5">
        {links.map(({ dependency, other }, index) => (
          <li
            key={dependency.id}
            className="inline-flex h-7 max-w-full min-w-0 items-center rounded-full border border-default bg-surface pr-px pl-2.5 text-meta"
          >
            <StatusIcon status={other.status} size={12} decorative />
            <button
              type="button"
              onClick={() => onOpenTask(other.id)}
              className="ml-1 min-w-0 self-stretch truncate rounded-sm text-fg hover:underline focus-visible:outline-offset-[-2px]"
            >
              {other.title}
            </button>
            <button
              ref={(node) => {
                if (!node) return undefined
                removeButtons.current.set(dependency.id, node)
                return () => {
                  removeButtons.current.delete(dependency.id)
                }
              }}
              type="button"
              aria-label={labels.remove(other.title)}
              onClick={() => remove(index)}
              // 24px target (WCAG 2.5.8).
              className="ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-fg-tertiary transition-colors duration-fast hover:bg-hover hover:text-fg hover:duration-instant"
            >
              <X className="size-3" aria-hidden />
            </button>
          </li>
        ))}
        <li>
          <DependencyPicker
            direction={direction}
            triggerRef={addButton}
            onAdd={(otherId) => void add(otherId)}
            {...picker}
          />
        </li>
      </ul>
    </>
  )
}

interface Candidate {
  task: Task
  verdict: DependencyValidation
  /** e.g. "Subtask of Write report" */
  context: string | null
}

interface CandidateGroup {
  key: string
  heading: string | null
  items: Candidate[]
}

function DependencyPicker({
  direction,
  task,
  project,
  phases,
  projectTasks,
  tasksById,
  dependencies,
  onAdd,
  triggerRef,
}: Omit<DependencyRowProps, 'links' | 'onAdd' | 'onRemove' | 'onOpenTask'> & {
  onAdd: (otherId: string) => void
  triggerRef: RefObject<HTMLButtonElement | null>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const labels = LABELS[direction]

  // Everything except the task itself, its own parent/subtasks and links that already exist in
  // this direction. The remaining candidates are validated; an invalid one stays visible with
  // the reason (e.g. a cycle) instead of disappearing.
  const groups = useMemo<CandidateGroup[]>(() => {
    if (!open || !project) return []
    const excluded = new Set<string>([task.id])
    if (task.parentTaskId) excluded.add(task.parentTaskId)
    for (const other of projectTasks) if (other.parentTaskId === task.id) excluded.add(other.id)
    for (const d of dependencies) {
      if (direction === 'blockedBy' && d.successorId === task.id) excluded.add(d.predecessorId)
      if (direction === 'blocking' && d.predecessorId === task.id) excluded.add(d.successorId)
    }
    const candidate = (other: Task): Candidate => ({
      task: other,
      verdict:
        direction === 'blockedBy'
          ? validateNewDependency(tasksById, dependencies, other.id, task.id)
          : validateNewDependency(tasksById, dependencies, task.id, other.id),
      context:
        other.parentTaskId && tasksById[other.parentTaskId]
          ? `Subtask of ${tasksById[other.parentTaskId].title}`
          : null,
    })

    const trimmed = query.trim()
    if (trimmed) {
      const pool = Object.fromEntries(
        projectTasks.filter((other) => !excluded.has(other.id)).map((other) => [other.id, other]),
      )
      const results = searchWorkspace(
        {
          projects: { [project.id]: project },
          phases: {},
          tasks: pool,
          milestones: {},
          dependencies: {},
        },
        trimmed,
        { limit: 50 },
      )
      const items = results.flatMap((result) =>
        result.kind === 'task' ? [candidate(result.task)] : [],
      )
      return items.length > 0 ? [{ key: 'results', heading: null, items }] : []
    }

    const outline = buildProjectOutline(project, phases, projectTasks, [])
    return outline.groups.flatMap((group) => {
      const items = group.tasks
        .flatMap(({ task: top, subtasks }) => [top, ...subtasks])
        .filter((other) => !excluded.has(other.id))
        .map(candidate)
      if (items.length === 0) return []
      return [
        {
          key: group.phase?.id ?? 'no-phase',
          heading: outline.hasPhases ? (group.phase?.name ?? 'No phase') : null,
          items,
        },
      ]
    })
  }, [open, project, phases, task, projectTasks, tasksById, dependencies, direction, query])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="xs"
          aria-label={labels.add}
          className="h-7 gap-1 px-2 text-fg-tertiary"
        >
          <Plus aria-hidden />
          Add
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={labels.add}
        className="w-80 p-0"
        onEscapeKeyDown={ignoreEscapeWhileComposing}
      >
        <Command shouldFilter={false} loop label={labels.add}>
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-subtle px-3">
            <Search className="size-3.5 shrink-0 text-fg-tertiary" aria-hidden />
            <CommandPrimitive.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Search tasks in this project…"
              className="h-full min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-tertiary focus-visible:outline-none"
            />
          </div>
          <CommandList className="max-h-72 p-1">
            <CommandEmpty className="px-3 py-6">
              {query.trim()
                ? `No tasks match “${query.trim()}”.`
                : 'No other tasks in this project yet.'}
            </CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.key} heading={group.heading ?? undefined}>
                {group.items.map(({ task: other, verdict, context }) => (
                  <CommandItem
                    key={other.id}
                    value={other.id}
                    disabled={!verdict.ok}
                    onSelect={() => {
                      setOpen(false)
                      setQuery('')
                      onAdd(other.id)
                    }}
                    className="h-auto min-h-9 items-start py-1.5"
                  >
                    <StatusIcon status={other.status} size={14} decorative className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{other.title}</span>
                      {!verdict.ok ? (
                        <span className="block text-meta text-fg-tertiary">{verdict.message}</span>
                      ) : context ? (
                        <span className="block truncate text-meta text-fg-tertiary">{context}</span>
                      ) : null}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
