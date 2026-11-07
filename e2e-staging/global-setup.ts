/**
 * Before any spec: makes sure the run is on a project that holds nothing but test data.
 *
 * - dry run only: creates the two accounts on the local simulator through the public sign-up;
 * - both modes: signs in both accounts through the Auth API and reads each account's projects.
 *   Any project that is not a test project stops the run (only a count is reported, never a name).
 *   Test projects left behind by a crashed earlier run are deleted;
 * - then signs in through the app's own form once per account and saves the browser session.
 */
import { chromium, type FullConfig } from '@playwright/test'
import {
  assertOnlyTestData,
  deleteTestProjects,
  isDryRun,
  listProjects,
  rememberSession,
  resetMetrics,
  settings,
  signInWithPassword,
  signUpDryRunAccounts,
  type UserKey,
} from './api.ts'
import { saveSignedInState } from './ui.ts'

export default async function globalSetup(config: FullConfig): Promise<void> {
  const { url, dryRun } = settings()
  const baseURL = config.projects[0].use.baseURL
  if (!baseURL) throw new Error('The staging config has no baseURL.')
  console.log(
    `[staging] ${dryRun ? 'DRY RUN against the local simulator' : 'REAL run against a Supabase project'}` +
      ` (${new URL(url).host})`,
  )

  resetMetrics()
  if (isDryRun()) await signUpDryRunAccounts()

  const users: UserKey[] = ['A', 'B']
  for (const user of users) {
    const session = await signInWithPassword(user)
    rememberSession(user, session)
    const projects = await listProjects(session.access_token)
    assertOnlyTestData(user, projects)
    const removed = await deleteTestProjects(user)
    if (removed > 0)
      console.log(`[staging] account ${user}: removed ${removed} leftover test project(s)`)
  }

  const browser = await chromium.launch()
  try {
    for (const user of users) await saveSignedInState(browser, baseURL, user)
  } finally {
    await browser.close()
  }
}
