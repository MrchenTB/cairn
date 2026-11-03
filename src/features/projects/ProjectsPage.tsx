/**
 * /projects — dense, Linear-style project table: name (+ description), status, progress (leaf
 * tasks), dates and open/total tasks. Status filter in the URL (?status=active|completed|
 * archived|all, default active), a quick text filter, row menu + right-click menu, and manual
 * reordering (drag handle or Move up/down) while the unfiltered Active list is shown.
 */
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type Ref } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, Ellipsis, FolderKanban, GripVertical, Plus, Search, X } from 'lucide-react'
import { useViewShortcut } from '@/app/shortcuts'
import { useUIStore } from '@/app/uiStore'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { ProgressBar } from '@/components/task/ProgressBar'
import { ProjectDot } from '@/components/task/ProjectDot'
import { ProjectStatusBadge } from '@/components/task/ProjectStatusBadge'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control'
import { insetFocus } from '@/components/ui/styles'
import { Tooltip } from '@/components/ui/tooltip'
import { useActions, useProjects, useToday, useWorkspaceData } from '@/data/hooks'
import { formatDateRange } from '@/domain/dates'
import { progressByProject, type ProgressInfo } from '@/domain/progress'
import { searchWorkspace } from '@/domain/search'
import type { ISODate, Project } from '@/domain/types'
import { cn } from '@/lib/utils'
import {
  POINTER_ACTIVATION,
  SCREEN_READER_INSTRUCTIONS,
  useDropAnimation,
} from './dnd'
import { contextKit, dropdownKit, type MenuKit } from './menuKit'
import { ProjectMenuItems } from './ProjectMenuItems'
import { useProjectCommands, type ProjectCommands } from './projectCommands'
import { dropAfterId, stepAfterId } from './projectOrder'
import { plural, projectContents, taskCountsByProject, type TaskCounts } from './projectStats'

const STATUS_FILTERS = ['active', 'completed', 'archived', 'all'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]
const DEFAULT_FILTER: StatusFilter = 'active'
const STATUS_PARAM = 'status'

const FILTER_LABELS: Record<StatusFilter, string> = {
  active: 'Active',
  completed: 'Completed',
  archived: 'Archived',
  all: 'All',
}

function parseFilter(value: string | null): StatusFilter {
  return (STATUS_FILTERS as readonly string[]).includes(value ?? '')
    ? (value as StatusFilter)
    : DEFAULT_FILTER
}

/** Project table columns; narrower panels drop Dates, then Tasks (container queries). */
const GRID =
  'grid grid-cols-[minmax(0,1fr)_7rem_9rem_2rem] @3xl:grid-cols-[minmax(0,1fr)_7rem_9rem_10rem_2rem] @5xl:grid-cols-[minmax(0,1fr)_7rem_9rem_10rem_4.5rem_2rem]'

export function ProjectsPage() {
  const projects = useProjects({ includeArchived: true })
  const data = useWorkspaceData()
  const today = useToday()
  const commands = useProjectCommands()
  const openProjectDialog = useUIStore((s) => s.openProjectDialog)
  const [searchParams, setSearchParams] = useSearchParams()
  const filter = parseFilter(searchParams.get(STATUS_PARAM))
  const [query, setQuery] = useState('')
  const filterRef = useRef<HTMLInputElement>(null)

  useViewShortcut('/', () => filterRef.current?.focus(), { description: 'Filter projects' })

  const progress = useMemo(() => progressByProject(data), [data])
  const counts = useMemo(() => taskCountsByProject(data), [data])
  const statusCounts = useMemo(() => {
    const result: Record<StatusFilter, number> = { active: 0, completed: 0, archived: 0, all: 0 }
    for (const project of projects) {
      result[project.status]++
      result.all++
    }
    return result
  }, [projects])

  const trimmedQuery = query.trim()
  // The domain search (NFKC, case-insensitive, every term in name or description) over projects.
  const matches = useMemo(() => {
    if (trimmedQuery === '') return null
    const projectsOnly = { projects: data.projects, phases: {}, tasks: {}, milestones: {}, dependencies: {} }
    return new Set(
      searchWorkspace(projectsOnly, trimmedQuery, { limit: Number.POSITIVE_INFINITY }).map(
        (result) => result.id,
      ),
    )
  }, [data.projects, trimmedQuery])

  const visible = useMemo(
    () =>
      projects.filter(
        (project) =>
          (filter === 'all' || project.status === filter) && (!matches || matches.has(project.id)),
      ),
    [projects, filter, matches],
  )
  const reorderable = filter === 'active' && matches === null && visible.length > 1

  const setFilter = (next: StatusFilter) => {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current)
        if (next === DEFAULT_FILTER) params.delete(STATUS_PARAM)
        else params.set(STATUS_PARAM, next)
        return params
      },
      { replace: true },
    )
  }

  const filterOptions: SegmentedOption<StatusFilter>[] = STATUS_FILTERS.map((value) => ({
    value,
    ariaLabel: `${FILTER_LABELS[value]} (${statusCounts[value]})`,
    label: (
      <>
        {FILTER_LABELS[value]}
        <span className="text-meta text-fg-tertiary tabular-nums">{statusCounts[value]}</span>
      </>
    ),
  }))

  const createButton = (
    <Button variant="secondary" size="sm" onClick={() => openProjectDialog({ mode: 'create' })}>
      <Plus strokeWidth={2} />
      New project
    </Button>
  )

  if (projects.length === 0) {
    return (
      <PageContainer width="full">
        <PageHeader title="Projects" />
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="A project holds your tasks — phases and milestones are optional."
          action={
            <Button variant="primary" size="md" onClick={() => openProjectDialog({ mode: 'create' })}>
              <Plus strokeWidth={2} />
              Create your first project
            </Button>
          }
        />
      </PageContainer>
    )
  }

  return (
    <PageContainer width="full">
      <PageHeader
        title="Projects"
        actions={createButton}
        tabs={
          <SegmentedControl
            aria-label="Filter projects by status"
            value={filter}
            onValueChange={setFilter}
            options={filterOptions}
          />
        }
        viewActions={
          <FilterInput
            inputRef={filterRef}
            value={query}
            onChange={setQuery}
          />
        }
      />
      {visible.length === 0 ? (
        <EmptyState
          variant="inline"
          icon={Search}
          title={
            matches
              ? `No projects match “${trimmedQuery}”`
              : `No ${FILTER_LABELS[filter].toLowerCase()} projects`
          }
          description={
            matches && filter !== 'all'
              ? `Only ${FILTER_LABELS[filter].toLowerCase()} projects are searched.`
              : filter === 'archived'
                ? 'Archived projects are kept out of Overview, My Tasks and the sidebar.'
                : undefined
          }
          action={
            matches ? (
              <Button variant="secondary" size="md" onClick={() => setQuery('')}>
                Clear filter
              </Button>
            ) : filter !== 'all' ? (
              <Button variant="secondary" size="md" onClick={() => setFilter('all')}>
                Show all projects
              </Button>
            ) : null
          }
          secondaryAction={
            matches && filter !== 'all' ? (
              <Button variant="link" size="sm" onClick={() => setFilter('all')}>
                Search all projects
              </Button>
            ) : null
          }
        />
      ) : (
        <ProjectsTable
          projects={visible}
          progress={progress}
          counts={counts}
          today={today}
          reorderable={reorderable}
          commands={commands}
          contentsOf={(projectId) => projectContents(data, projectId)}
        />
      )}
    </PageContainer>
  )
}

function FilterInput({
  value,
  onChange,
  inputRef,
}: {
  value: string
  onChange: (value: string) => void
  inputRef: Ref<HTMLInputElement>
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return
    if (value !== '') {
      event.preventDefault()
      onChange('')
    } else {
      event.currentTarget.blur()
    }
  }
  return (
    <div className="relative flex items-center">
      <Search
        aria-hidden
        className="pointer-events-none absolute left-2 size-3.5 text-fg-tertiary"
        strokeWidth={1.75}
      />
      <Input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Filter projects…"
        aria-label="Filter projects by name or description"
        aria-keyshortcuts="/"
        autoComplete="off"
        className="h-7 w-40 pr-7 pl-7 lg:w-52 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear filter"
          onClick={() => onChange('')}
          className="absolute right-1 grid size-5 place-items-center rounded-sm text-fg-tertiary hover:bg-hover hover:text-fg"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  )
}

interface ProjectsTableProps {
  projects: Project[]
  progress: Record<string, ProgressInfo>
  counts: Record<string, TaskCounts>
  today: ISODate
  reorderable: boolean
  commands: ProjectCommands
  contentsOf: (projectId: string) => ReturnType<typeof projectContents>
}

function ProjectsTable({
  projects,
  progress,
  counts,
  today,
  reorderable,
  commands,
  contentsOf,
}: ProjectsTableProps) {
  const actions = useActions()
  const dropAnimation = useDropAnimation()
  const [activeId, setActiveId] = useState<string | null>(null)
  const ids = useMemo(() => projects.map((project) => project.id), [projects])
  const byId = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: POINTER_ACTIVATION }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const nameOf = (id: UniqueIdentifier) => byId.get(String(id))?.name ?? 'project'
  const positionOf = (id: UniqueIdentifier) => ids.indexOf(String(id)) + 1
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${nameOf(active.id)}, position ${positionOf(active.id)} of ${ids.length}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${nameOf(active.id)} moved to position ${positionOf(over.id)} of ${ids.length}.`
        : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? `${nameOf(active.id)} dropped at position ${positionOf(over.id)} of ${ids.length}.`
        : `${nameOf(active.id)} dropped.`,
    onDragCancel: ({ active }) => `Moving ${nameOf(active.id)} was cancelled.`,
  }

  const move = (projectId: string, afterId: string | null | undefined) => {
    if (afterId === undefined) return
    void actions.moveProject(projectId, afterId)
  }

  const onDragStart = ({ active }: DragStartEvent) => setActiveId(String(active.id))
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null)
    move(String(active.id), dropAfterId(ids, String(active.id), over ? String(over.id) : null))
  }

  const activeProject = activeId ? byId.get(activeId) : undefined

  return (
    <div className="@container pb-10">
      <div role="table" aria-label="Projects" aria-rowcount={projects.length + 1}>
        <div role="rowgroup" className="sticky top-(--viewbar-height) z-(--z-sticky) bg-main">
          <div
            role="row"
            className={cn(GRID, 'h-8 items-center gap-4 border-b border-subtle px-6 text-meta font-medium text-fg-tertiary')}
          >
            <span role="columnheader">Project</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Progress</span>
            <span role="columnheader" className="hidden @3xl:block">
              Dates
            </span>
            <span role="columnheader" className="hidden text-right @5xl:block" title="Open / total tasks">
              Tasks
            </span>
            <span role="columnheader">
              <span className="sr-only">Actions</span>
            </span>
          </div>
        </div>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          accessibility={{ announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={!reorderable}>
            <div role="rowgroup" className="pt-1">
              {projects.map((project, index) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  progress={progress[project.id]}
                  counts={counts[project.id]}
                  today={today}
                  reorderable={reorderable}
                  commands={commands}
                  canMoveUp={index > 0}
                  canMoveDown={index < projects.length - 1}
                  onMove={(delta) => move(project.id, stepAfterId(ids, project.id, delta))}
                  onDelete={() => void commands.remove(project, contentsOf(project.id))}
                />
              ))}
            </div>
          </SortableContext>
          <DragOverlay dropAnimation={dropAnimation}>
            {activeProject ? <ProjectRowPreview project={activeProject} /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  )
}

interface ProjectRowProps {
  project: Project
  progress: ProgressInfo | undefined
  counts: TaskCounts | undefined
  today: ISODate
  reorderable: boolean
  commands: ProjectCommands
  canMoveUp: boolean
  canMoveDown: boolean
  onMove: (delta: -1 | 1) => void
  onDelete: () => void
}

function ProjectRow({
  project,
  progress,
  counts,
  today,
  reorderable,
  commands,
  canMoveUp,
  canMoveDown,
  onMove,
  onDelete,
}: ProjectRowProps) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } =
    useSortable({ id: project.id, disabled: !reorderable })
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition: transition,
  }
  const dates = formatDateRange(project.startDate, project.dueDate, today)
  const open = counts?.open ?? 0
  const total = counts?.total ?? 0

  const menuItems = (kit: MenuKit) => (
    <ProjectMenuItems kit={kit} project={project} commands={commands} onDelete={onDelete}>
      {reorderable ? (
        <>
          <kit.Separator />
          <kit.Item disabled={!canMoveUp} onSelect={() => onMove(-1)}>
            <ArrowUp />
            Move up
          </kit.Item>
          <kit.Item disabled={!canMoveDown} onSelect={() => onMove(1)}>
            <ArrowDown />
            Move down
          </kit.Item>
        </>
      ) : null}
    </ProjectMenuItems>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          role="row"
          data-dragging={isDragging || undefined}
          className={cn(
            GRID,
            'group/row relative h-10 items-center gap-4 px-6 text-ui',
            'transition-colors duration-fast hover:bg-hover hover:duration-instant data-[state=open]:bg-hover',
          )}
        >
          {isDragging ? (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-6 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-accent"
            />
          ) : null}
          <div
            role="cell"
            className={cn('flex min-w-0 items-center gap-2.5', isDragging && 'opacity-0')}
          >
            {reorderable ? (
              <button
                type="button"
                ref={setActivatorNodeRef}
                {...attributes}
                {...listeners}
                aria-label={`Reorder ${project.name}`}
                className={cn(
                  'absolute top-1/2 left-1 z-[1] grid h-6 w-5 -translate-y-1/2 cursor-grab place-items-center rounded-sm text-fg-tertiary',
                  'opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 focus-visible:opacity-100',
                  'hover:bg-hover hover:text-fg active:cursor-grabbing',
                  insetFocus,
                )}
              >
                <GripVertical className="size-3.5" aria-hidden />
              </button>
            ) : null}
            <ProjectDot color={project.color} />
            <Link
              to={`/projects/${project.id}`}
              className={cn(
                'max-w-[70%] shrink-0 truncate font-medium text-fg',
                // The link covers the row: one tab stop, middle-click opens a new tab.
                'after:absolute after:inset-0 after:content-[""] focus-visible:outline-none',
                'focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus',
              )}
            >
              {project.name}
            </Link>
            {project.description ? (
              <span className="min-w-0 truncate text-fg-tertiary">{project.description}</span>
            ) : null}
          </div>
          <div role="cell" className={cn(isDragging && 'opacity-0')}>
            <ProjectStatusBadge status={project.status} />
          </div>
          <div role="cell" className={cn('min-w-0', isDragging && 'opacity-0')}>
            <ProgressBar
              value={progress?.percent ?? null}
              done={progress?.done}
              total={progress?.total}
              aria-label={`${project.name} progress`}
            />
          </div>
          <div
            role="cell"
            className={cn(
              'hidden truncate text-meta text-fg-secondary tabular-nums @3xl:block',
              isDragging && 'opacity-0',
            )}
          >
            {dates || (
              <>
                <span className="text-fg-tertiary" aria-hidden>
                  —
                </span>
                <span className="sr-only">No dates</span>
              </>
            )}
          </div>
          <div
            role="cell"
            className={cn(
              'hidden text-right text-meta tabular-nums @5xl:block',
              isDragging && 'opacity-0',
            )}
          >
            {total === 0 ? (
              <>
                <span className="text-fg-tertiary" aria-hidden>
                  —
                </span>
                <span className="sr-only">No tasks</span>
              </>
            ) : (
              <span title={`${open} open of ${plural(total, 'task')} (subtasks included)`}>
                <span className="sr-only">
                  {open} open of {plural(total, 'task')}, subtasks included
                </span>
                <span aria-hidden>
                  <span className="text-fg-secondary">{open}</span>
                  <span className="text-fg-tertiary"> / {total}</span>
                </span>
              </span>
            )}
          </div>
          <div role="cell" className={cn('relative z-[1] flex justify-end', isDragging && 'opacity-0')}>
            <DropdownMenu>
              <Tooltip content="Project actions">
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions for ${project.name}`}
                    className={cn(
                      'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
                      insetFocus,
                    )}
                  >
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-52">
                {menuItems(dropdownKit)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">{menuItems(contextKit)}</ContextMenuContent>
    </ContextMenu>
  )
}

function ProjectRowPreview({ project }: { project: Project }) {
  return (
    <div className="flex h-10 cursor-grabbing items-center gap-2.5 rounded-md bg-elevated px-6 text-ui shadow-drag">
      <ProjectDot color={project.color} />
      <span className="truncate font-medium text-fg">{project.name}</span>
      <span className="ml-auto">
        <ProjectStatusBadge status={project.status} size="sm" />
      </span>
    </div>
  )
}
