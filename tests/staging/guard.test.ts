import { describe, expect, it } from 'vitest'
import {
  checkStagingEnv,
  findForeignProjects,
  isTestProjectName,
  TEST_PROJECT_PREFIX,
} from './guard.ts'

const jwt = (role: string) => {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ role, iss: 'supabase' })}.signature`
}

const REAL = {
  VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc123',
  VITE_SUPABASE_ANON_KEY: '',
  VITE_DATA_MODE: '',
  CAIRN_STAGING_PROJECT_REF: 'abcdefghijklmnopqrst',
  CAIRN_PRODUCTION_PROJECT_REF: 'zzzzzzzzzzzzzzzzzzzz',
  CAIRN_STAGING_USER_A_EMAIL: 'a@example.test',
  CAIRN_STAGING_USER_A_PASSWORD: 'password-a',
  CAIRN_STAGING_USER_B_EMAIL: 'b@example.test',
  CAIRN_STAGING_USER_B_PASSWORD: 'password-b',
}

const DRY = {
  VITE_SUPABASE_URL: 'http://127.0.0.1:54398',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_cloudsim_test_key',
  CAIRN_STAGING_USER_A_EMAIL: 'a@example.test',
  CAIRN_STAGING_USER_A_PASSWORD: 'password-a',
  CAIRN_STAGING_USER_B_EMAIL: 'b@example.test',
  CAIRN_STAGING_USER_B_PASSWORD: 'password-b',
}

const real = (changes: Record<string, string | undefined> = {}) =>
  checkStagingEnv({ ...REAL, ...changes }, { dryRun: false })
const dry = (changes: Record<string, string | undefined> = {}) =>
  checkStagingEnv({ ...DRY, ...changes }, { dryRun: true })

describe('checkStagingEnv, real run', () => {
  it('accepts a matching staging setup and returns the parsed settings', () => {
    expect(real()).toEqual({
      url: 'https://abcdefghijklmnopqrst.supabase.co',
      projectRef: 'abcdefghijklmnopqrst',
      publishableKey: 'sb_publishable_abc123',
      userA: { email: 'a@example.test', password: 'password-a' },
      userB: { email: 'b@example.test', password: 'password-b' },
      dryRun: false,
    })
  })

  it('accepts a trailing slash, a legacy anon JWT, and no production ref at all', () => {
    const settings = real({
      VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co/',
      VITE_SUPABASE_PUBLISHABLE_KEY: jwt('anon'),
      CAIRN_PRODUCTION_PROJECT_REF: undefined,
    })
    expect(settings.url).toBe('https://abcdefghijklmnopqrst.supabase.co')
  })

  it('refuses a missing URL', () => {
    expect(() => real({ VITE_SUPABASE_URL: '' })).toThrow(/VITE_SUPABASE_URL is empty/)
    expect(() => real({ VITE_SUPABASE_URL: undefined })).toThrow(/VITE_SUPABASE_URL is empty/)
  })

  it.each([
    ['a non-supabase host', 'https://abcdefghijklmnopqrst.example.com'],
    ['a look-alike host', 'https://abcdefghijklmnopqrst.supabase.co.evil.test'],
    ['a credential trick', 'https://abcdefghijklmnopqrst.supabase.co@evil.test'],
    ['plain http', 'http://abcdefghijklmnopqrst.supabase.co'],
    ['a path', 'https://abcdefghijklmnopqrst.supabase.co/rest/v1'],
    ['a sub-domain', 'https://x.abcdefghijklmnopqrst.supabase.co'],
    ['a loopback host', 'http://127.0.0.1:54399'],
    ['a port', 'https://abcdefghijklmnopqrst.supabase.co:8443'],
    ['not a URL', 'abcdefghijklmnopqrst'],
  ])('refuses %s in real mode', (_name, url) => {
    expect(() => real({ VITE_SUPABASE_URL: url })).toThrow(
      /must be exactly https:\/\/<project-ref>\.supabase\.co/,
    )
  })

  it('refuses a URL whose ref is not CAIRN_STAGING_PROJECT_REF', () => {
    expect(() => real({ CAIRN_STAGING_PROJECT_REF: 'bbbbbbbbbbbbbbbbbbbb' })).toThrow(
      /does not match CAIRN_STAGING_PROJECT_REF/,
    )
  })

  it('refuses a missing CAIRN_STAGING_PROJECT_REF', () => {
    expect(() => real({ CAIRN_STAGING_PROJECT_REF: '' })).toThrow(
      /CAIRN_STAGING_PROJECT_REF is empty/,
    )
  })

  it('refuses a URL that is the production project', () => {
    expect(() =>
      real({
        VITE_SUPABASE_URL: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co',
        CAIRN_STAGING_PROJECT_REF: 'zzzzzzzzzzzzzzzzzzzz',
      }),
    ).toThrow(/points at the production project/)
  })

  it('refuses a URL that is production even when the staging ref was changed to match it', () => {
    expect(() =>
      real({
        VITE_SUPABASE_URL: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co',
        CAIRN_STAGING_PROJECT_REF: 'abcdefghijklmnopqrst',
      }),
    ).toThrow(/points at the production project/)
  })

  it('refuses a staging ref that equals the production ref', () => {
    expect(() => real({ CAIRN_PRODUCTION_PROJECT_REF: 'abcdefghijklmnopqrst' })).toThrow(
      /CAIRN_STAGING_PROJECT_REF equals CAIRN_PRODUCTION_PROJECT_REF/,
    )
  })

  it('does not treat an empty or blank production ref as set', () => {
    expect(real({ CAIRN_PRODUCTION_PROJECT_REF: '  ' }).projectRef).toBe('abcdefghijklmnopqrst')
  })
})

describe('checkStagingEnv, dry run', () => {
  it('accepts the simulator on 127.0.0.1 or localhost, ignoring the project refs', () => {
    expect(dry()).toEqual({
      url: 'http://127.0.0.1:54398',
      projectRef: null,
      publishableKey: 'sb_publishable_cloudsim_test_key',
      userA: { email: 'a@example.test', password: 'password-a' },
      userB: { email: 'b@example.test', password: 'password-b' },
      dryRun: true,
    })
    expect(dry({ VITE_SUPABASE_URL: 'http://localhost:54398' }).url).toBe('http://localhost:54398')
  })

  it.each([
    ['a hosted project', 'https://abcdefghijklmnopqrst.supabase.co'],
    ['another remote host', 'http://example.com:54398'],
    ['a look-alike of localhost', 'http://localhost.evil.test:54398'],
    ['a credential trick', 'http://127.0.0.1@evil.test'],
    ['https on loopback', 'https://127.0.0.1:54398'],
    ['a LAN address', 'http://192.168.1.10:54398'],
  ])('refuses %s', (_name, url) => {
    expect(() => dry({ VITE_SUPABASE_URL: url })).toThrow(/only talks to the local simulator/)
  })

  it('refuses a missing or invalid URL', () => {
    expect(() => dry({ VITE_SUPABASE_URL: '' })).toThrow(/needs the local simulator URL/)
    expect(() => dry({ VITE_SUPABASE_URL: 'not a url' })).toThrow(/not a valid URL/)
  })
})

describe('checkStagingEnv, keys', () => {
  it.each([
    ['sb_secret_ key', 'sb_secret_abc123'],
    ['service_role JWT', jwt('service_role')],
  ])('refuses a %s in the publishable key variable', (_name, key) => {
    expect(() => real({ VITE_SUPABASE_PUBLISHABLE_KEY: key })).toThrow(
      /VITE_SUPABASE_PUBLISHABLE_KEY holds a Supabase secret or service_role key/,
    )
  })

  it('refuses a service_role JWT sitting in any CAIRN_ variable', () => {
    const key = jwt('service_role')
    expect(() => real({ CAIRN_STAGING_NOTES: key })).toThrow(
      /CAIRN_STAGING_NOTES holds a Supabase secret or service_role key/,
    )
    expect(() => real({ CAIRN_STAGING_USER_A_PASSWORD: key })).toThrow(
      /CAIRN_STAGING_USER_A_PASSWORD holds a Supabase secret/,
    )
    expect(() => dry({ CAIRN_SOMETHING: key })).toThrow(/CAIRN_SOMETHING holds a Supabase secret/)
  })

  it('refuses a secret key in any other VITE_ variable, even an unused one', () => {
    expect(() => real({ VITE_SUPABASE_ANON_KEY: 'sb_secret_abc123' })).toThrow(
      /VITE_SUPABASE_ANON_KEY holds a Supabase secret/,
    )
    expect(() => real({ VITE_ANYTHING: jwt('service_role') })).toThrow(
      /VITE_ANYTHING holds a Supabase secret/,
    )
  })

  it('never prints the value of a secret key', () => {
    const key = jwt('service_role')
    expect(() => real({ CAIRN_X: key })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(key) }),
    )
  })

  it('does not look at variables that are not VITE_ or CAIRN_', () => {
    expect(real({ SOMETHING_ELSE: jwt('service_role') }).dryRun).toBe(false)
  })

  it('requires a publishable key', () => {
    expect(() => real({ VITE_SUPABASE_PUBLISHABLE_KEY: '' })).toThrow(
      /VITE_SUPABASE_PUBLISHABLE_KEY is empty/,
    )
    expect(() => real({ VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' })).toThrow(
      /not a publishable key/,
    )
    expect(() => real({ VITE_SUPABASE_PUBLISHABLE_KEY: 'whatever' })).toThrow(
      /not a publishable key/,
    )
    expect(() => real({ VITE_SUPABASE_PUBLISHABLE_KEY: jwt('authenticated') })).toThrow(
      /not a publishable key/,
    )
  })
})

describe('checkStagingEnv, accounts', () => {
  it.each([
    'CAIRN_STAGING_USER_A_EMAIL',
    'CAIRN_STAGING_USER_A_PASSWORD',
    'CAIRN_STAGING_USER_B_EMAIL',
    'CAIRN_STAGING_USER_B_PASSWORD',
  ])('refuses an empty %s', (name) => {
    expect(() => real({ [name]: '' })).toThrow(new RegExp(`${name} is empty`))
    expect(() => dry({ [name]: undefined })).toThrow(new RegExp(`${name} is empty`))
  })

  it('refuses the same account twice, ignoring case', () => {
    expect(() => real({ CAIRN_STAGING_USER_B_EMAIL: 'A@Example.test' })).toThrow(/the same account/)
  })

  it('lists every problem at once and names no values', () => {
    let message = ''
    try {
      real({
        VITE_SUPABASE_URL: '',
        CAIRN_STAGING_USER_A_PASSWORD: '',
        CAIRN_STAGING_USER_B_EMAIL: '',
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('VITE_SUPABASE_URL is empty')
    expect(message).toContain('CAIRN_STAGING_USER_A_PASSWORD is empty')
    expect(message).toContain('CAIRN_STAGING_USER_B_EMAIL is empty')
    expect(message).not.toContain('password-b')
  })
})

describe('test project names', () => {
  it('recognises only names the suite itself gives its projects', () => {
    expect(TEST_PROJECT_PREFIX).toBe('[e2e] ')
    expect(isTestProjectName('[e2e] run-1 Export')).toBe(true)
    expect(isTestProjectName('[e2e] ')).toBe(true)
    for (const name of ['[e2e]', '[E2E] x', ' [e2e] x', 'x [e2e] ', 'Real project', '', null, 42]) {
      expect(isTestProjectName(name), String(name)).toBe(false)
    }
  })

  it('finds the projects that are not test projects', () => {
    const projects = [{ name: '[e2e] a' }, { name: 'Personal' }, { name: '[e2e] b' }, { name: '' }]
    expect(findForeignProjects(projects)).toEqual([{ name: 'Personal' }, { name: '' }])
    expect(findForeignProjects([])).toEqual([])
    expect(findForeignProjects([{ name: '[e2e] only' }])).toEqual([])
  })
})
