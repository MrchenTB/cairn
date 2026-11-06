/**
 * /timeline (PRD §4.8, acceptance 12) — every project on one time axis, so overlaps and milestones
 * read at a glance. One row per project; expanding a project shows its scheduled tasks and
 * milestones. The chart reuses the Gantt's engine and is read-only for dates in V1.
 */
import { useMemo } from 'react'
import { ChartGantt, Plus } from 'lucide-react'
import { useUIStore } from '@/app/uiStore'
import { ErrorState } from '@/components/layout/ErrorState'
import { LoadingState } from '@/components/layout/LoadingState'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import {
  useActions,
  usePreferences,
  useToday,
  useWorkspaceData,
  useWorkspaceStatus,
} from '@/data/hooks'
import { buildTimelineRows } from './model/rows'
import { TimelineChart } from './TimelineChart'
import { useExpandedProjects, useIncludeCompleted } from './timelinePrefs'

export function TimelinePage() {
  const { status, loadError } = useWorkspaceStatus()
  const actions = useActions()
  if (status === 'error') {
    return (
      <ErrorState
        titleAs="h1"
        title="Couldn’t load your workspace"
        message={loadError?.message}
        onRetry={() => void actions.load()}
      />
    )
  }
  if (status !== 'ready') return <LoadingState label="Loading your timeline…" />
  return <Timeline />
}

function Timeline() {
  const data = useWorkspaceData()
  const today = useToday()
  const { weekStartsOn } = usePreferences()
  const [expanded, toggleProject] = useExpandedProjects()
  const [includeCompleted, setIncludeCompleted] = useIncludeCompleted()
  const openProjectDialog = useUIStore((s) => s.openProjectDialog)

  const model = useMemo(
    () => buildTimelineRows(data, { expanded, includeCompleted }),
    [data, expanded, includeCompleted],
  )

  if (model.projectCount === 0) {
    const newProject = (
      <Button
        variant={model.completedCount > 0 ? 'ghost' : 'secondary'}
        size="md"
        onClick={() => openProjectDialog({ mode: 'create' })}
      >
        <Plus strokeWidth={2} />
        New project
      </Button>
    )
    return (
      <PageContainer width="full">
        <PageHeader title="Timeline" />
        {model.completedCount > 0 ? (
          <EmptyState
            icon={ChartGantt}
            title="No active projects"
            description="Completed projects are hidden here; archived projects never appear."
            action={
              <Button variant="secondary" size="md" onClick={() => setIncludeCompleted(true)}>
                Include completed
              </Button>
            }
            secondaryAction={newProject}
          />
        ) : (
          <EmptyState
            icon={ChartGantt}
            title="No projects yet"
            description="Every project appears here on one shared timeline, with its milestones."
            action={newProject}
          />
        )}
      </PageContainer>
    )
  }

  return (
    <PageContainer width="full" scroll={false} className="min-h-0">
      <TimelineChart
        model={model}
        data={data}
        today={today}
        weekStartsOn={weekStartsOn}
        includeCompleted={includeCompleted}
        onIncludeCompletedChange={setIncludeCompleted}
        onToggleProject={toggleProject}
      />
    </PageContainer>
  )
}
