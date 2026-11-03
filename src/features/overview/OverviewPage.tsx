import { LayoutDashboard } from 'lucide-react'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/empty-state'

/** PLACEHOLDER — replaced by the Overview feature (metrics, active projects, due soon). */
export function OverviewPage() {
  return (
    <PageContainer>
      <PageHeader title="Overview" />
      <EmptyState
        icon={LayoutDashboard}
        title="Coming soon"
        description="Your projects, upcoming deadlines and milestones at a glance."
      />
    </PageContainer>
  )
}
