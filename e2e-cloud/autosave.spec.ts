/// <reference lib="dom" />
/**
 * Task Modal autosave in cloud mode, against the local Supabase simulator (real client, real
 * migrations on PGlite; see tests/cloud-sim/README.md for what that does and does not prove).
 * The local-mode behaviour is in e2e/task-autosave.spec.ts; this file is about what only the cloud
 * has: real requests that fail, lag or never arrive, being offline, and accounts.
 */
import { type Page } from '@playwright/test'
import {
  expect,
  expectShell,
  seedProject,
  signIn,
  signOut,
  signUpNew,
  sim,
  submitSignUp,
  syncIndicator,
  test,
  toast,
  toastButton,
  uniqueEmail,
  watchConsole,
} from './support.ts'

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } })

const DRAFTS_KEY = 'cairn:task-drafts:v1'

const modal = (page: Page) => page.getByRole('dialog', { name: /^Edit task:/ })
const titleBox = (page: Page) => modal(page).getByRole('textbox', { name: 'Task title' })
const descriptionBox = (page: Page) => modal(page).getByRole('textbox', { name: 'Description' })
const footerState = (page: Page) => modal(page).locator('[data-save-state]')

const dbTask = async (id: string) =>
  (
    await sim.sql<{ title: string; description: string | null; status: string }>(
      'select title, description, status from public.tasks where id = $1',
      [id],
    )
  )[0]

const patches = async (id: string) =>
  (await sim.requests()).filter(
    (request) =>
      request.method === 'PATCH' &&
      request.path.includes('/tasks') &&
      request.query.includes(id) &&
      request.status !== 'dropped',
  ).length

async function openTask(page: Page) {
  const seeded = await seedProject(page, {
    name: 'Autosave',
    tasks: [{ key: 'plain', title: 'Plain task' }],
  })
  const taskId = seeded.ids.plain
  await page.goto(`/projects/${seeded.projectId}/list?task=${taskId}`)
  await expect(titleBox(page)).toHaveValue('Plain task')
  return { ...seeded, taskId }
}

test.describe('autosave in cloud mode', () => {
  test.beforeEach(async () => {
    await sim.clearFaults()
    await sim.latency(0, 0)
  })

  test('title, description and status reach the database; only changed fields are sent', async ({
    page,
  }) => {
    await signUpNew(page)
    const { taskId } = await openTask(page)

    await titleBox(page).fill('Renamed')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await dbTask(taskId)).title).toBe('Renamed')

    await descriptionBox(page).fill('A description')
    await expect
      .poll(async () => (await dbTask(taskId)).description, { timeout: 5000 })
      .toBe('A description')

    await modal(page)
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: /In Progress/ }).click()
    await expect.poll(async () => (await dbTask(taskId)).status).toBe('in_progress')
    await expect(footerState(page)).toHaveText('Saved')
  })

  test('slow network: closing does not wait, the write still lands', async ({ page }) => {
    await signUpNew(page)
    const { taskId } = await openTask(page)
    await sim.latency(900, 900)

    await descriptionBox(page).fill('Sent while closing')
    const before = Date.now()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(Date.now() - before).toBeLessThan(800)
    await expect(syncIndicator(page, 'Saving…')).toBeVisible()

    await expect
      .poll(async () => (await dbTask(taskId)).description, { timeout: 5000 })
      .toBe('Sent while closing')
    await sim.latency(0, 0)
  })

  test('a burst of commits on a slow network is two requests, ending on the newest text', async ({
    page,
  }) => {
    await signUpNew(page)
    const { taskId } = await openTask(page)
    await sim.latency(700, 700)
    const before = await patches(taskId)

    for (const text of ['one', 'two', 'three', 'four']) {
      await descriptionBox(page).fill(text)
      await titleBox(page).click()
    }
    await expect(descriptionBox(page)).toHaveValue('four')
    await expect
      .poll(async () => (await dbTask(taskId)).description, { timeout: 6000 })
      .toBe('four')
    await sim.latency(0, 0)
    await expect(footerState(page)).not.toHaveAttribute('data-save-state', 'saving')
    expect((await patches(taskId)) - before).toBe(2)
    await expect(descriptionBox(page)).toHaveValue('four')
  })

  test('the request never arrives: the text stays, Retry stores it once', async ({ page }) => {
    await signUpNew(page)
    const { taskId } = await openTask(page)
    await sim.fault({
      method: 'PATCH',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'drop',
      times: 1,
    })

    await titleBox(page).fill('Renamed')
    await page.keyboard.press('Enter')
    await expect(toast(page, /Couldn.t save the title of “Plain task”/)).toBeVisible()
    await expect(titleBox(page)).toHaveValue('Renamed')
    await expect(modal(page)).toContainText('Your text is kept here.')
    expect((await dbTask(taskId)).title).toBe('Plain task')

    await footerState(page).getByRole('button', { name: 'Retry' }).click()
    await expect.poll(async () => (await dbTask(taskId)).title).toBe('Renamed')
    await expect(modal(page)).not.toContainText('Your text is kept here.')
  })

  test('the answer is lost after the server saved: the text is not reported as failed for long', async ({
    page,
  }) => {
    await signUpNew(page)
    const { taskId } = await openTask(page)
    await sim.fault({
      method: 'PATCH',
      path: '/rest/v1/tasks',
      when: 'after',
      action: 'drop',
      times: 1,
    })

    await titleBox(page).fill('Applied, answer lost')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await dbTask(taskId)).title).toBe('Applied, answer lost')
    // The refresh after a failure finds the text stored: nothing is left to retry or to recover.
    await expect(modal(page)).not.toContainText('Your text is kept here.', { timeout: 5000 })
    await expect(titleBox(page)).toHaveValue('Applied, answer lost')
  })

  test('10. offline: text is held, not failed; back online it is saved by itself', async ({
    page,
    context,
  }) => {
    await signUpNew(page)
    const { taskId } = await openTask(page)

    await context.setOffline(true)
    await expect(footerState(page)).toContainText('Offline')
    await descriptionBox(page).fill('Written on the train')
    await titleBox(page).click()
    await expect(descriptionBox(page)).toHaveValue('Written on the train')
    await expect(footerState(page)).toContainText('Offline')
    await expect(toast(page, /Couldn.t save/)).toHaveCount(0)
    expect((await dbTask(taskId)).description).toBeNull()

    await context.setOffline(false)
    await expect
      .poll(async () => (await dbTask(taskId)).description, { timeout: 5000 })
      .toBe('Written on the train')
    await expect(footerState(page)).not.toContainText('Offline')
  })

  test('10. offline: a closed modal’s text still goes out when the connection is back', async ({
    page,
    context,
  }) => {
    await signUpNew(page)
    const { taskId } = await openTask(page)

    await context.setOffline(true)
    await expect(footerState(page)).toContainText('Offline')
    await descriptionBox(page).fill('Closed while offline')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Sync status: 1 unsaved text/ })).toBeVisible()

    await context.setOffline(false)
    await expect
      .poll(async () => (await dbTask(taskId)).description, { timeout: 5000 })
      .toBe('Closed while offline')
    await expect(page.getByRole('button', { name: /^Sync status: 1 unsaved text/ })).toHaveCount(0)
  })

  test('a server refusal keeps the text and does not offer a pointless Retry loop', async ({
    page,
  }) => {
    await signUpNew(page)
    const { taskId } = await openTask(page)
    await sim.fault({
      method: 'PATCH',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'status',
      status: 500,
      times: 1,
    })
    await descriptionBox(page).fill('Refused once')
    await titleBox(page).click()
    await expect(modal(page)).toContainText('Your text is kept here.')
    await expect(descriptionBox(page)).toHaveValue('Refused once')
    await toastButton(page, /Couldn.t save the description/, 'Retry').click()
    await expect.poll(async () => (await dbTask(taskId)).description).toBe('Refused once')
  })

  test('accounts: another account in the same tab never sees unsaved text', async ({ page }) => {
    const first = uniqueEmail('first')
    await signUpNew(page, first)
    await openTask(page)
    await sim.fault({
      method: 'PATCH',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'drop',
      times: 1,
    })
    await descriptionBox(page).fill('Private notes')
    await titleBox(page).click()
    await expect(modal(page)).toContainText('Your text is kept here.')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect
      .poll(() => page.evaluate((key) => sessionStorage.getItem(key) ?? '', DRAFTS_KEY))
      .toContain('Private notes')

    // Signing out on purpose names what is lost, and removes it.
    await page.goto('/settings/account')
    await page.getByRole('button', { name: 'Sign out' }).click()
    const prompt = page.getByRole('alertdialog', { name: 'Sign out of Cairn?' })
    await expect(prompt).toContainText('1 unsaved text in your tasks will be discarded.')
    await prompt.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/login/)
    await expect
      .poll(() => page.evaluate((key) => sessionStorage.getItem(key), DRAFTS_KEY))
      .toBeNull()

    await submitSignUp(page, uniqueEmail('second'))
    await expectShell(page)
    await expect(page.getByRole('button', { name: /unsaved text/ })).toHaveCount(0)
  })

  test('accounts: a stored copy from someone else is removed unread at sign-in', async ({
    page,
  }) => {
    watchConsole(page)
    const email = uniqueEmail('owner')
    await signUpNew(page, email)
    await signOut(page)
    await page.evaluate(
      (key) =>
        sessionStorage.setItem(
          key,
          JSON.stringify({
            version: 1,
            scope: 'somebody-else',
            drafts: [
              {
                taskId: 't',
                field: 'title',
                value: 'Their text',
                base: 'x',
                sent: 'x',
                taskTitle: 'Theirs',
              },
            ],
          }),
        ),
      DRAFTS_KEY,
    )
    await signIn(page, email)
    await expect(page.getByRole('button', { name: /unsaved text/ })).toHaveCount(0)
    await expect
      .poll(() => page.evaluate((key) => sessionStorage.getItem(key), DRAFTS_KEY))
      .toBeNull()
  })
})
