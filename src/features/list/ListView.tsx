import { List } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'

/** PLACEHOLDER — replaced by the List feature (/projects/:projectId/list). */
export function ListView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <EmptyState
        icon={List}
        title="Coming soon"
        description="Dense, grouped task list with inline editing."
      />
    </div>
  )
}
