import type { ReactElement } from 'react'
import { TASK_STATUSES, type TaskStatus } from '@/domain/types'
import { STATUS_LABELS } from './labels'
import { OptionMenu } from './OptionMenu'
import { StatusIcon } from './StatusIcon'

const renderStatusIcon = (status: TaskStatus) => <StatusIcon status={status} decorative />
const getStatusLabel = (status: TaskStatus) => STATUS_LABELS[status]

export interface StatusMenuProps {
  value: TaskStatus
  onChange: (status: TaskStatus) => void
  /** Custom trigger element; defaults to an icon button (`trigger="icon"`) or a chip. */
  children?: ReactElement
  trigger?: 'icon' | 'chip'
  disabled?: boolean
  align?: 'start' | 'center' | 'end'
  triggerClassName?: string
}

/** Status picker: "To Do" / "In Progress" / "Done" with glyphs; keys 1–3 pick while open. */
export function StatusMenu(props: StatusMenuProps) {
  return (
    <OptionMenu
      field="Status"
      options={TASK_STATUSES}
      getLabel={getStatusLabel}
      renderIcon={renderStatusIcon}
      firstDigit={1}
      {...props}
    />
  )
}
