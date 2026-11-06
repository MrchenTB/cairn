/** User-facing labels and token classes for task/project enums (one place, used everywhere). */
import type { ProjectColor, ProjectStatus, TaskPriority, TaskStatus } from '@/domain/types'

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
}

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: 'No priority',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
}

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: 'Active',
  completed: 'Completed',
  archived: 'Archived',
}

export const PROJECT_COLOR_LABELS: Record<ProjectColor, string> = {
  gray: 'Gray',
  blue: 'Blue',
  violet: 'Violet',
  pink: 'Pink',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  teal: 'Teal',
}

/** The palette's CSS variable per colour (for inline `--…` overrides and colour-mix). */
export const PROJECT_COLOR_VAR: Record<ProjectColor, string> = {
  gray: 'var(--project-gray)',
  blue: 'var(--project-blue)',
  violet: 'var(--project-violet)',
  pink: 'var(--project-pink)',
  red: 'var(--project-red)',
  orange: 'var(--project-orange)',
  yellow: 'var(--project-yellow)',
  green: 'var(--project-green)',
  teal: 'var(--project-teal)',
}

/** Background utility per project colour (dots, swatches). */
export const PROJECT_COLOR_BG: Record<ProjectColor, string> = {
  gray: 'bg-project-gray',
  blue: 'bg-project-blue',
  violet: 'bg-project-violet',
  pink: 'bg-project-pink',
  red: 'bg-project-red',
  orange: 'bg-project-orange',
  yellow: 'bg-project-yellow',
  green: 'bg-project-green',
  teal: 'bg-project-teal',
}

/** Text/currentColor utility per project colour (icons). */
export const PROJECT_COLOR_TEXT: Record<ProjectColor, string> = {
  gray: 'text-project-gray',
  blue: 'text-project-blue',
  violet: 'text-project-violet',
  pink: 'text-project-pink',
  red: 'text-project-red',
  orange: 'text-project-orange',
  yellow: 'text-project-yellow',
  green: 'text-project-green',
  teal: 'text-project-teal',
}
