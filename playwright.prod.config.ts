import { defineConfig, devices } from '@playwright/test'

/**
 * Production-build E2E: normal `vite build`s served the way Cloudflare serves them, with
 * public/_headers applied and the SPA fallback. Only this setup can catch CSP violations, a wrong
 * theme-script hash, broken lazy chunks or deep-link reloads, and what the bundle really ships.
 * One build runs in local mode, one in cloud mode with a made-up Supabase project.
 * `npm run test:prod` builds, serves and stops by itself; dist/ is not touched.
 */
const PORT = 5191
const CLOUD_PORT = 5192
const CLOUD_BUILD_DIR = 'test-results/prod-build-cloud'
export const BUILD_DIR = 'test-results/prod-build'
export const CANARY = 'canary-of-an-unused-vite-variable'
export const CLOUD_BASE_URL = `http://localhost:${CLOUD_PORT}`
export const FAKE_SUPABASE_URL = 'https://cairn-e2e-made-up.supabase.co'

function buildAndServe(outDir: string, port: number, env: Record<string, string>) {
  return {
    command: `npx vite build --outDir ${outDir} --emptyOutDir --logLevel error && node e2e-prod/static-server.mjs ${outDir} ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore' as const,
    stderr: 'pipe' as const,
    gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 2_000 },
    env: {
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
      VITE_SUPABASE_ANON_KEY: '',
      VITE_DATA_MODE: '',
      ...env,
    },
  }
}

export default defineConfig({
  testDir: 'e2e-prod',
  outputDir: 'test-results/e2e-prod',
  fullyParallel: true,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    buildAndServe(BUILD_DIR, PORT, { VITE_E2E_CANARY: CANARY }),
    buildAndServe(CLOUD_BUILD_DIR, CLOUD_PORT, {
      VITE_SUPABASE_URL: FAKE_SUPABASE_URL,
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_made_up_for_e2e',
    }),
  ],
})
