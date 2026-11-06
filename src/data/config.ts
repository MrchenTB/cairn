/**
 * Runtime configuration read from Vite env variables (`import.meta.env`, inlined at build time).
 *
 * Only PUBLIC values may reach the browser: the Supabase project URL and its publishable key
 * (`sb_publishable_…`, or the legacy anon JWT). `vite build` refuses a secret / service-role key
 * in any VITE_ variable (see vite.config.ts); it is refused here too, for the dev server. Read
 * variables one by one: reading `import.meta.env` as a value inlines every VITE_ variable.
 *
 * Mode selection (docs/architecture.md §6): Supabase mode when the URL and a key are set, unless
 * `VITE_DATA_MODE=local`; otherwise local mode (this browser's localStorage, no login).
 */
import type { DataMode } from './contracts'
import { isSecretSupabaseKey } from './secretKeys'

export { findSecretEnvVars, isSecretSupabaseKey } from './secretKeys'

/** The env variables this app reads. Values are untrusted until validated. */
export interface EnvSource {
  readonly VITE_SUPABASE_URL?: unknown
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: unknown
  readonly VITE_SUPABASE_ANON_KEY?: unknown
  readonly VITE_DATA_MODE?: unknown
  readonly MODE?: unknown
  readonly DEV?: unknown
}

export interface SupabaseConfig {
  url: string
  /** Publishable (or legacy anon) key. */
  key: string
}

/** Why local mode was selected (null in Supabase mode). */
export type LocalModeReason = 'forced' | 'not_configured' | 'invalid_url' | 'secret_key'

export interface AppConfig {
  dataMode: DataMode
  supabase: SupabaseConfig | null
  localReason: LocalModeReason | null
  /** Vite mode: 'development', 'production', 'e2e', 'test', … */
  viteMode: string
  /** Dev builds and the 'e2e' mode expose `window.__cairnTest` in local mode. */
  testHooksEnabled: boolean
}

function envString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** Pure mode resolution (exported for tests). */
export function resolveConfig(env: EnvSource): AppConfig {
  const viteMode = envString(env.MODE) ?? 'production'
  const testHooksEnabled = env.DEV === true || viteMode === 'e2e'
  const base = { viteMode, testHooksEnabled }
  const local = (localReason: LocalModeReason): AppConfig => ({
    ...base,
    dataMode: 'local',
    supabase: null,
    localReason,
  })

  if (envString(env.VITE_DATA_MODE)?.toLowerCase() === 'local') return local('forced')
  const url = envString(env.VITE_SUPABASE_URL)
  const key = envString(env.VITE_SUPABASE_PUBLISHABLE_KEY) ?? envString(env.VITE_SUPABASE_ANON_KEY)
  if (!url || !key) return local('not_configured')
  if (!isHttpUrl(url)) return local('invalid_url')
  if (isSecretSupabaseKey(key)) return local('secret_key')
  return {
    ...base,
    dataMode: 'supabase',
    supabase: { url: url.replace(/\/+$/, ''), key },
    localReason: null,
  }
}

/** Configuration of this build (computed once at startup). */
export const appConfig: AppConfig = resolveConfig({
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
  VITE_DATA_MODE: import.meta.env.VITE_DATA_MODE,
  MODE: import.meta.env.MODE,
  DEV: import.meta.env.DEV,
})

if (appConfig.localReason === 'invalid_url') {
  console.error('[cairn] VITE_SUPABASE_URL is not a valid http(s) URL — running in local mode.')
} else if (appConfig.localReason === 'secret_key') {
  console.error(
    '[cairn] The configured Supabase key is a secret/service-role key. It must NEVER be used in ' +
      'the browser: remove it from your env files and rotate it. Running in local mode.',
  )
}

/** 'supabase' (cloud sync) or 'local' (this browser only). */
export function getDataMode(): DataMode {
  return appConfig.dataMode
}

/** Supabase URL + publishable key, or null in local mode. */
export function getSupabaseConfig(): SupabaseConfig | null {
  return appConfig.supabase
}

/** Whether `window.__cairnTest` may be installed (local mode only, dev/e2e builds only). */
export function isTestHooksEnabled(): boolean {
  return appConfig.testHooksEnabled
}
