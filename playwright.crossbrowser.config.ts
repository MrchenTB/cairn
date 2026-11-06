import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config.ts'

/** Opt-in Safari (WebKit) and Firefox run of the acceptance flows; needs `npx playwright install webkit firefox`. */
export default defineConfig({
  ...base,
  outputDir: 'test-results/crossbrowser',
  workers: 1,
  testMatch: /acceptance-(owner-profile|core|gantt)\.spec\.ts/,
  projects: [
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
})
