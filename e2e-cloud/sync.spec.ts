/// <reference lib="dom" />
/**
 * Cloud mode, AC-13 proxy: two browser contexts signed in to one account stand in for two devices.
 * What one changes reaches the database, and the other shows it when it gets focus. This proves the
 * refresh path against the real schema; it is not the real two-device test on a real project.
 */
import { type Browser, type Page } from '@playwright/test'
import {
  expect,
  expectShell,
  focusAfterThrottle,
  listScroll,
  rowTitles,
  seedProject,
  sidebar,
  signIn,
  signUpNew,
  sim,
  syncIndicator,
  taskRow,
  test,
  watchConsole,
} from './support.ts'

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } })

/** A second "device": its own context (nothing shared with the first), clock under test control. */
async function secondDevice(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: 'http://localhost:5181',
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  watchConsole(page)
  await page.clock.install()
  await signIn(page, email)
  return page
}

test.describe('two devices, one account (AC-13 proxy)', () => {
  test('A changes, B focuses and sees it; B changes, A focuses and sees it', async ({
    browser,
    page,
  }) => {
    await page.clock.install()
    const email = await signUpNew(page)
    const { projectId, ids } = await seedProject(page, {
      name: 'Shared project',
      tasks: [
        { key: 'a', title: 'Alpha' },
        { key: 'b', title: 'Beta' },
      ],
    })
    const other = await secondDevice(browser, email)
    try {
      await other.goto(`/projects/${projectId}/list`)
      await expect.poll(() => rowTitles(listScroll(other))).toEqual(['Alpha', 'Beta'])

      // A adds a task and completes one.
      const input = page.getByRole('textbox', { name: 'New task' })
      if ((await input.count()) === 0) {
        await page
          .getByRole('button', { name: /Add task/ })
          .first()
          .click()
      }
      await input.fill('Gamma from A')
      await input.press('Enter')
      await input.press('Escape')
      await page
        .locator(`[data-task-row="${ids.a}"]`)
        .getByRole('button', { name: /^Status:/ })
        .click()
      await page.getByRole('menuitemradio', { name: 'Done' }).click()
      await expect(syncIndicator(page, 'Saved')).toBeVisible()
      await expect
        .poll(() => sim.sql('select status from public.tasks where id = $1', [ids.a]))
        .toEqual([{ status: 'done' }])

      // B has not been told anything yet; focus brings it.
      expect(await rowTitles(listScroll(other))).toEqual(['Alpha', 'Beta'])
      await focusAfterThrottle(other)
      await expect
        .poll(() => rowTitles(listScroll(other)))
        .toEqual(['Alpha', 'Beta', 'Gamma from A'])
      await expect(
        other.locator(`[data-task-row="${ids.a}"]`).getByRole('button', { name: /^Status:/ }),
      ).toHaveAccessibleName('Status: Done')

      // The reverse: B renames a task and deletes another.
      await taskRow(other, 'Beta').click({ button: 'right' })
      await other.getByRole('menuitem', { name: 'Delete task…' }).click()
      await other
        .getByRole('alertdialog')
        .getByRole('button', { name: /^Delete/ })
        .click()
      await expect.poll(() => rowTitles(listScroll(other))).toEqual(['Alpha', 'Gamma from A'])
      await expect(syncIndicator(other, 'Saved')).toBeVisible()

      await focusAfterThrottle(page)
      await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Gamma from A'])

      // A new project on B reaches A's sidebar and Projects page.
      await other.goto('/projects')
      await expectShell(other)
      await other.getByRole('button', { name: 'New project' }).first().click()
      const dialog = other.getByRole('dialog', { name: 'New project' })
      await dialog.getByRole('textbox', { name: 'Name' }).fill('Made on B')
      await dialog.getByRole('button', { name: 'Create project' }).click()
      await expect(other).toHaveURL(/\/projects\/[0-9a-f-]+\/list$/)
      await focusAfterThrottle(page)
      await expect(sidebar(page).getByRole('link', { name: /Made on B/ })).toBeVisible()

      // Both see one and the same set after a reload.
      await page.goto('/projects')
      await other.goto('/projects')
      for (const device of [page, other]) {
        await expectShell(device)
        await expect(
          device.getByRole('main').getByRole('link', { name: 'Shared project' }),
        ).toBeVisible()
        await expect(
          device.getByRole('main').getByRole('link', { name: 'Made on B' }),
        ).toBeVisible()
      }
    } finally {
      await other.context().close()
    }
  })

  test('a calendar date is the same day on a device in another time zone (§9.2)', async ({
    browser,
    page,
  }) => {
    const email = await signUpNew(page)
    const { projectId, ids } = await seedProject(page, {
      tasks: [{ key: 'a', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' }],
      milestones: [{ key: 'm', name: 'Launch', date: '2026-11-30' }],
    })
    const zones = ['Pacific/Kiritimati', 'America/Los_Angeles']
    for (const timezoneId of zones) {
      const context = await browser.newContext({
        baseURL: 'http://localhost:5181',
        locale: 'en-US',
        timezoneId,
        viewport: { width: 1280, height: 800 },
      })
      const other = await context.newPage()
      watchConsole(other)
      try {
        await signIn(other, email)
        await other.goto(`/projects/${projectId}/gantt`)
        const bar = other.locator(`[data-task-id="${ids.a}"][data-link-target]`)
        await expect(bar, timezoneId).toHaveAccessibleName(/^Alpha, Nov 5 – Nov 7, 3 days/)
        await other.goto(`/projects/${projectId}/list`)
        await expect(
          other.getByRole('button', { name: /^Milestone Launch/ }),
          timezoneId,
        ).toContainText('Nov 30')
        // Editing there keeps the dates of the first device's calendar.
        await other
          .locator(`[data-task-row="${ids.a}"]`)
          .getByRole('button', { name: /^Status:/ })
          .click()
        await other.getByRole('menuitemradio', { name: 'In Progress' }).click()
        await expect(syncIndicator(other, 'Saved')).toBeVisible()
        await expect
          .poll(() =>
            sim.sql(
              'select start_date::text, due_date::text, status from public.tasks where id = $1',
              [ids.a],
            ),
          )
          .toEqual([{ start_date: '2026-11-05', due_date: '2026-11-07', status: 'in_progress' }])
        await other
          .locator(`[data-task-row="${ids.a}"]`)
          .getByRole('button', { name: /^Status:/ })
          .click()
        await other.getByRole('menuitemradio', { name: 'To Do' }).click()
        await expect
          .poll(() => sim.sql('select status from public.tasks where id = $1', [ids.a]))
          .toEqual([{ status: 'todo' }])
      } finally {
        await context.close()
      }
    }
  })

  test('preferences follow the account to a new device; first-run defaults never overwrite them', async ({
    browser,
    page,
  }) => {
    const email = await signUpNew(page)
    await page.goto('/settings/appearance')
    await expectShell(page)
    await page
      .getByRole('radiogroup', { name: 'Theme' })
      .getByRole('radio', { name: 'Dark' })
      .click()
    await page
      .getByRole('radiogroup', { name: 'Week starts on' })
      .getByRole('radio', { name: 'Sunday' })
      .click()
    await expect
      .poll(() =>
        sim.sql(
          `select p.theme, p.week_starts_on from public.user_preferences p
           join auth.users u on u.id = p.user_id where u.email = $1`,
          [email],
        ),
      )
      .toEqual([{ theme: 'dark', week_starts_on: 0 }])

    const other = await secondDevice(browser, email)
    try {
      await other.goto('/settings/appearance')
      await expectShell(other)
      await expect(
        other.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }),
      ).toBeChecked()
      await expect(
        other
          .getByRole('radiogroup', { name: 'Week starts on' })
          .getByRole('radio', { name: 'Sunday' }),
      ).toBeChecked()
      expect(await other.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
        true,
      )
      await expect(
        sim.sql(
          `select p.theme, p.week_starts_on from public.user_preferences p
           join auth.users u on u.id = p.user_id where u.email = $1`,
          [email],
        ),
      ).resolves.toEqual([{ theme: 'dark', week_starts_on: 0 }])
    } finally {
      await other.context().close()
    }
  })

  test('a task deleted on A and edited on stale B: refused, honest, and B catches up', async ({
    browser,
    page,
  }) => {
    await page.clock.install()
    const email = await signUpNew(page)
    const { projectId, ids } = await seedProject(page, {
      tasks: [
        { key: 'a', title: 'Alpha' },
        { key: 'b', title: 'Beta' },
      ],
    })
    const other = await secondDevice(browser, email)
    try {
      await other.goto(`/projects/${projectId}/list`)
      await expect.poll(() => rowTitles(listScroll(other))).toEqual(['Alpha', 'Beta'])

      await taskRow(page, 'Alpha').click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Delete task…' }).click()
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: /^Delete/ })
        .click()
      await expect
        .poll(() => sim.sql('select id from public.tasks where id = $1', [ids.a]))
        .toEqual([])

      await other
        .locator(`[data-task-row="${ids.a}"]`)
        .getByRole('button', { name: /^Status:/ })
        .click()
      await other.getByRole('menuitemradio', { name: 'Done' }).click()
      await expect(
        other.locator('[data-sonner-toast]').filter({ hasText: /no longer exists/ }),
      ).toBeVisible()
      // The refresh after the failure removes the row; nothing is reported as saved.
      await expect.poll(() => rowTitles(listScroll(other))).toEqual(['Beta'])
      expect(await sim.sql('select id from public.tasks where id = $1', [ids.a])).toEqual([])
    } finally {
      await other.context().close()
    }
  })
})
