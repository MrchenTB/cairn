import type { ProjectColor } from '@/domain/types'
import { cn } from '@/lib/utils'
import { PROJECT_COLOR_BG } from './labels'

export interface ProjectDotProps {
  color: ProjectColor
  /** Diameter in px (default 8). */
  size?: number
  className?: string
  /** Accessible name; omit when the project name is visible next to the dot. */
  label?: string
}

/** Small round project colour marker (token colours, ≥ 3:1 on every surface). */
export function ProjectDot({ color, size = 8, className, label }: ProjectDotProps) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const }
  return (
    <span
      data-color={color}
      className={cn(
        'inline-block shrink-0 rounded-full',
        PROJECT_COLOR_BG[color] ?? PROJECT_COLOR_BG.gray,
        className,
      )}
      style={{ width: size, height: size }}
      {...a11y}
    />
  )
}
