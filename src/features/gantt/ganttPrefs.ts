/**
 * Per-device Gantt conveniences (localStorage via '@/lib/storage', never synced): the outline
 * pane width and which groups / parents are collapsed per project. The scale lives in
 * src/app/viewPrefs.ts (shared with the cross-project Timeline).
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { isPlainObject, onStorageKey, readJSON, writeJSON } from '@/lib/storage'
import { PANE_WIDTH_DEFAULT, PANE_WIDTH_MAX, PANE_WIDTH_MIN } from './model/constants'

const PANE_KEY = 'cairn:gantt-pane-width'
const COLLAPSED_KEY = 'cairn:gantt-collapsed'
/** Keys kept per project (oldest collapsed rows are dropped beyond this). */
const MAX_COLLAPSED_PER_PROJECT = 500

export function clampPaneWidth(width: number): number {
  if (!Number.isFinite(width)) return PANE_WIDTH_DEFAULT
  return Math.min(PANE_WIDTH_MAX, Math.max(PANE_WIDTH_MIN, Math.round(width)))
}

function createStored<T>(key: string, parse: (raw: unknown) => T) {
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
    set(next: T, persist = true) {
      snapshot = next
      if (persist) writeJSON(key, next)
      emit()
    },
    persist() {
      writeJSON(key, snapshot)
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const paneWidth = createStored(PANE_KEY, (raw) =>
  typeof raw === 'number' ? clampPaneWidth(raw) : PANE_WIDTH_DEFAULT,
)

const collapsed = createStored(COLLAPSED_KEY, (raw): Record<string, string[]> => {
  const result: Record<string, string[]> = {}
  if (!isPlainObject(raw)) return result
  for (const [projectId, keys] of Object.entries(raw)) {
    if (Array.isArray(keys))
      result[projectId] = keys.filter((k): k is string => typeof k === 'string')
  }
  return result
})

/**
 * [width, setWidth, commit]: `setWidth` updates live (e.g. while dragging the splitter) without
 * writing storage; `commit` persists the current width.
 */
export function usePaneWidth(): [number, (width: number) => void, () => void] {
  const width = useSyncExternalStore(paneWidth.subscribe, paneWidth.get, paneWidth.get)
  const setWidth = useCallback((next: number) => paneWidth.set(clampPaneWidth(next), false), [])
  const commit = useCallback(() => paneWidth.persist(), [])
  return [width, setWidth, commit]
}

const EMPTY: readonly string[] = []

/** Collapsed row keys of a project and a toggle. */
export function useCollapsedRows(
  projectId: string,
): [ReadonlySet<string>, (key: string, collapse?: boolean) => void] {
  const all = useSyncExternalStore(collapsed.subscribe, collapsed.get, collapsed.get)
  const keys = all[projectId] ?? EMPTY
  const set = useMemo<ReadonlySet<string>>(() => new Set(keys), [keys])
  const toggle = useCallback(
    (key: string, collapse?: boolean) => {
      const current = collapsed.get()[projectId] ?? []
      const isCollapsed = current.includes(key)
      const next = collapse ?? !isCollapsed
      if (next === isCollapsed) return
      const updated = next
        ? [...current, key].slice(-MAX_COLLAPSED_PER_PROJECT)
        : current.filter((k) => k !== key)
      collapsed.set({ ...collapsed.get(), [projectId]: updated })
    },
    [projectId],
  )
  return [set, toggle]
}
