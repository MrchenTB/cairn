/// <reference lib="dom" />
/**
 * Search overlay + Settings E2E — runs in LOCAL data mode against the dev server
 * (playwright.config.ts).
 *
 * PRD §4.10 (global search overlay, Settings), §5.4 (no silent failures), acceptance 11 (search
 * finds tasks across projects), 14 (themes, keyboard, modals) and 15 (failed saves are not
 * reported as saved, retry/rollback, a backup can be exported).
 *
 * Search: ⌘/Ctrl+K and the top-bar button, quick actions, grouped results with their context,
 * highlighting (CJK too), why a result matched, archived labels, no-results, the 50-result cap,
 * keyboard navigation and where each kind of result opens.
 * Settings: section routes, theme / week / time zone saved and surviving a reload, a failed save
 * rolling back with a working Retry, the sync card ("Sync now" never blanks the app), JSON and CSV
 * exports, the import flow (validation errors, preview, "new copies only", focus, a failed
 * import retried exactly once).
 */
import { readFileSync } from 'node:fs'
import { expect, test as base, type Download, type Locator, type Page } from '@playwright/test'

const LOCAL_WORKSPACE_KEY = 'cairn:local:workspace:v1'
const PROJECT_VIEWS_KEY = 'cairn:project-views'
const NOW = '2026-11-03T08:00:00.000Z'
/** Due dates far in the future: independent of the day the suite runs on. */
const DUE = '2040-11-05'
const MILESTONE_DATE = '2040-11-20'

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

// A fixed browser time zone and colour scheme: the defaults of a fresh device follow them.
test.use({ timezoneId: 'Asia/Taipei', locale: 'en-US', colorScheme: 'light' })

// ---------------------------------------------------------------------------
// Seed: a local "database" written to localStorage before the app boots
// ---------------------------------------------------------------------------

interface SeedTask {
  id: string
  title: string
  description?: string
  parentId?: string
  status?: 'todo' | 'in_progress' | 'done'
  dueDate?: string
}

interface SeedProject {
  id: string
  name: string
  description?: string
  status?: 'active' | 'completed' | 'archived'
  color?: string
  tasks?: SeedTask[]
  milestones?: { id: string; name: string; date: string }[]
}

/** Fractional-index keys that sort by position for up to 62 siblings: a0 … a9, aA … aZ, aa … az. */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const orderKey = (index: number) => `a${DIGITS[index]}`

function buildWorkspace(projects: SeedProject[]): unknown {
  const db = {
    version: 1,
    projects: {} as Record<string, unknown>,
    phases: {},
    tasks: {} as Record<string, unknown>,
    milestones: {} as Record<string, unknown>,
    dependencies: {},
    preferences: null,
  }
  projects.forEach((project, projectIndex) => {
    db.projects[project.id] = {
      id: project.id,
      name: project.name,
      description: project.description ?? null,
      status: project.status ?? 'active',
      color: project.color ?? 'violet',
      startDate: null,
      dueDate: null,
      scheduleMode: 'manual',
      sortOrder: orderKey(projectIndex),
      createdAt: NOW,
      updatedAt: NOW,
    }
    project.tasks?.forEach((task, index) => {
      db.tasks[task.id] = {
        id: task.id,
        projectId: project.id,
        phaseId: null,
        parentTaskId: task.parentId ?? null,
        title: task.title,
        description: task.description ?? null,
        status: task.status ?? 'todo',
        priority: 'none',
        startDate: null,
        dueDate: task.dueDate ?? null,
        sortOrder: orderKey(index),
        completedAt: task.status === 'done' ? NOW : null,
        createdAt: NOW,
        updatedAt: NOW,
      }
    })
    project.milestones?.forEach((milestone) => {
      db.milestones[milestone.id] = {
        id: milestone.id,
        projectId: project.id,
        phaseId: null,
        name: milestone.name,
        date: milestone.date,
        createdAt: NOW,
        updatedAt: NOW,
      }
    })
  })
  return db
}

/**
 * Research (the "interview" project: one done task, a subtask, a task found only through its
 * description), a project with a CJK name and description, a flat project with a second
 * "Interview users", an archived project with a task and a milestone, and 60 "Bulk" tasks.
 * 5 projects, 70 tasks, 2 milestones.
 */
function seedWorkspace(): unknown {
  return buildWorkspace([
    {
      id: 'p-research',
      name: 'Research',
      description: 'User interviews and a prototype',
      color: 'violet',
      tasks: [
        { id: 't-inbox', title: 'Inbox idea' },
        { id: 't-interview', title: 'Interview users', status: 'done' },
        { id: 't-synth', title: 'Synthesize findings', status: 'in_progress', dueDate: DUE },
        { id: 't-personas', title: 'Write personas', parentId: 't-synth' },
        {
          id: 't-proto',
          title: 'Prototype flow',
          description: 'A clickable prototype for the interview sessions',
        },
      ],
      milestones: [{ id: 'm-kickoff', name: 'Kickoff', date: MILESTONE_DATE }],
    },
    {
      id: 'p-cjk',
      name: 'Roadmap 規劃',
      description: '市場調查與使用者訪談計畫',
      color: 'teal',
      tasks: [
        { id: 'c-1', title: '問卷設計' },
        {
          id: 'c-2',
          title: '使用者訪談計畫整理成報告，包含訪談逐字稿與洞察摘要，並且需要在下週之前完成交付',
        },
      ],
    },
    {
      id: 'p-flat',
      name: 'Flat project',
      color: 'green',
      tasks: [
        { id: 'f-interview', title: 'Interview users' },
        { id: 'f-alpha', title: 'Alpha' },
      ],
    },
    {
      id: 'p-old',
      name: 'Legacy migration',
      color: 'gray',
      status: 'archived',
      tasks: [{ id: 'o-1', title: 'Inventory services' }],
      milestones: [{ id: 'm-cutover', name: 'Cutover', date: MILESTONE_DATE }],
    },
    {
      id: 'p-bulk',
      name: 'Bulk project',
      color: 'orange',
      tasks: Array.from({ length: 60 }, (_, index) => ({
        id: `b-${index}`,
        title: `Bulk task ${String(index + 1).padStart(2, '0')}`,
      })),
    },
  ])
}

const SEEDED = { projects: 5, tasks: 70, milestones: 2 }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Boots the app at `path`; the workspace is seeded once per tab (a reload keeps the changes). */
async function openApp(page: Page, path: string, workspace: unknown = seedWorkspace()) {
  if (workspace !== null) {
    await page.addInitScript(
      ({ storageKey, db }) => {
        if (sessionStorage.getItem('cairn-e2e-search-settings-seeded')) return
        localStorage.setItem(storageKey, JSON.stringify(db))
        sessionStorage.setItem('cairn-e2e-search-settings-seeded', '1')
      },
      { storageKey: LOCAL_WORKSPACE_KEY, db: workspace },
    )
  }
  await page.goto(path)
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
  await expect(page.getByRole('main').locator('[aria-busy="true"]')).toHaveCount(0)
}

type TestHooks = { failNextWrites(count: number): void; setLatency(ms: number): void }

function failNextWrites(page: Page, count: number): Promise<void> {
  return page.evaluate((n) => {
    ;(window as unknown as { __cairnTest: TestHooks }).__cairnTest.failNextWrites(n)
  }, count)
}

function setLatency(page: Page, ms: number): Promise<void> {
  return page.evaluate((value) => {
    ;(window as unknown as { __cairnTest: TestHooks }).__cairnTest.setLatency(value)
  }, ms)
}

const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })

/** Counts of the rows in the local "database" (what was really saved). */
function storedCounts(page: Page) {
  return page.evaluate((storageKey) => {
    const db = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, object>
    const count = (table: string) => Object.keys(db[table] ?? {}).length
    return { projects: count('projects'), tasks: count('tasks'), milestones: count('milestones') }
  }, LOCAL_WORKSPACE_KEY)
}

function storedPreferences(page: Page) {
  return page.evaluate(
    (storageKey) =>
      (JSON.parse(localStorage.getItem(storageKey) ?? '{}') as { preferences?: unknown })
        .preferences ?? null,
    LOCAL_WORKSPACE_KEY,
  ) as Promise<{ theme: string; weekStartsOn: number; timezone: string } | null>
}

const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains('dark'))

async function downloadText(download: Download): Promise<string> {
  const path = await download.path()
  return readFileSync(path, 'utf8')
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

const searchDialog = (page: Page) => page.getByRole('dialog', { name: 'Search' })

/** The modifier the app's keyboard engine treats as `mod` (⌘ on Apple platforms, else Ctrl). */
function modifierKey(page: Page): Promise<'Meta' | 'Control'> {
  return page.evaluate(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
    const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent
    return /mac|iphone|ipad|ipod/i.test(platform) ? 'Meta' : 'Control'
  })
}

/** Presses ⌘K / Ctrl+K, whichever this browser's platform uses. */
async function pressSearchShortcut(page: Page): Promise<void> {
  await page.keyboard.press(`${await modifierKey(page)}+k`)
}

/** ⌘/Ctrl+K: resolves with the open overlay once its input has focus. */
async function openSearch(page: Page): Promise<Locator> {
  await pressSearchShortcut(page)
  const dialog = searchDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox')).toBeFocused()
  return dialog
}

/** Types a query and waits for the list to show it. */
async function search(dialog: Locator, query: string): Promise<void> {
  await dialog.getByRole('combobox').fill(query)
  await expect(dialog.getByRole('combobox')).toHaveValue(query)
}

const selectedOption = (dialog: Locator) =>
  dialog.getByRole('option').and(dialog.locator('[aria-selected="true"]'))

// ===========================================================================
// Search
// ===========================================================================

test.describe('Search overlay', () => {
  test('opens from the button and from ⌘/Ctrl+K, offers quick actions and closes with Esc', async ({
    page,
  }) => {
    await openApp(page, '/overview')

    // Button → overlay, focus in the input, hints in the footer.
    await searchButton(page).click()
    const dialog = searchDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('combobox')).toBeFocused()
    await expect(dialog.getByRole('option')).toHaveText([
      /^New task/,
      /^New project/,
      /^Toggle theme/,
      /^Go to Overview/,
      /^Go to My Tasks/,
      /^Go to Projects/,
      /^Go to Timeline/,
      /^Go to Settings/,
    ])
    await expect(dialog).toContainText('Navigate')
    await expect(dialog).toContainText('Open')
    await expect(dialog).toContainText('Close')

    // Esc closes it and gives focus back to the button that opened it.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(searchButton(page)).toBeFocused()

    // The shortcut toggles it; a query is forgotten once it closes.
    await openSearch(page)
    await search(searchDialog(page), 'interview')
    await pressSearchShortcut(page)
    await expect(searchDialog(page)).toBeHidden()
    await openSearch(page)
    await expect(searchDialog(page).getByRole('combobox')).toHaveValue('')
  })

  test('quick actions navigate, toggle the theme and open the creation dialogs', async ({
    page,
  }) => {
    await openApp(page, '/overview')

    let dialog = await openSearch(page)
    await dialog.getByRole('option', { name: /^Go to Settings/ }).click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/\/settings\/account$/)

    dialog = await openSearch(page)
    await dialog.getByRole('option', { name: /^Go to Projects/ }).click()
    await expect(page).toHaveURL(/\/projects$/)

    // Toggle theme saves the preference (and survives a reload).
    expect(await isDark(page)).toBe(false)
    dialog = await openSearch(page)
    await expect(dialog.getByRole('option', { name: /^Toggle theme/ })).toContainText(
      'Switch to dark',
    )
    await dialog.getByRole('option', { name: /^Toggle theme/ }).click()
    await expect.poll(() => isDark(page)).toBe(true)
    await expect.poll(async () => (await storedPreferences(page))?.theme).toBe('dark')
    await page.reload()
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
    expect(await isDark(page)).toBe(true)
    dialog = await openSearch(page)
    await expect(dialog.getByRole('option', { name: /^Toggle theme/ })).toContainText(
      'Switch to light',
    )
    await page.keyboard.press('Escape')

    // New task / New project open their dialogs with the field ready.
    dialog = await openSearch(page)
    await dialog.getByRole('option', { name: /^New project/ }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Name' })).toBeFocused()
    await page.keyboard.press('Escape')

    await page.goto('/projects/p-flat/list')
    dialog = await openSearch(page)
    await dialog.getByRole('option', { name: /^New task/ }).click()
    await expect(dialog).toBeHidden()
    const created = page.getByRole('dialog')
    await expect(created.getByRole('textbox', { name: 'Task title' })).toBeFocused()
    await expect(created).toContainText('Flat project') // for the project being viewed
  })

  test('opening it again right after picking a result starts fresh with the input focused', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    const dialog = await openSearch(page)
    await search(dialog, 'project')
    // A click moves focus off the input; the overlay is still fading out when ⌘K comes.
    await dialog.getByRole('option', { name: /^Flat project/ }).click()
    await pressSearchShortcut(page)

    const again = searchDialog(page)
    await expect(again).toBeVisible()
    await expect(again.getByRole('combobox')).toBeFocused()
    await expect(again.getByRole('combobox')).toHaveValue('')
    await expect(again.getByRole('option', { name: /^New task/ })).toBeVisible()
    await page.keyboard.type('alpha') // typing goes to the input, not to the page
    await expect(again.getByRole('combobox')).toHaveValue('alpha')
  })

  test('⌘K right after confirming a delete keeps the input focused and Esc closes on the first press', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    const cdp = await page.context().newCDPSession(page)
    const first = await openSearch(page)
    await search(first, 'alpha')
    await first.getByRole('option', { name: /^Alpha/ }).click()
    const task = page.getByRole('dialog', { name: /^Edit task: Alpha/ })
    await task.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: /Delete task/ }).click()
    await page
      .getByRole('alertdialog', { name: 'Delete task?' })
      .getByRole('button', { name: 'Delete' })
      .click()
    // The confirmation and the task are still fading out when the overlay opens. On a slow
    // machine the overlay is still mounting when the confirmation's exit ends.
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 50 })
    const dialog = await openSearch(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await search(dialog, 'alpha')
    await expect(dialog.getByRole('listbox').getByText('No results for "alpha"')).toBeVisible()
    // Once the confirmation has gone for good, its delayed focus return has run: it must not
    // pull focus back to the "More actions" button of the closing task (nor open its tooltip).
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(task).toHaveCount(0)
    await expect(dialog.getByRole('combobox')).toBeFocused()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  test('a menu opened right after picking a task stays open while the overlay finishes closing', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    const dialog = await openSearch(page)
    await search(dialog, 'alpha')
    // A slow machine stretches the window between the click and the end of the overlay's exit.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
    await dialog.getByRole('option', { name: /^Alpha/ }).click()
    const task = page.getByRole('dialog', { name: /^Edit task: Alpha/ })
    await task.getByRole('button', { name: 'More actions' }).click()
    const deleteItem = page.getByRole('menuitem', { name: /Delete task/ })
    await expect(deleteItem).toBeVisible()
    // The overlay is gone for good: whatever it still had to do with focus has been done.
    await expect(dialog).toHaveCount(0)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await expect(deleteItem).toBeVisible()
    await deleteItem.click()
    await expect(page.getByRole('alertdialog', { name: 'Delete task?' })).toBeVisible()
  })

  test('lists the projects visited last under the quick actions', async ({ page }) => {
    await openApp(page, '/projects/p-flat/list')
    await expect(page.getByRole('heading', { name: 'Flat project', level: 1 })).toBeVisible()
    await page.goto('/projects/p-research/list')
    await expect(page.getByRole('heading', { name: 'Research', level: 1 })).toBeVisible()
    await page.goto('/overview')

    const dialog = await openSearch(page)
    const options = dialog.getByRole('option')
    await expect(options).toHaveCount(10)
    await expect(options.nth(8)).toContainText('Research') // most recent first
    await expect(options.nth(9)).toContainText('Flat project')
    await options.nth(9).click()
    await expect(page).toHaveURL(/\/projects\/p-flat\/list$/)
  })

  test('finds tasks across projects, with context, highlights and why they matched', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    const dialog = await openSearch(page)
    await search(dialog, 'interview')

    const options = dialog.getByRole('option')
    // Projects first, then tasks: open tasks before done ones, whatever the project.
    await expect(options).toHaveText([
      /^Research/,
      /^Interview users.*Flat project/,
      /^Prototype flow/,
      /^Interview users.*Research/,
    ])
    await expect(dialog.getByText('Projects', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Tasks', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Milestones', { exact: true })).toHaveCount(0)

    // Context a title alone does not give: the project, the status for screen readers.
    const flat = options.nth(1)
    await expect(flat).toContainText('Flat project')
    await expect(flat).toContainText('To Do')
    await expect(flat.locator('[data-match]')).toHaveText('Interview')
    await expect(options.nth(3)).toContainText('Done')

    // A task found only through its description quotes it, match emphasised.
    const proto = options.nth(2)
    await expect(proto.locator('[data-snippet]')).toHaveText(
      '…prototype for the interview sessions',
    )
    await expect(proto.locator('[data-snippet] [data-match]')).toHaveText('interview')
    await expect(proto.locator('[data-match]')).toHaveCount(1) // the snippet holds the only match
    // …and so does a project (description "User interviews and a prototype").
    await expect(options.first().locator('[data-snippet]')).toContainText('User interviews')

    // A subtask names its parent, a due date shows.
    await search(dialog, 'personas')
    await expect(options).toHaveCount(1)
    await expect(options.first()).toContainText('in Synthesize findings')
    await search(dialog, 'synthesize')
    await expect(options.first()).toContainText('Nov 5, 2040')
  })

  test('finds CJK text and ignores width / case differences', async ({ page }) => {
    await openApp(page, '/overview')
    const dialog = await openSearch(page)

    await search(dialog, '訪談')
    const options = dialog.getByRole('option')
    await expect(options).toHaveCount(2)
    await expect(options.first()).toContainText('Roadmap 規劃') // the project, via its description
    await expect(options.first().locator('[data-snippet] [data-match]')).toHaveText('訪談')
    await expect(options.nth(1).locator('[data-match]').first()).toHaveText('訪談')
    await expect(options.nth(1)).toContainText('Roadmap 規劃')

    await search(dialog, 'ＲＥＳＥＡＲＣＨ') // full-width capitals
    await expect(options.first()).toContainText('Research')
  })

  test('labels archived projects, finds milestones and says when nothing matches', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    const dialog = await openSearch(page)

    await search(dialog, 'legacy')
    await expect(dialog.getByRole('option')).toHaveCount(1)
    await expect(dialog.getByRole('option')).toContainText('Archived')

    await search(dialog, 'inventory')
    await expect(dialog.getByRole('option')).toContainText('Legacy migration')
    await expect(dialog.getByRole('option')).toContainText('Archived')

    await search(dialog, 'cutover')
    await expect(dialog.getByText('Milestones', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('option')).toContainText('Nov 20, 2040')
    await expect(dialog.getByRole('option')).toContainText('Archived')

    await search(dialog, 'zzqx')
    await expect(dialog.getByRole('option')).toHaveCount(0)
    await expect(dialog.locator('[cmdk-empty]')).toContainText('No results for "zzqx"')
    await expect(dialog.getByRole('status')).toHaveText('No results for "zzqx"')

    // Clearing the query brings the quick actions back; spaces alone are no query.
    await search(dialog, '   ')
    await expect(dialog.getByRole('option', { name: /^New task/ })).toBeVisible()
  })

  test('a long list is cut at 50 matches and says so', async ({ page }) => {
    await openApp(page, '/overview')
    const dialog = await openSearch(page)

    await search(dialog, 'bulk')
    await expect(dialog.getByRole('option')).toHaveCount(50)
    await expect(dialog).toContainText('Showing the first 50 matches')

    // Scrolled to the end and then refining the query: the selected first row is back in view.
    const options = dialog.getByRole('option')
    await page.keyboard.press('End')
    await expect(options.last()).toHaveAttribute('aria-selected', 'true')
    await expect(options.last()).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Backspace')
    await expect(options.first()).toHaveAttribute('aria-selected', 'true')
    await expect(options.first()).toBeInViewport({ ratio: 1 })

    await search(dialog, 'bulk task 05')
    await expect(options).toHaveCount(1)
    await expect(dialog).not.toContainText('Showing the first 50 matches')
  })

  test('arrow keys move through the results, Enter opens the selected one', async ({ page }) => {
    await openApp(page, '/overview')
    const dialog = await openSearch(page)
    await search(dialog, 'interview')

    const options = dialog.getByRole('option')
    await expect(options.first()).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowDown')
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowUp')
    await expect(options.first()).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowUp') // loops to the last row
    await expect(options.last()).toHaveAttribute('aria-selected', 'true')

    // The last row is the done "Interview users" of Research: Enter opens it over its project.
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/\/projects\/p-research\/list\?task=t-interview$/)
    await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Task title' })).toHaveValue(
      'Interview users',
    )
  })

  test('typing shortcut letters in the input is just typing', async ({ page }) => {
    await openApp(page, '/overview')
    const dialog = await openSearch(page)
    await dialog.getByRole('combobox').pressSequentially('g o c [ ?')
    await expect(dialog.getByRole('combobox')).toHaveValue('g o c [ ?')
    await expect(dialog).toBeVisible()
    await expect(page).toHaveURL(/\/overview$/)
    await expect(page.getByRole('dialog')).toHaveCount(1) // no new task, no shortcuts help
  })

  test('a project opens in the view it was last used in; focus lands on the page', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/board')
    await expect(page.getByRole('heading', { name: 'Research', level: 1 })).toBeVisible()
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), PROJECT_VIEWS_KEY))
      .toContain('board')
    await page.goto('/overview')

    let dialog = await openSearch(page)
    await search(dialog, 'research')
    await selectedOption(dialog).waitFor()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/\/projects\/p-research\/board$/)
    await expect(page.getByRole('main')).toBeFocused()

    // A project never opened before starts in List.
    dialog = await openSearch(page)
    await search(dialog, 'flat project')
    await dialog.getByRole('option', { name: /^Flat project/ }).click()
    await expect(page).toHaveURL(/\/projects\/p-flat\/list$/)
  })

  test('a task opens over its project, a subtask too; Esc closes the task and keeps the page', async ({
    page,
  }) => {
    await openApp(page, '/overview')

    let dialog = await openSearch(page)
    await search(dialog, 'alpha')
    await dialog.getByRole('option', { name: /^Alpha/ }).click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/\/projects\/p-flat\/list\?task=f-alpha$/)
    const task = page.getByRole('dialog')
    await expect(task.getByRole('textbox', { name: 'Task title' })).toHaveValue('Alpha')
    await page.keyboard.press('Escape')
    await expect(task).toBeHidden()
    await expect(page).toHaveURL(/\/projects\/p-flat\/list$/)

    dialog = await openSearch(page)
    await search(dialog, 'personas')
    await dialog.getByRole('option', { name: /^Write personas/ }).click()
    await expect(page).toHaveURL(/\/projects\/p-research\/list\?task=t-personas$/)
    await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Task title' })).toHaveValue(
      'Write personas',
    )
  })

  test('search over an open task switches that task; a task of an archived project opens too', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/list')
    await page.goto('/projects/p-research/list?task=t-inbox') // a deep link opens the task
    await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Task title' })).toHaveValue(
      'Inbox idea',
    )

    const dialog = await openSearch(page)
    await search(dialog, 'alpha')
    await selectedOption(dialog).waitFor()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/projects\/p-flat\/list\?task=f-alpha$/)
    await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Task title' })).toHaveValue(
      'Alpha',
    )
    await page.keyboard.press('Escape')

    const again = await openSearch(page)
    await search(again, 'inventory')
    await selectedOption(again).waitFor()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/projects\/p-old\/list\?task=o-1$/)
    await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Task title' })).toHaveValue(
      'Inventory services',
    )
  })

  test('a milestone opens the project Gantt and its dialog', async ({ page }) => {
    await openApp(page, '/overview')
    const dialog = await openSearch(page)
    await search(dialog, 'kickoff')
    await selectedOption(dialog).waitFor()
    await page.keyboard.press('Enter')

    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/\/projects\/p-research\/gantt$/)
    const milestone = page.getByRole('dialog')
    await expect(milestone).toContainText('Edit milestone')
    await expect(milestone.getByRole('textbox', { name: 'Name' })).toHaveValue('Kickoff')
    await page.keyboard.press('Escape')
    await expect(milestone).toBeHidden()
    await expect(page).toHaveURL(/\/projects\/p-research\/gantt$/)
  })

  test('works on an empty workspace', async ({ page }) => {
    await openApp(page, '/overview', null)
    const dialog = await openSearch(page)
    await expect(dialog.getByRole('option', { name: /^New task/ })).toBeVisible()
    await search(dialog, 'anything')
    await expect(dialog.locator('[cmdk-empty]')).toContainText('No results for "anything"')
  })
})

// ===========================================================================
// Settings
// ===========================================================================

test.describe('Settings', () => {
  test('sections have their own URLs and local mode is explained', async ({ page }) => {
    await openApp(page, '/settings')
    await expect(page).toHaveURL(/\/settings\/account$/)
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()

    const nav = page.getByRole('navigation', { name: 'Settings sections' })
    await expect(nav.getByRole('link', { name: 'Account' })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByText('Local mode — data stays in this browser')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0) // nothing to sign out of
    await expect(page.getByText(/^Version \d+\.\d+\.\d+/)).toBeVisible()

    await nav.getByRole('link', { name: 'Appearance' }).click()
    await expect(page).toHaveURL(/\/settings\/appearance$/)
    await expect(page.getByRole('heading', { name: 'Appearance', level: 2 })).toBeVisible()
    await nav.getByRole('link', { name: 'Data' }).click()
    await expect(page).toHaveURL(/\/settings\/data$/)
    await expect(page.getByRole('heading', { name: 'Sync status', level: 2 })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Backup', level: 2 })).toBeVisible()

    // Reload and Back keep the section; an unknown one falls back to Account.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Sync status', level: 2 })).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(/\/settings\/appearance$/)
    await page.goto('/settings/nonsense')
    await expect(page).toHaveURL(/\/settings\/account$/)
  })

  test('theme, week start and time zone are saved and survive a reload', async ({ page }) => {
    await openApp(page, '/settings/appearance')
    const theme = page.getByRole('radiogroup', { name: 'Theme' })
    await expect(theme.getByRole('radio', { name: 'System' })).toBeChecked()

    await theme.getByRole('radio', { name: 'Dark' }).click()
    await expect.poll(() => isDark(page)).toBe(true)
    await expect.poll(async () => (await storedPreferences(page))?.theme).toBe('dark')

    const week = page.getByRole('radiogroup', { name: 'Week starts on' })
    await expect(week.getByRole('radio', { name: 'Monday' })).toBeChecked()
    await week.getByRole('radio', { name: 'Sunday' }).click()
    await expect.poll(async () => (await storedPreferences(page))?.weekStartsOn).toBe(0)

    // Time zone: search by city or offset, pick, see what "today" means there.
    const zone = page.getByRole('combobox', { name: /^Time zone:/ })
    await expect(zone).toContainText('Asia/Taipei')
    await expect(zone).toContainText('UTC+08:00')
    const useBrowser = page.getByRole('button', { name: 'Use browser time zone' })
    await expect(useBrowser).toBeDisabled() // already the browser's zone
    await zone.click()
    await page.getByRole('combobox', { name: 'Time zones' }).fill('new york')
    await expect(page.getByRole('option')).toHaveCount(1)
    await page.getByRole('option', { name: /America\/New York/ }).click()
    await expect(zone).toContainText('America/New York')
    await expect(page.getByText(/in America\/New_York\.$/)).toBeVisible()
    await expect(page.getByText(/This browser is set to Asia\/Taipei/)).toBeVisible()
    await expect
      .poll(async () => (await storedPreferences(page))?.timezone)
      .toBe('America/New_York')

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Appearance', level: 2 })).toBeVisible()
    expect(await isDark(page)).toBe(true)
    await expect(
      page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }),
    ).toBeChecked()
    await expect(
      page
        .getByRole('radiogroup', { name: 'Week starts on' })
        .getByRole('radio', { name: 'Sunday' }),
    ).toBeChecked()
    await expect(page.getByRole('combobox', { name: /^Time zone:/ })).toContainText(
      'America/New York',
    )

    // Back to the browser's zone in one click.
    await page.getByRole('button', { name: 'Use browser time zone' }).click()
    await expect(page.getByRole('combobox', { name: /^Time zone:/ })).toContainText('Asia/Taipei')
    await expect(page.getByRole('button', { name: 'Use browser time zone' })).toBeDisabled()
    await expect.poll(async () => (await storedPreferences(page))?.timezone).toBe('Asia/Taipei')
  })

  test('the time zone list filters, says when nothing matches and works from the keyboard', async ({
    page,
  }) => {
    await openApp(page, '/settings/appearance')
    const zone = page.getByRole('combobox', { name: /^Time zone:/ })
    await zone.focus()
    await page.keyboard.press('Enter')
    const search = page.getByRole('combobox', { name: 'Time zones' })
    await expect(search).toBeFocused()

    // The list opens on the saved zone; filtering shows the first match, not a stale scroll spot.
    await search.fill('europe')
    await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('option').first()).toBeInViewport({ ratio: 1 })

    await search.fill('zzzz')
    await expect(page.getByText('No time zone matches "zzzz".')).toBeVisible()
    await search.fill('utc+9')
    await expect(page.getByRole('option', { name: /Asia\/Tokyo/ })).toBeVisible()

    await search.fill('tokyo')
    await expect(page.getByRole('option')).toHaveCount(1)
    await expect(page.getByRole('option')).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter') // the only match is selected
    await expect(zone).toContainText('Asia/Tokyo')
    await expect(zone).toBeFocused() // focus returns to the field
    await expect.poll(async () => (await storedPreferences(page))?.timezone).toBe('Asia/Tokyo')

    // Esc closes the list without changing anything or leaving the page.
    await zone.click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('combobox', { name: 'Time zones' })).toBeHidden()
    await expect(page).toHaveURL(/\/settings\/appearance$/)
    await expect(zone).toContainText('Asia/Tokyo')
  })

  test('a failed save rolls back, is never reported as saved, and Retry saves it', async ({
    page,
  }) => {
    await openApp(page, '/settings/appearance')
    const theme = page.getByRole('radiogroup', { name: 'Theme' })
    await failNextWrites(page, 1)
    await theme.getByRole('radio', { name: 'Dark' }).click()

    const failure = toast(page, "Couldn't save preferences")
    await expect(failure).toBeVisible()
    await expect(theme.getByRole('radio', { name: 'System' })).toBeChecked() // rolled back
    expect(await isDark(page)).toBe(false)
    expect((await storedPreferences(page))?.theme ?? 'system').toBe('system') // nothing stored

    await failure.getByRole('button', { name: 'Retry' }).click()
    await expect(theme.getByRole('radio', { name: 'Dark' })).toBeChecked()
    await expect.poll(() => isDark(page)).toBe(true)
    await expect.poll(async () => (await storedPreferences(page))?.theme).toBe('dark')
    await expect(failure).toHaveCount(0)
  })

  test('the sync card shows the real state; "Sync now" never blanks the app', async ({ page }) => {
    await openApp(page, '/settings/data')
    const card = page.getByRole('region', { name: 'Sync status' })
    await expect(card.getByText('Stored in this browser only', { exact: true })).toBeVisible()
    await expect(card).toContainText('Local only — this browser')
    await expect(card).toContainText('Online')
    await expect(card).toContainText('No changes saved in this session')
    await expect(card.getByText('Pending changes').locator('..')).toContainText('None')
    await expect(card.getByText('Last error').locator('..')).toContainText('None')
    await expect(card.getByRole('button', { name: 'Retry' })).toHaveCount(0)

    // While it runs: the page stays, the button shows progress and keeps keyboard focus.
    await setLatency(page, 700)
    const syncNow = card.getByRole('button', { name: 'Sync now' })
    await syncNow.focus()
    await page.keyboard.press('Enter')
    await expect(syncNow).toHaveAttribute('aria-busy', 'true')
    await expect(page.getByRole('heading', { name: 'Sync status', level: 2 })).toBeVisible()
    await expect(
      page.getByRole('complementary', { name: 'Sidebar' }).locator('[data-slot="skeleton"]'),
    ).toHaveCount(0)
    await expect(syncNow).toBeFocused()
    await expect(toast(page, 'Reloaded from this browser')).toBeVisible()
    await expect(syncNow).not.toHaveAttribute('aria-busy', 'true')
    await expect(syncNow).toBeFocused()
    await setLatency(page, 0)
  })

  test('a failed save shows up on the sync card with Retry, and Retry clears it', async ({
    page,
  }) => {
    await openApp(page, '/settings/appearance')
    await failNextWrites(page, 1)
    await page
      .getByRole('radiogroup', { name: 'Week starts on' })
      .getByRole('radio', { name: 'Sunday' })
      .click()
    await expect(toast(page, "Couldn't save preferences")).toBeVisible()

    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: 'Data' })
      .click()
    const card = page.getByRole('region', { name: 'Sync status' })
    await expect(card.getByText("Couldn't save your last change")).toBeVisible()
    await expect(card.getByText('Last error').locator('..')).toContainText('Network error')
    await expect(card.getByText('Last saved').locator('..')).toContainText('No changes saved')

    await card.getByRole('button', { name: 'Retry' }).click()
    await expect(card.getByText('Stored in this browser only', { exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Retry' })).toHaveCount(0)
    await expect(card.getByText('Last error').locator('..')).toContainText('None')
    await expect(card.getByText('Last saved').locator('..')).toContainText('Today')
    await expect(card.getByRole('button', { name: 'Sync now' })).toBeFocused() // focus stays on the card
    await expect.poll(async () => (await storedPreferences(page))?.weekStartsOn).toBe(0)
  })

  test('exports the whole workspace as JSON and the tasks as CSV', async ({ page }) => {
    await openApp(page, '/settings/data')
    await expect(
      page.getByText("You haven't exported a backup from this browser yet."),
    ).toBeVisible()

    const [json] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    expect(json.suggestedFilename()).toMatch(/^cairn-backup-\d{4}-\d{2}-\d{2}\.json$/)
    const backup = JSON.parse(await downloadText(json)) as {
      app: string
      formatVersion: number
      exportedAt: string
      preferences: { timezone: string } | null
      data: { projects: { name: string }[]; tasks: { title: string }[]; milestones: unknown[] }
    }
    expect(backup.app).toBe('cairn')
    expect(backup.formatVersion).toBe(1)
    expect(backup.data.projects).toHaveLength(SEEDED.projects)
    expect(backup.data.tasks).toHaveLength(SEEDED.tasks)
    expect(backup.data.milestones).toHaveLength(SEEDED.milestones)
    expect(backup.data.projects.map((project) => project.name)).toContain('Roadmap 規劃')
    expect(backup.data.tasks.map((task) => task.title)).toContain('問卷設計')
    expect(backup.preferences?.timezone).toBe('Asia/Taipei')
    await expect(toast(page, 'Backup exported')).toContainText(
      '5 projects, 70 tasks and 2 milestones',
    )
    await expect(page.getByText('Last exported just now from this browser.')).toBeVisible()

    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export tasks CSV' }).click(),
    ])
    expect(csv.suggestedFilename()).toMatch(/^cairn-tasks-\d{4}-\d{2}-\d{2}\.csv$/)
    const text = await downloadText(csv)
    expect(text.charCodeAt(0)).toBe(0xfeff) // a BOM, so Excel reads the UTF-8 text correctly
    const lines = text.slice(1).trimEnd().split('\r\n')
    expect(lines[0]).toBe(
      'Project,Phase,Parent task,Title,Status,Priority,Start,Due,Completed at,Description',
    )
    expect(lines).toHaveLength(SEEDED.tasks + 1)
    expect(lines).toContain('Roadmap 規劃,,,問卷設計,To Do,None,,,,')
    expect(
      lines.some((line) => line.startsWith('Research,,Synthesize findings,Write personas,')),
    ).toBe(true)
  })

  test('shows which problems make a file unusable and imports nothing from it', async ({
    page,
  }) => {
    await openApp(page, '/settings/data')
    const input = page.getByLabel('Backup file')
    const alert = page.getByRole('alert').filter({ hasText: "Couldn't import" })

    await input.setInputFiles({
      name: 'notes.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{ not json'),
    })
    await expect(alert).toContainText('Couldn\'t import "notes.json"')
    await expect(alert).toContainText("isn't valid JSON")

    await input.setInputFiles({
      name: 'other.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ hello: 'world' })),
    })
    await expect(alert).toContainText('Couldn\'t import "other.json"')
    await expect(alert).toContainText("isn't a Cairn backup")

    // A real backup with damaged rows: each problem is listed.
    const [json] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    const damaged = JSON.parse(await downloadText(json)) as {
      data: { tasks: Record<string, unknown>[]; projects: Record<string, unknown>[] }
    }
    damaged.data.tasks[0].title = ''
    damaged.data.tasks[1].status = 'weird'
    damaged.data.projects[0].color = 'neon'
    await input.setInputFiles({
      name: 'damaged.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(damaged)),
    })
    await expect(alert).toContainText('Couldn\'t import "damaged.json"')
    await expect(alert).toContainText('Nothing was imported')
    await expect(alert.getByRole('listitem')).toHaveCount(3)
    await expect(alert).toContainText('tasks[0].title')
    await expect(alert).toContainText('tasks[1].status')
    await expect(alert).toContainText('projects[0].color')

    await alert.getByRole('button', { name: 'Dismiss' }).click()
    await expect(alert).toHaveCount(0)
    expect(await storedCounts(page)).toEqual(SEEDED)
  })

  test('previews a backup, adds it as new copies and leaves everything else alone', async ({
    page,
  }) => {
    await openApp(page, '/settings/data')
    const [json] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    const text = await downloadText(json)

    // Choosing a file only previews it; Esc cancels and focus returns to the button.
    const input = page.getByLabel('Backup file')
    const importButton = page.getByRole('button', { name: 'Import backup…' })
    await importButton.focus()
    await input.setInputFiles({
      name: 'my-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    })
    const dialog = page.getByRole('dialog', { name: 'Import backup' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('my-backup.json')
    await expect(dialog).toContainText(/Exported \w{3} \d{1,2}, \d{4}/)
    const count = (label: string) => dialog.getByText(label, { exact: true }).locator('..')
    await expect(count('Projects')).toContainText('5')
    await expect(count('Tasks')).toContainText('70')
    await expect(count('Milestones')).toContainText('2')
    await expect(count('Dependencies')).toContainText('0')
    await expect(dialog).toContainText('added as new copies')
    await expect(dialog).toContainText(
      'Nothing that exists today is changed, overwritten or deleted',
    )
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(importButton).toBeFocused()
    expect(await storedCounts(page)).toEqual(SEEDED)

    // Confirm: everything arrives as copies, the originals stay, the success toast has the counts.
    await input.setInputFiles({
      name: 'my-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    })
    await dialog.getByRole('button', { name: 'Import as new copies' }).click()
    await expect(dialog).toBeHidden()
    await expect(toast(page, 'Backup imported')).toContainText(
      'Added 5 projects, 70 tasks and 2 milestones as new copies.',
    )
    await expect(importButton).toBeFocused()
    expect(await storedCounts(page)).toEqual({
      projects: SEEDED.projects * 2,
      tasks: SEEDED.tasks * 2,
      milestones: SEEDED.milestones * 2,
    })

    // Same data source everywhere: search finds the copy, the Projects table lists it.
    const search = await openSearch(page)
    await search.getByRole('combobox').fill('legacy')
    await expect(search.getByRole('option')).toHaveCount(2)
  })

  test('an empty backup cannot be imported', async ({ page }) => {
    await openApp(page, '/settings/data', null)
    await expect(page.getByRole('button', { name: 'Export tasks CSV' })).toBeDisabled()
    const [json] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    await expect(toast(page, 'Backup exported')).toContainText('no projects or tasks yet')
    const text = await downloadText(json)

    await page.getByLabel('Backup file').setInputFiles({
      name: 'empty.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    })
    const dialog = page.getByRole('dialog', { name: 'Import backup' })
    await expect(dialog).toContainText('nothing to import')
    await expect(dialog.getByRole('button', { name: 'Import as new copies' })).toBeDisabled()
  })

  test('a failed import keeps the file, offers one Try again and never adds a second copy', async ({
    page,
  }) => {
    await openApp(page, '/settings/data')
    const [json] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    await page.getByLabel('Backup file').setInputFiles({
      name: 'my-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(await downloadText(json)),
    })
    const dialog = page.getByRole('dialog', { name: 'Import backup' })
    await expect(dialog).toBeVisible()

    await failNextWrites(page, 1)
    await dialog.getByRole('button', { name: 'Import as new copies' }).click()

    // Nothing stored, the reason is in the dialog, the store's own toast (second Retry) is gone.
    await expect(dialog.getByRole('alert')).toContainText("Couldn't import the backup")
    await expect(dialog.getByRole('alert')).toContainText('Network error')
    await expect(dialog.getByRole('button', { name: 'Try again' })).toBeFocused()
    await expect(toast(page, "Couldn't import the backup")).toHaveCount(0)
    await expect(toast(page, 'Backup imported')).toHaveCount(0) // never reported as done
    expect(await storedCounts(page)).toEqual(SEEDED)

    await dialog.getByRole('button', { name: 'Try again' }).click()
    await expect(dialog).toBeHidden()
    await expect(toast(page, 'Backup imported')).toContainText(
      'Added 5 projects, 70 tasks and 2 milestones',
    )
    expect(await storedCounts(page)).toEqual({
      projects: SEEDED.projects * 2,
      tasks: SEEDED.tasks * 2,
      milestones: SEEDED.milestones * 2,
    })
    // …and nothing is waiting to be retried any more, and no failure toast lingers.
    await expect(
      page.getByRole('region', { name: 'Sync status' }).getByRole('button', { name: 'Retry' }),
    ).toHaveCount(0)
    await expect(toast(page, "Couldn't import the backup")).toHaveCount(0)
  })

  test('the import stays put while it runs: no double submit, Esc ignored', async ({ page }) => {
    await openApp(page, '/settings/data')
    const [json] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    await page.getByLabel('Backup file').setInputFiles({
      name: 'my-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(await downloadText(json)),
    })
    const dialog = page.getByRole('dialog', { name: 'Import backup' })
    await setLatency(page, 800)
    const confirm = dialog.getByRole('button', { name: 'Import as new copies' })
    await confirm.click()

    await expect(confirm).toHaveAttribute('aria-busy', 'true')
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await confirm.click({ force: true }) // ignored while busy
    await expect(dialog).toBeHidden()
    await setLatency(page, 0)
    expect(await storedCounts(page)).toEqual({
      projects: SEEDED.projects * 2,
      tasks: SEEDED.tasks * 2,
      milestones: SEEDED.milestones * 2,
    })
  })

  test('keyboard only: every Settings control can be reached and used', async ({ page }) => {
    await openApp(page, '/settings/appearance')
    const nav = page.getByRole('navigation', { name: 'Settings sections' })
    await nav.getByRole('link', { name: 'Appearance' }).focus()

    // Tab order: section links → theme → week start → time zone.
    await page.keyboard.press('Tab')
    await expect(nav.getByRole('link', { name: 'Data' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(
      page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'System' }),
    ).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('radio', { name: 'Light' })).toBeFocused()
    await page.keyboard.press('Space')
    await expect(page.getByRole('radio', { name: 'Light' })).toBeChecked()
    await expect.poll(async () => (await storedPreferences(page))?.theme).toBe('light')
    await page.keyboard.press('Tab')
    await expect(
      page
        .getByRole('radiogroup', { name: 'Week starts on' })
        .getByRole('radio', { name: 'Monday' }),
    ).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('combobox', { name: /^Time zone:/ })).toBeFocused()
  })
})
