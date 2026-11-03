import { FolderKanban } from 'lucide-react'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/empty-state'

/** PLACEHOLDER — replaced by the Projects feature (dense project list). */
export function ProjectsPage() {
  return (
    <PageContainer>
      <PageHeader title="Projects" />
      <EmptyState
        icon={FolderKanban}
        title="Coming soon"
        description="All your projects with status, progress and dates."
      />
    </PageContainer>
  )
}
