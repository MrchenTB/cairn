import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useMatches } from 'react-router'
import { useWorkspaceData } from '@/data/hooks'
import { collectCrumbs } from '../routeHandle'

/** Lets redirects (e.g. /my-tasks → /my-tasks/today) and the new page settle before speaking. */
const SETTLE_MS = 150

/**
 * Tells screen-reader users that an in-app navigation changed the page: a single-page app never
 * reloads, so nothing else announces it while focus stays on the link or shortcut they used.
 * Polite, page name only (the current breadcrumb). The first page, and `?task=` / other query
 * changes on the same page, are not announced — the Task Modal announces itself as it takes
 * focus. Mounted once by the AppShell.
 */
export function RouteAnnouncer() {
  const { pathname } = useLocation()
  const matches = useMatches()
  const data = useWorkspaceData()
  const label = useMemo(() => collectCrumbs(matches, data).at(-1)?.label ?? null, [matches, data])
  const labelRef = useRef(label)
  const previousPath = useRef(pathname)
  const [message, setMessage] = useState('')

  useLayoutEffect(() => {
    labelRef.current = label
  })

  useEffect(() => {
    if (previousPath.current === pathname) return undefined
    previousPath.current = pathname
    const timer = window.setTimeout(() => setMessage(labelRef.current ?? 'Cairn'), SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [pathname])

  return (
    <p
      data-slot="route-announcer"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {message}
    </p>
  )
}
