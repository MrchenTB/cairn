import { describe, expect, it } from 'vitest'
import { isSecretSupabaseKey, resolveConfig } from './config'

const URL = 'https://abcd1234.supabase.co'
const KEY = 'sb_publishable_123'

function jwt(payload: object): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`
}

describe('resolveConfig', () => {
  it('uses Supabase when the URL and the publishable key are set', () => {
    const config = resolveConfig({ VITE_SUPABASE_URL: URL, VITE_SUPABASE_PUBLISHABLE_KEY: KEY })
    expect(config.dataMode).toBe('supabase')
    expect(config.supabase).toEqual({ url: URL, key: KEY })
    expect(config.localReason).toBeNull()
  })

  it('falls back to the legacy anon key', () => {
    const anon = jwt({ role: 'anon' })
    const config = resolveConfig({ VITE_SUPABASE_URL: `${URL}/`, VITE_SUPABASE_ANON_KEY: anon })
    expect(config.dataMode).toBe('supabase')
    expect(config.supabase).toEqual({ url: URL, key: anon })
  })

  it('prefers the publishable key over the anon key', () => {
    const config = resolveConfig({
      VITE_SUPABASE_URL: URL,
      VITE_SUPABASE_PUBLISHABLE_KEY: KEY,
      VITE_SUPABASE_ANON_KEY: jwt({ role: 'anon' }),
    })
    expect(config.supabase?.key).toBe(KEY)
  })

  it('runs locally without keys, with blank values, or when forced', () => {
    expect(resolveConfig({}).dataMode).toBe('local')
    expect(resolveConfig({}).localReason).toBe('not_configured')
    expect(
      resolveConfig({ VITE_SUPABASE_URL: URL, VITE_SUPABASE_PUBLISHABLE_KEY: '  ' }).dataMode,
    ).toBe('local')
    const forced = resolveConfig({
      VITE_SUPABASE_URL: URL,
      VITE_SUPABASE_PUBLISHABLE_KEY: KEY,
      VITE_DATA_MODE: 'local',
    })
    expect(forced).toMatchObject({ dataMode: 'local', localReason: 'forced', supabase: null })
  })

  it('rejects invalid URLs and secret keys', () => {
    expect(
      resolveConfig({ VITE_SUPABASE_URL: 'not a url', VITE_SUPABASE_PUBLISHABLE_KEY: KEY })
        .localReason,
    ).toBe('invalid_url')
    expect(
      resolveConfig({ VITE_SUPABASE_URL: URL, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abc' }),
    ).toMatchObject({ dataMode: 'local', localReason: 'secret_key', supabase: null })
    expect(
      resolveConfig({
        VITE_SUPABASE_URL: URL,
        VITE_SUPABASE_ANON_KEY: jwt({ role: 'service_role' }),
      }).localReason,
    ).toBe('secret_key')
  })

  it('enables test hooks only in dev builds and the e2e mode', () => {
    expect(resolveConfig({ DEV: true, MODE: 'development' }).testHooksEnabled).toBe(true)
    expect(resolveConfig({ DEV: false, MODE: 'e2e' }).testHooksEnabled).toBe(true)
    expect(resolveConfig({ DEV: false, MODE: 'production' }).testHooksEnabled).toBe(false)
  })
})

describe('isSecretSupabaseKey', () => {
  it('detects secret and service-role keys only', () => {
    expect(isSecretSupabaseKey('sb_secret_x')).toBe(true)
    expect(isSecretSupabaseKey(jwt({ role: 'service_role' }))).toBe(true)
    expect(isSecretSupabaseKey(jwt({ role: 'anon' }))).toBe(false)
    expect(isSecretSupabaseKey(KEY)).toBe(false)
    expect(isSecretSupabaseKey('a.b.c')).toBe(false)
  })
})
