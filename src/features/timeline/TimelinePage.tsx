import { ChartGantt } from 'lucide-react'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/empty-state'

/** PLACEHOLDER — replaced by the cross-project Timeline feature. */
export function TimelinePage() {
  return (
    <PageContainer width="full">
      <PageHeader title="Timeline" />
      <EmptyState
        icon={ChartGantt}
        title="Coming soon"
        description="Every project on one timeline, with milestones."
      />
    </PageContainer>
  )
}
