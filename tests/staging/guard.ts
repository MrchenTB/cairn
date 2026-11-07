/**
 * Safety rules of the staging acceptance suite (playwright.staging.config.ts, e2e-staging/). Pure
 * functions, no I/O: they decide whether a run may start at all, and which projects it may touch.
 * The suite signs in to a real Supabase project with ordinary test accounts, so everything here
 * errs on the side of refusing.
 */
import { isSecretSupabaseKey } from '../../src/data/secretKeys.ts'

/** Every project the suite creates starts with this; it is the only kind it ever deletes. */
export const TEST_PROJECT_PREFIX = '[e2e] '

export interface StagingAccount {
  email: string
  password: string
}

export interface StagingSettings {
  /** Project URL without a trailing slash. */
  url: string
  /** The project ref in the URL (null for a loopback URL in a dry run). */
  projectRef: string | null
  publishableKey: string
  userA: StagingAccount
  userB: StagingAccount
  dryRun: boolean
}

type Env = Readonly<Record<string, string | undefined>>

const REAL_URL = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])

function jwtRole(token: string): unknown {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='))
    return (JSON.parse(json) as { role?: unknown } | null)?.role
  } catch {
    return null
  }
}

/** A key a browser may hold: `sb_publishable_…`, or a legacy JWT whose role is `anon`. */
function isPublishableKey(key: string): boolean {
  if (key.startsWith('sb_publishable_')) return key.length > 'sb_publishable_'.length
  return jwtRole(key) === 'anon'
}

function value(env: Env, name: string): string {
  return (env[name] ?? '').trim()
}

/**
 * The settings of a run, or an Error that lists everything to fix. Values are never quoted in a
 * message (they may be passwords or keys); only variable names are.
 */
export function checkStagingEnv(env: Env, options: { dryRun: boolean }): StagingSettings {
  const { dryRun } = options
  const problems: string[] = []

  // 1. A secret or service-role key anywhere: nothing else matters.
  const secrets = Object.entries(env)
    .filter(
      ([name, raw]) =>
        (name.startsWith('VITE_') || name.startsWith('CAIRN_')) &&
        typeof raw === 'string' &&
        isSecretSupabaseKey(raw.trim()),
    )
    .map(([name]) => name)
    .sort()
  for (const name of secrets) {
    problems.push(
      `${name} holds a Supabase secret or service_role key. These tests run as ordinary users and ` +
        'never need one: remove it, and rotate that key in the Supabase dashboard if it was ever ' +
        'saved or shared.',
    )
  }

  // 2. The project: URL, its ref, and the two refs that name the staging and production projects.
  const rawUrl = value(env, 'VITE_SUPABASE_URL')
  const stagingRef = value(env, 'CAIRN_STAGING_PROJECT_REF')
  const productionRef = value(env, 'CAIRN_PRODUCTION_PROJECT_REF')
  let url = ''
  let urlRef: string | null = null

  if (rawUrl === '') {
    problems.push(
      dryRun
        ? 'VITE_SUPABASE_URL is empty: a dry run needs the local simulator URL.'
        : 'VITE_SUPABASE_URL is empty: set it to https://<staging project ref>.supabase.co.',
    )
  } else if (dryRun) {
    let parsed: URL | null = null
    try {
      parsed = new URL(rawUrl)
    } catch {
      problems.push('VITE_SUPABASE_URL is not a valid URL.')
    }
    if (parsed) {
      if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) {
        problems.push(
          'A dry run only talks to the local simulator: VITE_SUPABASE_URL must be ' +
            'http://127.0.0.1:<port> or http://localhost:<port>, never a remote host.',
        )
      } else {
        url = parsed.origin
      }
    }
  } else {
    const match = REAL_URL.exec(rawUrl)
    if (!match) {
      problems.push(
        'VITE_SUPABASE_URL must be exactly https://<project-ref>.supabase.co (the Project URL of ' +
          'the staging project, with no path and no other host).',
      )
    } else {
      urlRef = match[1]
      url = rawUrl.replace(/\/$/, '')
    }
    if (stagingRef === '') {
      problems.push(
        'CAIRN_STAGING_PROJECT_REF is empty: set it to the ref of the staging project, the ' +
          '<project-ref> part of VITE_SUPABASE_URL.',
      )
    } else if (urlRef !== null && urlRef !== stagingRef) {
      problems.push(
        'The project ref in VITE_SUPABASE_URL does not match CAIRN_STAGING_PROJECT_REF. ' +
          'The URL may point at the wrong project: fix whichever of the two is wrong.',
      )
    }
  }

  if (productionRef !== '') {
    if (urlRef !== null && urlRef === productionRef) {
      problems.push(
        'VITE_SUPABASE_URL points at the production project (its ref equals ' +
          'CAIRN_PRODUCTION_PROJECT_REF). Use the staging project.',
      )
    }
    if (stagingRef !== '' && stagingRef === productionRef) {
      problems.push(
        'CAIRN_STAGING_PROJECT_REF equals CAIRN_PRODUCTION_PROJECT_REF: staging and production ' +
          'must be two different projects.',
      )
    }
  }

  // 3. A browser-safe key.
  const publishableKey = value(env, 'VITE_SUPABASE_PUBLISHABLE_KEY')
  if (publishableKey === '') {
    problems.push(
      'VITE_SUPABASE_PUBLISHABLE_KEY is empty: set it to the staging project’s publishable key ' +
        '(sb_publishable_…).',
    )
  } else if (
    !secrets.includes('VITE_SUPABASE_PUBLISHABLE_KEY') &&
    !isPublishableKey(publishableKey)
  ) {
    problems.push(
      'VITE_SUPABASE_PUBLISHABLE_KEY is not a publishable key: expected sb_publishable_… (or a ' +
        'legacy JWT whose role is anon).',
    )
  }

  // 4. Two different test accounts.
  const userA = {
    email: value(env, 'CAIRN_STAGING_USER_A_EMAIL'),
    password: env.CAIRN_STAGING_USER_A_PASSWORD ?? '',
  }
  const userB = {
    email: value(env, 'CAIRN_STAGING_USER_B_EMAIL'),
    password: env.CAIRN_STAGING_USER_B_PASSWORD ?? '',
  }
  if (userA.email === '') problems.push('CAIRN_STAGING_USER_A_EMAIL is empty.')
  if (userA.password === '') problems.push('CAIRN_STAGING_USER_A_PASSWORD is empty.')
  if (userB.email === '') problems.push('CAIRN_STAGING_USER_B_EMAIL is empty.')
  if (userB.password === '') problems.push('CAIRN_STAGING_USER_B_PASSWORD is empty.')
  if (userA.email !== '' && userA.email.toLowerCase() === userB.email.toLowerCase()) {
    problems.push(
      'CAIRN_STAGING_USER_A_EMAIL and CAIRN_STAGING_USER_B_EMAIL are the same account: the ' +
        'isolation tests need two different accounts.',
    )
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to run the staging tests${dryRun ? ' (dry run)' : ''}. Fix the following in ` +
        `.env.staging.local (see .env.staging.example):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    )
  }

  return { url, projectRef: urlRef, publishableKey, userA, userB, dryRun }
}

/** True only for names the suite itself gives its projects. */
export function isTestProjectName(name: unknown): boolean {
  return typeof name === 'string' && name.startsWith(TEST_PROJECT_PREFIX)
}

/** The projects that are not test projects: data the suite must not touch (and must not run on). */
export function findForeignProjects<T extends { name?: unknown }>(projects: readonly T[]): T[] {
  return projects.filter((project) => !isTestProjectName(project.name))
}
