/**
 * The app's single Supabase client (created on first use, never in local mode).
 * Sessions persist in localStorage and refresh automatically; email-confirmation and
 * password-recovery links are picked up from the URL on load.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseConfig } from './config'

/** PostgREST requests abort after this long instead of hanging the write queue forever. */
export const REQUEST_TIMEOUT_MS = 30_000

let client: SupabaseClient | null = null

/** Lazy singleton. Throws when Supabase is not configured (local data mode). */
export function getSupabaseClient(): SupabaseClient {
  if (client) return client
  const config = getSupabaseConfig()
  if (!config) throw new Error('Supabase is not configured: Cairn is running in local data mode.')
  client = createClient(config.url, config.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    db: { timeout: REQUEST_TIMEOUT_MS },
  })
  return client
}
