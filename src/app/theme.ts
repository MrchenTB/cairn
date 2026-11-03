import { createContext, useContext, useSyncExternalStore } from 'react'
import type { ThemePreference } from '@/domain/types'

export type ResolvedTheme = 'light' | 'dark'

export interface ThemeContextValue {
  /** What the user chose (system / light / dark). */
  preference: ThemePreference
  /** What is applied right now. */
  resolved: ResolvedTheme
  setPreference: (theme: ThemePreference) => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

/** Current theme preference, applied theme and setter (requires <ThemeProvider>). */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>')
  return value
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

function subscribeSystemTheme(callback: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const query = window.matchMedia(DARK_QUERY)
  query.addEventListener('change', callback)
  return () => query.removeEventListener('change', callback)
}

function getSystemDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(DARK_QUERY).matches
}

/** Live `prefers-color-scheme: dark` (updates when the OS theme changes). */
export function useSystemPrefersDark(): boolean {
  return useSyncExternalStore(subscribeSystemTheme, getSystemDark, () => false)
}
