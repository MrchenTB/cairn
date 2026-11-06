/**
 * /overview — the default home. Calm summary of the workspace from real store data: four
 * text-first metrics, active projects with leaf-task progress, upcoming tasks (overdue → today →
 * next 7 days) and milestones (next 30 days), plus a tiny read-only "Next 6 weeks" timeline that
 * leads to the full Timeline. An empty workspace gets a welcome with "Create project".
 * Every definition comes from src/domain (buckets, progress, roll-up).
 */
import { useMemo } from 'react'
import { Plus } from 'lucide-react'
import { useUIStore } from '@/app/uiStore'
import { LogoMark } from '@/components/brand/Logo'
import { ErrorState } from '@/components/layout/ErrorState'
import { LoadingState } from '@/components/layout/LoadingState'
import { PageBody, PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import {
  useActions,
  usePreferences,
  useProjects,
  useToday,
  useWorkspaceData,
  useWorkspaceStatus,
} from '@/data/hooks'
import { bucketPopulation, myTasks, overviewMetrics } from '@/domain/buckets'
import { formatDate } from '@/domain/dates'
import { progressByProject } from '@/domain/progress'
import { taskCountsByProject } from '@/features/projects/projectStats'
import { ActiveProjects } from './ActiveProjects'
import { MetricStrip } from './MetricStrip'
import { MiniTimeline } from './MiniTimeline'
import {
  miniTimeline,
  projectTimings,
  timelineWindow,
  upcomingMilestones,
  upcomingTasks,
} from './overviewModel'
import { UpcomingMilestones } from './UpcomingMilestones'
import { UpcomingTasks } from './UpcomingTasks'

export function OverviewPage() {
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
  if (status !== 'ready') return <LoadingState label="Loading your overview…" />
  return <Overview />
}

function WelcomeMark({ className }: { className?: string }) {
  return <LogoMark size={24} className={className} />
}

function Overview() {
  const data = useWorkspaceData()
  const today = useToday()
  const { weekStartsOn } = usePreferences()
  const projects = useProjects()
  const openProjectDialog = useUIStore((s) => s.openProjectDialog)
  const newProject = () => openProjectDialog({ mode: 'create' })

  const active = useMemo(
    () => projects.filter((project) => project.status === 'active'),
    [projects],
  )
  const metrics = useMemo(() => overviewMetrics(data, today), [data, today])
  const buckets = useMemo(() => myTasks(data, today), [data, today])
  const upcoming = useMemo(() => upcomingTasks(buckets), [buckets])
  const progress = useMemo(() => progressByProject(data), [data])
  const milestones = useMemo(() => upcomingMilestones(data, today), [data, today])
  const timeline = useMemo(
    () => miniTimeline(data, active, timelineWindow(today, weekStartsOn)),
    [data, active, today, weekStartsOn],
  )
  const counts = useMemo(() => taskCountsByProject(data), [data])
  const timings = useMemo(() => projectTimings(data, active), [data, active])
  const hasTasks = useMemo(() => bucketPopulation(data).length > 0, [data])
  const hasAnyProject = Object.keys(data.projects).length > 0

  if (!hasAnyProject) {
    return (
      <PageContainer>
        <PageHeader title="Overview" />
        <EmptyState
          icon={WelcomeMark}
          title="Plan clearly. Work simply."
          description="Start with a project, then see its tasks as a list, a board or a Gantt chart."
          action={
            <Button variant="primary" size="md" onClick={newProject}>
              <Plus strokeWidth={2} />
              Create project
            </Button>
          }
        />
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      <PageHeader
        title="Overview"
        description={formatDate(today, 'long')}
        actions={
          <Button variant="secondary" size="sm" onClick={newProject}>
            <Plus strokeWidth={2} />
            New project
          </Button>
        }
      />
      <PageBody className="@container gap-8 pt-3">
        <MetricStrip metrics={metrics} />
        <ActiveProjects
          projects={active}
          progress={progress}
          counts={counts}
          timings={timings}
          today={today}
          hasOtherProjects={Object.keys(data.projects).length > active.length}
        />
        {/* Two columns only when each has room for a subtask title next to project and date. */}
        <div className="grid gap-8 @[58rem]:grid-cols-2">
          <UpcomingTasks upcoming={upcoming} hasTasks={hasTasks} openCount={metrics.openTasks} />
          <UpcomingMilestones milestones={milestones} projects={data.projects} today={today} />
        </div>
        {active.length > 0 ? <MiniTimeline timeline={timeline} today={today} /> : null}
      </PageBody>
    </PageContainer>
  )
}
