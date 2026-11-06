/** Where the user goes after signing in (the page AuthGate sent them away from). */

const FALLBACK = '/overview'

/**
 * Only same-app paths are accepted as a post-login destination; anything else (missing, absolute,
 * protocol-relative, "/login" itself) goes to /overview. Browsers read "/\evil.com" like
 * "//evil.com", so the path must also resolve to this origin.
 */
export function safeReturnPath(from: string | undefined, origin = window.location.origin): string {
  if (!from || !from.startsWith('/') || from.startsWith('//') || from.includes('\\')) {
    return FALLBACK
  }
  try {
    const url = new URL(from, origin)
    if (
      url.origin !== origin ||
      // "/.//evil.com" normalises to the protocol-relative "//evil.com".
      url.pathname.startsWith('//') ||
      url.pathname === '/login' ||
      url.pathname.startsWith('/login/')
    ) {
      return FALLBACK
    }
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return FALLBACK
  }
}
