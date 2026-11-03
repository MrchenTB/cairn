import { Navigate, Outlet, useLocation } from 'react-router'
import { useAuth } from '@/data/hooks'
import { AppSplash } from './AppSplash'

/** Location state passed to /login so the user returns to the page they asked for. */
export interface LoginRedirectState {
  from?: string
}

/**
 * Protects the app. Local mode: always signed in. Supabase mode: splash while the session is
 * restored, /login (remembering the intended URL) when signed out. Loading/clearing the
 * workspace on sign-in/out is done by the auth store.
 */
export function AuthGate() {
  const { mode, status } = useAuth()
  const location = useLocation()

  if (mode === 'local' || status === 'signed_in') return <Outlet />
  if (status === 'loading') return <AppSplash />
  const state: LoginRedirectState = {
    from: `${location.pathname}${location.search}${location.hash}`,
  }
  return <Navigate to="/login" replace state={state} />
}
