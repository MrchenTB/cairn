/**
 * Per-device view preferences (localStorage, never synced):
 * - the last view used per project (list | board | gantt) → `/projects/:id` redirect
 * - the Gantt scale per scope (a project id, or e.g. 'timeline') → day | week | month
 * - recently visited projects (most recent first) → sidebar "Recent"
 * Every storage access is wrapped (see '@/lib/storage'); reads fall back to defaults.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { isPlainObject, onStorageKey, readJSON, writeJSON } from '@/lib/storage'

export const PROJECT_VIEWS = ['list', 'board', 'gantt'] as const
export type ProjectView = (typeof PROJECT_VIEWS)[number]
export const DEFAULT_PROJECT_VIEW: ProjectView = 'list'

export const GANTT_SCALES = ['day', 'week', 'month'] as const
export type GanttScale = (typeof GANTT_SCALES)[number]
export const DEFAULT_GANTT_SCALE: GanttScale = 'week'

const VIEWS_KEY = 'cairn:project-views'
const SCALES_KEY = 'cairn:gantt-scales'
const RECENTS_KEY = 'cairn:recent-projects'
const MAX_RECENTS = 10

export function isProjectView(value: unknown): value is ProjectView {
  return (PROJECT_VIEWS as readonly unknown[]).includes(value)
}
export function isGanttScale(value: unknown): value is GanttScale {
  return (GANTT_SCALES as readonly unknown[]).includes(value)
}

// ---------------------------------------------------------------------------
// Tiny external store per key (in-memory snapshot + cross-tab 'storage' sync)
// ---------------------------------------------------------------------------

function createStoredValue<T>(key: string, parse: (raw: unknown) => T) {
  let snapshot = parse(readJSON(key))
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  onStorageKey(key, () => {
    snapshot = parse(readJSON(key))
    emit()
  })
  return {
    get: () => snapshot,
    set(next: T) {
      snapshot = next
      writeJSON(key, next)
      emit()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Re-reads storage (tests). */
    reload() {
      snapshot = parse(readJSON(key))
      emit()
    },
  }
}

/** Own-property lookup, so ids like "constructor" never read Object.prototype. */
function own<V>(record: Record<string, V>, key: string): V | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function parseRecord<V>(guard: (value: unknown) => value is V) {
  return (raw: unknown): Record<string, V> => {
    const result: Record<string, V> = {}
    if (isPlainObject(raw)) {
      for (const [id, value] of Object.entries(raw)) {
        if (id !== '__proto__' && guard(value)) result[id] = value
      }
    }
    return result
  }
}

const views = createStoredValue(VIEWS_KEY, parseRecord(isProjectView))
const scales = createStoredValue(SCALES_KEY, parseRecord(isGanttScale))
const recents = createStoredValue(RECENTS_KEY, (raw): string[] =>
  Array.isArray(raw)
    ? raw
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .slice(0, MAX_RECENTS)
    : [],
)

// ---------------------------------------------------------------------------
// Last project view
// ---------------------------------------------------------------------------

/** Last view used for the project (default 'list'). */
export function getProjectView(projectId: string): ProjectView {
  return own(views.get(), projectId) ?? DEFAULT_PROJECT_VIEW
}

export function setProjectView(projectId: string, view: ProjectView): void {
  const current = views.get()
  if (own(current, projectId) === view) return
  views.set({ ...current, [projectId]: view })
}

export function useProjectView(projectId: string): ProjectView {
  const all = useSyncExternalStore(views.subscribe, views.get, views.get)
  return own(all, projectId) ?? DEFAULT_PROJECT_VIEW
}

// ---------------------------------------------------------------------------
// Gantt scale
// ---------------------------------------------------------------------------

/** Gantt scale for a scope: a project id, or a page key such as 'timeline' (default 'week'). */
export function getGanttScale(scopeId: string): GanttScale {
  return own(scales.get(), scopeId) ?? DEFAULT_GANTT_SCALE
}

export function setGanttScale(scopeId: string, scale: GanttScale): void {
  const current = scales.get()
  if (own(current, scopeId) === scale) return
  scales.set({ ...current, [scopeId]: scale })
}

/** [scale, setScale] for a scope, persisted per device. */
export function useGanttScale(scopeId: string): [GanttScale, (scale: GanttScale) => void] {
  const all = useSyncExternalStore(scales.subscribe, scales.get, scales.get)
  const setScale = useCallback((scale: GanttScale) => setGanttScale(scopeId, scale), [scopeId])
  return [own(all, scopeId) ?? DEFAULT_GANTT_SCALE, setScale]
}

// ---------------------------------------------------------------------------
// Recent projects
// ---------------------------------------------------------------------------

/** Moves the project to the front of the recent list (called on every project visit). */
export function recordProjectVisit(projectId: string): void {
  if (!projectId) return
  const current = recents.get()
  if (current[0] === projectId) return
  recents.set([projectId, ...current.filter((id) => id !== projectId)].slice(0, MAX_RECENTS))
}

/** Drops a project from recents and view prefs (e.g. after it was deleted). */
export function forgetProject(projectId: string): void {
  const currentRecents = recents.get()
  if (currentRecents.includes(projectId)) {
    recents.set(currentRecents.filter((id) => id !== projectId))
  }
  const currentViews = views.get()
  if (Object.hasOwn(currentViews, projectId)) {
    const rest = { ...currentViews }
    delete rest[projectId]
    views.set(rest)
  }
}

export function getRecentProjectIds(): string[] {
  return recents.get()
}

/** Recently visited project ids, most recent first (may include deleted/archived ids). */
export function useRecentProjectIds(): string[] {
  return useSyncExternalStore(recents.subscribe, recents.get, recents.get)
}

/** Test helper: re-reads all three keys from localStorage. */
export function reloadViewPrefsForTests(): void {
  views.reload()
  scales.reload()
  recents.reload()
}
