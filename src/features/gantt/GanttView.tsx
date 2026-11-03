import { ChartGantt } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'

/** PLACEHOLDER — replaced by the Gantt feature (/projects/:projectId/gantt). */
export function GanttView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <EmptyState
        icon={ChartGantt}
        title="Coming soon"
        description="Timeline bars, dependencies and milestones for this project."
      />
    </div>
  )
}
