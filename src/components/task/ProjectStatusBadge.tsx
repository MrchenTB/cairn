import { Badge } from '@/components/ui/badge'
import type { ProjectStatus } from '@/domain/types'
import { PROJECT_STATUS_LABELS } from './labels'

const VARIANT = { active: 'neutral', completed: 'success', archived: 'outline' } as const

export interface ProjectStatusBadgeProps {
  status: ProjectStatus
  size?: 'sm' | 'md'
  className?: string
}

/** Active (neutral) · Completed (success) · Archived (outlined, tertiary). Text always shown. */
export function ProjectStatusBadge({ status, size = 'md', className }: ProjectStatusBadgeProps) {
  return (
    <Badge variant={VARIANT[status]} size={size} className={className} data-status={status}>
      {PROJECT_STATUS_LABELS[status]}
    </Badge>
  )
}
