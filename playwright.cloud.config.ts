import { defineConfig, devices } from '@playwright/test'

/**
 * Cloud-mode E2E: the real app in Supabase mode against the local simulator (tests/cloud-sim, real
 * migration on PGlite). `npm run test:cloud` starts both servers and stops them afterwards. Specs
 * share one simulator, so they run one at a time.
 */
const SIM_PORT = 54399
const APP_PORT = 5181

const SIM_URL = `http://127.0.0.1:${SIM_PORT}`

export default defineConfig({
  testDir: 'e2e-cloud',
  outputDir: 'test-results/e2e-cloud',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
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
      command: `npx vite --config tests/cloud-sim/vite.config.ts --port ${APP_PORT} --strictPort`,
      url: `http://localhost:${APP_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 2_000 },
      env: {
        VITE_SUPABASE_URL: SIM_URL,
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_cloudsim_test_key',
        VITE_SUPABASE_ANON_KEY: '',
        VITE_DATA_MODE: '',
      },
    },
  ],
})
