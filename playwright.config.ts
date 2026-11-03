import { defineConfig, devices } from '@playwright/test'

/**
 * E2E tests run against Vite in LOCAL data mode (no Supabase keys needed). An already running
 * dev server on :5180 is reused; otherwise one is started with VITE_DATA_MODE=local (Vite reads
 * VITE_* variables from the process environment too).
 */
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:5180',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite --mode e2e --port 5180 --strictPort',
    url: 'http://localhost:5180',
    reuseExistingServer: true,
    timeout: 60_000,
    env: { VITE_DATA_MODE: 'local' },
  },
})
