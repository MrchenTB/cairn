import { useEffect, useState } from 'react'
import { LogoMark } from '@/components/brand/Logo'

/** After this long the splash says so: restoring a session can wait on a slow or absent server. */
export const SLOW_SPLASH_AFTER_MS = 10_000

/** Full-screen placeholder while the session or the first route chunk loads. */
export function AppSplash() {
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_SPLASH_AFTER_MS)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div
      role="status"
      aria-label="Loading Cairn"
      className="grid h-dvh place-content-center justify-items-center gap-3 bg-app text-fg-tertiary"
    >
      <LogoMark size={28} className="opacity-60 motion-safe:animate-fade-in-delayed" />
      {slow ? <p className="text-meta">This is taking longer than usual…</p> : null}
    </div>
  )
}
