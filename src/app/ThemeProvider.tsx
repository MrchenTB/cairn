import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { ThemeContext, useSystemPrefersDark, type ThemeContextValue } from './theme'
import { useSetThemePreference, useThemePreference } from './uiPrefs'

/**
 * Applies the theme: preferences.theme (+ the live OS preference for "system") → `.dark` on
 * <html> and the browser theme-color. Colour transitions are suppressed for the switch frame so
 * the whole UI changes at once.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const preference = useThemePreference()
  const setPreference = useSetThemePreference()
  const systemDark = useSystemPrefersDark()
  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
  const firstRun = useRef(true)

  useLayoutEffect(() => {
    const root = document.documentElement
    const isDark = resolved === 'dark'
    if (firstRun.current || root.classList.contains('dark') === isDark) {
      root.classList.toggle('dark', isDark)
    } else {
      root.classList.add('no-transitions')
      root.classList.toggle('dark', isDark)
      root.getBoundingClientRect() // flush styles while transitions are off
      requestAnimationFrame(() => root.classList.remove('no-transitions'))
    }
    firstRun.current = false
    const appBackground = getComputedStyle(root).getPropertyValue('--bg-app').trim()
    if (appBackground) {
      for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
        meta.setAttribute('content', appBackground)
      }
    }
  }, [resolved])

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  )
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
