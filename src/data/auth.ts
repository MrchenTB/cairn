/**
 * Authentication services. Supabase mode uses email + password (Supabase Auth, session kept in
 * localStorage and refreshed automatically). Local mode has no accounts: the user is always
 * signed in as `LOCAL_USER`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppErrorKind } from '@/domain/types'
import type { AuthChangeEvent, AuthService, AuthUser, DataMode } from './contracts'
import {
  NETWORK_ERROR_MESSAGE,
  RepositoryError,
  isFetchFailure,
  readableServerMessage,
} from './errors'
import { getSupabaseClient } from './supabaseClient'

/** The only "user" of local mode. */
export const LOCAL_USER: Readonly<AuthUser> = Object.freeze({ id: 'local-user', email: null })

/** The parts of `supabase.auth` this app uses. */
export type SupabaseAuthClient = Pick<
  SupabaseClient['auth'],
  | 'getSession'
  | 'onAuthStateChange'
  | 'signInWithPassword'
  | 'signUp'
  | 'signOut'
  | 'resetPasswordForEmail'
  | 'updateUser'
>

const AUTH_ERRORS: Record<string, readonly [AppErrorKind, string | null]> = {
  invalid_credentials: ['auth', 'Incorrect email or password.'],
  email_not_confirmed: [
    'auth',
    'Confirm your email address first — check your inbox for the link.',
  ],
  user_not_found: ['auth', 'Incorrect email or password.'],
  user_banned: ['permission', 'This account has been disabled.'],
  user_already_exists: ['conflict', 'An account with this email already exists.'],
  email_exists: ['conflict', 'An account with this email already exists.'],
  signup_disabled: ['permission', 'New sign-ups are disabled for this app.'],
  email_provider_disabled: ['permission', 'Email sign-in is disabled for this app.'],
  email_address_invalid: ['validation', 'Enter a valid email address.'],
  email_address_not_authorized: [
    'permission',
    "Emails can't be sent to this address yet (the project's email service is restricted).",
  ],
  weak_password: ['validation', null],
  validation_failed: ['validation', null],
  same_password: ['validation', 'Choose a password different from the current one.'],
  reauthentication_needed: [
    'auth',
    'For your security, sign in again before changing your password.',
  ],
  reauthentication_not_valid: [
    'auth',
    'For your security, sign in again before changing your password.',
  ],
  over_request_rate_limit: ['unknown', 'Too many attempts. Wait a moment and try again.'],
  over_email_send_rate_limit: ['unknown', 'Too many emails were sent. Try again later.'],
  session_expired: ['auth', 'Your session has expired. Sign in again.'],
  session_not_found: ['auth', 'Your session has expired. Sign in again.'],
  refresh_token_not_found: ['auth', 'Your session has expired. Sign in again.'],
  refresh_token_already_used: ['auth', 'Your session has expired. Sign in again.'],
  request_timeout: ['network', NETWORK_ERROR_MESSAGE],
}

/** Maps Supabase Auth errors (AuthError: name/status/code/message) to RepositoryErrors. */
export function toAuthError(error: unknown): RepositoryError {
  if (error instanceof RepositoryError) return error
  if (isFetchFailure(error)) return new RepositoryError('network', NETWORK_ERROR_MESSAGE, error)
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    name?: unknown
    code?: unknown
    status?: unknown
    message?: unknown
  }
  if (e.name === 'AuthRetryableFetchError' || e.status === 0) {
    return new RepositoryError('network', NETWORK_ERROR_MESSAGE, error)
  }
  // No session to act on (signed out meanwhile, or a reset link opened too long ago).
  if (e.name === 'AuthSessionMissingError') {
    return new RepositoryError('auth', 'Your session has expired. Sign in again.', error)
  }
  const known = typeof e.code === 'string' ? AUTH_ERRORS[e.code] : undefined
  if (known) {
    const [kind, message] = known
    return new RepositoryError(
      kind,
      message ?? readableServerMessage(e.message) ?? 'Check the details and try again.',
      error,
    )
  }
  if (e.status === 429) {
    return new RepositoryError('unknown', 'Too many attempts. Wait a moment and try again.', error)
  }
  return new RepositoryError(
    'auth',
    readableServerMessage(e.message) ?? 'Sign-in failed. Please try again.',
    error,
  )
}

function toAuthUser(user: { id: string; email?: string | null }): AuthUser {
  return { id: user.id, email: user.email ?? null }
}

const AUTH_EVENTS: Record<string, AuthChangeEvent> = {
  INITIAL_SESSION: 'initial_session',
  SIGNED_IN: 'signed_in',
  SIGNED_OUT: 'signed_out',
  TOKEN_REFRESHED: 'token_refreshed',
  USER_UPDATED: 'user_updated',
  PASSWORD_RECOVERY: 'password_recovery',
}

function defaultRedirect(): string {
  return typeof window === 'undefined' ? '' : window.location.origin
}

/**
 * Supabase Auth service. `onChange` callbacks run on a later task (setTimeout 0): code that
 * reacts to auth events calls Supabase again, which must not happen inside the auth callback.
 */
export function createSupabaseAuthService(
  auth: SupabaseAuthClient,
  options: { redirectTo?: () => string } = {},
): AuthService {
  const redirectTo = options.redirectTo ?? defaultRedirect
  return {
    mode: 'supabase',
    async getUser() {
      const { data, error } = await auth.getSession()
      if (error) throw toAuthError(error)
      return data.session ? toAuthUser(data.session.user) : null
    },
    onChange(callback) {
      let subscribed = true
      const { data } = auth.onAuthStateChange((event, session) => {
        const user = session ? toAuthUser(session.user) : null
        const kind = Object.hasOwn(AUTH_EVENTS, event) ? AUTH_EVENTS[event] : undefined
        // An event still on its way once the subscriber left is dropped, like later ones.
        setTimeout(() => {
          if (subscribed) callback(user, kind)
        }, 0)
      })
      return () => {
        subscribed = false
        data.subscription.unsubscribe()
      }
    },
    async signIn(email, password) {
      const { error } = await auth.signInWithPassword({ email, password })
      if (error) throw toAuthError(error)
    },
    async signUp(email, password) {
      const { data, error } = await auth.signUp({
        email,
        password,
        options: { emailRedirectTo: redirectTo() },
      })
      if (error) throw toAuthError(error)
      // No session = the project requires email confirmation before the first sign-in.
      return { needsConfirmation: !data.session }
    },
    async signOut() {
      // 'local': sign out this browser only, not the user's other devices.
      const { error } = await auth.signOut({ scope: 'local' })
      if (error) throw toAuthError(error)
    },
    async sendPasswordReset(email) {
      const { error } = await auth.resetPasswordForEmail(email, { redirectTo: redirectTo() })
      if (error) throw toAuthError(error)
    },
    async updatePassword(newPassword) {
      const { error } = await auth.updateUser({ password: newPassword })
      if (error) throw toAuthError(error)
    },
  }
}

/** Local mode: always signed in as LOCAL_USER; account actions are no-ops. */
export function createLocalAuthService(): AuthService {
  return {
    mode: 'local',
    getUser: async () => ({ ...LOCAL_USER }),
    onChange: () => () => {},
    signIn: async () => {},
    signUp: async () => ({ needsConfirmation: false }),
    signOut: async () => {},
    sendPasswordReset: async () => {},
    updatePassword: async () => {},
  }
}

/** The service for `mode` (Supabase client created on first use). */
export function createAuthService(mode: DataMode): AuthService {
  return mode === 'supabase'
    ? createSupabaseAuthService(getSupabaseClient().auth)
    : createLocalAuthService()
}
