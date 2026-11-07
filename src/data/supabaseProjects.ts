/**
 * Which Supabase project each place may use. Real data lives in production; only the production
 * site may reach it. vite.config.ts checks this for every dev server and build, so a wrongly scoped
 * variable on Vercel fails the build instead of pointing a preview at real data. The refs are not
 * secret: every build ships its project URL. No imports and no `import.meta` (vite.config.ts).
 */

export const STAGING_PROJECT_REF = 'bvaydvvqtuykoznoljux'

/** Empty until the production project exists. Fill it in the moment it does. */
export const PRODUCTION_PROJECT_REF = ''

const PROJECT_URL = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/

export function projectRefOf(url: string): string | null {
  return PROJECT_URL.exec(url.trim())?.[1] ?? null
}

interface Target {
  /** `VERCEL_ENV` of the build; undefined on this computer. */
  vercelEnv: string | undefined
  url: string | undefined
  hasKey: boolean
  productionRef?: string
}

/** What is wrong with this project for this place (null = nothing). Worded to stop a build. */
export function supabaseTargetProblem(target: Target): string | null {
  const { vercelEnv, hasKey, productionRef = PRODUCTION_PROJECT_REF } = target
  const url = target.url?.trim() ?? ''
  const ref = projectRefOf(url)
  const onProduction = productionRef !== '' && ref === productionRef

  if (vercelEnv === undefined) {
    return onProduction
      ? 'VITE_SUPABASE_URL is the production project, and only the production site may use it. ' +
          'Use local mode or `npm run dev:staging`.'
      : null
  }
  if (vercelEnv === 'production') {
    if (!url || !hasKey) {
      return 'the production site needs VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY: without them it runs in local mode and data stays in one browser.'
    }
    if (ref === STAGING_PROJECT_REF) {
      return 'the production site points at the staging project. Set the Production-scoped variables on Vercel to the production project.'
    }
    if (productionRef !== '' && !onProduction) {
      return 'the production site points at a project other than PRODUCTION_PROJECT_REF.'
    }
    return null
  }
  if (ref !== STAGING_PROJECT_REF || !hasKey) {
    return `a ${vercelEnv} deployment must use the staging project. Check the Preview-scoped VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY on Vercel.`
  }
  return null
}
