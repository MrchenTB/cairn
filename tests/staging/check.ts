/**
 * `npm run check:staging`: reads `.env.staging.local` and runs the same safety rules as the staging
 * test run, without starting anything or making a single request. Prints what is wrong, or that the
 * settings are fine. Values (passwords, keys) are never printed; only the project host is.
 */
import { existsSync } from 'node:fs'
import { loadEnv } from 'vite'
import { checkStagingEnv } from './guard.ts'

// Vite reads these too when it loads the staging mode. They are not wrong, but a stale one can
// supply a value the staging file leaves empty, so say that they are there.
const ALSO_READ = ['.env', '.env.local', '.env.staging']

try {
  const env = loadEnv('staging', process.cwd(), '')
  const settings = checkStagingEnv(env, { dryRun: false })
  console.log(`Settings are fine. The tests would run against ${new URL(settings.url).host}.`)
  const extra = ALSO_READ.filter((name) => existsSync(name))
  if (extra.length > 0) {
    console.log(
      `Note: ${extra.join(', ')} also exists and is read in staging mode. A value missing from ` +
        '.env.staging.local can come from there.',
    )
  }
  if (!env.CAIRN_PRODUCTION_PROJECT_REF?.trim()) {
    console.log(
      'Note: CAIRN_PRODUCTION_PROJECT_REF is empty. Fill it in as soon as the production project exists: ' +
        'then the tests refuse to run against it.',
    )
  }
} catch (error) {
  console.error(`\n${(error as Error).message}\n`)
  process.exit(1)
}
