/// <reference lib="dom" />
/**
 * Board E2E — runs in LOCAL data mode against the dev server (playwright.config.ts).
 *
 * PRD acceptance §9.1 #6: dragging a card To Do → In Progress on the Board shows the new status in
 * the List at once, and it survives a reload. Also covered: a reorder inside a column never changes
 * the status, an empty column accepts a card, the keyboard alternative (Space, arrows, Space), and
 * a failed drop that rolls back and is saved by the toast's Retry (window.__cairnTest).
 */
import { randomUUID } from 'node:crypto'
import { expect, test as base, type Locator, type Page } from '@playwright/test'

const LOCAL_WORKSPACE_KEY = 'cairn:local:workspace:v1'
const NOW = '2026-11-03T08:00:00.000Z'

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

type Status = 'todo' | 'in_progress' | 'done'

interface Seed {
  projectId: string
  /** task id by title */
  ids: Record<string, string>
  db: unknown
}

/** One project, top-level tasks in project order: To Do ×3, In Progress ×1, Done empty. */
function seedWorkspace(): Seed {
  const projectId = randomUUID()
  const rows: [string, Status][] = [
    ['Interview users', 'todo'],
    ['Prototype', 'in_progress'],
    ['Draft survey', 'todo'],
    ['Plan retro', 'todo'],
  ]
  const ids: Record<string, string> = {}
  const tasks: Record<string, unknown> = {}
  rows.forEach(([title, status], index) => {
    const id = randomUUID()
    ids[title] = id
    tasks[id] = {
      id,
      projectId,
      phaseId: null,
      parentTaskId: null,
      title,
      description: null,
      status,
      priority: 'none',
      startDate: null,
      dueDate: null,
      sortOrder: `a${index}`,
      completedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    }
  })
  const db = {
    version: 1,
    projects: {
      [projectId]: {
        id: projectId,
        name: 'Research',
        description: null,
        status: 'active',
        color: 'violet',
        startDate: null,
        dueDate: null,
        scheduleMode: 'manual',
        sortOrder: 'a0',
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    phases: {},
    tasks,
    milestones: {},
    dependencies: {},
    preferences: null,
  }
  return { projectId, ids, db }
}

/** Seeds the local workspace once per tab (reloads keep what the test changed). */
async function openBoard(page: Page, seed: Seed): Promise<void> {
  await page.addInitScript(
    ({ key, db }) => {
      if (sessionStorage.getItem('cairn-e2e-board-seeded')) return
      localStorage.setItem(key, JSON.stringify(db))
      sessionStorage.setItem('cairn-e2e-board-seeded', '1')
    },
    { key: LOCAL_WORKSPACE_KEY, db: seed.db },
  )
  await page.goto(`/projects/${seed.projectId}/board`)
  await expect(column(page, 'To Do')).toBeVisible()
}

/** A board column (its region is named "<Status> <n> task(s)"). */
function column(page: Page, name: string): Locator {
  return page.getByRole('region', { name: new RegExp(`^${name} \\d+ tasks?$`) })
}

function card(page: Page, title: string): Locator {
  return page.getByRole('button', { name: title, exact: true })
}

async function titlesIn(region: Locator): Promise<string[]> {
  return region
    .locator('[data-card-activator]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label') ?? ''))
}

/** Pointer drag with intermediate moves (dnd-kit starts a drag after a few px of movement). */
async function dragTo(page: Page, source: Locator, target: { x: number; y: number }) {
  const box = await source.boundingBox()
  if (!box) throw new Error('drag source is not visible')
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 6, start.y + 6, { steps: 3 })
  await page.mouse.move(target.x, target.y, { steps: 12 })
  await page.waitForTimeout(100) // let the last drag-over settle
  await page.mouse.up()
}

/** A point on the upper edge of `locator` (drops before that card). */
async function topOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('drop target is not visible')
  return { x: box.x + box.width / 2, y: box.y + 6 }
}

/** The stored status of a task in the local "database". */
function storedStatus(page: Page, taskId: string): Promise<string | undefined> {
  return page.evaluate(
    ({ key, taskId }) => JSON.parse(localStorage.getItem(key) ?? '{}')?.tasks?.[taskId]?.status,
    { key: LOCAL_WORKSPACE_KEY, taskId },
  )
}

test.describe('board (local mode)', () => {
  test('drag To Do → In Progress: the List shows the new status at once and after reload', async ({
    page,
  }) => {
    const seed = seedWorkspace()
    await openBoard(page, seed)
    await expect(column(page, 'To Do')).toHaveAccessibleName('To Do 3 tasks')

    await dragTo(page, card(page, 'Draft survey'), await topOf(card(page, 'Prototype')))

    await expect
      .poll(() => titlesIn(column(page, 'In Progress')))
      .toEqual(['Draft survey', 'Prototype'])
    expect(await titlesIn(column(page, 'To Do'))).toEqual(['Interview users', 'Plan retro'])
    await expect.poll(() => storedStatus(page, seed.ids['Draft survey'])).toBe('in_progress')

    await page.getByRole('link', { name: 'List', exact: true }).click()
    const row = page.locator(`[data-task-row="${seed.ids['Draft survey']}"]`)
    await expect(row.getByRole('button', { name: /^Status:/ })).toHaveAccessibleName(
      'Status: In Progress',
    )

    await page.reload()
    await expect(row.getByRole('button', { name: /^Status:/ })).toHaveAccessibleName(
      'Status: In Progress',
    )
  })

  test('reordering inside a column changes the order, never the status', async ({ page }) => {
    const seed = seedWorkspace()
    await openBoard(page, seed)

    await dragTo(page, card(page, 'Plan retro'), await topOf(card(page, 'Interview users')))

    await expect
      .poll(() => titlesIn(column(page, 'To Do')))
      .toEqual(['Plan retro', 'Interview users', 'Draft survey'])
    expect(await storedStatus(page, seed.ids['Plan retro'])).toBe('todo')
    await page.reload()
    await expect
      .poll(() => titlesIn(column(page, 'To Do')))
      .toEqual(['Plan retro', 'Interview users', 'Draft survey'])
  })

  test('an empty column takes a card, and the keyboard moves cards too', async ({ page }) => {
    const seed = seedWorkspace()
    await openBoard(page, seed)

    const done = column(page, 'Done')
    const box = await done.boundingBox()
    if (!box) throw new Error('Done column is not visible')
    await dragTo(page, card(page, 'Plan retro'), { x: box.x + box.width / 2, y: box.y + 120 })
    await expect.poll(() => titlesIn(done)).toEqual(['Plan retro'])

    // Space picks the card up, arrows move it (two columns right), Space drops it — one step at
    // a time, as the screen reader announcements report (dnd-kit listens after the pick-up).
    const live = page.locator('[id^="DndLiveRegion"]')
    await card(page, 'Interview users').focus()
    await page.keyboard.press('Space')
    await expect(live).toHaveText('Picked up “Interview users”. To Do, position 1 of 2.')
    await page.keyboard.press('ArrowRight')
    await expect(live).toHaveText(/is over In Progress, position 1 of 2\.$/)
    await page.keyboard.press('ArrowRight')
    await expect(live).toHaveText(/is over Done, position 1 of 2\.$/)
    await page.keyboard.press('Space')
    await expect(live).toHaveText('“Interview users” dropped in Done, position 1 of 2.')
    await expect.poll(() => titlesIn(done)).toContain('Interview users')
    await expect.poll(() => storedStatus(page, seed.ids['Interview users'])).toBe('done')
    await expect(card(page, 'Interview users')).toBeFocused()
  })

  test('a failed drop rolls back, and Retry saves it', async ({ page }) => {
    const seed = seedWorkspace()
    await openBoard(page, seed)
    await page.evaluate(() => {
      type TestHooks = { failNextWrites(count: number): void }
      ;(window as Window & { __cairnTest?: TestHooks }).__cairnTest?.failNextWrites(1)
    })

    await dragTo(page, card(page, 'Interview users'), await topOf(card(page, 'Prototype')))

    const toast = page.locator('[data-sonner-toast]').filter({ hasText: "Couldn't move task" })
    await expect(toast).toBeVisible()
    await expect.poll(() => titlesIn(column(page, 'To Do'))).toContain('Interview users')
    expect(await storedStatus(page, seed.ids['Interview users'])).toBe('todo')

    await toast.getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => titlesIn(column(page, 'In Progress'))).toContain('Interview users')
    await expect.poll(() => storedStatus(page, seed.ids['Interview users'])).toBe('in_progress')
  })
})
