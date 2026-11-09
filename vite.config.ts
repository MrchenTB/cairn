/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { findSecretEnvVars, supabaseUrlProblem } from './src/data/secretKeys.ts'
import { projectRefOf, supabaseTargetProblem } from './src/data/supabaseProjects.ts'

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
      const deployed = config.mode === 'production' || config.mode === 'staging'
      if (deployed && !hasSupabase) {
        config.logger.warn(
          'Supabase is not configured: this build runs in local mode, with data only in each ' +
            'browser and no sign-in or sync ("Local only — not synced").',
        )
      }
      if (deployed && hasSupabase) {
        const problem = supabaseUrlProblem(VITE_SUPABASE_URL.trim())
        if (problem) config.logger.warn(`VITE_SUPABASE_URL ${problem}.`)
      }
    },
  }
}

/**
 * Real data stays out of everything but the production site: refuses a dev server or build on this
 * computer that points at production, and a Vercel build whose variables have the wrong scope.
 */
function checkSupabaseTarget(): Plugin {
  return {
    name: 'cairn:check-supabase-target',
    configResolved(config) {
      const vercelEnv = process.env.VERCEL_ENV
      const { VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, VITE_SUPABASE_ANON_KEY } =
        config.env
      const problem = supabaseTargetProblem({
        vercelEnv,
        url: VITE_SUPABASE_URL,
        hasKey: Boolean(VITE_SUPABASE_PUBLISHABLE_KEY || VITE_SUPABASE_ANON_KEY),
        dataMode: config.env.VITE_DATA_MODE,
      })
      if (problem) throw new Error(`Refusing to start: ${problem}`)
      if (vercelEnv) {
        config.logger.info(
          `Vercel ${vercelEnv} build uses Supabase project ${projectRefOf(VITE_SUPABASE_URL)}.`,
        )
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), checkPublicEnv(), checkSupabaseTarget()],
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
          include: ['src/**/*.test.ts', 'tests/staging/**/*.test.ts', 'tests/build/**/*.test.ts'],
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
