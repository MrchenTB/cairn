/**
 * Route element for /projects/:projectId/* — project header (colour, name, status, compact
 * progress, dates, New task, ⋯ menu), the 40px view bar (List / Board / Gantt pills, keys 1/2/3)
 * whose right side is the <ViewBarActions> slot, and the active view in a `flex-1 min-h-0`
 * container so the Gantt can fill the height. `/projects/:id` redirects (router loader) to the
 * last view used for the project.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, Outlet, useNavigate, useParams } from 'react-router'
import {
  Archive,
  CalendarRange,
  ChartGantt,
  Columns3,
  Diamond,
  Ellipsis,
  FolderKanban,
  Layers,
  List,
  Plus,
  type LucideIcon,
} from 'lucide-react'
import { useViewShortcut } from '@/app/shortcuts'
import { useUIStore } from '@/app/uiStore'
import { recordProjectVisit, setProjectView, type ProjectView } from '@/app/viewPrefs'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { ProgressBar } from '@/components/task/ProgressBar'
import { ProjectDot } from '@/components/task/ProjectDot'
import { ProjectStatusBadge } from '@/components/task/ProjectStatusBadge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { NavTab, NavTabs } from '@/components/ui/tabs'
import { Tooltip } from '@/components/ui/tooltip'
import {
  useMilestones,
  usePhases,
  useProject,
  useProjectTasks,
  useToday,
} from '@/data/hooks'
import { formatDateRange } from '@/domain/dates'
import { computeProgress } from '@/domain/progress'
import type { Project } from '@/domain/types'
import { dropdownKit } from './menuKit'
import { PhaseDialogHost } from './PhaseDialog'
import { usePhaseDialog } from './phaseDialogStore'
import { ProjectMenuItems } from './ProjectMenuItems'
import { useProjectCommands } from './projectCommands'
import { ViewBarSlotProvider } from './viewBar'

interface ViewTab {
  view: ProjectView
  label: string
  icon: LucideIcon
  shortcut: string
}

const VIEW_TABS: readonly ViewTab[] = [
  { view: 'list', label: 'List', icon: List, shortcut: '1' },
  { view: 'board', label: 'Board', icon: Columns3, shortcut: '2' },
  { view: 'gantt', label: 'Gantt', icon: ChartGantt, shortcut: '3' },
]

export function ProjectLayout() {
  const { projectId } = useParams()
  const project = useProject(projectId)

  if (!project) {
    return (
      <PageContainer>
        <EmptyState
          icon={FolderKanban}
          title="Project not found"
          description="It may have been deleted, or the link is incomplete."
          action={
            <Button asChild variant="secondary" size="md">
              <Link to="/projects">Back to Projects</Link>
            </Button>
          }
        />
      </PageContainer>
    )
  }
  return <ProjectFrame project={project} />
}

function ProjectFrame({ project }: { project: Project }) {
  const navigate = useNavigate()
  const today = useToday()
  const tasks = useProjectTasks(project.id)
  const phases = usePhases(project.id)
  const milestones = useMilestones(project.id)
  const progress = useMemo(() => computeProgress(tasks), [tasks])
  const commands = useProjectCommands()
  const openNewTask = useUIStore((s) => s.openNewTask)
  const openMilestoneDialog = useUIStore((s) => s.openMilestoneDialog)
  const openPhaseDialog = usePhaseDialog((s) => s.open)
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    recordProjectVisit(project.id)
  }, [project.id])

  const showView = (view: ProjectView) => {
    setProjectView(project.id, view)
    navigate(`/projects/${project.id}/${view}`)
  }
  useViewShortcut('1', () => showView('list'), { description: 'List view' })
  useViewShortcut('2', () => showView('board'), { description: 'Board view' })
  useViewShortcut('3', () => showView('gantt'), { description: 'Gantt view' })

  const dates = formatDateRange(project.startDate, project.dueDate, today)
  const archived = project.status === 'archived'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={<ProjectDot color={project.color} size={10} />}
        title={project.name}
        meta={
          <>
            <ProjectStatusBadge status={project.status} size="sm" />
            <ProgressBar
              value={progress.percent}
              done={progress.done}
              total={progress.total}
              aria-label="Project progress"
            />
            {dates ? (
              <span className="inline-flex items-center gap-1.5 text-meta text-fg-tertiary tabular-nums">
                <CalendarRange className="size-3.5" aria-hidden />
                <span>
                  <span className="sr-only">Dates: </span>
                  {dates}
                </span>
              </span>
            ) : null}
          </>
        }
        description={
          project.description ? (
            <span className="block truncate" title={project.description}>
              {project.description}
            </span>
          ) : undefined
        }
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => openNewTask({ projectId: project.id })}>
              <Plus strokeWidth={2} />
              New task
            </Button>
            <DropdownMenu>
              <Tooltip content="Project actions">
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Project actions">
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-52">
                <ProjectMenuItems
                  kit={dropdownKit}
                  project={project}
                  commands={commands}
                  onDelete={() =>
                    void commands.remove(
                      project,
                      { tasks: tasks.length, phases: phases.length, milestones: milestones.length },
                      { leave: true },
                    )
                  }
                >
                  <DropdownMenuItem onSelect={() => openPhaseDialog(project.id)}>
                    <Layers />
                    Add phase…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => openMilestoneDialog({ mode: 'create', projectId: project.id })}
                  >
                    <Diamond />
                    Add milestone…
                  </DropdownMenuItem>
                </ProjectMenuItems>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
        tabs={
          <NavTabs aria-label="Project views">
            {VIEW_TABS.map((tab) => (
              <Tooltip key={tab.view} content={`${tab.label} view`} shortcut={tab.shortcut} side="bottom">
                <NavTab
                  to={`/projects/${project.id}/${tab.view}`}
                  onClick={() => setProjectView(project.id, tab.view)}
                  aria-keyshortcuts={tab.shortcut}
                >
                  <tab.icon />
                  {tab.label}
                </NavTab>
              </Tooltip>
            ))}
          </NavTabs>
        }
        viewActionsRef={setSlot}
      />
      {archived ? (
        <div
          role="status"
          className="mx-6 mb-2 flex shrink-0 items-center gap-2.5 rounded-lg bg-muted px-3 py-1.5 text-ui text-fg-secondary"
        >
          <Archive className="size-4 shrink-0 text-fg-tertiary" aria-hidden />
          <span className="min-w-0 flex-1">
            This project is archived. It’s hidden from Overview, My Tasks and the sidebar.
          </span>
          <Button
            variant="secondary"
            size="xs"
            onClick={() => void commands.setStatus(project, 'active')}
          >
            Unarchive
          </Button>
        </div>
      ) : null}
      <ViewBarSlotProvider slot={slot}>
        <div className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </div>
      </ViewBarSlotProvider>
      <PhaseDialogHost />
    </div>
  )
}
