/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { findSecretEnvVars, supabaseUrlProblem } from './src/data/secretKeys.ts'

/**
 * Build-time checks on the VITE_ variables (all of them public). A secret key stops the build: at
 * runtime it would be too late, the key would already be in the bundle. Missing or unusable
 * Supabase settings only warn, because the result is a valid build, but one that does not sync.
 */
function checkPublicEnv(): Plugin {
  return {
    name: 'cairn:check-public-env',
    apply: 'build',
    configResolved(config) {
      const secrets = findSecretEnvVars(config.env)
      if (secrets.length > 0) {
        throw new Error(
          `Refusing to build: ${secrets.join(', ')} holds a Supabase secret or service-role key. ` +
            'VITE_ variables are public and that key bypasses Row Level Security. Remove it, ' +
            'rotate it in the Supabase dashboard and use the publishable key.',
        )
      }
      const { VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, VITE_SUPABASE_ANON_KEY } =
        config.env
      const hasSupabase =
        VITE_SUPABASE_URL && (VITE_SUPABASE_PUBLISHABLE_KEY || VITE_SUPABASE_ANON_KEY)
      if (config.mode === 'production' && !hasSupabase) {
        config.logger.warn(
          'Supabase is not configured: this build runs in local mode, with data only in each ' +
            'browser and no sign-in or sync ("Local only — not synced").',
        )
      }
      if (config.mode === 'production' && hasSupabase) {
        const problem = supabaseUrlProblem(VITE_SUPABASE_URL.trim())
        if (problem) config.logger.warn(`VITE_SUPABASE_URL ${problem}.`)
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), checkPublicEnv()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          include: ['src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'db',
          include: ['tests/db/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
