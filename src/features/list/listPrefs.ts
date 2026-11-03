/**
 * List-view UI memory for the browser session (sessionStorage, never synced): which parents show
 * their subtasks and which phase groups are collapsed. Storage failures fall back to memory.
 */
import { useSyncExternalStore } from 'react'

function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function readIds(key: string): string[] {
  try {
    const raw = sessionStore()?.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeIds(key: string, ids: ReadonlySet<string>): void {
  try {
    sessionStore()?.setItem(key, JSON.stringify([...ids]))
  } catch {
    // quota / disabled storage: keep the in-memory value only
  }
}

/** A tiny external store holding a set of ids, persisted per tab session. */
function createSessionSet(key: string) {
  let snapshot: ReadonlySet<string> = new Set(readIds(key))
  const listeners = new Set<() => void>()
  const commit = (next: Set<string>) => {
    snapshot = next
    writeIds(key, next)
    for (const listener of listeners) listener()
  }
  return {
    get: (): ReadonlySet<string> => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(ids: readonly string[], included: boolean) {
      const next = new Set(snapshot)
      for (const id of ids) {
        if (included) next.add(id)
        else next.delete(id)
      }
      if (next.size !== snapshot.size || ids.some((id) => snapshot.has(id) !== included)) commit(next)
    },
    /** Test helper. */
    reset() {
      commit(new Set())
    },
  }
}

const expandedTasks = createSessionSet('cairn:list:expanded-tasks')
const collapsedGroups = createSessionSet('cairn:list:collapsed-groups')

/** Ids of parent tasks whose subtasks are shown (default: collapsed). */
export function useExpandedTasks(): ReadonlySet<string> {
  return useSyncExternalStore(expandedTasks.subscribe, expandedTasks.get, expandedTasks.get)
}

export function setTasksExpanded(taskIds: readonly string[], expanded: boolean): void {
  expandedTasks.set(taskIds, expanded)
}

/** Shows or hides one parent's subtasks; returns whether they are shown now. */
export function toggleTaskExpanded(taskId: string): boolean {
  const next = !expandedTasks.get().has(taskId)
  expandedTasks.set([taskId], next)
  return next
}

/** Key of a phase group in the collapsed set. */
export function groupKey(projectId: string, containerId: string): string {
  return `${projectId}|${containerId}`
}

/** Collapsed group keys (see `groupKey`); default: expanded. */
export function useCollapsedGroups(): ReadonlySet<string> {
  return useSyncExternalStore(collapsedGroups.subscribe, collapsedGroups.get, collapsedGroups.get)
}

export function setGroupCollapsed(key: string, collapsed: boolean): void {
  collapsedGroups.set([key], collapsed)
}

/** Test helper: forgets everything. */
export function resetListPrefsForTests(): void {
  expandedTasks.reset()
  collapsedGroups.reset()
}
