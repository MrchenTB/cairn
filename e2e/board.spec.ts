/// <reference lib="dom" />
/**
 * Board E2E — runs in LOCAL data mode against the dev server (playwright.config.ts).
 *
 * PRD §4.6 and acceptance §9.1 #6 (dragging a card To Do → In Progress shows the new status in the
 * List at once and after a reload), §5.4 (a failed write is rolled back with a Retry, never shown
 * as saved) and §9.1 #14 (keyboard).
 *
 * Pinned here:
 * - same-column reorders never change status or dates; an empty column takes a card without
 *   disturbing the project order; the keyboard (Space, arrows, Space / Esc) does everything the
 *   pointer does; every drag has a menu alternative (status menu, ⋯ menu);
 * - a failed move / status change / priority change / create is rolled back, toasted, and the
 *   toast's Retry stores it exactly once; pending writes show the card at once and never twice;
 * - a drop lands where the preview showed it, even when an earlier failed move is rolled back
 *   while the next drag is in flight;
 * - the lifted card shows the status of the column it is over;
 * - after a status change saved in the Task Modal (the card is re-mounted in another column),
 *   closing it puts keyboard focus back on that card;
 * - the phase filter (?phase=), inline "+ Add task" (rapid entry, Esc, IME-safe), empty states.
 *
 * Drags are driven with real mouse events and released only once the preview shows the card where
 * it should land (polled, no sleeps). Motion is reduced by default so geometry never changes
 * under a following drag; one test runs with full motion.
 */
import { randomUUID } from 'node:crypto'
import { generateNKeysBetween } from 'fractional-indexing'
import { expect, test as base, type Locator, type Page } from '@playwright/test'

const LOCAL_WORKSPACE_KEY = 'cairn:local:workspace:v1'
const NOW = '2026-11-03T08:00:00.000Z'
const TIME_ZONE = 'Asia/Taipei'

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

test.use({
  viewport: { width: 1280, height: 800 },
  timezoneId: TIME_ZONE,
  locale: 'en-US',
  reducedMotion: 'reduce',
})

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

type Status = 'todo' | 'in_progress' | 'done'
type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

interface SeedTask {
  title: string
  status: Status
  priority?: Priority
  startDate?: string
  dueDate?: string
  /** Phase name (one of `SeedOptions.phases`). */
  phase?: string
  /** Statuses of this task's subtasks, in order. */
  subtasks?: Status[]
}

interface SeedOptions {
  /** Top-level tasks in project order. */
  tasks: SeedTask[]
  phases?: string[]
}

interface Seed {
  projectId: string
  /** Task id by title. */
  ids: Record<string, string>
  db: unknown
}

/** Today in the app's time zone (the browser's, at first run), `offset` days away. */
function today(offset = 0): string {
  const date = new Date(Date.now() + offset * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(date)
}

function seedWorkspace({ tasks, phases = [] }: SeedOptions): Seed {
  const projectId = randomUUID()
  const phaseIds: Record<string, string> = {}
  const phaseRows: Record<string, unknown> = {}
  const phaseKeys = generateNKeysBetween(null, null, phases.length)
  phases.forEach((name, index) => {
    const id = randomUUID()
    phaseIds[name] = id
    phaseRows[id] = {
      id,
      projectId,
      name,
      sortOrder: phaseKeys[index],
      createdAt: NOW,
      updatedAt: NOW,
    }
  })

  const ids: Record<string, string> = {}
  const taskRows: Record<string, unknown> = {}
  const row = (
    title: string,
    status: Status,
    sortOrder: string,
    extra: Partial<SeedTask>,
    parentTaskId: string | null,
    phaseId: string | null,
  ) => {
    const id = randomUUID()
    ids[title] = id
    taskRows[id] = {
      id,
      projectId,
      phaseId,
      parentTaskId,
      title,
      description: null,
      status,
      priority: extra.priority ?? 'none',
      startDate: extra.startDate ?? null,
      dueDate: extra.dueDate ?? null,
      sortOrder,
      completedAt: status === 'done' ? NOW : null,
      createdAt: NOW,
      updatedAt: NOW,
    }
    return id
  }
  const taskKeys = generateNKeysBetween(null, null, tasks.length)
  tasks.forEach((task, index) => {
    const phaseId = task.phase ? phaseIds[task.phase] : null
    if (task.phase && !phaseId) throw new Error(`unknown phase ${task.phase}`)
    const parent = row(task.title, task.status, taskKeys[index], task, null, phaseId)
    const subKeys = generateNKeysBetween(null, null, task.subtasks?.length ?? 0)
    task.subtasks?.forEach((status, i) =>
      row(`${task.title} · subtask ${i + 1}`, status, subKeys[i], {}, parent, phaseId),
    )
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
    phases: phaseRows,
    tasks: taskRows,
    milestones: {},
    dependencies: {},
    preferences: null,
  }
  return { projectId, ids, db }
}

/** To Do ×3, In Progress ×1, Done empty — in this project order. */
function standardSeed(): Seed {
  return seedWorkspace({
    tasks: [
      { title: 'Interview users', status: 'todo' },
      { title: 'Prototype', status: 'in_progress' },
      { title: 'Draft survey', status: 'todo' },
      { title: 'Plan retro', status: 'todo' },
    ],
  })
}

/** Seeds the local workspace once per tab (reloads keep what the test changed). */
async function openBoard(page: Page, seed: Seed, search = ''): Promise<void> {
  await page.addInitScript(
    ({ key, db }) => {
      if (sessionStorage.getItem('cairn-e2e-board-seeded')) return
      localStorage.setItem(key, JSON.stringify(db))
      sessionStorage.setItem('cairn-e2e-board-seeded', '1')
    },
    { key: LOCAL_WORKSPACE_KEY, db: seed.db },
  )
  await page.goto(`/projects/${seed.projectId}/board${search}`)
  await expect(column(page, 'To Do')).toBeVisible()
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/** A board column (its region is named "<Status> <n> task(s)"). */
function column(page: Page, name: string): Locator {
  return page.getByRole('region', { name: new RegExp(`^${name} \\d+ tasks?$`) })
}

/** A card's activator (a button named by the task title). */
function card(page: Page, title: string): Locator {
  return page.getByRole('button', { name: title, exact: true })
}

/** The card's <li> (holds its status and ⋯ controls). */
function cardItem(page: Page, title: string): Locator {
  return page.locator('li', { has: card(page, title) })
}

async function titlesIn(region: Locator): Promise<string[]> {
  return region
    .locator('[data-card-activator]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label') ?? ''))
}

/**
 * Card titles of a region in on-screen order. While a card is being dragged, a reorder inside a
 * column is previewed with CSS transforms (the DOM order only changes on drop), so a drag preview
 * is read from the card positions, not from the DOM order.
 */
async function visualTitlesIn(region: Locator): Promise<string[]> {
  return region.locator('[data-card-activator]').evaluateAll((elements) =>
    elements
      .map((element) => ({
        title: element.getAttribute('aria-label') ?? '',
        top: element.getBoundingClientRect().top,
      }))
      .sort((a, b) => a.top - b.top)
      .map((entry) => entry.title),
  )
}

async function boardTitles(page: Page): Promise<Record<Status, string[]>> {
  return {
    todo: await titlesIn(column(page, 'To Do')),
    in_progress: await titlesIn(column(page, 'In Progress')),
    done: await titlesIn(column(page, 'Done')),
  }
}

interface Point {
  x: number
  y: number
}

/** A point on the upper edge of `locator` (a drop there enters before that card). */
async function topOf(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('drop target is not visible')
  return { x: box.x + box.width / 2, y: box.y + 6 }
}

/** A point `depth` px below the top of `locator` (the empty part of a column). */
async function insideOf(locator: Locator, depth: number): Promise<Point> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('drop target is not visible')
  return { x: box.x + box.width / 2, y: box.y + depth }
}

/**
 * Pointer drag with real mouse events: press on `source`, move past dnd-kit's activation distance,
 * glide to `to`, then wait until `preview` holds (the drag preview shows the card where it will
 * land — polled) and release, unless `release` is false (the caller releases later).
 */
async function dragCard(
  page: Page,
  source: Locator,
  to: Point,
  options: { preview?: () => Promise<void>; release?: boolean } = {},
): Promise<void> {
  const box = await source.boundingBox()
  if (!box) throw new Error('drag source is not visible')
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 6, start.y + 6, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await options.preview?.()
  if (options.release !== false) await page.mouse.up()
}

interface StoredTask {
  id: string
  title: string
  status: Status
  priority: Priority
  phaseId: string | null
  parentTaskId: string | null
  startDate: string | null
  dueDate: string | null
  sortOrder: string
  completedAt: string | null
}

/** The tasks of the local "database", as saved. */
function storedTasks(page: Page): Promise<StoredTask[]> {
  return page.evaluate(
    (key) => Object.values(JSON.parse(localStorage.getItem(key) ?? '{}')?.tasks ?? {}),
    LOCAL_WORKSPACE_KEY,
  ) as Promise<StoredTask[]>
}

async function storedTask(page: Page, id: string): Promise<StoredTask | undefined> {
  return (await storedTasks(page)).find((task) => task.id === id)
}

/** Top-level task titles in the saved project order (code-unit order, like the app). */
async function storedOrder(page: Page): Promise<string[]> {
  return (await storedTasks(page))
    .filter((task) => !task.parentTaskId)
    .sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0))
    .map((task) => task.title)
}

type TestHooks = {
  failNextWrites(count: number): void
  setLatency(ms: number): void
}

/** The local-mode test hooks (window.__cairnTest). */
async function failNextWrites(page: Page, count: number): Promise<void> {
  await page.evaluate(
    (n) => (window as Window & { __cairnTest?: TestHooks }).__cairnTest?.failNextWrites(n),
    count,
  )
}

async function setLatency(page: Page, ms: number): Promise<void> {
  await page.evaluate(
    (value) => (window as Window & { __cairnTest?: TestHooks }).__cairnTest?.setLatency(value),
    ms,
  )
}

/** A toast by (part of) its text. */
function toast(page: Page, text: string | RegExp): Locator {
  return page.locator('[data-sonner-toast]').filter({ hasText: text })
}

/** dnd-kit's screen-reader announcements. */
function liveRegion(page: Page): Locator {
  return page.locator('[id^="DndLiveRegion"]')
}

/**
 * Space on a focused card picks it up. dnd-kit starts listening for the arrow keys one task after
 * the pick-up (the announcement can show before that), so a task-queue barrier follows the
 * announcement: a key pressed right after it is never lost.
 */
async function pickUpWithKeyboard(
  page: Page,
  title: string,
  announcement: string | RegExp,
): Promise<void> {
  await card(page, title).focus()
  await page.keyboard.press('Space')
  await expect(liveRegion(page)).toHaveText(announcement)
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
}

// ---------------------------------------------------------------------------
// Drag and drop (PRD §4.6, acceptance #6)
// ---------------------------------------------------------------------------

test.describe('board drag and drop (local mode)', () => {
  test.describe('with motion', () => {
    test.use({ reducedMotion: 'no-preference' })

    test('drag To Do → In Progress: the List shows the new status at once and after reload', async ({
      page,
    }) => {
      const seed = standardSeed()
      await openBoard(page, seed)
      await expect(column(page, 'To Do')).toHaveAccessibleName('To Do 3 tasks')

      await dragCard(page, card(page, 'Draft survey'), await topOf(card(page, 'Prototype')), {
        preview: () =>
          expect
            .poll(() => visualTitlesIn(column(page, 'In Progress')))
            .toEqual(['Draft survey', 'Prototype']),
      })

      await expect
        .poll(() => titlesIn(column(page, 'In Progress')))
        .toEqual(['Draft survey', 'Prototype'])
      expect(await titlesIn(column(page, 'To Do'))).toEqual(['Interview users', 'Plan retro'])
      await expect
        .poll(async () => (await storedTask(page, seed.ids['Draft survey']))?.status)
        .toBe('in_progress')

      await page.getByRole('link', { name: 'List', exact: true }).click()
      const row = page.locator(`[data-task-row="${seed.ids['Draft survey']}"]`)
      await expect(row.getByRole('button', { name: /^Status:/ })).toHaveAccessibleName(
        'Status: In Progress',
      )

      await page.reload()
      await expect(row.getByRole('button', { name: /^Status:/ })).toHaveAccessibleName(
        'Status: In Progress',
      )
      await page.getByRole('link', { name: 'Board', exact: true }).click()
      await expect
        .poll(() => titlesIn(column(page, 'In Progress')))
        .toEqual(['Draft survey', 'Prototype'])
    })
  })

  test('reordering inside a column changes the order, never the status or the dates', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      tasks: [
        { title: 'Interview users', status: 'todo' },
        { title: 'Prototype', status: 'in_progress' },
        { title: 'Draft survey', status: 'todo' },
        { title: 'Plan retro', status: 'todo', startDate: '2026-11-10', dueDate: '2026-11-20' },
      ],
    })
    await openBoard(page, seed)
    const before = await storedTask(page, seed.ids['Plan retro'])

    await dragCard(page, card(page, 'Plan retro'), await topOf(card(page, 'Interview users')), {
      preview: () =>
        expect
          .poll(() => visualTitlesIn(column(page, 'To Do')))
          .toEqual(['Plan retro', 'Interview users', 'Draft survey']),
    })

    await expect
      .poll(() => storedOrder(page))
      .toEqual(['Plan retro', 'Interview users', 'Prototype', 'Draft survey'])
    const after = await storedTask(page, seed.ids['Plan retro'])
    expect(after).toMatchObject({
      status: 'todo',
      startDate: '2026-11-10',
      dueDate: '2026-11-20',
      completedAt: null,
    })
    expect(after?.sortOrder).not.toBe(before?.sortOrder)

    await page.reload()
    await expect
      .poll(() => titlesIn(column(page, 'To Do')))
      .toEqual(['Plan retro', 'Interview users', 'Draft survey'])
  })

  test('a drop in the middle of another column lands between its neighbours', async ({ page }) => {
    const seed = seedWorkspace({
      tasks: [
        { title: 'Alpha', status: 'todo' },
        { title: 'Prototype', status: 'in_progress' },
        { title: 'Bravo', status: 'todo' },
        { title: 'Review', status: 'in_progress' },
        { title: 'Charlie', status: 'in_progress' },
      ],
    })
    await openBoard(page, seed)

    await dragCard(page, card(page, 'Alpha'), await topOf(card(page, 'Review')), {
      preview: () =>
        expect
          .poll(() => visualTitlesIn(column(page, 'In Progress')))
          .toEqual(['Prototype', 'Alpha', 'Review', 'Charlie']),
    })

    await expect
      .poll(() => storedOrder(page))
      .toEqual(['Prototype', 'Alpha', 'Bravo', 'Review', 'Charlie'])
    expect((await storedTask(page, seed.ids['Alpha']))?.status).toBe('in_progress')
  })

  test('an empty column takes a card and the project order stays as it was', async ({ page }) => {
    const seed = standardSeed()
    await openBoard(page, seed)
    const done = column(page, 'Done')

    await dragCard(page, card(page, 'Plan retro'), await insideOf(done, 120), {
      preview: () => expect.poll(() => visualTitlesIn(done)).toEqual(['Plan retro']),
    })

    await expect
      .poll(async () => (await storedTask(page, seed.ids['Plan retro']))?.status)
      .toBe('done')
    expect((await storedTask(page, seed.ids['Plan retro']))?.completedAt).not.toBeNull()
    // Nothing else moved: the card kept its place in the One project order.
    expect(await storedOrder(page)).toEqual([
      'Interview users',
      'Prototype',
      'Draft survey',
      'Plan retro',
    ])
    await expect(done).toHaveAccessibleName('Done 1 task')
  })

  test('Escape cancels a drag: nothing moves and nothing is saved', async ({ page }) => {
    const seed = standardSeed()
    await openBoard(page, seed)
    const saved = await storedTasks(page)

    await dragCard(page, card(page, 'Plan retro'), await topOf(card(page, 'Prototype')), {
      release: false,
      preview: () =>
        expect
          .poll(() => visualTitlesIn(column(page, 'In Progress')))
          .toEqual(['Plan retro', 'Prototype']),
    })
    await page.keyboard.press('Escape')
    await page.mouse.up()

    await expect.poll(() => titlesIn(column(page, 'In Progress'))).toEqual(['Prototype'])
    expect(await titlesIn(column(page, 'To Do'))).toEqual([
      'Interview users',
      'Draft survey',
      'Plan retro',
    ])
    expect(await storedTasks(page)).toEqual(saved)
  })

  test('the lifted card shows the status of the column it is over', async ({ page }) => {
    const seed = seedWorkspace({
      tasks: [
        { title: 'Late report', status: 'todo', dueDate: today(-4), priority: 'high' },
        { title: 'Prototype', status: 'in_progress' },
        { title: 'Shipped', status: 'done' },
      ],
    })
    await openBoard(page, seed)
    const lifted = page.locator('[data-board-drag-overlay]')
    const glyph = lifted.locator('svg[data-status]')

    await dragCard(page, card(page, 'Late report'), await insideOf(card(page, 'Late report'), 30), {
      release: false,
      preview: () => expect(lifted).toBeVisible(),
    })
    await expect(glyph).toHaveAttribute('data-status', 'todo')
    await expect(lifted.locator('[data-bucket]')).toHaveAttribute('data-bucket', 'overdue')

    const inProgress = await topOf(card(page, 'Prototype'))
    await page.mouse.move(inProgress.x, inProgress.y, { steps: 12 })
    await expect(glyph).toHaveAttribute('data-status', 'in_progress')

    const done = await topOf(card(page, 'Shipped'))
    await page.mouse.move(done.x, done.y, { steps: 12 })
    await expect(glyph).toHaveAttribute('data-status', 'done')
    // A done task is never overdue.
    await expect(lifted.locator('[data-bucket]')).toHaveAttribute('data-bucket', 'done')

    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(lifted).toHaveCount(0)
  })

  test('the keyboard moves cards: Space, arrows, Space; Escape cancels', async ({ page }) => {
    const seed = standardSeed()
    await openBoard(page, seed)
    const live = liveRegion(page)

    // Space picks the card up, arrows move it (two columns right), Space drops it — one step at a
    // time, as the screen reader announcements report.
    await pickUpWithKeyboard(
      page,
      'Interview users',
      'Picked up “Interview users”. To Do, position 1 of 3.',
    )
    await page.keyboard.press('ArrowRight')
    await expect(live).toHaveText(/is over In Progress, position 1 of 2\.$/)
    await page.keyboard.press('ArrowRight')
    await expect(live).toHaveText(/is over Done, position 1 of 1\.$/)
    await page.keyboard.press('Space')
    await expect(live).toHaveText('“Interview users” dropped in Done, position 1 of 1.')
    await expect.poll(() => titlesIn(column(page, 'Done'))).toEqual(['Interview users'])
    await expect
      .poll(async () => (await storedTask(page, seed.ids['Interview users']))?.status)
      .toBe('done')
    await expect(card(page, 'Interview users')).toBeFocused()

    // Escape puts a card that was moved around back, and keeps focus on it.
    await pickUpWithKeyboard(page, 'Plan retro', /^Picked up “Plan retro”/)
    await page.keyboard.press('ArrowRight')
    await expect(live).toHaveText(/is over In Progress/)
    await page.keyboard.press('Escape')
    await expect(live).toHaveText(/was cancelled\. It stays in To Do/)
    await expect.poll(() => titlesIn(column(page, 'In Progress'))).toEqual(['Prototype'])
    await expect(card(page, 'Plan retro')).toBeFocused()
    expect((await storedTask(page, seed.ids['Plan retro']))?.status).toBe('todo')
  })

  test('arrow keys move focus between cards, Enter opens the task', async ({ page }) => {
    const seed = standardSeed()
    await openBoard(page, seed)

    await card(page, 'Interview users').focus()
    await page.keyboard.press('ArrowDown')
    await expect(card(page, 'Draft survey')).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(card(page, 'Prototype')).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(card(page, 'Interview users')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`task=${seed.ids['Interview users']}`))
  })
})

// ---------------------------------------------------------------------------
// Failures and pending writes (PRD §5.4, acceptance #15)
// ---------------------------------------------------------------------------

test.describe('board write failures and pending writes (local mode)', () => {
  test('a failed drop rolls back, and Retry saves it', async ({ page }) => {
    const seed = standardSeed()
    await openBoard(page, seed)
    await failNextWrites(page, 1)

    await dragCard(page, card(page, 'Interview users'), await topOf(card(page, 'Prototype')), {
      preview: () =>
        expect
          .poll(() => visualTitlesIn(column(page, 'In Progress')))
          .toEqual(['Interview users', 'Prototype']),
    })

    await expect(toast(page, "Couldn't move task")).toBeVisible()
    await expect.poll(() => titlesIn(column(page, 'To Do'))).toContain('Interview users')
    expect((await storedTask(page, seed.ids['Interview users']))?.status).toBe('todo')

    await toast(page, "Couldn't move task").getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => titlesIn(column(page, 'In Progress'))).toContain('Interview users')
    await expect
      .poll(async () => (await storedTask(page, seed.ids['Interview users']))?.status)
      .toBe('in_progress')
  })

  test('an earlier move that fails while the next drag is in flight does not shift the drop', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      tasks: [
        { title: 'Alpha', status: 'todo' },
        { title: 'Prototype', status: 'in_progress' },
        { title: 'Bravo', status: 'todo' },
        { title: 'Charlie', status: 'todo' },
        { title: 'Review', status: 'in_progress' },
      ],
    })
    await openBoard(page, seed)
    await setLatency(page, 600)
    await failNextWrites(page, 1)

    // 1st drag: Alpha → top of In Progress. It is shown at once and fails ~600 ms later.
    await dragCard(page, card(page, 'Alpha'), await topOf(card(page, 'Prototype')), {
      preview: () =>
        expect
          .poll(() => visualTitlesIn(column(page, 'In Progress')))
          .toEqual(['Alpha', 'Prototype', 'Review']),
    })
    // 2nd drag: Charlie between Prototype and Review — held while the 1st one is rolled back.
    await dragCard(page, card(page, 'Charlie'), await topOf(card(page, 'Review')), {
      release: false,
      preview: () =>
        expect
          .poll(() => visualTitlesIn(column(page, 'In Progress')))
          .toEqual(['Alpha', 'Prototype', 'Charlie', 'Review']),
    })
    await expect(toast(page, "Couldn't move task")).toBeVisible()
    await page.mouse.up()

    // Charlie lands where the user saw it: between Prototype and Review (not after Review).
    await expect
      .poll(() => titlesIn(column(page, 'In Progress')), { timeout: 10_000 })
      .toEqual(['Prototype', 'Charlie', 'Review'])
    await expect(column(page, 'To Do')).toHaveAccessibleName('To Do 2 tasks')
    expect(await titlesIn(column(page, 'To Do'))).toEqual(['Alpha', 'Bravo'])
    await expect
      .poll(async () => (await storedTask(page, seed.ids['Charlie']))?.status, { timeout: 10_000 })
      .toBe('in_progress')
    const order = await storedOrder(page)
    expect(order.indexOf('Prototype')).toBeLessThan(order.indexOf('Charlie'))
    expect(order.indexOf('Charlie')).toBeLessThan(order.indexOf('Review'))
    expect((await storedTask(page, seed.ids['Alpha']))?.status).toBe('todo')
  })

  test('a failed status change rolls back and Retry applies it', async ({ page }) => {
    const seed = standardSeed()
    await openBoard(page, seed)
    await failNextWrites(page, 1)

    await cardItem(page, 'Plan retro').getByRole('button', { name: 'Status: To Do' }).click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()

    await expect(toast(page, "Couldn't update task")).toBeVisible()
    await expect.poll(() => titlesIn(column(page, 'To Do'))).toContain('Plan retro')
    expect((await storedTask(page, seed.ids['Plan retro']))?.status).toBe('todo')
    // The rolled-back card is a new element: keyboard focus returns to it.
    await expect(card(page, 'Plan retro')).toBeFocused()

    await toast(page, "Couldn't update task").getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => titlesIn(column(page, 'Done'))).toEqual(['Plan retro'])
    await expect
      .poll(async () => (await storedTask(page, seed.ids['Plan retro']))?.status)
      .toBe('done')
  })

  test('a failed ⋯ menu move and a failed priority change are rolled back with Retry', async ({
    page,
  }) => {
    const seed = standardSeed()
    await openBoard(page, seed)

    await failNextWrites(page, 1)
    await cardItem(page, 'Plan retro')
      .getByRole('button', { name: /^More actions/ })
      .click()
    await page.getByRole('menuitem', { name: 'Move to top' }).click()
    await expect(toast(page, "Couldn't move task")).toBeVisible()
    await expect
      .poll(() => titlesIn(column(page, 'To Do')))
      .toEqual(['Interview users', 'Draft survey', 'Plan retro'])
    await toast(page, "Couldn't move task").getByRole('button', { name: 'Retry' }).click()
    await expect
      .poll(() => titlesIn(column(page, 'To Do')))
      .toEqual(['Plan retro', 'Interview users', 'Draft survey'])
    // Saved: the next failure must not be used up by the Retry that is still being written.
    await expect
      .poll(() => storedOrder(page))
      .toEqual(['Plan retro', 'Interview users', 'Prototype', 'Draft survey'])

    await failNextWrites(page, 1)
    await cardItem(page, 'Draft survey')
      .getByRole('button', { name: /^More actions/ })
      .click()
    await page.getByRole('menuitem', { name: /^Priority/ }).click()
    await page.getByRole('menuitemradio', { name: 'Urgent' }).click()
    await expect(toast(page, "Couldn't update task")).toBeVisible()
    expect((await storedTask(page, seed.ids['Draft survey']))?.priority).toBe('none')
    await toast(page, "Couldn't update task").getByRole('button', { name: 'Retry' }).click()
    await expect
      .poll(async () => (await storedTask(page, seed.ids['Draft survey']))?.priority)
      .toBe('urgent')
  })

  test('a Retry that fails again shows the failure again, and the next Retry saves it', async ({
    page,
  }) => {
    const seed = standardSeed()
    await openBoard(page, seed)
    await failNextWrites(page, 2) // the move and its first Retry (offline-like)

    await cardItem(page, 'Plan retro')
      .getByRole('button', { name: /^More actions/ })
      .click()
    await page.getByRole('menuitem', { name: 'Move to top' }).click()
    const first = toast(page, "Couldn't move task")
    await expect(first).toBeVisible()

    // Retry fails at once. The dismissed toast leaves, and the new failure is shown — with its own
    // Retry — instead of being lost with the toast that was on its way out.
    const dismissed = await first.elementHandle()
    await first.getByRole('button', { name: 'Retry' }).click()
    await dismissed?.waitForElementState('hidden')
    await expect(toast(page, "Couldn't move task")).toBeVisible()
    await expect(page.getByRole('button', { name: /^Sync status: Couldn't save/ })).toBeVisible()
    expect(await titlesIn(column(page, 'To Do'))).toEqual([
      'Interview users',
      'Draft survey',
      'Plan retro',
    ])

    await toast(page, "Couldn't move task").getByRole('button', { name: 'Retry' }).click()
    await expect
      .poll(() => titlesIn(column(page, 'To Do')))
      .toEqual(['Plan retro', 'Interview users', 'Draft survey'])
    await expect
      .poll(() => storedOrder(page))
      .toEqual(['Plan retro', 'Interview users', 'Prototype', 'Draft survey'])
    await expect(toast(page, "Couldn't move task")).toHaveCount(0)
  })

  test('with a slow save the new card shows at once, saving is indicated, and it is created once', async ({
    page,
  }) => {
    const seed = standardSeed()
    await openBoard(page, seed)
    await setLatency(page, 800)

    const todo = column(page, 'To Do')
    await todo.getByRole('button', { name: 'Add task to To Do' }).click()
    const input = todo.getByRole('textbox', { name: 'New task in To Do' })
    await input.fill('Slow save')
    await input.press('Enter')
    await input.press('Enter') // the second Enter has nothing to add

    await expect(card(page, 'Slow save')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Sync status: Saving/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Sync status: Saving/ })).toBeHidden()
    await expect(page.locator('[data-card-activator][aria-label="Slow save"]')).toHaveCount(1)
    expect((await storedTasks(page)).filter((task) => task.title === 'Slow save')).toHaveLength(1)
  })

  test('a failed inline add is rolled back, the composer stays open, and Retry creates it once', async ({
    page,
  }) => {
    const seed = standardSeed()
    await openBoard(page, seed)
    const todo = column(page, 'To Do')
    await todo.getByRole('button', { name: 'Add task to To Do' }).click()
    const input = todo.getByRole('textbox', { name: 'New task in To Do' })
    await failNextWrites(page, 1)

    await input.fill('Will fail')
    await input.press('Enter')

    await expect(toast(page, "Couldn't create task")).toBeVisible()
    await expect(card(page, 'Will fail')).toHaveCount(0)
    await expect(input).toBeFocused() // ready for the next one
    await toast(page, "Couldn't create task").getByRole('button', { name: 'Retry' }).click()
    await expect(card(page, 'Will fail')).toHaveCount(1)
    await expect
      .poll(async () => (await storedTasks(page)).filter((task) => task.title === 'Will fail'))
      .toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Inline add, header +, empty states
// ---------------------------------------------------------------------------

test.describe('board adding tasks and empty states (local mode)', () => {
  test('inline add: rapid entry keeps focus, nothing blank is added, Esc cancels, it persists', async ({
    page,
  }) => {
    const seed = standardSeed()
    await openBoard(page, seed)
    const todo = column(page, 'To Do')
    const add = todo.getByRole('button', { name: 'Add task to To Do' })
    await add.click()
    const input = todo.getByRole('textbox', { name: 'New task in To Do' })
    await expect(input).toBeFocused()

    for (const title of ['Rapid one', '快速新增：第二個任務', 'Rapid three']) {
      await input.fill(title)
      await input.press('Enter')
      await expect(card(page, title)).toBeVisible()
      await expect(input).toBeFocused()
      await expect(input).toHaveValue('')
    }
    await input.fill('   ')
    await input.press('Enter')
    await expect(todo).toHaveAccessibleName('To Do 6 tasks')

    // New cards go to the end of the column (and of the project order), as To Do tasks.
    expect(await titlesIn(todo)).toEqual([
      'Interview users',
      'Draft survey',
      'Plan retro',
      'Rapid one',
      '快速新增：第二個任務',
      'Rapid three',
    ])
    await expect
      .poll(async () => (await storedOrder(page)).slice(-3))
      .toEqual(['Rapid one', '快速新增：第二個任務', 'Rapid three'])

    await input.fill('never saved')
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(add).toBeFocused()
    await expect(card(page, 'never saved')).toHaveCount(0)

    await page.reload()
    await expect(todo).toHaveAccessibleName('To Do 6 tasks')
    expect(await titlesIn(todo)).toContain('快速新增：第二個任務')
  })

  test('inline add in In Progress and Done creates tasks with that status', async ({ page }) => {
    const seed = standardSeed()
    await openBoard(page, seed)

    for (const [name, title] of [
      ['In Progress', 'Started thing'],
      ['Done', 'Finished thing'],
    ]) {
      const region = column(page, name)
      await region.getByRole('button', { name: `Add task to ${name}` }).click()
      const input = region.getByRole('textbox', { name: `New task in ${name}` })
      await input.fill(title)
      await input.press('Enter')
      await expect(card(page, title)).toBeVisible()
    }

    expect(await titlesIn(column(page, 'In Progress'))).toEqual(['Prototype', 'Started thing'])
    expect(await titlesIn(column(page, 'Done'))).toEqual(['Finished thing'])
    const created = (await storedTasks(page)).find((task) => task.title === 'Finished thing')
    expect(created).toMatchObject({ status: 'done' })
    expect(created?.completedAt).not.toBeNull()
  })

  test('an empty project shows three empty columns; the first inline add works', async ({
    page,
  }) => {
    const seed = seedWorkspace({ tasks: [] })
    await openBoard(page, seed)

    for (const name of ['To Do', 'In Progress', 'Done']) {
      await expect(column(page, name)).toHaveAccessibleName(`${name} 0 tasks`)
    }
    await expect(column(page, 'To Do').getByText('No tasks yet')).toBeVisible()
    await expect(column(page, 'In Progress').getByText('No tasks', { exact: true })).toBeVisible()

    const todo = column(page, 'To Do')
    await todo.getByRole('button', { name: 'Add task to To Do' }).click()
    await todo.getByRole('textbox', { name: 'New task in To Do' }).fill('First task')
    await todo.getByRole('textbox', { name: 'New task in To Do' }).press('Enter')
    await expect(todo).toHaveAccessibleName('To Do 1 task')
    await expect(card(page, 'First task')).toBeVisible()
  })

  test('the column + opens the Task Modal preset to that column', async ({ page }) => {
    const seed = standardSeed()
    await openBoard(page, seed)

    await column(page, 'In Progress')
      .getByRole('button', { name: 'New task in In Progress' })
      .click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Status: In Progress' })).toBeVisible()
    await dialog
      .getByRole('textbox', { name: /title|name/i })
      .first()
      .fill('Created in the modal')
    await dialog.getByRole('button', { name: 'Create task' }).click()
    await expect(dialog).toBeHidden()

    await expect
      .poll(() => titlesIn(column(page, 'In Progress')))
      .toEqual(['Prototype', 'Created in the modal'])
  })
})

// ---------------------------------------------------------------------------
// Menus: the non-drag alternatives (WCAG 2.5.7)
// ---------------------------------------------------------------------------

test.describe('board status and ⋯ menus (local mode)', () => {
  test('the status menu moves a card (pointer and keyboard) and the List agrees', async ({
    page,
  }) => {
    const seed = standardSeed()
    await openBoard(page, seed)

    await cardItem(page, 'Draft survey').getByRole('button', { name: 'Status: To Do' }).click()
    await page.getByRole('menuitemradio', { name: 'In Progress' }).click()
    // It joins the column at its place in the project order (after "Prototype") and keeps focus.
    await expect
      .poll(() => titlesIn(column(page, 'In Progress')))
      .toEqual(['Prototype', 'Draft survey'])
    await expect(card(page, 'Draft survey')).toBeFocused()

    // Keyboard only: Tab to the card's status button, Enter, digit 3 = Done.
    await card(page, 'Prototype').focus()
    await page.keyboard.press('Tab')
    await expect(
      cardItem(page, 'Prototype').getByRole('button', { name: /^Status:/ }),
    ).toBeFocused()
    await page.keyboard.press('Enter')
    await page.keyboard.press('3')
    await expect.poll(() => titlesIn(column(page, 'Done'))).toEqual(['Prototype'])
    await expect(card(page, 'Prototype')).toBeFocused()

    await page.getByRole('link', { name: 'List', exact: true }).click()
    const statusOf = (title: string) =>
      page.locator(`[data-task-row="${seed.ids[title]}"]`).getByRole('button', { name: /^Status:/ })
    await expect(statusOf('Draft survey')).toHaveAccessibleName('Status: In Progress')
    await expect(statusOf('Prototype')).toHaveAccessibleName('Status: Done')
  })

  test('the ⋯ menu reorders inside the column without touching status, and sets the priority', async ({
    page,
  }) => {
    const seed = standardSeed()
    await openBoard(page, seed)
    const todo = column(page, 'To Do')

    // First card: nothing above it.
    await cardItem(page, 'Interview users')
      .getByRole('button', { name: /^More actions/ })
      .click()
    await expect(page.getByRole('menuitem', { name: 'Move to top' })).toBeDisabled()
    await expect(page.getByRole('menuitem', { name: 'Move up' })).toBeDisabled()
    await page.keyboard.press('Escape')

    await cardItem(page, 'Plan retro')
      .getByRole('button', { name: /^More actions/ })
      .click()
    await page.getByRole('menuitem', { name: 'Move to top' }).click()
    await expect
      .poll(() => titlesIn(todo))
      .toEqual(['Plan retro', 'Interview users', 'Draft survey'])
    expect((await storedTask(page, seed.ids['Plan retro']))?.status).toBe('todo')

    await cardItem(page, 'Plan retro')
      .getByRole('button', { name: /^More actions/ })
      .click()
    await page.getByRole('menuitem', { name: 'Move down' }).click()
    await expect
      .poll(() => titlesIn(todo))
      .toEqual(['Interview users', 'Plan retro', 'Draft survey'])

    await cardItem(page, 'Plan retro')
      .getByRole('button', { name: /^More actions/ })
      .click()
    await page.getByRole('menuitem', { name: 'Move to bottom' }).click()
    await expect
      .poll(() => titlesIn(todo))
      .toEqual(['Interview users', 'Draft survey', 'Plan retro'])
    // Stored in the project order: the card sits right after "Draft survey".
    await expect
      .poll(() => storedOrder(page))
      .toEqual(['Interview users', 'Prototype', 'Draft survey', 'Plan retro'])

    await cardItem(page, 'Draft survey')
      .getByRole('button', { name: /^More actions/ })
      .click()
    await page.getByRole('menuitem', { name: /^Priority/ }).click()
    await page.getByRole('menuitemradio', { name: 'High' }).click()
    await expect
      .poll(async () => (await storedTask(page, seed.ids['Draft survey']))?.priority)
      .toBe('high')
    await expect(card(page, 'Draft survey')).toHaveAccessibleDescription(/Priority: High\./)
  })
})

// ---------------------------------------------------------------------------
// Cards, Task Modal, phase filter
// ---------------------------------------------------------------------------

test.describe('board cards, Task Modal and phase filter (local mode)', () => {
  test('cards show top-level tasks only, with due state, subtask summary and phase', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      phases: ['Discovery'],
      tasks: [
        {
          title: 'Overdue task',
          status: 'todo',
          dueDate: today(-3),
          priority: 'high',
          phase: 'Discovery',
          subtasks: ['done', 'todo', 'todo'],
        },
        { title: 'Finished late', status: 'done', dueDate: today(-9) },
        { title: 'Plain task', status: 'in_progress' },
      ],
    })
    await openBoard(page, seed)

    expect(await boardTitles(page)).toEqual({
      todo: ['Overdue task'],
      in_progress: ['Plain task'],
      done: ['Finished late'],
    })
    const overdue = cardItem(page, 'Overdue task')
    await expect(overdue.locator('[data-bucket="overdue"]')).toBeVisible()
    await expect(overdue).toContainText('1/3')
    await expect(overdue).toContainText('Discovery')
    await expect(cardItem(page, 'Finished late').locator('[data-bucket]')).toHaveAttribute(
      'data-bucket',
      'done',
    )
    // A card without meta has no meta row.
    await expect(cardItem(page, 'Plain task').locator('[data-bucket]')).toHaveCount(0)
    // Screen readers get the meta as one sentence.
    await expect(card(page, 'Overdue task')).toHaveAccessibleDescription(
      /Priority: High\. Overdue, due .*\. 1 of 3 subtasks done\. Phase: Discovery\./,
    )
  })

  test('a click or Enter opens the Task Modal; Esc gives focus back to the card', async ({
    page,
  }) => {
    const seed = standardSeed()
    await openBoard(page, seed)

    await card(page, 'Draft survey').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`task=${seed.ids['Draft survey']}`))
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(card(page, 'Draft survey')).toBeFocused()
    await expect(page).not.toHaveURL(/task=/)

    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('a status saved in the Task Modal moves the card, and focus returns to it', async ({
    page,
  }) => {
    const seed = standardSeed()
    await openBoard(page, seed)

    await card(page, 'Draft survey').focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Status: To Do' }).click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()

    await expect.poll(() => titlesIn(column(page, 'Done'))).toEqual(['Draft survey'])
    // The card was re-mounted in another column: keyboard focus did not fall to the page.
    await expect(card(page, 'Draft survey')).toBeFocused()

    // Same through the card's ⋯ menu ("Open task").
    await cardItem(page, 'Plan retro')
      .getByRole('button', { name: /^More actions/ })
      .click()
    await page.getByRole('menuitem', { name: 'Open task' }).click()
    await dialog.getByRole('button', { name: 'Status: To Do' }).click()
    await page.getByRole('menuitemradio', { name: 'In Progress' }).click()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await expect
      .poll(() => titlesIn(column(page, 'In Progress')))
      .toEqual(['Prototype', 'Plan retro'])
    await expect(
      cardItem(page, 'Plan retro').getByRole('button', { name: /^More actions/ }),
    ).toBeFocused()
  })

  test('the phase filter narrows the board, survives the modal and a reload, and new tasks join the phase', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      phases: ['Discovery', 'Design'],
      tasks: [
        { title: 'Interview users', status: 'todo', phase: 'Discovery' },
        { title: 'Prototype', status: 'in_progress', phase: 'Design' },
        { title: 'Draft survey', status: 'todo', phase: 'Discovery' },
        { title: 'Plan retro', status: 'todo' },
      ],
    })
    await openBoard(page, seed)
    const filter = page.getByRole('combobox', { name: /^Phase filter/ })
    await expect(filter).toHaveAccessibleName('Phase filter All phases')
    // With every phase shown, cards carry their phase chip.
    await expect(cardItem(page, 'Prototype')).toContainText('Design')

    await filter.click()
    await page.getByRole('option', { name: 'Discovery' }).click()
    await expect(page).toHaveURL(/phase=/)
    await expect(column(page, 'To Do')).toHaveAccessibleName('To Do 2 tasks')
    expect(await boardTitles(page)).toEqual({
      todo: ['Interview users', 'Draft survey'],
      in_progress: [],
      done: [],
    })
    // Filtered to one phase, the chip would repeat on every card.
    await expect(cardItem(page, 'Interview users')).not.toContainText('Discovery')

    // The modal keeps the filter in the URL.
    await card(page, 'Interview users').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page).toHaveURL(/phase=.*task=|task=.*phase=/)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page).toHaveURL(/phase=/)
    await expect(page).not.toHaveURL(/task=/)

    // A task added while filtered joins that phase (and stays visible).
    const todo = column(page, 'To Do')
    await todo.getByRole('button', { name: 'Add task to To Do' }).click()
    await todo.getByRole('textbox', { name: 'New task in To Do' }).fill('Filtered add')
    await todo.getByRole('textbox', { name: 'New task in To Do' }).press('Enter')
    await expect(card(page, 'Filtered add')).toBeVisible()
    const created = (await storedTasks(page)).find((task) => task.title === 'Filtered add')
    expect(created?.phaseId).not.toBeNull()

    await page.reload()
    await expect(column(page, 'To Do')).toHaveAccessibleName('To Do 3 tasks')

    await filter.click()
    await page.getByRole('option', { name: 'No phase' }).click()
    await expect.poll(() => titlesIn(column(page, 'To Do'))).toEqual(['Plan retro'])

    await page.getByRole('button', { name: 'Clear phase filter' }).click()
    await expect(page).not.toHaveURL(/phase=/)
    await expect(column(page, 'To Do')).toHaveAccessibleName('To Do 4 tasks')
  })

  test('a filter that matches nothing says so and offers to show every phase', async ({ page }) => {
    const seed = seedWorkspace({
      phases: ['Discovery', 'Design'],
      tasks: [{ title: 'Only one', status: 'todo', phase: 'Design' }],
    })
    await openBoard(page, seed)

    await page.getByRole('combobox', { name: /^Phase filter/ }).click()
    await page.getByRole('option', { name: 'Discovery' }).click()
    await expect(page.getByText('No tasks in Discovery')).toBeVisible()
    await expect(column(page, 'To Do')).toHaveAccessibleName('To Do 0 tasks')

    await page.getByRole('button', { name: 'Clear filter' }).click()
    await expect(card(page, 'Only one')).toBeVisible()
  })

  test('a drag under a phase filter places the card among the visible cards and keeps its phase', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      phases: ['Discovery', 'Design'],
      tasks: [
        { title: 'Alpha', status: 'todo', phase: 'Discovery' },
        { title: 'Bravo', status: 'todo', phase: 'Design' },
        { title: 'Charlie', status: 'in_progress', phase: 'Discovery' },
        { title: 'Delta', status: 'in_progress', phase: 'Design' },
      ],
    })
    await openBoard(page, seed, '')
    await page.getByRole('combobox', { name: /^Phase filter/ }).click()
    await page.getByRole('option', { name: 'Discovery' }).click()
    await expect.poll(() => titlesIn(column(page, 'In Progress'))).toEqual(['Charlie'])

    await dragCard(page, card(page, 'Alpha'), await topOf(card(page, 'Charlie')), {
      preview: () =>
        expect
          .poll(() => visualTitlesIn(column(page, 'In Progress')))
          .toEqual(['Alpha', 'Charlie']),
    })

    await expect
      .poll(async () => (await storedTask(page, seed.ids['Alpha']))?.status)
      .toBe('in_progress')
    const order = await storedOrder(page)
    expect(order.indexOf('Alpha')).toBeLessThan(order.indexOf('Charlie'))
    expect((await storedTask(page, seed.ids['Alpha']))?.phaseId).toBe(
      (await storedTask(page, seed.ids['Charlie']))?.phaseId,
    )

    // dnd-kit swallows clicks for 50 ms after a drop (a production build gets here sooner).
    await page.waitForTimeout(60)
    await page.getByRole('button', { name: 'Clear phase filter' }).click()
    await expect
      .poll(() => titlesIn(column(page, 'In Progress')))
      .toEqual(['Alpha', 'Charlie', 'Delta'])
  })
})
