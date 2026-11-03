import type { ReactElement } from 'react'
import { TASK_PRIORITIES, type TaskPriority } from '@/domain/types'
import { PRIORITY_LABELS } from './labels'
import { OptionMenu } from './OptionMenu'
import { PriorityIcon } from './PriorityIcon'

const renderPriorityIcon = (priority: TaskPriority) => (
  <PriorityIcon priority={priority} decorative />
)
const getPriorityLabel = (priority: TaskPriority) => PRIORITY_LABELS[priority]

export interface PriorityMenuProps {
  value: TaskPriority
  onChange: (priority: TaskPriority) => void
  /** Custom trigger element; defaults to an icon button (`trigger="icon"`) or a chip. */
  children?: ReactElement
  trigger?: 'icon' | 'chip'
  disabled?: boolean
  align?: 'start' | 'center' | 'end'
  triggerClassName?: string
}

/** Priority picker (No priority → Urgent) with cairn-stone glyphs; keys 0–4 pick while open. */
export function PriorityMenu(props: PriorityMenuProps) {
  return (
    <OptionMenu
      field="Priority"
      options={TASK_PRIORITIES}
      getLabel={getPriorityLabel}
      renderIcon={renderPriorityIcon}
      firstDigit={0}
      {...props}
    />
  )
}
