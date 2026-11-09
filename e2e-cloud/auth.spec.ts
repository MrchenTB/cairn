/// <reference lib="dom" />
/**
 * Cloud mode, accounts (PRD §9.1 AC-1, §9.2): the real app and @supabase/auth-js against the
 * simulated GoTrue. Sign up, sign in, wrong password, friendly empty state, session across reloads,
 * sign out clears data, forgot password through the emailed link, and an expired session whose
 * refresh fails. The local-only label must never show here.
 */
import {
  expect,
  expectShell,
  listScroll,
  rest,
  rowTitles,
  seedProject,
  sidebar,
  signIn,
  signOut,
  signUpNew,
  sim,
  storedSession,
  submitSignIn,
  submitSignUp,
  syncIndicator,
  test,
  toast,
  uniqueEmail,
  watchConsole,
  PASSWORD,
} from './support.ts'

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } })

test.describe('accounts (AC-1)', () => {
  test('signed out, every page asks to sign in and remembers where you were going', async ({
    page,
  }) => {
    await page.goto('/projects')
    await expect(page).toHaveURL(/\/login$/)
    await expect(page).toHaveTitle('Sign in · Cairn')
    await expect(page.getByRole('heading', { name: 'Welcome to Cairn' })).toBeVisible()
    // Cloud mode never shows the local-mode label, not even on the sign-in page.
    await expect(page.getByText('Local only')).toHaveCount(0)
    const email = uniqueEmail()
    await submitSignUp(page, email)
    await expect(page).toHaveURL(/\/projects$/)
    await expectShell(page)
  })

  test('sign up, friendly empty state, Saved label, session survives a reload, sign out clears data', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    await expect(page).toHaveTitle('Overview · Cairn')
    // The first run of a new account: a welcome, not a blank page or an error.
    const main = page.getByRole('main')
    await expect(main.getByRole('button', { name: /Create project/ }).first()).toBeVisible()
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    await expect(page.getByText('Local only')).toHaveCount(0)

    // First-run preferences reached the database once.
    await expect
      .poll(() =>
        sim.sql(
          'select 1 from public.user_preferences p join auth.users u on u.id = p.user_id where u.email = $1',
          [email],
        ),
      )
      .toHaveLength(1)

    await page.reload()
    await expect(page).toHaveURL(/\/overview$/)
    await expectShell(page)
    await expect(sidebar(page)).toBeVisible()

    await page.goto('/settings/account')
    await expect(page.getByText(email)).toBeVisible()
    await expect(page.getByText('Local mode')).toHaveCount(0)

    await signOut(page)
    await expect(page.getByRole('heading', { name: 'Welcome to Cairn' })).toBeVisible()
    expect(await storedSession(page)).toBeNull()
    // Protected pages are closed again, also after a reload.
    await page.goto('/overview')
    await expect(page).toHaveURL(/\/login$/)
  })

  test('wrong password and unknown address give the same honest message; a right one signs in', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    await signOut(page)

    await submitSignIn(page, email, 'not the password')
    await expect(page.getByRole('alert')).toHaveText('Incorrect email or password.')
    await expect(page).toHaveURL(/\/login$/)
    expect(await storedSession(page)).toBeNull()

    await submitSignIn(page, uniqueEmail('nobody'), PASSWORD)
    await expect(page.getByRole('alert')).toHaveText('Incorrect email or password.')

    await signIn(page, email)
  })

  test('signing up twice with one address is refused with a readable message', async ({ page }) => {
    const email = await signUpNew(page)
    await signOut(page)
    await submitSignUp(page, email)
    await expect(page.getByRole('alert')).toHaveText('An account with this email already exists.')
  })

  test('form validation: bad email, short password and a server-side weak password', async ({
    page,
  }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Create an account' }).click()
    await page.getByLabel('Email').fill('not-an-email')
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByRole('alert')).toHaveText('Enter a valid email address.')
    await page.getByLabel('Email').fill(uniqueEmail())
    await page.getByLabel('Password', { exact: true }).fill('short')
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByRole('alert')).toContainText('Use at least 8 characters')
    // The server's own email check (the client only looks for an @).
    await page.getByLabel('Email').fill('no-dot@domain')
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByRole('alert')).toContainText(/email/i)
    await expect(page).toHaveURL(/\/login$/)
  })

  test('hosted default, email confirmation on: notice, not confirmed yet, the link signs in', async ({
    page,
  }) => {
    await sim.config({ autoconfirm: false })
    const email = uniqueEmail()
    await page.goto('/login')
    await submitSignUp(page, email)
    await expect(page.getByRole('heading', { name: 'Confirm your email' })).toBeVisible()
    await expect(page.getByRole('status')).toContainText(email)
    expect(await storedSession(page)).toBeNull()

    await page.getByRole('button', { name: 'Back to sign in' }).click()
    await submitSignIn(page, email)
    await expect(page.getByRole('alert')).toContainText('Confirm your email address first')

    const [mail] = await sim.mail(email)
    expect(mail.type).toBe('signup')
    expect(mail.link).toContain(encodeURIComponent('http://localhost:5181'))
    await page.goto(mail.link)
    await expect(page).toHaveURL(/\/overview$/)
    await expectShell(page)
    // The tokens never stay in the address bar.
    expect(new URL(page.url()).hash).toBe('')
    expect((await storedSession(page))?.access_token).toBeTruthy()

    // The same link cannot be used twice.
    await signOut(page)
    await page.goto(mail.link)
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('alert')).toContainText('invalid or has expired')
    // …and the account works with its password.
    await signIn(page, email)
  })
})

test.describe('forgot password', () => {
  test('email link (PASSWORD_RECOVERY) opens Set a new password; the new one works, the old one does not', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    await signOut(page)

    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await expect(page.getByRole('alert')).toContainText('Enter your email address first')
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()

    const mails = await sim.mail(email)
    expect(mails).toHaveLength(1)
    const link = mails[0].link

    // A second request right away is refused by the server's rate limit, with a readable message.
    await page.getByRole('button', { name: 'Back to sign in' }).click()
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await expect(page.getByRole('alert')).toHaveText('Too many emails were sent. Try again later.')

    await page.goto(link)
    const dialog = page.getByRole('dialog', { name: 'Set a new password' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(email)
    expect(new URL(page.url()).hash).toBe('')

    // Same password → the server refuses, and the dialog says why.
    await dialog.getByLabel('New password', { exact: true }).fill(PASSWORD)
    await dialog.getByLabel('Confirm new password', { exact: true }).fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Update password' }).click()
    await expect(dialog.getByRole('alert')).toHaveText(
      'Choose a password different from the current one.',
    )

    const newPassword = 'a brand new passphrase'
    await dialog.getByLabel('New password', { exact: true }).fill(newPassword)
    await dialog.getByLabel('Confirm new password', { exact: true }).fill(newPassword)
    await dialog.getByRole('button', { name: 'Update password' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText('Password updated')).toBeVisible()
    await expect(page).toHaveURL(/\/overview$/)
    await expectShell(page)

    await signOut(page)
    await submitSignIn(page, email, PASSWORD)
    await expect(page.getByRole('alert')).toHaveText('Incorrect email or password.')
    await signIn(page, email, newPassword)
  })

  test('forgot password for an unknown address looks the same and sends nothing', async ({
    page,
  }) => {
    const email = uniqueEmail('nobody')
    await page.goto('/login')
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
    expect(await sim.mail(email)).toEqual([])
  })

  test('an expired recovery link explains itself on the sign-in page', async ({ page }) => {
    const email = await signUpNew(page)
    await signOut(page)
    await sim.config({ otpExpirySeconds: -1 })
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
    const [mail] = await sim.mail(email)
    await page.goto(mail.link)
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('alert')).toContainText('invalid or has expired')
    expect(await storedSession(page)).toBeNull()
  })
})

test.describe('several tabs and accounts', () => {
  test('sign out in one tab signs out the other and clears it; a new account there shows only its data', async ({
    context,
    page,
  }) => {
    await signUpNew(page)
    await seedProject(page, { name: 'Secret plans', tasks: [{ key: 'a', title: 'Alpha task' }] })
    const other = await context.newPage()
    watchConsole(other)
    await other.goto('/projects')
    await expectShell(other)
    await expect(other.getByRole('main').getByRole('link', { name: 'Secret plans' })).toBeVisible()

    await signOut(page)
    // The second tab follows without being touched.
    await expect(other).toHaveURL(/\/login/)
    await expect(other.getByText('Secret plans')).toHaveCount(0)

    await submitSignUp(page, uniqueEmail('second'))
    await expect(page).not.toHaveURL(/\/login/)
    await expectShell(page)
    await expect(other).not.toHaveURL(/\/login/)
    await expectShell(other)
    await expect(other.getByText('Secret plans')).toHaveCount(0)
    await other.close()
  })

  test('another account’s email link while signed in: switches to that account, no data of the first', async ({
    page,
  }) => {
    const second = uniqueEmail('second')
    await signUpNew(page, second)
    await seedProject(page, { name: 'Second account project' })
    await signOut(page)
    await page.getByLabel('Email').fill(second)
    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
    const [mail] = await sim.mail(second)

    await page.goto('/login')
    await submitSignUp(page, uniqueEmail('first'))
    await expect(page).not.toHaveURL(/\/login/)
    await expectShell(page)
    await seedProject(page, { name: 'First account project' })
    await expect(page.getByRole('heading', { name: 'First account project' })).toBeVisible()

    await page.goto(mail.link)
    const dialog = page.getByRole('dialog', { name: 'Set a new password' })
    await expect(dialog).toContainText(second)
    await dialog.getByRole('button', { name: 'Not now' }).click()
    await page.goto('/projects')
    await expectShell(page)
    await expect(
      page.getByRole('main').getByRole('link', { name: 'Second account project' }),
    ).toBeVisible()
    await expect(page.getByText('First account project')).toHaveCount(0)
  })
})

test.describe('session lifetime', () => {
  test('the access token expires, the refresh token works: no interruption, data stays', async ({
    page,
  }) => {
    // 92 s lifetime: the client treats a token within 90 s of expiry as expired, so it refreshes soon.
    await sim.config({ accessTokenTtlSeconds: 92 })
    await signUpNew(page)
    const { ids } = await seedProject(page, { tasks: [{ key: 'a', title: 'Alpha' }] })
    const before = (await storedSession(page))?.refresh_token
    await page.waitForTimeout(2_500)

    // A write after the margin passed refreshes first, then saves with the new token.
    await page
      .locator(`[data-task-row="${ids.a}"]`)
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect
      .poll(() =>
        sim.sql<{ status: string }>('select status from public.tasks where id = $1', [ids.a]),
      )
      .toEqual([{ status: 'done' }])
    const requests = await sim.requests()
    expect(
      requests.some(
        (request) =>
          request.path === '/auth/v1/token' &&
          request.query.includes('refresh_token') &&
          request.status === 200,
      ),
    ).toBe(true)
    expect((await storedSession(page))?.refresh_token).not.toBe(before)
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    await page.reload()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha'])
  })

  test('laptop asleep past the expiry, refresh refused (open tab): signed out, data cleared, back to where you were', async ({
    page,
  }) => {
    await page.clock.install()
    const email = await signUpNew(page)
    const { projectId } = await seedProject(page, {
      name: 'Secret plans',
      tasks: [{ key: 'a', title: 'Alpha' }],
    })
    await expect(page.getByRole('heading', { name: 'Secret plans' })).toBeVisible()

    await sim.revokeSessions(email)
    await page.clock.fastForward('02:00:00')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))

    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'Welcome to Cairn' })).toBeVisible()
    await expect(page.getByText('Secret plans')).toHaveCount(0)
    expect(await storedSession(page)).toBeNull()
    // Nothing of the account's data stays in this browser's storage.
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
    expect(stored).not.toContain('Secret plans')

    // Signing in again returns to the page that was open, with the data from the server.
    await submitSignIn(page, email)
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/list$`))
    await expect(page.getByRole('heading', { name: 'Secret plans' })).toBeVisible()
  })

  test('expired and refused at startup (reload): the sign-in page, never a stuck splash', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    await seedProject(page, { name: 'Secret plans', tasks: [{ key: 'a', title: 'Alpha' }] })
    await sim.revokeSessions(email)
    await page.evaluate(() => {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index) ?? ''
        if (key.startsWith('sb-') && key.endsWith('-auth-token')) {
          const session = JSON.parse(localStorage.getItem(key) ?? '{}')
          localStorage.setItem(key, JSON.stringify({ ...session, expires_at: 1_000_000 }))
        }
      }
    })
    await page.reload()
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'Welcome to Cairn' })).toBeVisible()
    expect(await storedSession(page)).toBeNull()
  })

  test('a write refused because the session ended is not reported as saved', async ({ page }) => {
    const email = await signUpNew(page)
    const { ids } = await seedProject(page, { tasks: [{ key: 'a', title: 'Alpha' }] })
    // The server's clock passes the token's expiry, the session is revoked meanwhile.
    await sim.revokeSessions(email)
    await sim.config({ clockOffsetSeconds: 7200 })
    await page
      .locator(`[data-task-row="${ids.a}"]`)
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect(toast(page, "Couldn't update task")).toContainText('Your session has expired')
    await sim.config({ clockOffsetSeconds: 0 })
    expect(await sim.sql('select status from public.tasks where id = $1', [ids.a])).toEqual([
      { status: 'todo' },
    ])
  })

  test('the server rejects a token the client still trusts, the refresh token works: renewed, next save works', async ({
    page,
  }) => {
    await signUpNew(page)
    const { ids } = await seedProject(page, { tasks: [{ key: 'a', title: 'Alpha' }] })
    const before = (await storedSession(page))?.refresh_token
    // E.g. this device's clock is behind, or the project's signing keys were rotated.
    await sim.config({ clockOffsetSeconds: 7200 })
    await page
      .locator(`[data-task-row="${ids.a}"]`)
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    // Not saved, and not reported as saved.
    await expect(toast(page, "Couldn't update task")).toBeVisible()
    await expect(
      page.locator(`[data-task-row="${ids.a}"]`).getByRole('button', { name: /^Status:/ }),
    ).toHaveAccessibleName('Status: To Do')
    await expect.poll(async () => (await storedSession(page))?.refresh_token).not.toBe(before)
    // Still signed in with a token the server accepts: doing it again works.
    await expect(page).toHaveURL(/\/list$/)
    await page
      .locator(`[data-task-row="${ids.a}"]`)
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect
      .poll(() => sim.sql('select status from public.tasks where id = $1', [ids.a]))
      .toEqual([{ status: 'done' }])
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
  })

  test('the server rejects a token the client still trusts, and refuses the refresh too: signed out, data cleared', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    const { ids } = await seedProject(page, {
      name: 'Secret plans',
      tasks: [{ key: 'a', title: 'Alpha' }],
    })
    await sim.revokeSessions(email)
    await sim.config({ clockOffsetSeconds: 7200 })
    await page
      .locator(`[data-task-row="${ids.a}"]`)
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: 'Welcome to Cairn' })).toBeVisible()
    await expect(page.getByText('Secret plans')).toHaveCount(0)
    expect(await storedSession(page)).toBeNull()
    await sim.config({ clockOffsetSeconds: 0 })
    expect(await sim.sql('select status from public.tasks where id = $1', [ids.a])).toEqual([
      { status: 'todo' },
    ])
  })

  test('refresh fails on the network (not refused): still signed in, works again when it is back', async ({
    page,
  }) => {
    await sim.config({ accessTokenTtlSeconds: 92 })
    await signUpNew(page)
    const { ids } = await seedProject(page, { tasks: [{ key: 'a', title: 'Alpha' }] })
    await page.waitForTimeout(2_500)
    await sim.fault({
      method: 'POST',
      path: '/auth/v1/token',
      when: 'before',
      action: 'status',
      status: 503,
      times: 50,
    })
    await page.reload()
    // A failed refresh must not end the session or lose the page.
    await expect(page).toHaveURL(/\/list$/)
    expect((await storedSession(page))?.refresh_token).toBeTruthy()
    await sim.clearFaults()
    await page.reload()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha'])
    await expect(page.locator(`[data-task-row="${ids.a}"]`)).toBeVisible()
  })

  test('expired at startup and the server unreachable: not signed out; continues once it is back', async ({
    page,
  }) => {
    // supabase-js retries the refresh with backoff for ~30 s, then waits a 60 s cool-down.
    test.setTimeout(240_000)
    await signUpNew(page)
    const { projectId } = await seedProject(page, {
      name: 'Kept plans',
      tasks: [{ key: 'a', title: 'Alpha' }],
    })
    await page.goto(`/projects/${projectId}/list`)
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha'])
    // The access token has expired (a laptop asleep overnight) and the token endpoint cannot be
    // reached (offline): supabase-js keeps the session but cannot renew it.
    await page.evaluate(() => {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index) ?? ''
        if (key.startsWith('sb-') && key.endsWith('-auth-token')) {
          const session = JSON.parse(localStorage.getItem(key) ?? '{}')
          localStorage.setItem(key, JSON.stringify({ ...session, expires_at: 1_000_000 }))
        }
      }
    })
    await sim.fault({
      method: 'POST',
      path: '/auth/v1/token',
      when: 'before',
      action: 'drop',
      times: 50,
    })
    await page.reload()
    // While supabase-js retries: the splash, never the sign-in page.
    await expect(page.getByRole('status', { name: 'Loading Cairn' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Can’t reach Cairn' })).toBeVisible({
      timeout: 60_000,
    })
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/list$`)) // not sent to /login
    await expect(page.getByLabel('Password')).toHaveCount(0)
    expect((await storedSession(page))?.refresh_token).toBeTruthy() // the session was kept

    // Still unreachable: Try again stays here.
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('heading', { name: 'Can’t reach Cairn' })).toBeVisible()

    // Back online: the library renews the session by itself after its cool-down, no reload.
    await sim.clearFaults()
    await expect
      .poll(() => rowTitles(listScroll(page)), { timeout: 150_000, intervals: [2_000] })
      .toEqual(['Alpha'])
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/list$`))
  })

  test('sign out without a connection still signs this device out', async ({ page }) => {
    await signUpNew(page)
    await page.goto('/settings/account')
    await expectShell(page)
    await sim.fault({ method: 'POST', path: '/auth/v1/logout', when: 'before', action: 'drop' })
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Sign out', exact: true })
      .click()
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: 'Welcome to Cairn' })).toBeVisible()
    expect(await storedSession(page)).toBeNull()
  })

  test('sign out, another account in the same browser: nothing of the first is shown or kept', async ({
    page,
  }) => {
    const first = await signUpNew(page)
    const { projectId } = await seedProject(page, {
      name: 'Secret plans',
      tasks: [{ key: 'a', title: 'Alpha task' }],
    })
    await expect(page.getByRole('heading', { name: 'Secret plans' })).toBeVisible()
    await expect(sidebar(page).getByText('Secret plans')).toBeVisible()
    await signOut(page)
    await expect(page.getByText('Secret plans')).toHaveCount(0)
    const kept = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
    expect(kept).not.toContain('Secret plans')
    expect(kept).not.toContain('Alpha task')
    expect(kept).not.toContain(first)

    await submitSignUp(page, uniqueEmail('second'))
    await expect(page).not.toHaveURL(/\/login/)
    await expectShell(page)
    await expect(page.getByText('Secret plans')).toHaveCount(0)
    await page.goto('/overview')
    await expectShell(page)
    await expect(page.getByRole('button', { name: /Create project/ }).first()).toBeVisible()
    await expect(page.getByText('Secret plans')).toHaveCount(0)
    await page.goto(`/projects/${projectId}/list`)
    await expect(page.getByText('Project not found')).toBeVisible()
    await expect(page.getByText('Secret plans')).toHaveCount(0)
    // A direct read with this account's token sees none of it either.
    const token = (await storedSession(page))?.access_token ?? ''
    expect((await rest(token, `projects?id=eq.${projectId}&select=*`)).body).toEqual([])
  })
})
