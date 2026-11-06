/// <reference lib="dom" />
/**
 * PRD §6.1 / AC-16: user text is always rendered as text, and unknown or hostile ids in URLs are
 * handled. The dev server applies no CSP (public/_headers belongs to the host), so a payload that
 * became markup would really run here. Formulas in CSV exports: src/data/backup.test.ts. The same
 * app behind the real CSP: e2e-prod/. Cross-account access: tests/db and e2e-cloud/isolation.spec.ts.
 */
import { readFileSync } from 'node:fs'
import { expect, test as base } from '@playwright/test'
import { expectNoInjection, openSeeded, XSS } from './security.helpers.ts'

const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await use(errors)
      expect(errors, 'uncaught exceptions').toEqual([])
    },
    { auto: true },
  ],
})
test.use({ timezoneId: 'Asia/Taipei', locale: 'en-US', colorScheme: 'light' })

test.describe('user text is always text', () => {
  test('on every page, in the title and in the task modal', async ({ page }) => {
    await openSeeded(page, '/overview')
    await expectNoInjection(page, 'overview')
    for (const path of [
      '/projects',
      '/projects/p1/list',
      '/projects/p1/board',
      '/projects/p1/gantt',
      '/timeline',
      '/my-tasks/all',
      '/projects/p1/gantt?task=t4',
    ]) {
      await page.goto(path)
      // Not by role: an open task modal hides the sidebar from the accessibility tree.
      await expect(page.locator('aside[aria-label="Sidebar"]')).toBeVisible()
      await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0)
      await page.waitForTimeout(150)
      await expectNoInjection(page, path)
    }

    // The literal payload is on screen, as text, in the modal.
    await page.goto('/projects/p1/list?task=t1')
    const modal = page.getByRole('dialog').first()
    await expect(modal).toBeVisible()
    await expect(modal.getByRole('textbox').first()).toHaveValue(`Task ${XSS}`)
    await expect(modal.getByRole('textbox', { name: /description/i })).toHaveValue(
      /javascript:alert/,
    )
    await expectNoInjection(page, 'task modal')
    await page.keyboard.press('Escape')

    // document.title: the crumb is the project name, as a plain string.
    await page.goto('/projects/p1/list')
    await expect.poll(() => page.title()).toBe(`Project ${XSS} · Cairn`)
    expect(await page.evaluate(() => document.querySelector('title')?.childElementCount)).toBe(0)
    await expectNoInjection(page, 'title')
  })

  test('the search highlight splits text into marks, never into tags', async ({ page }) => {
    await openSeeded(page, '/overview')
    await page
      .getByRole('banner')
      .getByRole('button', { name: /^Search/ })
      .click()
    const results = page.getByRole('dialog', { name: 'Search' })
    const search = results.getByRole('combobox').or(results.getByRole('textbox')).first()
    await search.fill('img src')
    await expect(results.locator('[data-match]').first()).toBeVisible()
    await expect(results).toContainText('onerror')
    expect(await results.locator('[data-match]').first().innerHTML()).not.toContain('<')
    await expectNoInjection(page, 'search highlight')
    await search.fill('<script>')
    await expect(results.locator('[data-match]').first()).toContainText('<script>')
    await expectNoInjection(page, 'search for a tag')
    await search.fill(XSS)
    await page.waitForTimeout(150)
    await expectNoInjection(page, 'search for the whole payload')
  })

  test('in the dialog and the toast that name a deleted project', async ({ page }) => {
    await openSeeded(page, '/projects')
    const row = page.getByRole('row').filter({ hasText: 'Project <img' })
    await row.getByRole('button', { name: /^Actions for/ }).click()
    await page.getByRole('menuitem', { name: 'Delete project…' }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText(XSS)
    await expectNoInjection(page, 'confirm dialog')
    await confirm.getByRole('button', { name: /Delete/ }).click()
    const toast = page.locator('[data-sonner-toast]').first()
    await expect(toast).toContainText('<img src=x')
    await expectNoInjection(page, 'delete toast')
  })

  test('in an import preview and in the error for a damaged file', async ({ page }) => {
    await openSeeded(page, '/settings/data')
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    const backup = readFileSync(await download.path(), 'utf8')
    expect(JSON.parse(backup).data.projects[0].name).toContain(XSS)

    const input = page.getByLabel('Backup file')
    await input.setInputFiles({
      name: `${XSS}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(backup),
    })
    const dialog = page.getByRole('dialog', { name: 'Import backup' })
    await expect(dialog).toContainText(XSS)
    await expectNoInjection(page, 'import preview')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await input.setInputFiles({
      name: `${XSS}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ app: 'cairn', formatVersion: XSS })),
    })
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't import" })).toContainText(XSS)
    await expectNoInjection(page, 'import error')
  })
})

test.describe('unknown and hostile ids in URLs', () => {
  test('an unknown project shows "Project not found", whatever its id looks like', async ({
    page,
  }) => {
    await openSeeded(page, '/overview')
    for (const path of [
      '/projects/00000000-0000-4000-8000-000000000000',
      '/projects/00000000-0000-4000-8000-000000000000/gantt',
      '/projects/not-a-uuid/board',
      '/projects/__proto__/list',
      '/projects/constructor/gantt',
      '/projects/hasOwnProperty/list',
      '/projects/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E/list',
      "/projects/'%20OR%201%3D1--/list",
    ]) {
      await page.goto(path)
      await expect(page.getByRole('main'), path).toContainText('Project not found')
      await expectNoInjection(page, path)
    }
    const polluted = await page.evaluate(() => (({}) as Record<string, unknown>).polluted ?? null)
    expect(polluted).toBeNull()
  })

  test('an unknown ?task= shows "Task not found" and leaves the URL', async ({ page }) => {
    await openSeeded(page, '/overview')
    for (const id of [
      '00000000-0000-4000-8000-000000000000',
      '__proto__',
      'constructor',
      XSS,
      "' OR 1=1--",
    ]) {
      await page.goto(`/overview?task=${encodeURIComponent(id)}`)
      await expect(
        page.locator('[data-sonner-toast]').filter({ hasText: 'Task not found' }),
        id,
      ).toBeVisible()
      await expect(page).toHaveURL(/\/overview$/)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expectNoInjection(page, id)
    }
  })

  test('unknown routes stay in the app, on this origin', async ({ page, baseURL }) => {
    await openSeeded(page, '/overview')
    for (const [path, url] of [
      ['/my-tasks/__proto__', /\/my-tasks\/today$/],
      ['/settings/constructor', /\/settings\/account$/],
      ['/login', /\/overview$/],
    ] as const) {
      await page.goto(path)
      await expect(page).toHaveURL(url)
    }
    for (const path of [
      '/nonsense',
      '/projects/p1/nonsense',
      '/%3Cscript%3Ealert(1)%3C%2Fscript%3E',
    ]) {
      await page.goto(path)
      await expect(page.getByRole('main'), path).toContainText('Page not found')
      expect(new URL(page.url()).origin).toBe(baseURL)
      await expectNoInjection(page, path)
    }
  })

  test('hostile query parameters are ignored', async ({ page }) => {
    await openSeeded(page, '/projects/p1/board?phase=__proto__')
    await expect(page.getByRole('main').getByText('Plain task')).toBeVisible()
    await page.goto('/projects/p1/board?phase=%3Cimg%20src%3Dx%3E')
    await expect(page.getByRole('main').getByText('Plain task')).toBeVisible()
    await page.goto('/projects?status=__proto__')
    await expect(page.getByRole('main').getByText('Project <img')).toBeVisible()
    await page.goto('/my-tasks/all?completed=__proto__')
    await expect(page.getByRole('heading').first()).toBeVisible()
    await expectNoInjection(page, 'query parameters')
  })
})
