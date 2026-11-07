/**
 * Detection of Supabase settings that must not reach a deployed build: keys that must never be in
 * a browser, and URLs that cannot work. No imports and no `import.meta`: vite.config.ts uses this
 * too, to refuse a build that would ship such a key and to warn about such a URL.
 */

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='))
    const payload: unknown = JSON.parse(json)
    return typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** True for keys that bypass RLS and must never be shipped to a browser. */
export function isSecretSupabaseKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true
  return decodeJwtPayload(key)?.role === 'service_role'
}

/** Names of the VITE_ variables (all of them are public) that hold a secret key. */
export function findSecretEnvVars(env: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(env)
    .filter(
      ([name, value]) =>
        name.startsWith('VITE_') && typeof value === 'string' && isSecretSupabaseKey(value.trim()),
    )
    .map(([name]) => name)
}

/**
 * What is wrong with this VITE_SUPABASE_URL on a deployed site (null = nothing): config.ts falls
 * back to local mode on an invalid URL, connect-src in vercel.json only allows hosted projects
 * over https, and supabase-js appends its own paths. Worded to follow the variable's name.
 */
export function supabaseUrlProblem(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'is not a valid http(s) URL, so this build runs in local mode'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'is not a valid http(s) URL, so this build runs in local mode'
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co')) {
    return 'is not https://<project-ref>.supabase.co, so connect-src in vercel.json blocks it on a deployed site'
  }
  if (url.pathname !== '/') {
    return 'must be the project URL without a path, or every request goes to the wrong address'
  }
  return null
}
