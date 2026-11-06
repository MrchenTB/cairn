/**
 * The app's single Supabase client (created on first use, never in local mode).
 * Sessions persist in localStorage and refresh automatically; email-confirmation and
 * password-recovery links are picked up from the URL on load.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseConfig } from './config'

/** Every request gives up after this long instead of hanging the write queue or a form forever. */
export const REQUEST_TIMEOUT_MS = 30_000

/**
 * A stored session that is not a JSON object (damaged storage) makes the auth library log an
 * error on every start; it is dropped so the app starts at the sign-in page quietly.
 */
function dropUnreadableStoredSession(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i)
      if (!key || !/^sb-.+-auth-token$/.test(key)) continue
      const raw = localStorage.getItem(key)
      let readable = false
      try {
        const value: unknown = JSON.parse(raw ?? 'null')
        readable = typeof value === 'object' && value !== null
      } catch {
        readable = false
      }
      if (!readable) localStorage.removeItem(key)
    }
  } catch {
    // storage unavailable: the library copes with that itself
  }
}

/**
 * `fetch` with a deadline, for every request of the client (`db.timeout` only covers PostgREST, and
 * only until the answer starts). The deadline stays armed once the answer has started: it also
 * covers a body that never finishes. The caller's own abort passes through with its reason.
 */
export async function fetchWithDeadline(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const deadline = new AbortController()
  const caller = init?.signal
  const disarm = () => {
    clearTimeout(timer)
    caller?.removeEventListener('abort', onCallerAbort)
  }
  const onCallerAbort = () => {
    disarm()
    deadline.abort(caller?.reason)
  }
  const timer = setTimeout(() => {
    disarm()
    deadline.abort()
  }, REQUEST_TIMEOUT_MS)
  if (caller?.aborted) onCallerAbort()
  else caller?.addEventListener('abort', onCallerAbort, { once: true })
  try {
    return await fetch(input, { ...init, signal: deadline.signal })
  } catch (error) {
    disarm()
    throw error
  }
}

let client: SupabaseClient | null = null

/** Lazy singleton. Throws when Supabase is not configured (local data mode). */
export function getSupabaseClient(): SupabaseClient {
  if (client) return client
  const config = getSupabaseConfig()
  if (!config) throw new Error('Supabase is not configured: Cairn is running in local data mode.')
  dropUnreadableStoredSession()
  client = createClient(config.url, config.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    global: { fetch: fetchWithDeadline },
  })
  return client
}
