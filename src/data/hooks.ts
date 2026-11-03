/**
 * Read hooks over the workspace store. Selectors return STABLE references (store slices)
 * and derive arrays with useMemo — never return a freshly built array/object from a zustand
 * selector (zustand v5 + React 19 would loop). Use these hooks instead of reaching into the
 * store in views, so every view shares the same rules.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { todayInTimeZone } from '@/domain/dates'
import { compareMilestones } from '@/domain/hierarchy'
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

/** Own rows only: ids come from URLs (`?task=constructor` must not find Object.prototype). */
function byId<T>(table: Record<string, T>, id: string | null | undefined): T | undefined {
  return id && Object.hasOwn(table, id) ? table[id] : undefined
}

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
/**
 * Session state and auth actions. `passwordRecovery` = the user arrived through a password-reset
 * link and should choose a new password (`actions.updatePassword` / `dismissPasswordRecovery`).
 */
export function useAuth() {
  const status = useAuthStore((s) => s.status)
  const user = useAuthStore((s) => s.user)
  const mode = useAuthStore((s) => s.mode)
  const passwordRecovery = useAuthStore((s) => s.passwordRecovery)
  const actions = useAuthStore((s) => s.actions)
  return { status, user, mode, passwordRecovery, actions }
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
  return useWorkspaceStore((s) => byId(s.data.projects, projectId))
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
  return useWorkspaceStore((s) => byId(s.data.tasks, taskId))
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
/**
 * Milestones (of one project, or all when projectId is omitted) in the outline's order: date,
 * then name, then id (`compareMilestones`).
 */
export function useMilestones(projectId?: string | null): Milestone[] {
  const milestones = useWorkspaceStore((s) => s.data.milestones)
  return useMemo(
    () =>
      Object.values(milestones)
        .filter((m) => !projectId || m.projectId === projectId)
        .sort(compareMilestones),
    [milestones, projectId],
  )
}
export function useMilestone(milestoneId: string | null | undefined): Milestone | undefined {
  return useWorkspaceStore((s) => byId(s.data.milestones, milestoneId))
}
export function usePhase(phaseId: string | null | undefined): Phase | undefined {
  return useWorkspaceStore((s) => byId(s.data.phases, phaseId))
}

/**
 * What the sidebar sync indicator should say, in priority order:
 * 'error' (Couldn't save · Retry when canRetry) → 'offline' (Supabase mode) → 'saving' →
 * 'local' (Local only — not synced) → 'saved' → 'idle'.
 */
export type SyncIndicator = 'error' | 'offline' | 'saving' | 'local' | 'saved' | 'idle'

export function syncIndicator(mode: DataMode, sync: SyncState): SyncIndicator {
  if (sync.lastError) return 'error'
  if (!sync.online && mode === 'supabase') return 'offline'
  if (sync.pending > 0) return 'saving'
  if (mode === 'local') return 'local'
  return sync.lastSavedAt !== null ? 'saved' : 'idle'
}

export function useSyncIndicator(): { indicator: SyncIndicator; canRetry: boolean } {
  const mode = useDataMode()
  const sync = useSyncState()
  return { indicator: syncIndicator(mode, sync), canRetry: sync.canRetry }
}
/** Dependencies of a project. */
export function useDependencies(projectId: string | null | undefined): Dependency[] {
  const deps = useWorkspaceStore((s) => s.data.dependencies)
  return useMemo(
    () => (projectId ? Object.values(deps).filter((d) => d.projectId === projectId) : []),
    [deps, projectId],
  )
}

const CLOCK_TICK_MS = 30_000
const clockListeners = new Set<() => void>()
let stopClock: (() => void) | null = null

function tickClock(): void {
  for (const listener of [...clockListeners]) listener()
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'hidden') tickClock()
}

/**
 * One shared clock for every `useToday` (a list renders hundreds of due labels): a 30 s tick,
 * plus a tick when the tab is shown again (timers sleep with the laptop). Stops with the last
 * subscriber.
 */
function subscribeToClock(onTick: () => void): () => void {
  clockListeners.add(onTick)
  if (!stopClock) {
    const id = window.setInterval(tickClock, CLOCK_TICK_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)
    stopClock = () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }
  return () => {
    clockListeners.delete(onTick)
    if (clockListeners.size === 0 && stopClock) {
      stopClock()
      stopClock = null
    }
  }
}

/**
 * Today's calendar date in the user's configured time zone (Preferences.timezone).
 * Re-evaluates every 30 s (and when the tab is shown again) so views roll over at midnight;
 * re-renders only when the date changes.
 */
export function useToday(): ISODate {
  const timeZone = useWorkspaceStore((s) => s.preferences.timezone)
  return useSyncExternalStore(subscribeToClock, () => todayInTimeZone(timeZone))
}
