/**
 * /projects/:projectId/gantt (PRD §4.7) — rendered inside ProjectLayout, which handles a missing
 * project. Reads the project's outline through the data hooks and hands the row model to the
 * chart; an empty project shows an empty state with "New task".
 */
import { useMemo } from 'react'
import { useParams } from 'react-router'
import { ChartGantt, Plus } from 'lucide-react'
import { useUIStore } from '@/app/uiStore'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import {
  useDependencies,
  useMilestones,
  usePhases,
  usePreferences,
  useProject,
  useProjectTasks,
  useToday,
} from '@/data/hooks'
import { buildProjectOutline } from '@/domain/hierarchy'
import { findConflicts } from '@/domain/scheduling'
import type { Project } from '@/domain/types'
import { GanttChart } from './components/GanttChart'
import { useCollapsedRows } from './ganttPrefs'
import { buildGanttRows } from './model/rows'
import { dataBounds } from './model/viewport'

export function GanttView() {
  const { projectId } = useParams()
  const project = useProject(projectId)
  // ProjectLayout renders "Project not found" instead of this view.
  if (!project) return null
  return <ProjectGantt key={project.id} project={project} />
}

function ProjectGantt({ project }: { project: Project }) {
  const tasks = useProjectTasks(project.id)
  const phases = usePhases(project.id)
  const milestones = useMilestones(project.id)
  const dependencies = useDependencies(project.id)
  const { weekStartsOn } = usePreferences()
  const today = useToday()
  const openNewTask = useUIStore((s) => s.openNewTask)
  const [collapsed, toggleRow] = useCollapsedRows(project.id)

  const outline = useMemo(
    () => buildProjectOutline(project, phases, tasks, milestones),
    [project, phases, tasks, milestones],
  )
  const model = useMemo(() => buildGanttRows(outline, collapsed), [outline, collapsed])
  const { startDate, dueDate } = project
  const bounds = useMemo(
    () => dataBounds(tasks, milestones, { startDate, dueDate }),
    [tasks, milestones, startDate, dueDate],
  )
  const conflicts = useMemo(() => findConflicts(tasks, dependencies), [tasks, dependencies])

  if (tasks.length === 0 && milestones.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <EmptyState
          icon={ChartGantt}
          title="No tasks yet"
          description="Add a task with dates to see it on the timeline. Tasks without dates wait in “Unscheduled” until you drag them onto it."
          action={
            <Button variant="secondary" size="md" onClick={() => openNewTask({ projectId: project.id })}>
              <Plus strokeWidth={2} />
              New task
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <GanttChart
      project={project}
      model={model}
      dependencies={dependencies}
      milestones={milestones}
      conflicts={conflicts}
      bounds={bounds}
      today={today}
      weekStartsOn={weekStartsOn}
      onToggleRow={toggleRow}
    />
  )
}
