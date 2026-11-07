import { defineConfig, devices } from '@playwright/test'
import { loadEnv } from 'vite'
import { checkStagingEnv, type StagingSettings } from './tests/staging/guard.ts'

/**
 * Staging acceptance suite (docs/cloud-test-plan.md, phase 1): the real app in Supabase mode against
 * a REAL staging project, as two ordinary test accounts. `npm run test:staging`.
 *
 * Settings come from `.env.staging.local` (see `.env.staging.example`) and are checked here, at
 * config load, so a wrong setup stops the run before any server starts or any request is made:
 * tests/staging/guard.ts.
 *
 * `CAIRN_STAGING_DRY_RUN=1` (`npm run test:staging:dry-run`) runs the same specs against the local
 * simulator (tests/cloud-sim) on ports of its own, ignoring `.env.staging.local` completely. It
 * proves the tests themselves work; it proves nothing about Supabase.
 *
 * One worker, one spec at a time: the specs share two accounts, and a hosted project rate-limits.
 */
const dryRun = process.env.CAIRN_STAGING_DRY_RUN === '1'

const SIM_PORT = 54398
const APP_PORT = dryRun ? 5184 : 5183
const SIM_URL = `http://127.0.0.1:${SIM_PORT}`

/** The names the guard and the specs read; nothing else is copied from the env files. */
const SETTING_NAMES = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_DATA_MODE',
  'CAIRN_STAGING_PROJECT_REF',
  'CAIRN_PRODUCTION_PROJECT_REF',
  'CAIRN_STAGING_USER_A_EMAIL',
  'CAIRN_STAGING_USER_A_PASSWORD',
  'CAIRN_STAGING_USER_B_EMAIL',
  'CAIRN_STAGING_USER_B_PASSWORD',
] as const

const DRY_RUN_ENV: Record<(typeof SETTING_NAMES)[number], string> = {
  VITE_SUPABASE_URL: SIM_URL,
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_cloudsim_test_key',
  VITE_SUPABASE_ANON_KEY: '',
  VITE_DATA_MODE: '',
  CAIRN_STAGING_PROJECT_REF: '',
  CAIRN_PRODUCTION_PROJECT_REF: '',
  CAIRN_STAGING_USER_A_EMAIL: 'staging-a@example.test',
  CAIRN_STAGING_USER_A_PASSWORD: 'dry run password a',
  CAIRN_STAGING_USER_B_EMAIL: 'staging-b@example.test',
  CAIRN_STAGING_USER_B_PASSWORD: 'dry run password b',
}

function resolveSettings(): { env: Record<string, string>; settings: StagingSettings } {
  // A dry run never reads .env.staging.local, so it can never be pointed at a real project.
  const loaded = dryRun ? DRY_RUN_ENV : loadEnv('staging', process.cwd(), '')
  const env = Object.fromEntries(SETTING_NAMES.map((name) => [name, loaded[name] ?? ''])) as Record<
    string,
    string
  >
  try {
    // The whole loaded environment is checked, so a secret key in any VITE_ or CAIRN_ variable counts.
    return { env, settings: checkStagingEnv(loaded, { dryRun }) }
  } catch (error) {
    console.error(`\n${(error as Error).message}\n`)
    process.exit(1)
  }
}

const { env, settings } = resolveSettings()
// Workers, global setup and the web servers read the checked settings from the environment.
Object.assign(process.env, env)

const appServer = {
  url: `http://localhost:${APP_PORT}`,
  reuseExistingServer: false,
  timeout: 120_000,
  stdout: 'ignore' as const,
  stderr: 'pipe' as const,
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 2_000 },
  // The app gets exactly the values the guard approved, whatever else is in the environment.
  env: {
    VITE_SUPABASE_URL: settings.url,
    VITE_SUPABASE_PUBLISHABLE_KEY: settings.publishableKey,
    VITE_SUPABASE_ANON_KEY: '',
    VITE_DATA_MODE: '',
  },
}

export default defineConfig({
  testDir: 'e2e-staging',
  outputDir: 'test-results/staging',
  globalSetup: './e2e-staging/global-setup.ts',
  globalTeardown: './e2e-staging/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: dryRun
    ? [
        {
          command: `node --disable-warning=ExperimentalWarning tests/cloud-sim/server.ts --port ${SIM_PORT}`,
          url: `${SIM_URL}/__sim/health`,
          reuseExistingServer: false,
          timeout: 60_000,
          stdout: 'ignore',
          stderr: 'pipe',
          gracefulShutdown: { signal: 'SIGTERM', timeout: 2_000 },
        },
        {
          ...appServer,
          command: `npx vite --config tests/cloud-sim/vite.config.ts --mode staging --port ${APP_PORT} --strictPort`,
        },
      ]
    : [
        {
          ...appServer,
          command: `npx vite --config tests/cloud-sim/vite.config.ts --mode staging --port ${APP_PORT} --strictPort`,
        },
      ],
})
