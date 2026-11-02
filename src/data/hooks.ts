/**
 * Read hooks over the workspace store. Selectors return STABLE references (store slices)
 * and derive arrays with useMemo — never return a freshly built array/object from a zustand
 * selector (zustand v5 + React 19 would loop). Use these hooks instead of reaching into the
 * store in views, so every view shares the same rules.
 */
import { useEffect, useMemo, useState } from 'react'
import { todayInTimeZone } from '@/domain/dates'
import { bySortOrder } from '@/domain/ordering'
import type {
  Dependency,
  ISODate,
  Milestone,
  Phase,
  Preferences,
  Project,
  Task,
  WorkspaceData,
} from '@/domain/types'
import type { DataMode, SyncState, WorkspaceActions } from './contracts'
import { useAuthStore, useWorkspaceStore } from './store'

export function useActions(): WorkspaceActions {
  return useWorkspaceStore((s) => s.actions)
}
export function useDataMode(): DataMode {
  return useWorkspaceStore((s) => s.mode)
}
export function useWorkspaceStatus() {
  const status = useWorkspaceStore((s) => s.status)
  const loadError = useWorkspaceStore((s) => s.loadError)
  return { status, loadError }
}
/** Whole normalised workspace (stable until any entity changes). */
export function useWorkspaceData(): WorkspaceData {
  return useWorkspaceStore((s) => s.data)
}
export function usePreferences(): Preferences {
  return useWorkspaceStore((s) => s.preferences)
}
export function useSyncState(): SyncState {
  return useWorkspaceStore((s) => s.sync)
}
export function useAuth() {
  const status = useAuthStore((s) => s.status)
  const user = useAuthStore((s) => s.user)
  const mode = useAuthStore((s) => s.mode)
  const actions = useAuthStore((s) => s.actions)
  return { status, user, mode, actions }
}

/** Projects sorted by sortOrder. Archived projects excluded unless includeArchived. */
export function useProjects(options: { includeArchived?: boolean } = {}): Project[] {
  const projects = useWorkspaceStore((s) => s.data.projects)
  const includeArchived = options.includeArchived ?? false
  return useMemo(
    () =>
      Object.values(projects)
        .filter((p) => includeArchived || p.status !== 'archived')
        .sort(bySortOrder),
    [projects, includeArchived],
  )
}
export function useProject(projectId: string | null | undefined): Project | undefined {
  return useWorkspaceStore((s) => (projectId ? s.data.projects[projectId] : undefined))
}
/** Phases of a project sorted by sortOrder. */
export function usePhases(projectId: string | null | undefined): Phase[] {
  const phases = useWorkspaceStore((s) => s.data.phases)
  return useMemo(
    () =>
      projectId
        ? Object.values(phases)
            .filter((p) => p.projectId === projectId)
            .sort(bySortOrder)
        : [],
    [phases, projectId],
  )
}
/** Every task (top-level and subtasks) of a project, sorted by sortOrder. */
export function useProjectTasks(projectId: string | null | undefined): Task[] {
  const tasks = useWorkspaceStore((s) => s.data.tasks)
  return useMemo(
    () =>
      projectId
        ? Object.values(tasks)
            .filter((t) => t.projectId === projectId)
            .sort(bySortOrder)
        : [],
    [tasks, projectId],
  )
}
export function useTask(taskId: string | null | undefined): Task | undefined {
  return useWorkspaceStore((s) => (taskId ? s.data.tasks[taskId] : undefined))
}
/** Subtasks of a parent, sorted. */
export function useSubtasks(parentTaskId: string | null | undefined): Task[] {
  const tasks = useWorkspaceStore((s) => s.data.tasks)
  return useMemo(
    () =>
      parentTaskId
        ? Object.values(tasks)
            .filter((t) => t.parentTaskId === parentTaskId)
            .sort(bySortOrder)
        : [],
    [tasks, parentTaskId],
  )
}
/** Milestones (of one project, or all when projectId is omitted) sorted by date then name. */
export function useMilestones(projectId?: string | null): Milestone[] {
  const milestones = useWorkspaceStore((s) => s.data.milestones)
  return useMemo(
    () =>
      Object.values(milestones)
        .filter((m) => !projectId || m.projectId === projectId)
        .sort((a, b) =>
          a.date === b.date ? a.name.localeCompare(b.name) : a.date < b.date ? -1 : 1,
        ),
    [milestones, projectId],
  )
}
export function useMilestone(milestoneId: string | null | undefined): Milestone | undefined {
  return useWorkspaceStore((s) => (milestoneId ? s.data.milestones[milestoneId] : undefined))
}
/** Dependencies of a project. */
export function useDependencies(projectId: string | null | undefined): Dependency[] {
  const deps = useWorkspaceStore((s) => s.data.dependencies)
  return useMemo(
    () => (projectId ? Object.values(deps).filter((d) => d.projectId === projectId) : []),
    [deps, projectId],
  )
}

/**
 * Today's calendar date in the user's configured time zone (Preferences.timezone).
 * Re-evaluates every 30 s so views roll over at midnight.
 */
export function useToday(): ISODate {
  const timeZone = useWorkspaceStore((s) => s.preferences.timezone)
  const [today, setToday] = useState(() => todayInTimeZone(timeZone))
  useEffect(() => {
    setToday(todayInTimeZone(timeZone))
    const id = window.setInterval(() => setToday(todayInTimeZone(timeZone)), 30_000)
    return () => window.clearInterval(id)
  }, [timeZone])
  return today
}
