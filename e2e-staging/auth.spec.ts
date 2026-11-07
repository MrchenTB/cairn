/// <reference lib="dom" />
/**
 * A1, A2: signing in through the app's own form on the real project, in a browser that has no
 * session. Each signs in (or fails to) exactly once: a hosted project rate-limits sign-ins, and
 * this suite never signs out in the UI (that would end the sessions the other specs reuse).
 */
import { account, expect, expectShell, sidebar, submitSignIn, test } from './support.ts'

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } })

test.describe('sign-in (A)', () => {
  test('A1: the right email and password sign in, and a reload keeps the session', async ({
    device,
  }) => {
    const page = await device(null)
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Welcome to Cairn' })).toBeVisible()
    const { email, password } = account('A')
    await submitSignIn(page, email, password)

    await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 })
    await expectShell(page)
    await expect(sidebar(page).getByText('Local only')).toHaveCount(0)

    await page.reload()
    await expectShell(page)
    await expect(page).not.toHaveURL(/\/login/)
    await expect(sidebar(page).getByText('Local only')).toHaveCount(0)
    await expect(page.getByText('Local only')).toHaveCount(0)
  })

  test('A2: a wrong password shows Incorrect email or password', async ({ device }) => {
    const page = await device(null)
    await page.goto('/login')
    // Account A's real email with a password that is not hers: one attempt only (rate limits).
    await submitSignIn(page, account('A').email, `not-the-password-${Date.now()}`)

    await expect(page.getByRole('alert')).toHaveText('Incorrect email or password.')
    await expect(page).toHaveURL(/\/login/)
    await expect(sidebar(page)).toHaveCount(0)
  })
})
