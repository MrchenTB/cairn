/// <reference lib="dom" />
/**
 * Browser helpers of the staging suite that need no Playwright fixtures, so global setup can use
 * them too: the app's own sign-in form, and the locators every spec shares.
 */
import { expect, type Browser, type Locator, type Page } from '@playwright/test'
import { account, STORAGE_STATE, type UserKey } from './api.ts'

export const sidebar = (page: Page): Locator => page.getByRole('complementary', { name: 'Sidebar' })

/** The app shell is up and the workspace finished loading. */
export async function expectShell(page: Page): Promise<void> {
  await expect(sidebar(page)).toBeVisible()
  await expect(page.getByRole('main').locator('[aria-busy="true"]')).toHaveCount(0)
}

export async function submitSignIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

/**
 * Signs in through the real form and saves the browser session (storageState) for the specs, so
 * they do not sign in again and again: a hosted project rate-limits sign-ins. The specs never sign
 * out in the UI either: contexts made from one saved state share its session, and signing out ends
 * that session for all of them.
 */
export async function saveSignedInState(browser: Browser, baseURL: string, user: UserKey) {
  const context = await browser.newContext({
    baseURL,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
  })
  try {
    const page = await context.newPage()
    await page.goto('/login')
    const { email, password } = account(user)
    await submitSignIn(page, email, password)
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 })
    await expectShell(page)
    await context.storageState({ path: STORAGE_STATE[user] })
  } finally {
    await context.close()
  }
}
