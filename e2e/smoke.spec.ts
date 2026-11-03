/// <reference lib="dom" />
/**
 * Shell smoke test — runs in LOCAL data mode against the dev server (playwright.config.ts).
 *
 * Covers the app frame only: boot without console errors, sidebar navigation (with its screen
 * reader announcement), redirects and the NotFound page, sidebar collapse + theme persistence
 * (theme applied before React mounts), the ⌘/Ctrl+K search toggle with Esc, the shortcuts help,
 * a failed save's toast Retry over a modal, and keyboard basics (skip link, focus return, no
 * shortcuts while typing). Pages inside the shell belong to feature slices, so the assertions
 * stick to shell contracts: URL, document title, breadcrumb, aria-current, aria-expanded, the
 * data-collapsed / .dark state and the stored preferences.
 */
import { expect, test as base, type Locator, type Page } from '@playwright/test'

const UI_PREFS_KEY = 'cairn:ui-prefs'
const LOCAL_WORKSPACE_KEY = 'cairn:local:workspace:v1'
const PROJECT_VIEWS_KEY = 'cairn:project-views'

/** Every test fails if the page logs a console error or throws. */
const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
      await use(errors)
      expect(errors, 'console errors / uncaught exceptions').toEqual([])
    },
    { auto: true },
  ],
})

function sidebar(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Sidebar' })
}

function currentCrumb(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Breadcrumb' }).locator('[aria-current="page"]')
}

/**
 * The top-bar Search button. While a modal overlay is open Radix hides the rest of the app from
 * assistive tech (aria-hidden), so the lookup must include hidden elements.
 */
function searchButton(page: Page): Locator {
  return page
    .getByRole('banner', { includeHidden: true })
    .getByRole('button', { name: /^Search/, includeHidden: true })
}

/** Waits until the shell is mounted and the workspace has finished loading. */
async function openApp(page: Page, path = '/'): Promise<void> {
  await page.goto(path)
  await expect(sidebar(page)).toBeVisible()
  await expect(page.getByRole('main').locator('[aria-busy="true"]')).toHaveCount(0)
}

/** Resolves once a preference reached both the startup cache and the local "database". */
async function expectSavedPreference(page: Page, key: string, value: unknown): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ key, uiPrefsKey, workspaceKey }) => {
          const read = (storageKey: string) => {
            try {
              return JSON.parse(localStorage.getItem(storageKey) ?? 'null')
            } catch {
              return null
            }
          }
          return [read(uiPrefsKey)?.[key], read(workspaceKey)?.preferences?.[key]]
        },
        { key, uiPrefsKey: UI_PREFS_KEY, workspaceKey: LOCAL_WORKSPACE_KEY },
      ),
    )
    .toEqual([value, value])
}

/** The modifier the app's keyboard engine treats as `mod` (⌘ on Apple platforms, else Ctrl). */
function modifierKey(page: Page): Promise<'Meta' | 'Control'> {
  return page.evaluate(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
    const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent
    return /mac|iphone|ipad|ipod/i.test(platform) ? 'Meta' : 'Control'
  })
}

test.describe('app shell (local mode)', () => {
  test('boots at /overview in local mode without console errors', async ({ page }) => {
    await openApp(page, '/')
    await expect(page).toHaveURL(/\/overview$/)
    await expect(page).toHaveTitle('Overview · Cairn')
    await expect(currentCrumb(page)).toHaveText('Overview')
    // Local mode is never presented as cloud sync.
    await expect(
      sidebar(page).getByRole('button', { name: 'Sync status: Local only — not synced' }),
    ).toBeVisible()
    await expect(
      sidebar(page)
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Overview' }),
    ).toHaveAttribute('aria-current', 'page')
  })

  test('sidebar navigation reaches every top-level page (and Back works)', async ({ page }) => {
    await openApp(page, '/overview')
    const destinations = [
      { name: /^My Tasks/, url: /\/my-tasks\/today$/, crumb: 'My Tasks' },
      { name: /^Projects$/, url: /\/projects$/, crumb: 'Projects' },
      { name: /^Timeline$/, url: /\/timeline$/, crumb: 'Timeline' },
      { name: /^Settings$/, url: /\/settings\/account$/, crumb: 'Settings' },
      { name: /^Overview$/, url: /\/overview$/, crumb: 'Overview' },
    ]
    // Screen readers hear the new page's name (focus stays on the link that was used).
    const announcer = page.locator('[data-slot="route-announcer"]')
    await expect(announcer).toHaveAttribute('aria-live', 'polite')
    for (const destination of destinations) {
      const link = sidebar(page).getByRole('link', { name: destination.name })
      await link.click()
      await expect(page).toHaveURL(destination.url)
      await expect(page).toHaveTitle(`${destination.crumb} · Cairn`)
      await expect(currentCrumb(page)).toHaveText(destination.crumb)
      await expect(link).toHaveAttribute('aria-current', 'page')
      await expect(sidebar(page).locator('[aria-current="page"]')).toHaveCount(1)
      await expect(announcer).toHaveText(destination.crumb)
    }
    await page.goBack()
    await expect(page).toHaveURL(/\/settings\/account$/)
    await expect(currentCrumb(page)).toHaveText('Settings')
  })

  test('redirects keep the query string; unknown routes show NotFound', async ({ page }) => {
    await openApp(page, '/my-tasks')
    await expect(page).toHaveURL(/\/my-tasks\/today$/)
    await page.goto('/my-tasks/someday?ref=smoke')
    await expect(page).toHaveURL(/\/my-tasks\/today\?ref=smoke$/)
    await page.goto('/settings')
    await expect(page).toHaveURL(/\/settings\/account$/)
    await page.goto('/settings/nope')
    await expect(page).toHaveURL(/\/settings\/account$/)
    await page.goto('/login')
    await expect(page).toHaveURL(/\/overview$/) // local mode has no sign-in page
    await page.goto('/?ref=smoke')
    await expect(page).toHaveURL(/\/overview\?ref=smoke$/)

    // /projects/:id opens the project's last used view on this device (default: list).
    await page.evaluate(
      (key) => localStorage.setItem(key, JSON.stringify({ 'p-smoke': 'board' })),
      PROJECT_VIEWS_KEY,
    )
    await page.goto('/projects/p-smoke?ref=smoke')
    await expect(page).toHaveURL(/\/projects\/p-smoke\/board\?ref=smoke$/)
    await page.goto('/projects/p-other')
    await expect(page).toHaveURL(/\/projects\/p-other\/list$/)
    await page.goto('/projects/a%2Fb') // an encoded id stays one path segment
    await expect(page).toHaveURL(/\/projects\/a%2Fb\/list$/)

    await page.goto('/definitely/not-a-page')
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    await expect(page).toHaveTitle('Not found · Cairn')
    await expect(sidebar(page)).toBeVisible() // still inside the shell
    await page.getByRole('link', { name: 'Go to Overview' }).click()
    await expect(page).toHaveURL(/\/overview$/)
  })

  test('sidebar collapse persists across reloads (button and "[")', async ({ page }) => {
    await openApp(page, '/overview')
    const aside = sidebar(page)
    await expect(aside).toHaveAttribute('data-collapsed', 'false')

    await aside.getByRole('button', { name: 'Collapse sidebar' }).click()
    await expect(aside).toHaveAttribute('data-collapsed', 'true')
    await expectSavedPreference(page, 'sidebarCollapsed', true)
    await page.reload()
    await expect(aside).toHaveAttribute('data-collapsed', 'true')
    // The icon rail keeps every destination reachable by name.
    await expect(aside.getByRole('link', { name: /^Timeline$/ })).toBeVisible()

    await page.locator('body').press('[')
    await expect(aside).toHaveAttribute('data-collapsed', 'false')
    await expectSavedPreference(page, 'sidebarCollapsed', false)
    await page.reload()
    await expect(aside).toHaveAttribute('data-collapsed', 'false')
    await expect(aside.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible()
  })

  test('theme menu switches light/dark, persists, and applies before React mounts', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await openApp(page, '/overview')
    const html = page.locator('html')
    const themeButton = page.getByRole('banner').getByRole('button', { name: /^Theme:/ })
    await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/)

    await themeButton.click()
    await page.getByRole('menuitemradio', { name: 'Dark' }).click()
    await expect(html).toHaveClass(/(^|\s)dark(\s|$)/)
    await expect(themeButton).toHaveAccessibleName('Theme: Dark')
    await expectSavedPreference(page, 'theme', 'dark')

    await page.reload()
    await expect(html).toHaveClass(/(^|\s)dark(\s|$)/)
    await expect(themeButton).toHaveAccessibleName('Theme: Dark')

    // No flash: with the app bundle blocked (React never mounts), the inline script in
    // index.html has already applied the stored theme.
    const probe = await page.context().newPage()
    await probe.route('**/src/main.tsx*', (route) => route.abort())
    await probe.goto('/overview')
    expect(
      await probe.evaluate(() => ({
        dark: document.documentElement.classList.contains('dark'),
        reactMounted: (document.getElementById('root')?.childElementCount ?? 0) > 0,
      })),
    ).toEqual({ dark: true, reactMounted: false })
    await probe.close()

    await themeButton.click()
    await page.getByRole('menuitemradio', { name: 'Light' }).click()
    await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/)
    await expectSavedPreference(page, 'theme', 'light')
    await page.reload()
    await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/)

    // "System" follows the OS setting live.
    await themeButton.click()
    await page.getByRole('menuitemradio', { name: 'System' }).click()
    await expectSavedPreference(page, 'theme', 'system')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(html).toHaveClass(/(^|\s)dark(\s|$)/)
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/)
  })

  test('⌘/Ctrl+K toggles the search overlay and Esc closes it', async ({ page }) => {
    await openApp(page, '/overview')
    const button = searchButton(page)
    const mod = await modifierKey(page)
    await expect(button).toHaveAttribute('aria-expanded', 'false')

    await page.keyboard.press(`${mod}+k`)
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    // Whatever the overlay renders: a dialog, when present, is visible and owns focus.
    const dialogs = page.getByRole('dialog')
    if ((await dialogs.count()) > 0) {
      await expect(dialogs.first()).toBeVisible()
      await expect
        .poll(() => dialogs.first().evaluate((node) => node.contains(document.activeElement)))
        .toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // ⌘K toggles; the top-bar button opens it too, and Esc gives focus back to that button.
    await page.keyboard.press(`${mod}+k`)
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press(`${mod}+k`)
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(button).toBeFocused()
  })

  test('"?" opens the shortcuts help: focus stays inside, Esc returns it', async ({ page }) => {
    await openApp(page, '/overview')
    const button = searchButton(page)
    await button.focus()
    await page.keyboard.press('?')
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(help).toBeVisible()
    await expect(help.getByText('Go to Timeline')).toBeVisible()
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab')
      expect(await help.evaluate((node) => node.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(help).toHaveCount(0)
    await expect(button).toBeFocused()
  })

  test("a failed save's toast Retry stays usable over a modal dialog", async ({ page }) => {
    await openApp(page, '/overview')
    // A CSS locator: while the modal is open the sidebar is hidden from assistive tech.
    const aside = page.locator('aside[aria-label="Sidebar"]')
    await page.evaluate(() => {
      type TestHooks = { failNextWrites(count: number): void }
      ;(window as Window & { __cairnTest?: TestHooks }).__cairnTest?.failNextWrites(1)
    })
    await page.locator('body').press('[')
    // The write fails: the collapse is rolled back and an error toast offers Retry.
    const retry = page.locator('[data-sonner-toast] [data-button]', { hasText: 'Retry' })
    await expect(retry).toBeVisible()
    await expect(aside).toHaveAttribute('data-collapsed', 'false')

    // A modal opens on top (Radix makes the rest of the page inert to the pointer).
    await page.locator('body').press('?')
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(help).toBeVisible()

    await retry.click() // a real hit-tested click: it must reach the toast, not the overlay
    await expect(aside).toHaveAttribute('data-collapsed', 'true')
    await expect(help).toBeVisible() // using the toast did not dismiss the dialog
    await expectSavedPreference(page, 'sidebarCollapsed', true)
  })

  test('the skip link moves keyboard focus to the main content', async ({ page }) => {
    await openApp(page, '/overview')
    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: 'Skip to content' })
    await expect(skip).toBeFocused()
    await expect(skip).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('main')).toBeFocused()
    await expect(page).toHaveURL(/\/overview$/) // no #main added to the URL
  })

  test('single-key shortcuts navigate, but never while typing', async ({ page }) => {
    await openApp(page, '/overview')
    await page.locator('body').press('g')
    await page.locator('body').press('p')
    await expect(page).toHaveURL(/\/projects$/)

    // A text field anywhere on the page swallows the same keys.
    await page.evaluate(() => {
      const input = document.createElement('input')
      input.setAttribute('aria-label', 'Scratch field')
      document.getElementById('main')?.prepend(input)
    })
    const field = page.getByRole('textbox', { name: 'Scratch field' })
    await field.click()
    await page.keyboard.type('gt[?')
    await expect(field).toHaveValue('gt[?')
    await expect(page).toHaveURL(/\/projects$/)
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'false')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})
