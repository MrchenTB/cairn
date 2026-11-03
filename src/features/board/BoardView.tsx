import { Columns3 } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'

/** PLACEHOLDER — replaced by the Board feature (/projects/:projectId/board). */
export function BoardView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <EmptyState
        icon={Columns3}
        title="Coming soon"
        description="To Do, In Progress and Done columns with drag and drop."
      />
    </div>
  )
}
