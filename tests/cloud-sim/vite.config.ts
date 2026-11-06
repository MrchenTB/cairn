/**
 * Vite for the cloud-mode E2E run (port 5181, see playwright.cloud.config.ts): the app's own config
 * with a private dependency cache, so it can never disturb the dev server on :5180, and without file
 * watching or HMR, so edits made during a run cannot reload the page under a test.
 */
import { mergeConfig } from 'vite'
import base from '../../vite.config.ts'

export default mergeConfig(base, {
  cacheDir: 'node_modules/.vite-cloud',
  server: { hmr: false, watch: null },
})
