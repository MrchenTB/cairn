/**
 * Email-link failures (Supabase mode). When a password-reset or confirmation link is expired or
 * was already used, Supabase Auth redirects back with `#error=…&error_code=…` (implicit flow;
 * `?error=…` with PKCE). The router's redirects drop the hash before /login renders, so the
 * startup URL is read once in main.tsx and the sign-in page explains what happened.
 *
 * The URL text itself (`error_description`) is never shown: anyone can craft such a link, so
 * the message is always Cairn's own copy.
 */

export const EXPIRED_LINK_MESSAGE =
  'That email link is invalid or has expired. Sign in, or choose “Forgot password?” to get a new link.'
export const FAILED_LINK_MESSAGE = 'That email link didn’t work. Sign in, or request a new link.'

const EXPIRED_CODES = new Set(['otp_expired', 'access_denied', 'flow_state_expired'])

let captured: string | null = null

/** The message for an auth error in `href`, or null when the URL carries none. */
export function authRedirectErrorMessage(href: string): string | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const params = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : '')
  for (const [key, value] of url.searchParams) params.set(key, value)
  // Supabase always sends error_description (and usually error_code); a bare ?error= is not one.
  if (!params.has('error_code') && !params.has('error_description')) return null
  const code = params.get('error_code') ?? params.get('error')
  return code && EXPIRED_CODES.has(code) ? EXPIRED_LINK_MESSAGE : FAILED_LINK_MESSAGE
}

/** Reads the startup URL (call once, before the router redirects). */
export function captureAuthRedirectError(href: string = window.location.href): void {
  captured = authRedirectErrorMessage(href)
}

/** The captured message (null when the app did not start from a failed email link). */
export function peekAuthRedirectError(): string | null {
  return captured
}

/** Forget it once shown, so a later sign-out does not show it again. */
export function clearAuthRedirectError(): void {
  captured = null
}
