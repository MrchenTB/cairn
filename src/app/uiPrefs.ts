/**
 * Theme + sidebar preferences for the shell.
 *
 * Source of truth: the workspace store's `preferences`. The store seeds them at startup from the
 * device cache `localStorage['cairn:ui-prefs'] = { theme, sidebarCollapsed }` and rewrites that
 * cache whenever they change, so they are correct before the workspace loads; index.html reads
 * the same cache to set `.dark` before first paint. Changes go through
 * actions.updatePreferences (optimistic, synced, rolled back with a toast if saving fails).
 */
import { useCallback } from 'react'
import { useActions, usePreferences } from '@/data/hooks'
import type { ThemePreference } from '@/domain/types'

/** localStorage key of the startup cache (owned by the data store, read by index.html). */
export const UI_PREFS_KEY = 'cairn:ui-prefs'

export function useThemePreference(): ThemePreference {
  return usePreferences().theme
}

export function useSetThemePreference(): (theme: ThemePreference) => void {
  const actions = useActions()
  return useCallback(
    (theme: ThemePreference) => {
      void actions.updatePreferences({ theme })
    },
    [actions],
  )
}

export function useSidebarCollapsed(): boolean {
  return usePreferences().sidebarCollapsed
}

export function useSetSidebarCollapsed(): (collapsed: boolean) => void {
  const actions = useActions()
  return useCallback(
    (collapsed: boolean) => {
      void actions.updatePreferences({ sidebarCollapsed: collapsed })
    },
    [actions],
  )
}
