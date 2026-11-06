/**
 * Timeline conveniences, never synced: which projects are expanded (this browser session only,
 * so a fresh start is calm again) and "Include completed" (per device). The scale lives in
 * src/app/viewPrefs.ts under the scope 'timeline'.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { readJSON, writeJSON } from '@/lib/storage'

const EXPANDED_KEY = 'cairn:timeline-expanded'
const INCLUDE_COMPLETED_KEY = 'cairn:timeline-include-completed'

// Every sessionStorage access can throw (private mode, blocked site data): memory still works.
function readExpanded(): ReadonlySet<string> {
  try {
    const raw = window.sessionStorage.getItem(EXPANDED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
}

function writeExpanded(ids: ReadonlySet<string>): void {
  try {
    window.sessionStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]))
  } catch {
    // Remembered in memory for this page load only.
  }
}

let expanded = readExpanded()
let includeCompleted = readJSON(INCLUDE_COMPLETED_KEY) === true
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function toggleExpanded(projectId: string): void {
  const next = new Set(expanded)
  if (!next.delete(projectId)) next.add(projectId)
  expanded = next
  writeExpanded(next)
  emit()
}

/** [expanded project ids, toggle]. Nothing is expanded until the user asks (readability first). */
export function useExpandedProjects(): [ReadonlySet<string>, (projectId: string) => void] {
  const ids = useSyncExternalStore(subscribe, () => expanded)
  return [ids, toggleExpanded]
}

/** [include completed projects, setter] (default false; archived projects are never shown). */
export function useIncludeCompleted(): [boolean, (include: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => includeCompleted)
  const set = useCallback((next: boolean) => {
    if (next === includeCompleted) return
    includeCompleted = next
    writeJSON(INCLUDE_COMPLETED_KEY, next)
    emit()
  }, [])
  return [value, set]
}

/** Test helper: re-reads both values from storage. */
export function reloadTimelinePrefsForTests(): void {
  expanded = readExpanded()
  includeCompleted = readJSON(INCLUDE_COMPLETED_KEY) === true
  emit()
}
