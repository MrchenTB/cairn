import type { ReactNode } from 'react'
import { Pencil, Trash } from 'lucide-react'
import type { Project } from '@/domain/types'
import type { MenuKit } from './menuKit'
import { statusActions, type ProjectCommands } from './projectCommands'

export interface ProjectMenuItemsProps {
  kit: MenuKit
  project: Project
  commands: ProjectCommands
  onDelete: () => void
  /** Extra items after "Edit project…" (Add phase, Move up…). */
  children?: ReactNode
}

/** Edit · [extra] · status changes · Delete — the same list in the "…" menu and on right-click. */
export function ProjectMenuItems({ kit: K, project, commands, onDelete, children }: ProjectMenuItemsProps) {
  return (
    <>
      <K.Item onSelect={() => commands.edit(project.id)}>
        <Pencil />
        Edit project…
      </K.Item>
      {children}
      <K.Separator />
      {statusActions(project.status).map((action) => (
        <K.Item key={action.key} onSelect={() => void commands.setStatus(project, action.next)}>
          <action.icon />
          {action.label}
        </K.Item>
      ))}
      <K.Separator />
      <K.Item variant="destructive" onSelect={onDelete}>
        <Trash />
        Delete project…
      </K.Item>
    </>
  )
}
