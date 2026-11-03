import { useState } from 'react'
import { Link, Outlet, useParams } from 'react-router'
import { ChartGantt, Columns3, FolderKanban, List } from 'lucide-react'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { ProjectDot } from '@/components/task/ProjectDot'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { NavTab, NavTabs } from '@/components/ui/tabs'
import { useProject } from '@/data/hooks'
import { ViewBarSlotProvider } from './viewBar'

/**
 * PLACEHOLDER — replaced by the Projects feature. Contract kept by the replacement: renders the
 * project header + view bar (List / Board / Gantt) with the <ViewBarActions> slot, and the
 * <Outlet/> inside a `flex min-h-0 flex-1` container so the Gantt can fill the height.
 */
export function ProjectLayout() {
  const { projectId } = useParams()
  const project = useProject(projectId)
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={project.name}
        icon={<ProjectDot color={project.color} size={10} />}
        tabs={
          <NavTabs aria-label="Project views">
            <NavTab to="list">
              <List />
              List
            </NavTab>
            <NavTab to="board">
              <Columns3 />
              Board
            </NavTab>
            <NavTab to="gantt">
              <ChartGantt />
              Gantt
            </NavTab>
          </NavTabs>
        }
        viewActionsRef={setSlot}
      />
      <ViewBarSlotProvider slot={slot}>
        <div className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </div>
      </ViewBarSlotProvider>
    </div>
  )
}
