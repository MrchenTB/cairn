/// <reference lib="dom" />
/**
 * Cross-project Timeline E2E — LOCAL data mode against the dev server (playwright.config.ts).
 *
 * PRD acceptance §9.1 #12: different projects and their milestones on one shared time axis, so
 * overlaps read at a glance. Also covered: one row per project by default, expansion remembered for
 * the session, read-only bars opening the Task Modal, an edit in the modal reaching the chart (and
 * a FAILED edit rolling back with a working Retry), the link to a project's Gantt, Today / T, the
 * scales and their persistence, Include completed, archived projects staying off the chart, the
 * empty states, keyboard use, Back closing the modal, both themes, a workspace with many projects,
 * and a project's name never running under one of its milestone diamonds while scrolling.
 */
import { randomUUID } from 'node:crypto'
import { expect, test as base, type Locator, type Page } from '@playwright/test'

const LOCAL_WORKSPACE_KEY = 'cairn:local:workspace:v1'
const EXPANDED_KEY = 'cairn:timeline-expanded'
const NOW = new Date().toISOString()
const DAY_PX = { day: 36, week: 16, month: 5 }
/** The project pane's default width: the time axis starts this far into the chart. */
const PANE_PX = 300

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

/** The browser's local calendar date, `days` from now (the app's "today" in local mode). */
function at(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

interface Seed {
  ids: Record<string, string>
  db: unknown
}

/** Small builders for a local workspace; `ids` maps every name to its generated id. */
function workspace() {
  const ids: Record<string, string> = {}
  const id = (name: string) => (ids[name] = randomUUID())
  const stamps = { createdAt: NOW, updatedAt: NOW }
  const rows = {
    projects: [] as { id: string }[],
    tasks: [] as { id: string }[],
    milestones: [] as { id: string }[],
    dependencies: [] as { id: string }[],
  }
  return {
    ids,
    project(name: string, sortOrder: string, extra: object = {}) {
      rows.projects.push({
        id: id(name),
        name,
        description: null,
        status: 'active',
        color: 'blue',
        startDate: null,
        dueDate: null,
        scheduleMode: 'manual',
        sortOrder,
        ...stamps,
        ...extra,
      } as { id: string })
    },
    task(title: string, projectName: string, sortOrder: string, extra: object = {}) {
      rows.tasks.push({
        id: id(title),
        projectId: ids[projectName],
        phaseId: null,
        parentTaskId: null,
        title,
        description: null,
        status: 'todo',
        priority: 'none',
        startDate: null,
        dueDate: null,
        sortOrder,
        completedAt: null,
        ...stamps,
        ...extra,
      } as { id: string })
    },
    milestone(name: string, projectName: string, date: string) {
      rows.milestones.push({
        id: id(name),
        projectId: ids[projectName],
        phaseId: null,
        name,
        date,
        ...stamps,
      } as { id: string })
    },
    /** Finish-to-start: `predecessor` must finish before `successor` starts. */
    dependency(predecessor: string, successor: string, projectName: string) {
      rows.dependencies.push({
        id: randomUUID(),
        projectId: ids[projectName],
        predecessorId: ids[predecessor],
        successorId: ids[successor],
        type: 'FS',
        createdAt: NOW,
      } as { id: string })
    },
    build(): Seed {
      const byId = (list: { id: string }[]) => Object.fromEntries(list.map((row) => [row.id, row]))
      return {
        ids,
        db: {
          version: 1,
          projects: byId(rows.projects),
          phases: {},
          tasks: byId(rows.tasks),
          milestones: byId(rows.milestones),
          dependencies: byId(rows.dependencies),
          preferences: null,
        },
      }
    },
  }
}

function seedWorkspace(): Seed {
  const w = workspace()
  w.project('Research', 'a1', { color: 'violet', startDate: at(-10), dueDate: at(30) })
  w.project('Website', 'a2', { color: 'teal' })
  w.project('Finished', 'a3', { status: 'completed', startDate: at(-40), dueDate: at(-20) })
  w.project('Shelved', 'a4', { status: 'archived', startDate: at(-10), dueDate: at(10) })
  w.project('Ideas', 'a5', { color: 'gray' })

  w.task('Interview users', 'Research', 'a1', { startDate: at(-8), dueDate: at(4) })
  w.task('Write report', 'Research', 'a2', { startDate: at(6), dueDate: at(12), status: 'done' })
  w.task('Undated note', 'Research', 'a3')
  w.task('Wireframes', 'Website', 'a1', { startDate: at(5), dueDate: at(40) })
  // Starts long before its predecessor finishes: a dependency conflict.
  w.task('Review wireframes', 'Website', 'a2', { startDate: at(8), dueDate: at(12) })
  w.task('Undated idea', 'Ideas', 'a1')
  w.dependency('Wireframes', 'Review wireframes', 'Website')

  w.milestone('Report out', 'Research', at(14))
  w.milestone('Launch', 'Website', at(42))
  return w.build()
}

/** Where names meet diamonds: a long bar with two milestones, and a project that is one day. */
function labelWorkspace(): Seed {
  const w = workspace()
  w.project('Roadmap 路線圖規劃', 'a1', { color: 'violet', startDate: at(-30), dueDate: at(60) })
  w.project('Ops', 'a2', { color: 'red' })
  w.milestone('Alpha', 'Roadmap 路線圖規劃', at(10))
  w.milestone('Beta', 'Roadmap 路線圖規劃', at(25))
  w.milestone('Kickoff', 'Ops', at(7))
  return w.build()
}

/** `projectCount` projects with eight tasks each (every tenth has no dates at all). */
function bulkWorkspace(projectCount: number): Seed & { projectIds: string[] } {
  const w = workspace()
  for (let i = 0; i < projectCount; i++) {
    const name = `Project ${String(i).padStart(2, '0')} ${i % 3 === 0 ? '專案規劃' : 'plan'}`
    const dated = i % 10 !== 9
    w.project(name, `a${String(i).padStart(3, '0')}`, { color: 'blue' })
    if (!dated) continue
    for (let k = 0; k < 8; k++) {
      const start = ((i * 7) % 90) - 45 + k * 5
      w.task(`${name} task ${k}`, name, `a${k}`, { startDate: at(start), dueDate: at(start + 4) })
    }
    if (i % 4 === 0) w.milestone(`${name} milestone`, name, at(((i * 7) % 90) - 20))
  }
  const seed = w.build()
  const projects = Object.values((seed.db as { projects: Record<string, { id: string }> }).projects)
  return { ...seed, projectIds: projects.map((project) => project.id) }
}

const EMPTY_DB = {
  version: 1,
  projects: {},
  phases: {},
  tasks: {},
  milestones: {},
  dependencies: {},
  preferences: null,
}

/** Seeds the local workspace once per browser session (a reload keeps the user's changes). */
async function seedPage(page: Page, seed: Seed, expanded: string[] = []): Promise<void> {
  await page.addInitScript(
    ({ key, db, expandedKey, expandedIds }) => {
      if (sessionStorage.getItem('cairn-e2e-timeline-seeded')) return
      localStorage.setItem(key, JSON.stringify(db))
      if (expandedIds.length > 0) sessionStorage.setItem(expandedKey, JSON.stringify(expandedIds))
      sessionStorage.setItem('cairn-e2e-timeline-seeded', '1')
    },
    { key: LOCAL_WORKSPACE_KEY, db: seed.db, expandedKey: EXPANDED_KEY, expandedIds: expanded },
  )
}

async function openTimeline(page: Page, seed: Seed, expanded: string[] = []): Promise<void> {
  await seedPage(page, seed, expanded)
  await page.goto('/timeline')
  await expect(chart(page)).toBeVisible()
}

function chart(page: Page): Locator {
  return page.getByRole('region', { name: 'Timeline of all projects' })
}

function bar(page: Page, projectId: string): Locator {
  return chart(page).locator(`[data-project-bar="${projectId}"]`)
}

function projectRowOf(page: Page, projectId: string): Locator {
  return chart(page).locator(`[data-row-key="project:${projectId}"]`)
}

function rowKeys(page: Page): Promise<(string | null)[]> {
  return chart(page)
    .locator('[data-row-key]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row-key')))
}

async function rect(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('not visible')
  return box
}

/** Two animation frames: scroll handlers and the React updates they cause have run. */
function settle(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

/** Waits until the chart stops scrolling (a smooth scroll to Today has arrived). */
async function scrollIdle(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const first = await chart(page).evaluate((el) => el.scrollLeft)
      await settle(page)
      return first === (await chart(page).evaluate((el) => el.scrollLeft))
    })
    .toBe(true)
}

type TestHooks = { failNextWrites(count: number): void; setLatency(ms: number): void }
function failNextWrites(page: Page, count: number): Promise<void> {
  return page.evaluate((n) => {
    ;(window as Window & { __cairnTest?: TestHooks }).__cairnTest?.failNextWrites(n)
  }, count)
}

function toastWith(page: Page, text: string | RegExp): Locator {
  return page.locator('[data-sonner-toast]').filter({ hasText: text })
}

/** Scrolls so the centre of `target` is `x` px right of the time axis' left edge. */
async function scrollTargetTo(page: Page, target: Locator, x: number): Promise<void> {
  const area = await rect(chart(page))
  const box = await rect(target)
  const current = box.x + box.width / 2 - (area.x + PANE_PX)
  await chart(page).evaluate(
    (el, by) => el.scrollBy({ left: by, behavior: 'instant' }),
    current - x,
  )
  await settle(page)
}

test('every project and its milestones share one time axis; archived stay off', async ({
  page,
}) => {
  const seed = seedWorkspace()
  await openTimeline(page, seed)
  const { ids } = seed

  // One row per project, active only, Unscheduled at the bottom.
  expect(await rowKeys(page)).toEqual([
    `project:${ids.Research}`,
    `project:${ids.Website}`,
    'section:unscheduled',
    `project:${ids.Ideas}`,
  ])

  // Overlap is visible: the Website bar starts inside the Research bar, 15 days after its start.
  // (Research runs -10 … +30; Website's roll-up runs +5 … +42 with its Launch milestone.)
  const research = await rect(bar(page, ids.Research))
  const website = await rect(bar(page, ids.Website))
  expect(website.x - research.x).toBeCloseTo(15 * DAY_PX.week, 0)
  expect(research.width).toBeCloseTo(41 * DAY_PX.week, 0)
  expect(website.width).toBeCloseTo(38 * DAY_PX.week, 0)
  expect(website.x).toBeLessThan(research.x + research.width)

  // Milestones sit on their project's row at their date.
  const reportOut = chart(page).getByRole('button', { name: /^Milestone Report out/ })
  const center = await rect(reportOut)
  expect(center.x + center.width / 2 - research.x).toBeCloseTo(24.5 * DAY_PX.week, 0)

  // Names on request: hover shows the chip of this diamond only.
  const chip = chart(page).getByText(/^Report out · /)
  await expect(chip).toHaveCSS('opacity', '0')
  await reportOut.hover()
  await expect(chip).toHaveCSS('opacity', '1')
  await expect(chart(page).getByText(/^Launch · /)).toHaveCSS('opacity', '0')

  // Today: one line through the chart, and its pill in the header.
  await expect(chart(page).locator('[data-today-column]')).toHaveCount(1)

  // Progress is on the row, in the pane and as a word for screen readers.
  await expect(projectRowOf(page, ids.Research)).toContainText('33%')
  await expect(projectRowOf(page, ids.Ideas)).toContainText('0%')
  await expect(chart(page).getByRole('link', { name: 'Research' })).toHaveAccessibleDescription(
    /1 of 3 tasks done · 33%/,
  )
})

test('expanding is remembered for the session; bars open the Task Modal; edits reach the chart', async ({
  page,
}) => {
  const seed = seedWorkspace()
  await openTimeline(page, seed)
  const { ids } = seed

  const expand = page.getByRole('button', { name: /^Expand Research/ })
  await expand.focus()
  await page.keyboard.press('Enter')
  expect(await rowKeys(page)).toEqual([
    `project:${ids.Research}`,
    `task:${ids['Interview users']}`,
    `task:${ids['Write report']}`,
    `milestone:${ids['Report out']}`,
    `project:${ids.Website}`,
    'section:unscheduled',
    `project:${ids.Ideas}`,
  ])
  // Focus stays on the toggle, which now collapses.
  await expect(page.getByRole('button', { name: /^Collapse Research/ })).toBeFocused()

  // Across a page change and a reload.
  await page.getByRole('link', { name: 'Overview' }).click()
  await expect(page).toHaveURL(/\/overview$/)
  await page.getByRole('link', { name: 'Timeline', exact: true }).first().click()
  await expect(chart(page).locator(`[data-row-key="task:${ids['Interview users']}"]`)).toBeVisible()
  await page.reload()
  await expect(chart(page).locator(`[data-row-key="task:${ids['Interview users']}"]`)).toBeVisible()

  // Read-only bar: click opens the modal, nothing moves.
  const taskBar = chart(page).locator(`[data-task-id="${ids['Interview users']}"]`)
  const before = await rect(taskBar)
  await taskBar.click()
  await expect(page).toHaveURL(new RegExp(`\\?task=${ids['Interview users']}$`))
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // An edit in the modal reaches the chart through the store.
  await dialog.getByPlaceholder('Task name').fill('Interview ten users')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click() // saves the title and closes
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\/timeline$/)
  await expect(taskBar).toContainText('Interview ten users')
  expect((await rect(taskBar)).x).toBeCloseTo(before.x, 0)

  // Collapsing is remembered too.
  await page.getByRole('button', { name: /^Collapse Research/ }).click()
  await page.reload()
  await expect(chart(page).locator(`[data-row-key="task:${ids['Interview users']}"]`)).toHaveCount(
    0,
  )
  await expect(page.getByRole('button', { name: /^Expand Research/ })).toBeVisible()
})

test('a failed title save from the Task Modal on the Timeline rolls back with a Retry; Retry stores it and the bar follows', async ({
  page,
}) => {
  const seed = seedWorkspace()
  await openTimeline(page, seed)
  const { ids } = seed
  await page.getByRole('button', { name: /^Expand Research/ }).click()

  // While the modal is open the chart is aria-hidden: a role-based locator would not find it.
  const taskBar = page.locator(`[data-task-id="${ids['Interview users']}"]`)
  await taskBar.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder('Task name').fill('Interview ten users')
  await failNextWrites(page, 1)
  await dialog.getByPlaceholder('Task name').press('Enter')

  // Never reported as saved: the chart keeps the stored title, the failure names the task and the
  // field and offers Retry.
  const failure = toastWith(page, /Couldn.t save the title of “Interview users”/)
  await expect(failure).toBeVisible()
  await expect(failure.getByRole('button', { name: 'Retry' })).toBeVisible()
  await expect(taskBar).toContainText('Interview users')
  await expect(taskBar).not.toContainText('ten')
  await expect(dialog).toBeVisible()

  await failure.getByRole('button', { name: 'Retry' }).click()
  await expect(taskBar).toContainText('Interview ten users')
  await expect(failure).toHaveCount(0)
  // Nothing is left to retry, so Esc closes without asking.
  await expect(dialog).not.toContainText('Your text is kept here.')
  await expect(dialog.locator('[data-save-state]')).not.toContainText('Couldn’t save')
  await dialog.getByPlaceholder('Task name').focus()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\/timeline$/)

  // The retried write is really stored.
  await page.reload()
  await expect(taskBar).toContainText('Interview ten users')
})

test('the chart is the only scroll container: rows scroll under a sticky header', async ({
  page,
}) => {
  const seed = seedWorkspace()
  await page.setViewportSize({ width: 1280, height: 420 })
  await openTimeline(page, seed)
  await page.getByRole('button', { name: /^Expand Research/ }).click()
  await page.getByRole('button', { name: /^Expand Website/ }).click()

  const before = await rect(chart(page))
  const toolbar = await rect(page.getByRole('button', { name: 'Today', exact: true }))
  const { clientHeight, scrollHeight } = await chart(page).evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }))
  expect(scrollHeight).toBeGreaterThan(clientHeight)
  expect(before.y + before.height).toBeLessThanOrEqual(420)

  await chart(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(chart(page).getByRole('link', { name: 'Ideas' })).toBeInViewport()
  // Nothing else moved: page chrome and the time header stay put.
  expect((await rect(chart(page))).y).toBe(before.y)
  expect((await rect(page.getByRole('button', { name: 'Today', exact: true }))).y).toBe(toolbar.y)
  await expect(chart(page).getByText('Project', { exact: true })).toBeInViewport()
})

test('the milestone diamond opens its dialog and the project name opens its Gantt', async ({
  page,
}) => {
  const seed = seedWorkspace()
  await openTimeline(page, seed)
  const { ids } = seed

  await chart(page)
    .getByRole('button', { name: /^Milestone Report out/ })
    .click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await chart(page).getByRole('link', { name: 'Website' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.Website}/gantt$`))
})

test('a milestone edited from the chart is renamed everywhere on the chart', async ({ page }) => {
  const seed = seedWorkspace()
  await openTimeline(page, seed)
  const { ids } = seed
  await page.getByRole('button', { name: /^Expand Research/ }).click()

  // Its diamond on the project's row (the expanded list has a second one on its own row).
  const diamond = page.locator(
    `[data-row-key="project:${ids.Research}"] [data-milestone-id="${ids['Report out']}"]`,
  )
  await diamond.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder('e.g. Submission deadline').fill('Report ready')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()

  await expect(diamond).toHaveAttribute('aria-label', /^Milestone Report ready, .*, Research$/)
  await expect(chart(page).getByRole('button', { name: 'Milestone: Report ready' })).toBeVisible()
  await expect(chart(page).getByText('Report out', { exact: true })).toHaveCount(0)
})

test('a dependency conflict shows on the listed task, like in the Gantt', async ({ page }) => {
  const seed = seedWorkspace()
  await openTimeline(page, seed)
  const { ids } = seed

  // Collapsed projects list no tasks, so there is nothing to warn about yet.
  await expect(chart(page).getByRole('button', { name: /^Review wireframes, / })).toHaveCount(0)
  await page.getByRole('button', { name: /^Expand Website/ }).click()
  await expect(
    chart(page).getByRole('button', { name: /^Review wireframes, .*dependency conflict/ }),
  ).toBeVisible()
  // The predecessor itself is fine.
  await expect(chart(page).locator(`[data-task-id="${ids.Wireframes}"]`)).not.toHaveAttribute(
    'aria-label',
    /conflict/,
  )
})

test('keyboard: Enter or Space on a bar opens its task, Esc returns to it, Back closes the modal', async ({
  page,
}) => {
  const seed = seedWorkspace()
  await openTimeline(page, seed)
  const { ids } = seed
  await page.getByRole('button', { name: /^Expand Research/ }).click()

  const taskBar = chart(page).locator(`[data-task-id="${ids['Interview users']}"]`)
  const dialog = page.getByRole('dialog')
  await taskBar.focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`\\?task=${ids['Interview users']}$`))
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(taskBar).toBeFocused()

  await page.keyboard.press('Space')
  await expect(dialog).toBeVisible()
  // The browser's Back button closes it again (and Forward brings it back).
  await page.goBack()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\/timeline$/)
  await page.goForward()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // A diamond is a button too, and its name shows while it has keyboard focus.
  const diamond = chart(page).locator(`[data-milestone-id="${ids['Report out']}"]`).first()
  await diamond.focus()
  await expect(chart(page).getByText(/^Report out · /)).toHaveCSS('opacity', '1')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // A deep link keeps the Timeline underneath.
  await page.goto(`/timeline?task=${ids['Interview users']}`)
  await expect(dialog).toBeVisible()
  // The form focuses its title once mounted; an Esc before that can beat the dialog's key handler.
  await expect(dialog.getByRole('textbox', { name: 'Task title' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(chart(page)).toBeVisible()
})

test('scales, Today (button and T), Include completed, and both survive a reload', async ({
  page,
}) => {
  const seed = seedWorkspace()
  await openTimeline(page, seed)
  const { ids } = seed
  /** Where today's column is on screen, as a fraction of the visible time axis (pane = 300px). */
  const todayAt = async () => {
    const area = await rect(chart(page))
    const today = await rect(chart(page).locator('[data-today-column]'))
    return (today.x + today.width / 2 - area.x - PANE_PX) / (area.width - PANE_PX)
  }

  // The Research bar is 41 days long on every scale, and its width follows the scale.
  for (const scale of ['day', 'month', 'week'] as const) {
    await page.getByRole('radio', { name: new RegExp(`^${scale}$`, 'i') }).click()
    await expect(bar(page, ids.Research)).toHaveCSS('width', `${41 * DAY_PX[scale]}px`)
  }

  // Today: scroll away, press the button, come back.
  await chart(page).evaluate((el) => el.scrollBy({ left: 300, behavior: 'instant' }))
  await expect.poll(todayAt).toBeLessThan(0.1)
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await expect.poll(todayAt).toBeCloseTo(1 / 3, 1)

  // T does the same, from anywhere on the page, also after the range grew to the left.
  await chart(page).evaluate((el) => el.scrollBy({ left: -1500, behavior: 'instant' }))
  await expect.poll(todayAt).toBeGreaterThan(0.6)
  await page.locator('body').click({ position: { x: 700, y: 90 } })
  await page.keyboard.press('t')
  await expect.poll(todayAt).toBeCloseTo(1 / 3, 1)

  // Completed on request; archived never. Adding a project that starts earlier grows the range
  // to the left, and the view must not jump: today's column stays where it was.
  await expect(bar(page, ids.Finished)).toHaveCount(0)
  await scrollIdle(page)
  const todayBefore = await rect(chart(page).locator('[data-today-column]'))
  await page.getByRole('switch', { name: /Include completed/ }).click()
  await expect(bar(page, ids.Finished)).toHaveCount(1)
  await settle(page)
  expect((await rect(chart(page).locator('[data-today-column]'))).x).toBeCloseTo(todayBefore.x, 0)
  await expect(
    projectRowOf(page, ids.Finished).getByText('Completed', { exact: true }),
  ).toBeVisible()
  await expect(bar(page, ids.Shelved)).toHaveCount(0)

  // The scale and the switch are per device: both are still there after a reload.
  await page.getByRole('radio', { name: /^month$/i }).click()
  await page.reload()
  await expect(page.getByRole('switch', { name: /Include completed/ })).toBeChecked()
  await expect(page.getByRole('radio', { name: /^month$/i })).toBeChecked()
  await expect(bar(page, ids.Finished)).toHaveCount(1)
  await expect(bar(page, ids.Research)).toHaveCSS('width', `${41 * DAY_PX.month}px`)
})

test.describe('empty states', () => {
  test('without projects: an empty state that opens the New project dialog', async ({ page }) => {
    await seedPage(page, { ids: {}, db: EMPTY_DB })
    await page.goto('/timeline')
    await expect(
      page.getByText('Every project appears here on one shared timeline, with its milestones.'),
    ).toBeVisible()
    await expect(chart(page)).toHaveCount(0)
    // The sidebar has an icon-only button with the same name: the empty state's has text.
    await page
      .getByRole('button', { name: 'New project' })
      .filter({ hasText: 'New project' })
      .click()
    await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible()
  })

  test('with only completed projects: offers Include completed; archived never appear', async ({
    page,
  }) => {
    const w = workspace()
    w.project('Finished', 'a1', { status: 'completed', startDate: at(-40), dueDate: at(-20) })
    w.project('Shelved', 'a2', { status: 'archived', startDate: at(-10), dueDate: at(10) })
    const seed = w.build()
    await seedPage(page, seed)
    await page.goto('/timeline')
    await expect(page.getByText('No active projects')).toBeVisible()
    await expect(chart(page)).toHaveCount(0)

    await page.getByRole('button', { name: 'Include completed' }).click()
    await expect(chart(page)).toBeVisible()
    await expect(bar(page, seed.ids.Finished)).toHaveCount(1)
    await expect(bar(page, seed.ids.Shelved)).toHaveCount(0)
    await expect(page.getByText('No active projects')).toHaveCount(0)
  })

  test('with nothing scheduled: lists the projects as Unscheduled and links to plan the first', async ({
    page,
  }) => {
    const w = workspace()
    w.project('Backlog', 'a1')
    w.project('Ideas 想法', 'a2')
    w.task('Someday', 'Backlog', 'a1')
    const seed = w.build()
    await openTimeline(page, seed)

    expect(await rowKeys(page)).toEqual([
      'section:unscheduled',
      `project:${seed.ids.Backlog}`,
      `project:${seed.ids['Ideas 想法']}`,
    ])
    await expect(page.getByText('Nothing scheduled yet')).toBeVisible()
    // Dates are what moves a project onto the chart: the link goes to its Gantt.
    await page.getByRole('link', { name: 'Plan Backlog' }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${seed.ids.Backlog}/gantt$`))
  })
})

test.describe('names and diamonds', () => {
  test('a project name never runs under its own milestone diamonds while scrolling', async ({
    page,
  }) => {
    const seed = labelWorkspace()
    await openTimeline(page, seed)
    const row = projectRowOf(page, seed.ids['Roadmap 路線圖規劃'])
    const label = row.locator('[data-bar-label]')
    const alpha = row.locator(`[data-milestone-id="${seed.ids.Alpha}"]`)
    const beta = row.locator(`[data-milestone-id="${seed.ids.Beta}"]`)

    // Put the first diamond at several distances from the left edge of the time axis: far ahead
    // of the name, just behind its end, under it, at its start, and already scrolled past it.
    const seen = { visible: 0, hidden: 0 }
    for (const x of [320, 160, 110, 60, 30, 12, -10, -60, -200]) {
      await scrollTargetTo(page, alpha, x)
      const diamonds = [await rect(alpha), await rect(beta)]
      if ((await label.count()) === 0) {
        seen.hidden++
        continue
      }
      seen.visible++
      const name = await rect(label)
      for (const diamond of diamonds) {
        const apart =
          name.x + name.width <= diamond.x + 0.5 || name.x >= diamond.x + diamond.width - 0.5
        expect(apart, `name [${name.x}, ${name.x + name.width}] vs diamond at ${diamond.x}`).toBe(
          true,
        )
      }
    }
    // The walk really covered both situations: a name that fits, and one a diamond covers.
    expect(seen.visible).toBeGreaterThan(2)
    expect(seen.hidden).toBeGreaterThan(0)
    // Once the diamonds are behind it, the whole name is back, unclipped.
    await scrollTargetTo(page, beta, -200)
    await expect(label).toBeVisible()
    await expect(label).toHaveCSS('max-width', 'none')
  })

  test('the name of a one-day project sits clear of its diamond on every scale', async ({
    page,
  }) => {
    const seed = labelWorkspace()
    await openTimeline(page, seed)
    const row = projectRowOf(page, seed.ids.Ops)
    for (const scale of ['month', 'week', 'day'] as const) {
      await page.getByRole('radio', { name: new RegExp(`^${scale}$`, 'i') }).click()
      await expect(page.getByRole('radio', { name: new RegExp(`^${scale}$`, 'i') })).toBeChecked()
      await settle(page)
      const diamond = await rect(row.locator('[data-milestone-id]'))
      const name = await rect(row.locator('[data-bar-label]'))
      // Clear of the diamond with air to spare (the Month scale's 6px bar used to leave 1.5px).
      expect(name.x, `${scale}: the name starts after the diamond`).toBeGreaterThanOrEqual(
        diamond.x + diamond.width + 3,
      )
    }
  })
})

test('light and dark both draw the chart', async ({ page }) => {
  const seed = seedWorkspace()
  await page.emulateMedia({ colorScheme: 'dark' })
  await openTimeline(page, seed)
  const { ids } = seed

  /** Relative luminance 0 (black) … 1 (white) of the chart's own background. */
  const luminance = () =>
    chart(page).evaluate((el) => {
      const match = getComputedStyle(el).backgroundColor.match(/[\d.]+/g) ?? []
      const [r, g, b] = match.slice(0, 3).map(Number)
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    })

  await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/)
  expect(await luminance()).toBeLessThan(0.25)
  await expect(bar(page, ids.Research)).toBeVisible()
  await expect(bar(page, ids.Research)).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).not.toHaveClass(/(^|\s)dark(\s|$)/)
  expect(await luminance()).toBeGreaterThan(0.8)
  await expect(bar(page, ids.Research)).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  // The today pill and line are visible in both.
  await expect(chart(page).locator('[data-today-column]')).toHaveCount(1)
})

test('many projects: rows are virtualised, scrolling reaches Unscheduled at the bottom', async ({
  page,
}) => {
  const seed = bulkWorkspace(60)
  await openTimeline(page, seed, seed.projectIds)

  // 54 scheduled projects × 9 rows each are expanded, yet only the visible rows exist.
  const domRows = await chart(page).locator('[data-row-key]').count()
  expect(domRows).toBeGreaterThan(5)
  expect(domRows).toBeLessThan(60)
  const { scrollHeight, clientHeight } = await chart(page).evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }))
  expect(scrollHeight).toBeGreaterThan(clientHeight * 20)

  await chart(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(chart(page).getByText('Unscheduled', { exact: true })).toBeInViewport()
  await expect(chart(page).getByRole('link', { name: /^Project 59 / })).toBeInViewport()
  // Rows never overlap, wherever they are.
  const overlaps = await chart(page).evaluate((el) => {
    const rows = [...el.querySelectorAll<HTMLElement>('[data-row-key]')]
      .map((row) => ({ top: parseFloat(row.style.top), height: parseFloat(row.style.height) }))
      .sort((a, b) => a.top - b.top)
    return rows.filter((row, i) => i > 0 && row.top < rows[i - 1].top + rows[i - 1].height - 0.5)
      .length
  })
  expect(overlaps).toBe(0)

  // Back at the top, the first project is where it was.
  await chart(page).evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(chart(page).getByRole('link', { name: /^Project 00 / })).toBeInViewport()
})
