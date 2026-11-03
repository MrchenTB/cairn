/**
 * Project actions shared by the Projects page rows and the project header menu: edit, status
 * changes (confirmed with a toast + Undo — the row may leave the current filter) and the delete
 * flow (confirm with exact counts → optional navigation away → delete → forget view prefs).
 * Writes go through the store; failures are toasted and rolled back there.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import { Archive, ArchiveArrowUp, CircleCheck, RotateCcw, type LucideIcon } from 'lucide-react'
import { useUIStore } from '@/app/uiStore'
import { forgetProject } from '@/app/viewPrefs'
import { confirm } from '@/components/ui/confirm'
import { useActions } from '@/data/hooks'
import type { Project, ProjectStatus } from '@/domain/types'
import { notify } from '@/lib/notify'
import { deleteProjectDescription, type ProjectContents } from './projectStats'

export interface StatusAction {
  key: string
  label: string
  next: ProjectStatus
  icon: LucideIcon
}

/** The status changes offered for a project in its current status. */
export function statusActions(status: ProjectStatus): StatusAction[] {
  switch (status) {
    case 'active':
      return [
        { key: 'complete', label: 'Mark completed', next: 'completed', icon: CircleCheck },
        { key: 'archive', label: 'Archive', next: 'archived', icon: Archive },
      ]
    case 'completed':
      return [
        { key: 'reopen', label: 'Reopen', next: 'active', icon: RotateCcw },
        { key: 'archive', label: 'Archive', next: 'archived', icon: Archive },
      ]
    default:
      return [{ key: 'unarchive', label: 'Unarchive', next: 'active', icon: ArchiveArrowUp }]
  }
}

/** Confirmation after a status change (the row may leave the current Projects filter). */
export function statusChangeMessage(previous: ProjectStatus, next: ProjectStatus): string {
  if (next === 'completed') return 'Project marked completed'
  if (next === 'archived') return 'Project archived'
  return previous === 'archived' ? 'Project unarchived' : 'Project reopened'
}

export interface ProjectCommands {
  edit(projectId: string): void
  /** Resolves true when the change was saved. */
  setStatus(project: Project, next: ProjectStatus): Promise<boolean>
  /**
   * Confirms (stating exactly what is deleted), then deletes. `leave` navigates to /projects
   * first (used from inside the project). Resolves true when the project was deleted.
   */
  remove(project: Project, contents: ProjectContents, options?: { leave?: boolean }): Promise<boolean>
}

export function useProjectCommands(): ProjectCommands {
  const actions = useActions()
  const navigate = useNavigate()
  const openProjectDialog = useUIStore((s) => s.openProjectDialog)

  return useMemo<ProjectCommands>(
    () => ({
      edit(projectId) {
        openProjectDialog({ mode: 'edit', projectId })
      },
      async setStatus(project, next) {
        const previous = project.status
        if (previous === next) return true
        const result = await actions.updateProject(project.id, { status: next })
        if (!result.ok) {
          // Remote failures were toasted (with Retry) by the store; validation has no form here.
          if (result.error.kind === 'validation') notify.error(result.error.message)
          return false
        }
        notify.success(statusChangeMessage(previous, next), {
          description: project.name,
          action: {
            label: 'Undo',
            onClick: () => void actions.updateProject(project.id, { status: previous }),
          },
        })
        return true
      },
      async remove(project, contents, options = {}) {
        const confirmed = await confirm({
          title: `Delete “${project.name}”?`,
          description: deleteProjectDescription(contents),
          confirmLabel: 'Delete project',
          destructive: true,
        })
        if (!confirmed) return false
        if (options.leave) navigate('/projects', { replace: true })
        const result = await actions.deleteProject(project.id)
        if (!result.ok) {
          if (result.error.kind === 'validation') notify.error(result.error.message)
          return false
        }
        forgetProject(project.id)
        notify.success('Project deleted', { description: project.name })
        return true
      },
    }),
    [actions, navigate, openProjectDialog],
  )
}
