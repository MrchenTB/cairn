/// <reference lib="dom" />
/**
 * Cloud mode, the edges only a server shows (PRD §5.4, §9.2): auth requests that fail or hang, a
 * session that ends while work is open, answers arriving out of turn, a device whose view went
 * stale, and an outage. "Another device" is a direct REST call with the same account's token.
 * Hangs are real on the server; the page's clock is moved so that the tests need not wait them out.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type Page } from '@playwright/test'
import {
  accessToken,
  expect,
  expectShell,
  focusAfterThrottle,
  listScroll,
  PASSWORD,
  phaseGroup,
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
  taskRow,
  test,
  toast,
  uniqueEmail,
  userId,
  watchConsole,
} from './support.ts'

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } })

const NETWORK_MESSAGE = 'Network error — check your connection.'

const statusButton = (page: Page, id: string) =>
  page.locator(`[data-task-row="${id}"]`).getByRole('button', { name: /^Status:/ })

async function setStatus(page: Page, id: string, status: string): Promise<void> {
  await statusButton(page, id).click()
  await page.getByRole('menuitemradio', { name: status }).click()
}

const dbStatus = (id: string) =>
  sim.sql<{ status: string }>('select status from public.tasks where id = $1', [id])

const SEED = {
  tasks: [
    { key: 'a', title: 'Alpha' },
    { key: 'b', title: 'Beta' },
  ],
}

const accounts = (email: string) =>
  sim.sql('select id from auth.users where email = $1', [email.toLowerCase()])

/** Marks the stored access token as long expired, as after a night with the laptop closed. */
async function expireStoredSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index) ?? ''
      if (key.startsWith('sb-') && key.endsWith('-auth-token')) {
        const session = JSON.parse(localStorage.getItem(key) ?? '{}')
        localStorage.setItem(key, JSON.stringify({ ...session, expires_at: 1_000_000 }))
      }
    }
  })
}

/** Every value a status button shows from now on. */
async function recordStatus(page: Page, id: string): Promise<void> {
  await page.evaluate((taskId) => {
    const seen: string[] = []
    const read = () => {
      const label = document
        .querySelector(`[data-task-row="${taskId}"] button[aria-label^="Status:"]`)
        ?.getAttribute('aria-label')
      if (label && seen[seen.length - 1] !== label) seen.push(label)
    }
    new MutationObserver(read).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-label'],
    })
    ;(window as unknown as { __statusSeen: string[] }).__statusSeen = seen
  }, id)
}

/** What the button showed from the first time it showed `label`. */
const statusSeenSince = (page: Page, label: string) =>
  page.evaluate((from) => {
    const { __statusSeen: seen } = window as unknown as { __statusSeen: string[] }
    return seen.slice(seen.indexOf(from))
  }, label)

test.describe('auth requests that fail', () => {
  test('sign in: no connection, a gateway page, a rate limit: honest each time, then it works', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    await signOut(page)
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    const submit = page.getByRole('button', { name: 'Sign in', exact: true })
    const alert = page.getByRole('alert')
    const fault = { method: 'POST', path: '/auth/v1/token', when: 'before' } as const

    await sim.fault({ ...fault, action: 'drop' })
    await submit.click()
    await expect(alert).toHaveText(NETWORK_MESSAGE)

    await sim.fault({
      ...fault,
      action: 'status',
      status: 503,
      body: '<html>Service unavailable</html>',
      contentType: 'text/html',
    })
    await submit.click()
    // The connection works and the server failed: the message must not blame the connection.
    await expect(alert).toHaveText("The server couldn't complete the request. Try again.")

    await sim.fault({
      ...fault,
      action: 'status',
      status: 500,
      body: '<html><h1>Internal Server Error</h1></html>',
      contentType: 'text/html',
    })
    await submit.click()
    await expect(alert).toHaveText("The server couldn't complete the request. Try again.")

    await sim.fault({
      ...fault,
      action: 'status',
      status: 429,
      body: JSON.stringify({ message: 'Request rate limit reached' }),
    })
    await submit.click()
    await expect(alert).toHaveText('Too many attempts. Wait a moment and try again.')

    expect(await storedSession(page)).toBeNull()
    await expect(page).toHaveURL(/\/login$/)
    await submit.click()
    await expect(page).not.toHaveURL(/\/login/)
    await expectShell(page)
  })

  test('sign up: not delivered, then applied with the answer lost: honest, one account that works', async ({
    page,
  }) => {
    const email = uniqueEmail()
    await page.goto('/login')
    await sim.fault({ method: 'POST', path: '/auth/v1/signup', when: 'before', action: 'drop' })
    await submitSignUp(page, email)
    const alert = page.getByRole('alert')
    await expect(alert).toHaveText(NETWORK_MESSAGE)
    expect(await accounts(email)).toEqual([])

    await sim.fault({ method: 'POST', path: '/auth/v1/signup', when: 'after', action: 'drop' })
    const create = page.getByRole('button', { name: 'Create account' })
    await create.click()
    await expect(alert).toHaveText(NETWORK_MESSAGE)
    await expect(page.getByRole('heading', { name: 'Confirm your email' })).toHaveCount(0)
    expect(await accounts(email)).toHaveLength(1)

    await create.click()
    await expect(alert).toHaveText('An account with this email already exists.')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await submitSignIn(page, email)
    await expect(page).not.toHaveURL(/\/login/)
    await expectShell(page)
  })

  test('forgot password: no connection or a server error: never "Check your email"', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    await signOut(page)
    await page.getByLabel('Email').fill(email)
    const forgot = page.getByRole('button', { name: 'Forgot password?' })
    const sent = page.getByRole('heading', { name: 'Check your email' })

    await sim.fault({ method: 'POST', path: '/auth/v1/recover', when: 'before', action: 'drop' })
    await forgot.click()
    await expect(page.getByRole('alert')).toHaveText(NETWORK_MESSAGE)
    await expect(sent).toHaveCount(0)

    await sim.fault({
      method: 'POST',
      path: '/auth/v1/recover',
      when: 'before',
      action: 'status',
      status: 500,
      body: JSON.stringify({ message: 'Error sending recovery email' }),
    })
    await forgot.click()
    await expect(page.getByRole('alert')).toContainText('Error sending recovery email')
    await expect(sent).toHaveCount(0)
    expect(await sim.mail(email)).toEqual([])

    await forgot.click()
    await expect(sent).toBeVisible()
    expect(await sim.mail(email)).toHaveLength(1)
  })

  test('recovery dialog: the save fails, the dialog stays and says why; the next try works', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    await signOut(page)
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
    const [mail] = await sim.mail(email)
    await page.goto(mail.link)
    const dialog = page.getByRole('dialog', { name: 'Set a new password' })
    const newPassword = 'a brand new passphrase'
    await dialog.getByLabel('New password', { exact: true }).fill(newPassword)
    await dialog.getByLabel('Confirm new password', { exact: true }).fill(newPassword)
    const update = dialog.getByRole('button', { name: 'Update password' })

    await sim.fault({ method: 'PUT', path: '/auth/v1/user', when: 'before', action: 'drop' })
    await update.click()
    await expect(dialog.getByRole('alert')).toHaveText(NETWORK_MESSAGE)
    await expect(page.getByText('Password updated')).toHaveCount(0)

    await update.click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText('Password updated')).toBeVisible()
    await signOut(page)
    await signIn(page, email, newPassword)
  })

  test('recovery link of the signed-in account itself asks for the new password; Not now keeps the old one', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    await signOut(page)
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
    const [mail] = await sim.mail(email)
    await signIn(page, email)

    await page.goto(mail.link)
    const dialog = page.getByRole('dialog', { name: 'Set a new password' })
    await expect(dialog).toContainText(email)
    await dialog.getByRole('button', { name: 'Not now' }).click()
    await expect(dialog).toBeHidden()
    await expectShell(page)
    await signOut(page)
    await signIn(page, email)
  })

  test('sign-in returns to a task deep link; a signed-in user on /login goes to the app', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    const { projectId, ids } = await seedProject(page, SEED)
    await signOut(page)
    await page.goto(`/projects/${projectId}/list?task=${ids.a}`)
    await expect(page).toHaveURL(/\/login/)
    await submitSignIn(page, email)
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/list\\?task=${ids.a}$`))
    await expect(page.getByRole('dialog', { name: 'Edit task: Alpha' })).toBeVisible()

    await page.goto('/login')
    await expect(page).toHaveURL(/\/overview$/)
    await expectShell(page)
  })

  test('a corrupted stored session: the sign-in page, nothing crashes, signing in works', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    const key = await page.evaluate(() =>
      Object.keys(localStorage).find((k) => k.startsWith('sb-') && k.endsWith('-auth-token')),
    )
    for (const value of ['not json{', '{"access_token":"x"}', '"text"', 'null']) {
      await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key!, value])
      await page.goto('/overview')
      await expect(page, value).toHaveURL(/\/login$/)
      await expect(page.getByRole('heading', { name: 'Welcome to Cairn' })).toBeVisible()
    }
    await submitSignIn(page, email)
    await expect(page).not.toHaveURL(/\/login/)
    await expectShell(page)
  })

  test('email confirmation on: a taken address looks like a new one and sends nothing', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    await signOut(page)
    await sim.config({ autoconfirm: false })
    await submitSignUp(page, email)
    await expect(page.getByRole('heading', { name: 'Confirm your email' })).toBeVisible()
    expect(await storedSession(page)).toBeNull()
    expect(await sim.mail(email)).toEqual([])
  })
})

test.describe('auth requests that hang', () => {
  const HANG = 300_000

  test('sign in: gives up, says so, and the next try works', async ({ page }) => {
    await page.clock.install()
    const email = await signUpNew(page)
    await signOut(page)
    await sim.fault({
      method: 'POST',
      path: '/auth/v1/token',
      when: 'before',
      action: 'delay',
      delayMs: HANG,
    })
    await submitSignIn(page, email)
    const submit = page.getByRole('button', { name: /Sign in/ }).first()
    await expect(submit).toBeDisabled()
    await page.clock.fastForward('00:31')
    await expect(page.getByRole('alert')).toHaveText(NETWORK_MESSAGE)
    await submitSignIn(page, email)
    await expect(page).not.toHaveURL(/\/login/)
    await expectShell(page)
  })

  test('forgot password: gives up, says so', async ({ page }) => {
    await page.clock.install()
    const email = await signUpNew(page)
    await signOut(page)
    await page.getByLabel('Email').fill(email)
    await sim.fault({
      method: 'POST',
      path: '/auth/v1/recover',
      when: 'before',
      action: 'delay',
      delayMs: HANG,
    })
    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await expect(page.getByRole('button', { name: /Forgot password|Sending/ })).toBeDisabled()
    await page.clock.fastForward('00:31')
    await expect(page.getByRole('alert')).toHaveText(NETWORK_MESSAGE)
    await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0)
  })

  test('sign out: this device is signed out anyway', async ({ page }) => {
    await page.clock.install()
    await signUpNew(page)
    await page.goto('/settings/account')
    await expectShell(page)
    await sim.fault({
      method: 'POST',
      path: '/auth/v1/logout',
      when: 'before',
      action: 'delay',
      delayMs: HANG,
    })
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Sign out', exact: true })
      .click()
    await expect(page.getByRole('alertdialog')).toBeHidden()
    await page.clock.fastForward('00:31')
    await expect(page).toHaveURL(/\/login/)
    expect(await storedSession(page)).toBeNull()
  })

  test('restoring the session at startup: the splash says so, then that the server cannot be reached; it recovers by itself', async ({
    page,
  }) => {
    await page.clock.install()
    await signUpNew(page)
    const { projectId } = await seedProject(page, { name: 'Kept project', ...SEED })
    await expireStoredSession(page)
    await sim.fault({
      method: 'POST',
      path: '/auth/v1/token',
      when: 'before',
      action: 'delay',
      delayMs: HANG,
      times: 4,
    })
    await page.reload()
    const splash = page.getByRole('status', { name: 'Loading Cairn' })
    await expect(splash).toBeVisible()
    await expect(splash).not.toContainText('longer than usual')
    await page.clock.fastForward('00:11')
    await expect(splash).toContainText('longer than usual')

    // Past the request timeouts: never a splash forever. The session is kept, it was not refused,
    // so this is not a sign-out: no sign-in page, the address stays (D35).
    await expect
      .poll(
        async () => {
          await page.clock.fastForward('00:31')
          return page.getByRole('heading', { name: 'Can’t reach Cairn' }).isVisible()
        },
        { timeout: 20_000 },
      )
      .toBe(true)
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/list$`))
    await expect(page.getByRole('heading', { name: 'Welcome to Cairn' })).toHaveCount(0)
    expect((await storedSession(page))?.refresh_token).toBeTruthy()

    // The server answers again: back to the page that was open, with its data.
    await sim.clearFaults()
    // (The address never left the page; it is the data appearing that shows the recovery.)
    await expect
      .poll(
        async () => {
          await page.clock.fastForward('00:31')
          return page.getByRole('heading', { name: 'Kept project' }).isVisible()
        },
        { timeout: 60_000 },
      )
      .toBe(true)
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/list$`))
    await expect(page.getByRole('heading', { name: 'Can’t reach Cairn' })).toHaveCount(0)
  })

  test('auth server down at startup with a long expired token: cannot reach Cairn (not sign-in), session kept, back when it answers', async ({
    page,
  }) => {
    await page.clock.install()
    await signUpNew(page)
    const { projectId } = await seedProject(page, { name: 'Kept project', ...SEED })
    await expireStoredSession(page)
    await sim.fault({
      method: 'POST',
      path: '/auth/v1/token',
      when: 'before',
      action: 'status',
      status: 503,
      times: 500,
    })
    await page.reload()
    await expect
      .poll(
        async () => {
          await page.clock.fastForward('00:10')
          return page.getByRole('heading', { name: 'Can’t reach Cairn' }).isVisible()
        },
        { timeout: 30_000 },
      )
      .toBe(true)
    await expect(page.getByRole('heading', { name: 'Welcome to Cairn' })).toHaveCount(0)
    await expect(page.getByText('Kept project')).toHaveCount(0) // nothing shown until confirmed
    expect((await storedSession(page))?.refresh_token).toBeTruthy()

    await sim.clearFaults()
    // (The address never left the page; it is the data appearing that shows the recovery.)
    await expect
      .poll(
        async () => {
          await page.clock.fastForward('00:31')
          return page.getByRole('heading', { name: 'Kept project' }).isVisible()
        },
        { timeout: 60_000 },
      )
      .toBe(true)
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/list$`))
    await expect(page.getByRole('heading', { name: 'Can’t reach Cairn' })).toHaveCount(0)
  })
})

test.describe('a session that ends while work is open', () => {
  test('unsaved text in the task modal, signed out in another tab: the sign-in page, no prompt left over; the same account gets the text back to decide on', async ({
    context,
    page,
  }) => {
    const email = await signUpNew(page)
    const { projectId, ids } = await seedProject(page, SEED)
    await page.goto(`/projects/${projectId}/list?task=${ids.a}`)
    const modal = page.getByRole('dialog', { name: 'Edit task: Alpha' })
    await modal.getByRole('textbox', { name: 'Task title' }).fill('Alpha, not saved')

    const tab = await context.newPage()
    watchConsole(tab)
    await signOut(tab)
    await tab.close()

    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: 'Welcome to Cairn' })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(toast(page, /not found/i)).toHaveCount(0)
    expect(await sim.sql('select title from public.tasks where id = $1', [ids.a])).toEqual([
      { title: 'Alpha' },
    ])

    // Back in as the same account, the text that never reached the server is offered back (it was
    // kept for this account), but it is not pretended to be saved and nothing is written for it.
    await submitSignIn(page, email)
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/list`))
    // The task link opens its modal again, which hides the sidebar from the accessibility tree.
    const again = page.getByRole('dialog', { name: 'Edit task: Alpha' })
    await expect(again.getByRole('textbox', { name: 'Task title' })).toHaveValue('Alpha, not saved')
    await expect(again).toContainText('Recovered text that wasn’t saved.')
    expect(await sim.sql('select title from public.tasks where id = $1', [ids.a])).toEqual([
      { title: 'Alpha' },
    ])
    await again.getByRole('button', { name: 'Discard: title' }).click()
    await expect(again.getByRole('textbox', { name: 'Task title' })).toHaveValue('Alpha')
  })

  test('unsaved edits in the task modal, the session is refused: the sign-in page, no prompt left over', async ({
    page,
  }) => {
    await page.clock.install()
    const email = await signUpNew(page)
    const { projectId, ids } = await seedProject(page, { name: 'Secret plans', ...SEED })
    await page.goto(`/projects/${projectId}/list?task=${ids.a}`)
    const modal = page.getByRole('dialog', { name: 'Edit task: Alpha' })
    await modal.getByRole('textbox', { name: 'Task title' }).fill('Alpha, not saved')

    await sim.revokeSessions(email)
    await page.clock.fastForward('02:00:00')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))

    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'Welcome to Cairn' })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.getByText('Secret plans')).toHaveCount(0)
    expect(await storedSession(page)).toBeNull()
  })

  test('a failed write and its Retry end with the session: nothing is sent for the next account', async ({
    page,
  }) => {
    await signUpNew(page)
    const { ids } = await seedProject(page, SEED)
    await sim.fault({
      method: 'PATCH',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'status',
      status: 500,
    })
    await setStatus(page, ids.a, 'Done')
    const failure = toast(page, "Couldn't update task")
    await expect(failure.getByRole('button', { name: 'Retry' })).toBeVisible()

    await sidebar(page).getByRole('link', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Sign out', exact: true })
      .click()
    await expect(page).toHaveURL(/\/login/)
    await expect(failure.getByRole('button', { name: 'Retry' })).toHaveCount(0)

    await submitSignUp(page, uniqueEmail('next'))
    await expect(page).not.toHaveURL(/\/login/)
    await expectShell(page)
    await expect(sidebar(page).getByRole('button', { name: 'Retry' })).toHaveCount(0)
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    expect(await dbStatus(ids.a)).toEqual([{ status: 'todo' }])
  })
})

test.describe('answers arriving out of turn', () => {
  test('a slow refresh never overwrites a newer change', async ({ page }) => {
    await page.clock.install()
    await signUpNew(page)
    const { ids } = await seedProject(page, SEED)
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta'])
    await recordStatus(page, ids.a)

    const reads = async () =>
      (await sim.requests()).filter((r) => r.method === 'GET' && r.path === '/rest/v1/tasks').length
    const before = await reads()
    // The read happens now, its answer is on the wire for a while: it shows the old status.
    await sim.fault({
      method: 'GET',
      path: '/rest/v1/tasks',
      when: 'after',
      action: 'delay',
      delayMs: 1500,
    })
    await focusAfterThrottle(page)
    await expect.poll(reads).toBeGreaterThan(before)

    await setStatus(page, ids.a, 'Done')
    await expect.poll(() => dbStatus(ids.a)).toEqual([{ status: 'done' }])
    await page.waitForTimeout(2000)
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: Done')
    expect(await statusSeenSince(page, 'Status: Done')).toEqual(['Status: Done'])
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
  })

  test('two quick changes to one task: stored in order, and the first answer never brings the old value back', async ({
    page,
  }) => {
    await signUpNew(page)
    const { ids } = await seedProject(page, SEED)
    await recordStatus(page, ids.a)
    // If the two requests were not sent one after the other, this one would land last.
    await sim.fault({
      method: 'PATCH',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'delay',
      delayMs: 1200,
    })
    await setStatus(page, ids.a, 'Done')
    await setStatus(page, ids.a, 'In Progress')
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: In Progress')
    await expect(syncIndicator(page, 'Saved')).toBeVisible({ timeout: 10_000 })
    expect(await dbStatus(ids.a)).toEqual([{ status: 'in_progress' }])
    expect(await statusSeenSince(page, 'Status: In Progress')).toEqual(['Status: In Progress'])
    await page.reload()
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: In Progress')
  })

  test('the first change fails, the second was already on screen: only the second stays, in order', async ({
    page,
  }) => {
    await signUpNew(page)
    const { ids } = await seedProject(page, SEED)
    await sim.fault({
      method: 'PATCH',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'status',
      status: 500,
    })
    await setStatus(page, ids.a, 'Done')
    await setStatus(page, ids.b, 'In Progress')
    await expect(toast(page, "Couldn't update task")).toBeVisible()
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: To Do')
    await expect(statusButton(page, ids.b)).toHaveAccessibleName('Status: In Progress')
    await expect
      .poll(async () => [await dbStatus(ids.a), await dbStatus(ids.b)])
      .toEqual([[{ status: 'todo' }], [{ status: 'in_progress' }]])
  })
})

test.describe('Settings → Data in cloud mode', () => {
  test('Sync now brings what another device did; a failure says so everywhere; the next one clears it', async ({
    page,
  }) => {
    await signUpNew(page)
    const { projectId } = await seedProject(page, { name: 'Shared', ...SEED })
    await page.goto('/settings/data')
    await expectShell(page)
    await expect(page.getByText('Cloud sync (Supabase)')).toBeVisible()
    await expect(page.getByText('All changes saved')).toBeVisible()
    await expect(page.getByText('Changes are saved to the cloud as you make them.')).toBeVisible()
    const fact = (label: string) => page.locator('dt', { hasText: label }).locator('+ dd')
    await expect(fact('Connection')).toHaveText('Online')
    await expect(fact('Pending changes')).toHaveText('None')
    await expect(fact('Last error')).toHaveText('None')

    const added = await rest(await accessToken(page), 'tasks?select=id', {
      method: 'POST',
      body: { id: randomUUID(), project_id: projectId, title: 'From elsewhere', sort_order: 'a9' },
      prefer: 'return=representation',
    })
    expect(added.status).toBe(201)

    const syncNow = page.getByRole('button', { name: 'Sync now' })
    await syncNow.click()
    await expect(toast(page, 'Synced with the cloud')).toBeVisible()

    await sim.fault({
      method: 'GET',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'status',
      status: 500,
    })
    await syncNow.click()
    await expect(toast(page, "Couldn't refresh")).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't refresh ·" })).toBeVisible()
    await expect(fact('Last error')).not.toHaveText('None')
    await expect(syncIndicator(page, "Couldn't sync")).toBeVisible()

    await syncNow.click()
    await expect(toast(page, 'Synced with the cloud')).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't refresh ·" })).toHaveCount(0)
    await expect(fact('Last error')).toHaveText('None')
    await expect(syncIndicator(page, 'Saved')).toBeVisible()

    // Client-side navigation: the data on screen came from Sync now, not from a page load.
    await sidebar(page)
      .getByRole('link', { name: /Shared/ })
      .click()
    await expect
      .poll(() => rowTitles(listScroll(page)))
      .toEqual(['Alpha', 'Beta', 'From elsewhere'])
  })
})

test.describe('a stale device', () => {
  test('two devices edit different fields of one task: both stay', async ({ page }) => {
    await page.clock.install()
    await signUpNew(page)
    const { projectId, ids } = await seedProject(page, SEED)
    await page.goto(`/projects/${projectId}/list?task=${ids.a}`)
    const modal = page.getByRole('dialog', { name: /Edit task:/ })
    await modal.getByRole('textbox', { name: /Description/ }).fill('Written here')

    const changed = await rest(await accessToken(page), `tasks?id=eq.${ids.a}`, {
      method: 'PATCH',
      body: { title: 'Renamed elsewhere', priority: 'high' },
    })
    expect(changed.status).toBe(204)
    await focusAfterThrottle(page)
    // The title nobody touched here follows; the unsaved description stays.
    await expect(modal.getByRole('textbox', { name: 'Task title' })).toHaveValue(
      'Renamed elsewhere',
    )
    await expect(modal.getByRole('textbox', { name: /Description/ })).toHaveValue('Written here')
    // Done hands over the description that was still waiting; the title is not sent again.
    await modal.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(modal).toBeHidden()
    await expect
      .poll(() =>
        sim.sql('select title, priority, description from public.tasks where id = $1', [ids.a]),
      )
      .toEqual([{ title: 'Renamed elsewhere', priority: 'high', description: 'Written here' }])
  })

  test('the task deleted elsewhere while its modal is open: it closes with a reason, never a blank form', async ({
    page,
  }) => {
    await page.clock.install()
    await signUpNew(page)
    const { projectId, ids } = await seedProject(page, SEED)
    await page.goto(`/projects/${projectId}/list?task=${ids.a}`)
    const modal = page.getByRole('dialog', { name: 'Edit task: Alpha' })
    await expect(modal).toBeVisible()
    const deleted = await rest(await accessToken(page), 'rpc/delete_task', {
      method: 'POST',
      body: { p_task_id: ids.a, p_keep_subtasks: false, p_promoted: [] },
    })
    expect(deleted.status).toBe(204)
    await focusAfterThrottle(page)
    await expect(modal).toBeHidden()
    await expect(toast(page, /not found/i)).toBeVisible()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Beta'])
    await expect(page).not.toHaveURL(/task=/)
  })

  test('a milestone deleted elsewhere while its dialog is open: Save says so, nothing is recreated', async ({
    page,
  }) => {
    await signUpNew(page)
    const { projectId, ids } = await seedProject(page, {
      milestones: [{ key: 'm', name: 'Launch', date: '2026-12-01' }],
    })
    await page.getByRole('button', { name: /^Milestone Launch/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit milestone' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Launch moved')
    const gone = await rest(await accessToken(page), `milestones?id=eq.${ids.m}`, {
      method: 'DELETE',
    })
    expect(gone.status).toBe(204)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(/This milestone no longer exists/).first()).toBeVisible()
    await expect(
      sim.sql('select id from public.milestones where project_id = $1', [projectId]),
    ).resolves.toEqual([])
    await expect(
      toast(page, /no longer exists/).getByRole('button', { name: 'Retry' }),
    ).toHaveCount(0)
  })

  test('a Gantt drag of a task deleted elsewhere: refused whole, honest, and the bar goes away', async ({
    page,
  }) => {
    await page.clock.setFixedTime('2026-11-04T10:00:00+08:00')
    await signUpNew(page)
    const { projectId, ids } = await seedProject(page, {
      tasks: [
        { key: 'a', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
        { key: 'b', title: 'Beta', start: '2026-11-05', due: '2026-11-07' },
      ],
    })
    await page.goto(`/projects/${projectId}/gantt`)
    await expect(page.getByRole('region', { name: 'Gantt chart' })).toBeVisible()
    const bar = page.locator(`[data-task-id="${ids.a}"][data-link-target]`)
    await expect(bar).toBeVisible()
    const deleted = await rest(await accessToken(page), 'rpc/delete_task', {
      method: 'POST',
      body: { p_task_id: ids.a, p_keep_subtasks: false, p_promoted: [] },
    })
    expect(deleted.status).toBe(204)

    const box = (await bar.boundingBox())!
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 4, from.y, { steps: 2 })
    await page.mouse.move(from.x + 120, from.y, { steps: 10 })
    await page.mouse.up()

    await expect(toast(page, /no longer exists|could not be found/i)).toBeVisible()
    await expect(bar).toHaveCount(0)
    await expect(sidebar(page).getByRole('button', { name: 'Retry' })).toHaveCount(0)
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    expect(
      await sim.sql('select start_date::text from public.tasks where id = $1', [ids.b]),
    ).toEqual([{ start_date: '2026-11-05' }])
  })

  test('a task moved into a phase deleted elsewhere: refused, readable, and the phase goes away', async ({
    page,
  }) => {
    await signUpNew(page)
    const { ids } = await seedProject(page, {
      phases: ['Build'],
      tasks: [
        { key: 'a', title: 'Alpha' },
        { key: 'b', title: 'Beta', phase: 'Build' },
      ],
    })
    const gone = await rest(await accessToken(page), `phases?id=eq.${ids.Build}`, {
      method: 'DELETE',
    })
    expect(gone.status).toBe(204)
    await taskRow(page, 'Alpha').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to phase' }).hover()
    await page.getByRole('menuitem', { name: 'Build' }).click()
    await expect(toast(page, /no longer exists/i)).toBeVisible()
    await expect(
      toast(page, /no longer exists/i).getByRole('button', { name: 'Retry' }),
    ).toHaveCount(0)
    await expect(phaseGroup(page, 'Build')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Move Alpha' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Move Beta' })).toBeVisible()
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    expect(await sim.sql('select phase_id from public.tasks where id = $1', [ids.a])).toEqual([
      { phase_id: null },
    ])
  })
})

test.describe('an outage', () => {
  test('two changes fail; Retry applies both, in order, once', async ({ page }) => {
    await signUpNew(page)
    const { ids } = await seedProject(page, SEED)
    await sim.fault({
      method: 'PATCH',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'drop',
      times: 2,
    })
    await setStatus(page, ids.a, 'Done')
    await expect(toast(page, "Couldn't update task")).toBeVisible()
    await setStatus(page, ids.b, 'In Progress')
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: To Do')
    await expect(statusButton(page, ids.b)).toHaveAccessibleName('Status: To Do')
    await expect(syncIndicator(page, "Couldn't save")).toBeVisible()

    const patches = async () =>
      (await sim.requests()).filter(
        (r) => r.method === 'PATCH' && r.path === '/rest/v1/tasks' && r.status === 200,
      ).length
    const before = await patches()
    await sidebar(page).getByRole('button', { name: 'Retry' }).click()
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: Done')
    await expect(statusButton(page, ids.b)).toHaveAccessibleName('Status: In Progress')
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    await expect(sidebar(page).getByRole('button', { name: 'Retry' })).toHaveCount(0)
    expect(await dbStatus(ids.a)).toEqual([{ status: 'done' }])
    expect(await dbStatus(ids.b)).toEqual([{ status: 'in_progress' }])
    expect(await patches()).toBe(before + 2)
    await page.reload()
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: Done')
    await expect(statusButton(page, ids.b)).toHaveAccessibleName('Status: In Progress')
  })

  test('an import too large for the server (413): readable, nothing stored, the dialog stays', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    await seedProject(page, { name: 'Original', ...SEED })
    await page.goto('/settings/data')
    await expectShell(page)
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    await page.getByLabel('Backup file').setInputFiles({
      name: 'my-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(readFileSync(await download.path(), 'utf8')),
    })
    const dialog = page.getByRole('dialog', { name: 'Import backup' })
    await sim.fault({
      method: 'POST',
      path: '/rest/v1/rpc/import_workspace',
      when: 'before',
      action: 'status',
      status: 413,
      body: JSON.stringify({ message: 'Payload too large' }),
    })
    await dialog.getByRole('button', { name: 'Import as new copies' }).click()
    await expect(page.getByText('This is too much data to save at once.').first()).toBeVisible()
    await expect(dialog).toBeVisible()
    const owner = await userId(email)
    expect(
      await sim.sql('select id from public.projects where user_id = $1', [owner]),
    ).toHaveLength(1)
  })
})
