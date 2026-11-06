import { describe, expect, it } from 'vitest'
import { findSecretEnvVars, isSecretSupabaseKey, resolveConfig } from './config'
import { supabaseUrlProblem } from './secretKeys'

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

describe('findSecretEnvVars', () => {
  it('names every VITE_ variable holding a secret key, whatever it is called', () => {
    expect(
      findSecretEnvVars({
        VITE_SUPABASE_URL: URL,
        VITE_SUPABASE_PUBLISHABLE_KEY: KEY,
        VITE_SUPABASE_SERVICE_ROLE_KEY: ' sb_secret_abc ',
        VITE_SOMETHING_ELSE: jwt({ role: 'service_role' }),
        VITE_SUPABASE_ANON_KEY: jwt({ role: 'anon' }),
        VITE_EMPTY: '',
        NOT_PUBLIC: 'sb_secret_abc',
        DEV: false,
      }),
    ).toEqual(['VITE_SUPABASE_SERVICE_ROLE_KEY', 'VITE_SOMETHING_ELSE'])
    expect(findSecretEnvVars({ VITE_SUPABASE_PUBLISHABLE_KEY: KEY })).toEqual([])
  })
})

describe('supabaseUrlProblem', () => {
  it('accepts a hosted project URL, with or without a trailing slash', () => {
    expect(supabaseUrlProblem('https://abcdefgh.supabase.co')).toBeNull()
    expect(supabaseUrlProblem('https://abcdefgh.supabase.co/')).toBeNull()
  })

  it('flags URLs that leave a deployed build in local mode', () => {
    for (const url of [
      'abcdefgh.supabase.co',
      'abcdefgh.supabase.co:443',
      'ftp://abcdefgh.supabase.co',
    ]) {
      expect(supabaseUrlProblem(url), url).toMatch(/local mode/)
    }
  })

  it('flags URLs that the CSP blocks on a deployed site', () => {
    for (const url of [
      'http://abcdefgh.supabase.co',
      'http://127.0.0.1:54321',
      'https://db.example.com',
      'https://supabase.co.evil.example',
    ]) {
      expect(supabaseUrlProblem(url), url).toMatch(/connect-src/)
    }
  })

  it('flags a URL with a path: supabase-js adds its own', () => {
    expect(supabaseUrlProblem('https://abcdefgh.supabase.co/rest/v1/')).toMatch(/without a path/)
  })
})
