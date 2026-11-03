import { ListTodo } from 'lucide-react'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/empty-state'

/** PLACEHOLDER — replaced by the My Tasks feature (/my-tasks/:tab: today | upcoming | overdue | all). */
export function MyTasksPage() {
  return (
    <PageContainer>
      <PageHeader title="My Tasks" />
      <EmptyState
        icon={ListTodo}
        title="Coming soon"
        description="Everything due today, this week and overdue, across all projects."
      />
    </PageContainer>
  )
}
