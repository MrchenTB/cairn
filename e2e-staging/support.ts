/// <reference lib="dom" />
/**
 * Shared test kit of the staging suite (playwright.staging.config.ts). Same conventions as
 * e2e-cloud/support.ts, but every check goes through public interfaces only: the app's UI and
 * `/rest/v1` with the user's own token. Faults are made in the browser (`page.route`,
 * `context.setOffline`), never on the server.
 */
import { readFileSync } from 'node:fs'
import {
  expect,
  test as base,
  type BrowserContext,
  type Download,
  type Locator,
  type Page,
} from '@playwright/test'
import { deleteTestProjects, STORAGE_STATE, type UserKey } from './api.ts'
import { expectShell, saveSignedInState, sidebar } from './ui.ts'

export * from './api.ts'
export { expectShell, sidebar, submitSignIn } from './ui.ts'
export { expect }

/** The browser's own line for any failed HTTP answer: expected wherever a test provokes one. */
const NETWORK_LOG = /^Failed to load resource/

const errors: string[] = []

/** The console check for a page of its own: a second device or a second tab. */
export function watchConsole(page: Page): void {
  page.on('console', (message) => {
    if (message.type() === 'error' && !NETWORK_LOG.test(message.text())) {
      errors.push(message.text())
    }
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
}

/** When the browser session saved for this account stops being valid (seconds since the epoch). */
function savedSessionExpiry(user: UserKey): number {
  const state = JSON.parse(readFileSync(STORAGE_STATE[user], 'utf8')) as {
    origins: { localStorage: { name: string; value: string }[] }[]
  }
  for (const origin of state.origins) {
    for (const item of origin.localStorage) {
      if (item.name.startsWith('sb-') && item.name.endsWith('-auth-token')) {
        return (JSON.parse(item.value) as { expires_at: number }).expires_at
      }
    }
  }
  return 0
}

/** Opens a browser session of an account (`null` = nobody signed in), closed after the test. */
export type Device = (user: UserKey | null) => Promise<Page>

export const test = base.extend<{ device: Device; guard: void }>({
  device: async ({ browser, baseURL }, provide) => {
    const contexts: BrowserContext[] = []
    await provide(async (user) => {
      const context = await browser.newContext({
        baseURL,
        locale: 'en-US',
        viewport: { width: 1280, height: 800 },
        storageState: user ? STORAGE_STATE[user] : undefined,
      })
      contexts.push(context)
      const page = await context.newPage()
      watchConsole(page)
      return page
    })
    for (const context of contexts) await context.close()
  },

  /**
   * Around every test: sessions kept fresh, then (after it, pass or fail) every test project of
   * both accounts removed, then the console must have stayed clean.
   */
  guard: [
    async ({ page, browser, baseURL }, use) => {
      errors.length = 0
      watchConsole(page)
      for (const user of ['A', 'B'] as const) {
        // A saved browser session near its end would be renewed by two contexts at once.
        if (savedSessionExpiry(user) - Date.now() / 1000 < 20 * 60 && baseURL) {
          await saveSignedInState(browser, baseURL, user)
        }
      }
      await use()
      for (const user of ['A', 'B'] as const) await deleteTestProjects(user)
      expect(errors, 'console errors / uncaught exceptions').toEqual([])
    },
    { auto: true },
  ],
})

// ---------------------------------------------------------------------------
// Locators shared with the local-mode specs
// ---------------------------------------------------------------------------

export const taskRow = (page: Page, title: string) =>
  page
    .locator('[data-task-row]')
    .filter({ has: page.getByRole('button', { name: `Move ${title}`, exact: true }) })

/** Titles of the task rows in order; subtasks are marked with "↳ ". */
export function rowTitles(scope: Locator): Promise<string[]> {
  return scope.locator('[data-task-row]').evaluateAll((rows) =>
    rows.map((row) => {
      const handle = row.querySelector('button[aria-label^="Move "]')
      const title = handle?.getAttribute('aria-label')?.slice('Move '.length) ?? '?'
      return row.getAttribute('data-depth') === '1' ? `↳ ${title}` : title
    }),
  )
}

export const listScroll = (page: Page) => page.locator('[data-list-scroll]')

/** A toast on its way in or showing (one being dismissed stays in the DOM for its exit animation). */
export const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]:not([data-removed="true"])').filter({ hasText: text })

export function syncIndicator(page: Page, label: string | RegExp): Locator {
  return sidebar(page).getByRole('button', {
    name: typeof label === 'string' ? `Sync status: ${label}` : label,
  })
}

export const modal = (page: Page) => page.getByRole('dialog', { name: /^Edit task:/ })
export const titleBox = (page: Page) => modal(page).getByRole('textbox', { name: 'Task title' })
export const descriptionBox = (page: Page) =>
  modal(page).getByRole('textbox', { name: 'Description' })
export const footerState = (page: Page) => modal(page).locator('[data-save-state]')

/** Opens the Task Modal on a task and waits for its title to show. */
export async function openTask(
  page: Page,
  projectId: string,
  taskId: string,
  title: string,
): Promise<void> {
  await page.goto(`/projects/${projectId}/list?task=${taskId}`)
  await expect(titleBox(page)).toHaveValue(title)
}

/** Opens a project's List view and waits until the workspace has loaded. */
export async function openList(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/list`)
  await expectShell(page)
}

// ---------------------------------------------------------------------------
// Dates in the Task Modal
// ---------------------------------------------------------------------------

/** Today plus `offset` days, as YYYY-MM-DD (a plain calendar day, no time zone arithmetic). */
export function isoDay(offset = 0): string {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dayPattern(date: string): RegExp {
  const [year, month, day] = date.split('-').map(Number)
  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  })
  const suffix =
    day % 10 === 1 && day !== 11
      ? 'st'
      : day % 10 === 2 && day !== 12
        ? 'nd'
        : day % 10 === 3 && day !== 13
          ? 'rd'
          : 'th'
  return new RegExp(`${monthName} ${day}${suffix}, ${year}`)
}

/** Picks a day in one of the Task Modal's date pickers ("Start date", "Due date"). */
export async function pickDate(page: Page, field: string, date: string): Promise<void> {
  await modal(page)
    .getByRole('button', { name: new RegExp(`^${field}:`) })
    .click()
  const picker = page.getByRole('dialog', { name: field, exact: true })
  const day = picker.getByRole('button', { name: dayPattern(date) })
  for (let step = 0; step < 4 && (await day.count()) === 0; step += 1) {
    await picker.getByRole('button', { name: 'Go to the Next Month' }).click()
  }
  await day.click()
  await expect(picker).toBeHidden()
}

// ---------------------------------------------------------------------------
// Backup files
// ---------------------------------------------------------------------------

/** Settings → Data → Export JSON backup: the downloaded file's text. */
export async function exportBackup(page: Page): Promise<string> {
  await page.goto('/settings/data')
  await expectShell(page)
  const [download]: [Download, void] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export JSON backup' }).click(),
  ])
  return readFileSync(await download.path(), 'utf8')
}

/** Settings → Data → Import backup…, confirmed as new copies; resolves with the success toast. */
export async function importBackup(page: Page, text: string): Promise<string> {
  await page.goto('/settings/data')
  await expectShell(page)
  await page.getByLabel('Backup file').setInputFiles({
    name: 'staging-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  })
  const dialog = page.getByRole('dialog', { name: 'Import backup' })
  await dialog.getByRole('button', { name: 'Import as new copies' }).click()
  await expect(dialog).toBeHidden({ timeout: 60_000 })
  const done = toast(page, 'Backup imported')
  await expect(done).toBeVisible({ timeout: 30_000 })
  return (await done.innerText()).replace(/\s+/g, ' ')
}

/** Median of a list of numbers. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
