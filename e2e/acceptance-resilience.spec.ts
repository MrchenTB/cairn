/// <reference lib="dom" />
/**
 * Acceptance E2E for resilience — PRD §9.1 AC-14 and AC-15, §5.4. Runs in LOCAL data mode against
 * the dev server (playwright.config.ts); the "cloud" is the browser's localStorage, so a failed
 * write is injected with window.__cairnTest.failNextWrites() and a slow server with setLatency().
 *
 * AC-14  Dark and light on every page, the collapsible sidebar, closing the Task Modal (Esc, X,
 *        overlay, the unsaved-changes guard, focus coming back) and the basic keyboard operation.
 * AC-15  A failed write never looks saved: create, update, move, delete, drag, schedule and import
 *        each roll back, say so with a Retry that works exactly once; the sync indicator and the
 *        Settings sync card tell the truth; a JSON backup restores everything in a fresh browser;
 *        the CSV opens correctly in a spreadsheet; another tab's change shows on focus.
 *
 * "Saved" and "Offline" in the sidebar exist only in cloud mode (local mode is always labelled
 * "Local only — not synced"); those two labels are covered by the unit tests of deriveSyncStatus
 * and SyncIndicator. Here the local-mode equivalents are proven in a real browser.
 *
 * Time is pinned (Wed 2026-11-04, Asia/Taipei) where dates matter.
 */
import { readFileSync } from 'node:fs'
import { expect, test as base, type Download, type Locator, type Page } from '@playwright/test'

const LOCAL_WORKSPACE_KEY = 'cairn:local:workspace:v1'
const UI_PREFS_KEY = 'cairn:ui-prefs'
const GANTT_SCALES_KEY = 'cairn:gantt-scales'
const NOW = '2026-11-04T10:00:00+08:00'
const STAMP = '2026-11-03T08:00:00.000Z'
const TIME_ZONE = 'Asia/Taipei'
/** Pixels per day on the Gantt Day scale. */
const DAY_PX = 36

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
  timezoneId: TIME_ZONE,
  locale: 'en-US',
  colorScheme: 'light',
  viewport: { width: 1280, height: 800 },
})

// ---------------------------------------------------------------------------
// Seed: a local "database" written to localStorage before the app boots
// ---------------------------------------------------------------------------

type Status = 'todo' | 'in_progress' | 'done'
type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

interface SeedTask {
  id: string
  title: string
  phaseId?: string
  parentId?: string
  status?: Status
  priority?: Priority
  start?: string
  due?: string
  description?: string
}

interface SeedProject {
  id: string
  name: string
  status?: 'active' | 'completed' | 'archived'
  color?: string
  mode?: 'manual' | 'auto'
  phases?: { id: string; name: string }[]
  /** In project order; subtasks follow their parent in the order given. */
  tasks?: SeedTask[]
  milestones?: { id: string; name: string; date: string; phaseId?: string }[]
}

const key = (index: number) => `a${index}`

function buildDb(projects: SeedProject[], dependencies: [string, string, string][]): unknown {
  const db = {
    version: 1,
    projects: {} as Record<string, unknown>,
    phases: {} as Record<string, unknown>,
    tasks: {} as Record<string, unknown>,
    milestones: {} as Record<string, unknown>,
    dependencies: {} as Record<string, unknown>,
    preferences: { theme: 'system', sidebarCollapsed: false, timezone: TIME_ZONE, weekStartsOn: 1 },
  }
  projects.forEach((project, projectIndex) => {
    db.projects[project.id] = {
      id: project.id,
      name: project.name,
      description: null,
      status: project.status ?? 'active',
      color: project.color ?? 'violet',
      startDate: null,
      dueDate: null,
      scheduleMode: project.mode ?? 'manual',
      sortOrder: key(projectIndex),
      createdAt: STAMP,
      updatedAt: STAMP,
    }
    project.phases?.forEach((phase, index) => {
      db.phases[phase.id] = {
        id: phase.id,
        projectId: project.id,
        name: phase.name,
        sortOrder: key(index),
        createdAt: STAMP,
        updatedAt: STAMP,
      }
    })
    const subOrder: Record<string, number> = {}
    let topOrder = 0
    project.tasks?.forEach((task) => {
      const order = task.parentId
        ? (subOrder[task.parentId] = (subOrder[task.parentId] ?? -1) + 1)
        : topOrder++
      db.tasks[task.id] = {
        id: task.id,
        projectId: project.id,
        phaseId: task.phaseId ?? null,
        parentTaskId: task.parentId ?? null,
        title: task.title,
        description: task.description ?? null,
        status: task.status ?? 'todo',
        priority: task.priority ?? 'none',
        startDate: task.start ?? null,
        dueDate: task.due ?? null,
        sortOrder: key(order),
        completedAt: task.status === 'done' ? STAMP : null,
        createdAt: STAMP,
        updatedAt: STAMP,
      }
    })
    project.milestones?.forEach((milestone) => {
      db.milestones[milestone.id] = {
        id: milestone.id,
        projectId: project.id,
        phaseId: milestone.phaseId ?? null,
        name: milestone.name,
        date: milestone.date,
        createdAt: STAMP,
        updatedAt: STAMP,
      }
    })
  })
  for (const [id, predecessor, successor] of dependencies) {
    const projectId = (db.tasks[predecessor] as { projectId: string }).projectId
    db.dependencies[id] = {
      id,
      projectId,
      predecessorId: predecessor,
      successorId: successor,
      type: 'FS',
      createdAt: STAMP,
    }
  }
  return db
}

const ID = {
  research: 'p-research',
  flat: 'p-flat',
  cjk: 'p-cjk',
  auto: 'p-auto',
  done: 'p-done',
  old: 'p-old',
} as const

/**
 * Six projects: Research (phases, a subtask, milestones, two dependencies), Flat project, a
 * project full of awkward text (CSV), an Auto-scheduled plan, a completed and an archived one.
 * 6 projects, 2 phases, 20 tasks, 3 milestones, 4 dependencies.
 */
function seedWorkspace(): unknown {
  return buildDb(
    [
      {
        id: ID.research,
        name: 'Research',
        color: 'violet',
        phases: [
          { id: 'ph-disc', name: 'Discovery' },
          { id: 'ph-build', name: 'Build' },
        ],
        tasks: [
          { id: 't-inbox', title: 'Inbox idea' },
          {
            id: 't-interview',
            title: 'Interview users',
            phaseId: 'ph-disc',
            status: 'done',
            start: '2026-11-02',
            due: '2026-11-03',
          },
          {
            id: 't-synth',
            title: 'Synthesize findings',
            phaseId: 'ph-disc',
            status: 'in_progress',
            priority: 'high',
            start: '2026-11-05',
            due: '2026-11-09',
          },
          { id: 't-persona', title: 'Write personas', phaseId: 'ph-disc', parentId: 't-synth' },
          {
            id: 't-proto',
            title: 'Prototype flow',
            phaseId: 'ph-build',
            start: '2026-11-10',
            due: '2026-11-12',
          },
          {
            id: 't-survey',
            title: 'Draft survey',
            phaseId: 'ph-build',
            priority: 'medium',
            start: '2026-11-13',
            due: '2026-11-14',
          },
        ],
        milestones: [
          { id: 'm-kick', name: 'Kickoff', date: '2026-11-05', phaseId: 'ph-disc' },
          { id: 'm-launch', name: 'Launch', date: '2026-11-20' },
        ],
      },
      {
        id: ID.flat,
        name: 'Flat project',
        color: 'green',
        tasks: [
          { id: 'f-alpha', title: 'Alpha' },
          { id: 'f-beta', title: 'Beta', status: 'in_progress' },
          { id: 'f-gamma', title: 'Gamma', status: 'done' },
          { id: 'f-delta', title: 'Delta' },
        ],
      },
      {
        id: ID.cjk,
        name: 'Roadmap 規劃, "v2"',
        color: 'teal',
        tasks: [
          { id: 'c-1', title: '問卷設計', status: 'todo' },
          {
            id: 'c-2',
            title: 'Draft "quoted", plan',
            priority: 'high',
            description: 'line one\nline two, with a comma and a "quote"',
          },
          { id: 'c-3', title: '=SUM(1,2) formula' },
          { id: 'c-4', title: '🚀 Ship it ✓', status: 'done' },
        ],
      },
      {
        id: ID.auto,
        name: 'Auto plan',
        color: 'orange',
        mode: 'auto',
        tasks: [
          { id: 'a-alpha', title: 'Alpha step', start: '2026-11-05', due: '2026-11-07' },
          { id: 'a-bravo', title: 'Bravo step', start: '2026-11-08', due: '2026-11-10' },
          { id: 'a-charlie', title: 'Charlie step', start: '2026-11-11', due: '2026-11-12' },
        ],
      },
      {
        id: ID.done,
        name: 'Website redesign',
        color: 'blue',
        status: 'completed',
        tasks: [
          { id: 'w-1', title: 'Wireframes', status: 'done' },
          { id: 'w-2', title: 'Visual design', status: 'done' },
        ],
      },
      {
        id: ID.old,
        name: 'Legacy migration',
        color: 'gray',
        status: 'archived',
        tasks: [{ id: 'o-1', title: 'Inventory services' }],
        milestones: [{ id: 'm-cutover', name: 'Cutover', date: '2026-12-01' }],
      },
    ],
    [
      ['d-1', 't-synth', 't-proto'],
      ['d-2', 't-proto', 't-survey'],
      ['d-3', 'a-alpha', 'a-bravo'],
      ['d-4', 'a-bravo', 'a-charlie'],
    ],
  )
}

const SEEDED = { projects: 6, phases: 2, tasks: 20, milestones: 3, dependencies: 4 }

/**
 * Boots the app at `path`. The workspace is seeded once per tab (a reload keeps what the test
 * changed); `workspace: null` starts empty. Time is pinned unless `pinTime` is false.
 */
async function openApp(
  page: Page,
  path: string,
  options: { workspace?: unknown; pinTime?: boolean } = {},
): Promise<void> {
  const { workspace = seedWorkspace(), pinTime = true } = options
  if (pinTime) await page.clock.setFixedTime(NOW)
  await page.addInitScript(
    ({ storageKey, db, scalesKey, scales }) => {
      if (sessionStorage.getItem('cairn-e2e-acceptance-seeded')) return
      if (db) localStorage.setItem(storageKey, JSON.stringify(db))
      localStorage.setItem(scalesKey, JSON.stringify(scales))
      sessionStorage.setItem('cairn-e2e-acceptance-seeded', '1')
    },
    {
      storageKey: LOCAL_WORKSPACE_KEY,
      db: workspace,
      scalesKey: GANTT_SCALES_KEY,
      scales: { [ID.auto]: 'day', [ID.research]: 'day' },
    },
  )
  await page.goto(path)
  await pageReady(page)
}

// ---------------------------------------------------------------------------
// Test hooks, stored data, claims
// ---------------------------------------------------------------------------

type TestHooks = { failNextWrites(count: number): void; setLatency(ms: number): void }

function failNextWrites(page: Page, count = 1): Promise<void> {
  return page.evaluate((n) => {
    ;(window as Window & { __cairnTest?: TestHooks }).__cairnTest?.failNextWrites(n)
  }, count)
}

function setLatency(page: Page, ms: number): Promise<void> {
  return page.evaluate((n) => {
    ;(window as Window & { __cairnTest?: TestHooks }).__cairnTest?.setLatency(n)
  }, ms)
}

interface StoredDb {
  projects: Record<
    string,
    {
      name: string
      status: string
      color: string
      description: string | null
      sortOrder: string
      scheduleMode: string
    }
  >
  phases: Record<string, { projectId: string; name: string; sortOrder: string }>
  tasks: Record<
    string,
    {
      projectId: string
      phaseId: string | null
      parentTaskId: string | null
      title: string
      description: string | null
      status: string
      priority: string
      startDate: string | null
      dueDate: string | null
      completedAt: string | null
      sortOrder: string
    }
  >
  milestones: Record<
    string,
    { projectId: string; phaseId: string | null; name: string; date: string }
  >
  dependencies: Record<string, { projectId: string; predecessorId: string; successorId: string }>
  preferences: { theme: string; sidebarCollapsed: boolean } | null
}

/** What the local "database" holds right now (the source of truth after a reload). */
function readDb(page: Page): Promise<StoredDb> {
  return page.evaluate(
    (storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? '{}') as StoredDb,
    LOCAL_WORKSPACE_KEY,
  )
}

/** The raw stored text: equal before and after a failed write means nothing was stored. */
function rawDb(page: Page): Promise<string | null> {
  return page.evaluate((storageKey) => localStorage.getItem(storageKey), LOCAL_WORKSPACE_KEY)
}

async function titlesStored(page: Page, title: string): Promise<number> {
  return Object.values((await readDb(page)).tasks).filter((task) => task.title === title).length
}

/**
 * Records, from now on, every distinct toast text and every sidebar sync state the page shows,
 * so a test can prove that a failure was never presented as a success in between.
 */
async function recordClaims(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as Window & { __claims?: { toasts: string[]; sync: string[] } }
    w.__claims = { toasts: [], sync: [] }
    const record = () => {
      const claims = w.__claims
      if (!claims) return
      for (const element of document.querySelectorAll('[data-sonner-toast]')) {
        if (element.hasAttribute('data-earlier-phase')) continue
        const text = (element as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
        if (text && !claims.toasts.includes(text)) claims.toasts.push(text)
      }
      const state = document
        .querySelector('aside[aria-label="Sidebar"] [data-sync]')
        ?.getAttribute('data-sync')
      if (state && claims.sync.at(-1) !== state) claims.sync.push(state)
    }
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    record()
  })
}

/** Starts a new phase of the recording (the next claims are judged on their own). */
function newPhase(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as Window & { __claims?: { toasts: string[]; sync: string[] } }
    const last = w.__claims?.sync.at(-1)
    // A toast of the previous phase still on screen (such as "Saved" after a Retry) is not a new claim.
    for (const element of document.querySelectorAll('[data-sonner-toast]')) {
      element.setAttribute('data-earlier-phase', '')
    }
    w.__claims = { toasts: [], sync: last ? [last] : [] }
  })
}

function claims(page: Page): Promise<{ toasts: string[]; sync: string[] }> {
  return page.evaluate(
    () =>
      (window as Window & { __claims?: { toasts: string[]; sync: string[] } }).__claims ?? {
        toasts: [],
        sync: [],
      },
  )
}

// ---------------------------------------------------------------------------
// Locators and shared checks
// ---------------------------------------------------------------------------

function sidebar(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Sidebar' })
}

/** CSS locator: while a modal is open the sidebar is hidden from the accessibility tree. */
const syncIndicator = (page: Page) => page.locator('aside[aria-label="Sidebar"] [data-sync]')

const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })

const retryButton = (scope: Locator) => scope.getByRole('button', { name: 'Retry', exact: true })
/** The sidebar's own Retry (CSS: a modal dialog hides the sidebar from the accessibility tree). */
const sidebarRetry = (page: Page) => syncIndicator(page).locator('button', { hasText: /^Retry$/ })

/**
 * The state right after a write failed: the sidebar says so and offers Retry, the failure toast
 * has a Retry, nothing was stored, and nothing on screen claimed success on the way.
 */
async function expectFailedHonestly(
  page: Page,
  failure: Locator,
  storedBefore: string | null,
  options: { toastRetry?: boolean } = {},
): Promise<void> {
  const { toastRetry = true } = options
  await expect(failure).toBeVisible()
  if (toastRetry) await expect(retryButton(failure)).toBeVisible()
  await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'failed')
  await expect(syncIndicator(page)).toContainText("Couldn't save")
  await expect(sidebarRetry(page)).toBeVisible()
  expect(await rawDb(page), 'a failed write stores nothing').toBe(storedBefore)
  const seen = await claims(page)
  for (const text of seen.toasts) {
    expect(text, 'every message shown while the write failed is a failure message').toMatch(
      /^Couldn.t /,
    )
  }
  expect(seen.sync, 'the sidebar never showed an idle or saved state in between').not.toContain(
    'saved',
  )
  // From the first "Saving…" on, the only way out of it was the failure (never back to idle).
  const saving = seen.sync.indexOf('saving')
  const failed = seen.sync.indexOf('failed')
  if (saving >= 0) {
    expect(seen.sync.slice(saving, failed + 1).filter((state) => state !== 'saving')).toEqual([
      'failed',
    ])
  }
}

/** After a successful Retry: no failure left anywhere. */
async function expectRecovered(page: Page, failure: Locator): Promise<void> {
  await expect(failure).toHaveCount(0)
  await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'local')
  await expect(sidebarRetry(page)).toHaveCount(0)
}

// ---------------------------------------------------------------------------
// List / Board / Gantt helpers (copied from the feature specs: the same real pointer input)
// ---------------------------------------------------------------------------

const taskRow = (page: Page, title: string) =>
  page
    .locator('[data-task-row]')
    .filter({ has: page.getByRole('button', { name: `Move ${title}`, exact: true }) })

function rowTitles(scope: Locator): Promise<string[]> {
  return scope.locator('[data-task-row]').evaluateAll((rows) =>
    rows.map((row) => {
      const handle = row.querySelector('button[aria-label^="Move "]')
      const title = handle?.getAttribute('aria-label')?.slice('Move '.length) ?? '?'
      return row.getAttribute('data-depth') === '1' ? `↳ ${title}` : title
    }),
  )
}

const liveRegion = (page: Page) => page.locator('[id^="DndLiveRegion"]')

async function dragHandleTo(
  page: Page,
  source: Locator,
  target: { x: number; y: number },
  announced: RegExp,
): Promise<void> {
  await source.hover()
  const handle = source.getByRole('button', { name: /^Move / })
  const box = await handle.boundingBox()
  if (!box) throw new Error('drag handle is not visible')
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 6, start.y + (target.y > start.y ? 6 : -6), { steps: 3 })
  await page.mouse.move(target.x, target.y, { steps: 14 })
  await expect(liveRegion(page)).toHaveText(announced)
  await page.mouse.up()
}

async function pointIn(locator: Locator, fraction: number): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('target is not visible')
  return { x: box.x + 300, y: box.y + box.height * fraction }
}

const boardColumn = (page: Page, name: string) =>
  page.getByRole('region', { name: new RegExp(`^${name} \\d+ tasks?$`) })
const boardCard = (page: Page, title: string) =>
  page.getByRole('button', { name: title, exact: true })

function cardTitles(region: Locator): Promise<string[]> {
  return region
    .locator('[data-card-activator]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label') ?? ''))
}

async function dragCard(
  page: Page,
  source: Locator,
  to: { x: number; y: number },
  preview: () => Promise<void>,
): Promise<void> {
  const box = await source.boundingBox()
  if (!box) throw new Error('drag source is not visible')
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 6, start.y + 6, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await preview()
  await page.mouse.up()
}

const ganttChart = (page: Page) => page.getByRole('region', { name: 'Gantt chart' })
const ganttBar = (page: Page, id: string) =>
  page.locator(`[data-task-id="${id}"][data-link-target]`)

async function moveBar(page: Page, id: string, days: number): Promise<void> {
  const box = await ganttBar(page, id).boundingBox()
  if (!box) throw new Error('bar is not visible')
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + Math.sign(days) * 4, from.y, { steps: 2 })
  await page.mouse.move(from.x + days * DAY_PX, from.y, { steps: 10 })
  await page.mouse.up()
}

function storedDates(
  page: Page,
  id: string,
): Promise<{ start: string | null; due: string | null }> {
  return readDb(page).then((db) => ({
    start: db.tasks[id]?.startDate ?? null,
    due: db.tasks[id]?.dueDate ?? null,
  }))
}

// Task Modal locators
const editModal = (page: Page, title: string) =>
  page.getByRole('dialog', { name: `Edit task: ${title}` })
const newTaskModal = (page: Page) => page.getByRole('dialog', { name: 'New task', exact: true })
const titleBox = (modal: Locator) => modal.getByRole('textbox', { name: 'Task title' })
const saveButton = (modal: Locator) => modal.getByRole('button', { name: 'Save', exact: true })
const discardAlert = (page: Page) => page.getByRole('alertdialog', { name: 'Discard changes?' })

/** The modifier the app's keyboard engine treats as `mod` (⌘ on Apple platforms, else Ctrl). */
function modifierKey(page: Page): Promise<'Meta' | 'Control'> {
  return page.evaluate(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
    const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent
    return /mac|iphone|ipad|ipod/i.test(platform) ? 'Meta' : 'Control'
  })
}

async function downloadText(download: Download): Promise<string> {
  return readFileSync(await download.path(), 'utf8')
}

// ===========================================================================
// AC-15 · a failed write is never shown as saved
// ===========================================================================

test.describe('AC-15: failed writes roll back, say so, and Retry works exactly once', () => {
  test.describe.configure({ timeout: 90_000 })

  test('AC-15: create — an inline task, a Task Modal task and a project', async ({ page }) => {
    await openApp(page, `/projects/${ID.flat}/list`)
    const list = page.locator('[data-list-scroll]')
    await expect.poll(() => rowTitles(list)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
    await recordClaims(page)

    // 1. inline "Add task"
    let before = await rawDb(page)
    await failNextWrites(page)
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'New task' })
    await input.fill('Inline then retried')
    await input.press('Enter')
    let failure = toast(page, "Couldn't create task")
    await expectFailedHonestly(page, failure, before)
    await expect.poll(() => rowTitles(list)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
    await retryButton(failure).click()
    await expect
      .poll(() => rowTitles(list))
      .toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Inline then retried'])
    await expectRecovered(page, failure)
    await expect.poll(() => titlesStored(page, 'Inline then retried')).toBe(1)
    await page.keyboard.press('Escape') // closes the inline composer that stayed open

    // 2. the Task Modal (C)
    await newPhase(page)
    before = await rawDb(page)
    await page.locator('body').press('c')
    const modal = newTaskModal(page)
    await titleBox(modal).fill('Modal then retried')
    await failNextWrites(page)
    await modal.getByRole('button', { name: 'Create task' }).click()
    failure = toast(page, "Couldn't create task")
    await expectFailedHonestly(page, failure, before)
    await expect(toast(page, 'Task created')).toHaveCount(0)
    await expect(titleBox(modal)).toHaveValue('Modal then retried') // nothing typed is lost
    await retryButton(failure).click()
    await expect(modal).toBeHidden()
    await expect(toast(page, 'Task created')).toContainText('Modal then retried')
    await expect.poll(() => titlesStored(page, 'Modal then retried')).toBe(1)
    await expectRecovered(page, failure)

    // 3. a project (its dialog owns the retry: "Try again")
    await newPhase(page)
    await page.goto('/projects')
    before = await rawDb(page)
    await page.locator('main').getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Project then retried')
    await failNextWrites(page)
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await expect(dialog.getByText('Couldn’t create the project')).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('Project then retried')
    expect(await rawDb(page)).toBe(before)
    await expect(page.getByRole('heading', { name: 'Project then retried' })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Try again' }).click()
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/list$/)
    const made = Object.values((await readDb(page)).projects).filter(
      (project) => project.name === 'Project then retried',
    )
    expect(made).toHaveLength(1)
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'local')
  })

  test('AC-15: update — a status in the List and a title saved from the Task Modal', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.flat}/list`)
    await recordClaims(page)

    // a status changed in place
    let before = await rawDb(page)
    const delta = taskRow(page, 'Delta')
    await failNextWrites(page)
    await delta.getByRole('button', { name: /^Status:/ }).click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    let failure = toast(page, "Couldn't update task")
    await expectFailedHonestly(page, failure, before)
    await expect(delta.getByRole('button', { name: 'Status: To Do' })).toBeVisible()
    await retryButton(failure).click()
    await expect(delta.getByRole('button', { name: 'Status: Done' })).toBeVisible()
    await expect.poll(async () => (await readDb(page)).tasks['f-delta'].status).toBe('done')
    await expectRecovered(page, failure)

    // a title saved from the Task Modal: the edit stays in the form, Retry stores it
    await newPhase(page)
    before = await rawDb(page)
    await taskRow(page, 'Alpha').getByRole('button', { name: 'Alpha', exact: true }).click()
    const modal = editModal(page, 'Alpha')
    await titleBox(modal).fill('Alpha, edited')
    await failNextWrites(page)
    await saveButton(modal).click()
    failure = toast(page, "Couldn't update task")
    await expectFailedHonestly(page, failure, before)
    await expect(modal).toBeVisible()
    await expect(titleBox(modal)).toHaveValue('Alpha, edited')
    expect((await readDb(page)).tasks['f-alpha'].title).toBe('Alpha')
    await retryButton(failure).click()
    await expect.poll(async () => (await readDb(page)).tasks['f-alpha'].title).toBe('Alpha, edited')
    await expectRecovered(page, failure)
  })

  test('AC-15: a Retry that fails again says so again, and the next Retry saves it once', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.flat}/list`)
    await recordClaims(page)
    const before = await rawDb(page)
    await failNextWrites(page, 2)
    await taskRow(page, 'Delta')
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    const failure = toast(page, "Couldn't update task")
    await expectFailedHonestly(page, failure, before)

    // The first Retry meets the same outage: still rolled back, still honest, Retry still offered.
    await retryButton(failure).click()
    // The withdrawn first toast may still be animating out beside the new one: look at the live one.
    const again = failure.and(page.locator('[data-removed="false"]'))
    await expect(again).toBeVisible()
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'failed')
    await expect(
      taskRow(page, 'Delta').getByRole('button', { name: 'Status: To Do' }),
    ).toBeVisible()
    expect(await rawDb(page)).toBe(before)
    expect((await claims(page)).toasts.every((text) => /^Couldn.t /.test(text))).toBe(true)

    await retryButton(again).click()
    await expect(taskRow(page, 'Delta').getByRole('button', { name: 'Status: Done' })).toBeVisible()
    await expect.poll(async () => (await readDb(page)).tasks['f-delta'].status).toBe('done')
    await expectRecovered(page, failure)
  })

  test('AC-15: move and drag — a List reorder, a Board drop across columns', async ({ page }) => {
    await openApp(page, `/projects/${ID.flat}/list`)
    const list = page.locator('[data-list-scroll]')
    await expect.poll(() => rowTitles(list)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
    await recordClaims(page)

    // List: Delta to the top
    let before = await rawDb(page)
    await failNextWrites(page)
    await dragHandleTo(
      page,
      taskRow(page, 'Delta'),
      await pointIn(taskRow(page, 'Alpha'), 0.2),
      /^Delta is over Alpha\.$/,
    )
    let failure = toast(page, "Couldn't move task")
    await expectFailedHonestly(page, failure, before)
    await expect.poll(() => rowTitles(list)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
    await retryButton(failure).click()
    await expect.poll(() => rowTitles(list)).toEqual(['Delta', 'Alpha', 'Beta', 'Gamma'])
    await expectRecovered(page, failure)
    await page.reload()
    await expect.poll(() => rowTitles(list)).toEqual(['Delta', 'Alpha', 'Beta', 'Gamma'])

    // Board: Alpha from To Do onto Beta's column
    await newPhase(page)
    await page.goto(`/projects/${ID.flat}/board`)
    await expect(boardColumn(page, 'To Do')).toBeVisible()
    before = await rawDb(page)
    await failNextWrites(page)
    const beta = await boardCard(page, 'Beta').boundingBox()
    if (!beta) throw new Error('Beta is not visible')
    await dragCard(
      page,
      boardCard(page, 'Alpha'),
      { x: beta.x + beta.width / 2, y: beta.y + 6 },
      () => expect.poll(() => cardTitles(boardColumn(page, 'In Progress'))).toContain('Alpha'),
    )
    failure = toast(page, "Couldn't move task")
    await expectFailedHonestly(page, failure, before)
    await expect.poll(() => cardTitles(boardColumn(page, 'To Do'))).toContain('Alpha')
    expect((await readDb(page)).tasks['f-alpha'].status).toBe('todo')
    await retryButton(failure).click()
    await expect.poll(() => cardTitles(boardColumn(page, 'In Progress'))).toContain('Alpha')
    await expect.poll(async () => (await readDb(page)).tasks['f-alpha'].status).toBe('in_progress')
    await expectRecovered(page, failure)
    // The List agrees (one data source).
    await page.goto(`/projects/${ID.flat}/list`)
    await expect(
      taskRow(page, 'Alpha').getByRole('button', { name: 'Status: In Progress' }),
    ).toBeVisible()
  })

  test('AC-15: delete — a task from the Task Modal and a project from the Projects page', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.flat}/list`)
    await recordClaims(page)

    let before = await rawDb(page)
    await taskRow(page, 'Gamma')
      .getByRole('button', { name: /^Gamma/ })
      .click()
    const modal = editModal(page, 'Gamma')
    await modal.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: /Delete task/ }).click()
    await failNextWrites(page)
    await page
      .getByRole('alertdialog', { name: 'Delete task?' })
      .getByRole('button', { name: 'Delete' })
      .click()
    let failure = toast(page, "Couldn't delete task")
    await expectFailedHonestly(page, failure, before)
    await expect(toast(page, 'Task deleted')).toHaveCount(0)
    await expect(taskRow(page, 'Gamma')).toBeVisible() // the row came back
    expect((await readDb(page)).tasks['f-gamma']).toBeDefined()
    await retryButton(failure).click()
    await expect(taskRow(page, 'Gamma')).toHaveCount(0)
    await expect.poll(async () => (await readDb(page)).tasks['f-gamma']).toBeUndefined()
    await expectRecovered(page, failure)

    // a project (names exactly what goes with it)
    await newPhase(page)
    await page.goto('/projects')
    const table = page.getByRole('table', { name: 'Projects' })
    await expect(table).toBeVisible()
    before = await rawDb(page)
    const row = table
      .getByRole('row')
      .filter({ has: page.getByRole('link', { name: 'Flat project', exact: true }) })
    await row.getByRole('button', { name: 'Actions for Flat project' }).click()
    await page.getByRole('menuitem', { name: 'Delete project…' }).click()
    const confirmation = page.getByRole('alertdialog', { name: 'Delete “Flat project”?' })
    await expect(confirmation).toContainText('Deletes 3 tasks')
    await failNextWrites(page)
    await confirmation.getByRole('button', { name: 'Delete project' }).click()
    failure = toast(page, "Couldn't delete project")
    await expectFailedHonestly(page, failure, before)
    await expect(toast(page, 'Project deleted')).toHaveCount(0)
    await expect(table.getByRole('link', { name: 'Flat project', exact: true })).toBeVisible()
    await retryButton(failure).click()
    await expect(table.getByRole('link', { name: 'Flat project', exact: true })).toHaveCount(0)
    await expect.poll(async () => (await readDb(page)).projects[ID.flat]).toBeUndefined()
    expect(
      Object.values((await readDb(page)).tasks).filter((task) => task.projectId === ID.flat),
    ).toHaveLength(0)
    await expectRecovered(page, failure)
  })

  test('AC-15: schedule — a Gantt drag and an Auto-mode apply that moves several tasks', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/gantt`)
    await expect(ganttChart(page)).toBeVisible()
    await recordClaims(page)

    // Manual mode: drag "Draft survey" two days earlier (no dependency conflict: it follows Prototype)
    let before = await rawDb(page)
    await failNextWrites(page)
    await moveBar(page, 't-survey', 1)
    let failure = toast(page, "Couldn't change dates")
    await expectFailedHonestly(page, failure, before)
    expect(await storedDates(page, 't-survey')).toEqual({ start: '2026-11-13', due: '2026-11-14' })
    await expect(ganttBar(page, 't-survey')).toHaveAccessibleName(/Nov 13 – Nov 14/)
    await retryButton(failure).click()
    await expect(ganttBar(page, 't-survey')).toHaveAccessibleName(/Nov 14 – Nov 15/)
    await expect
      .poll(() => storedDates(page, 't-survey'))
      .toEqual({ start: '2026-11-14', due: '2026-11-15' })
    await expectRecovered(page, failure)

    // Auto mode: moving Alpha pushes Bravo and Charlie; the apply is one atomic write
    await newPhase(page)
    await page.goto(`/projects/${ID.auto}/gantt`)
    await expect(ganttBar(page, 'a-alpha')).toBeVisible()
    before = await rawDb(page)
    await moveBar(page, 'a-alpha', 2)
    const preview = page.getByRole('dialog', { name: 'Move dependent tasks?' })
    await expect(preview).toBeVisible()
    await failNextWrites(page)
    await preview.getByRole('button', { name: 'Apply 3 changes' }).click()
    failure = toast(page, /Couldn't (reschedule tasks|change dates)/)
    await expectFailedHonestly(page, failure, before)
    for (const [id, dates] of [
      ['a-alpha', { start: '2026-11-05', due: '2026-11-07' }],
      ['a-bravo', { start: '2026-11-08', due: '2026-11-10' }],
      ['a-charlie', { start: '2026-11-11', due: '2026-11-12' }],
    ] as const) {
      expect(await storedDates(page, id)).toEqual(dates)
    }
    await expect(ganttBar(page, 'a-bravo')).toHaveAccessibleName(/Nov 8 – Nov 10/)
    await retryButton(failure).click()
    await expect
      .poll(async () => [
        await storedDates(page, 'a-alpha'),
        await storedDates(page, 'a-bravo'),
        await storedDates(page, 'a-charlie'),
      ])
      .toEqual([
        { start: '2026-11-07', due: '2026-11-09' },
        { start: '2026-11-10', due: '2026-11-12' },
        { start: '2026-11-13', due: '2026-11-14' },
      ])
    await expectRecovered(page, failure)
  })

  test('AC-15: import — a failed import keeps the file, "Try again" imports the copy exactly once', async ({
    page,
  }) => {
    await openApp(page, '/settings/data')
    await recordClaims(page)
    const [json] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    const text = await downloadText(json)
    await newPhase(page)

    const before = await rawDb(page)
    await page.getByLabel('Backup file').setInputFiles({
      name: 'backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    })
    const dialog = page.getByRole('dialog', { name: 'Import backup' })
    await expect(dialog).toBeVisible()
    await failNextWrites(page)
    await dialog.getByRole('button', { name: 'Import as new copies' }).click()
    await expect(dialog.getByRole('alert')).toContainText("Couldn't import the backup")
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'failed')
    expect(await rawDb(page), 'a failed import stores nothing').toBe(before)
    expect(
      (await claims(page)).toasts.filter(
        (message) => /imported/i.test(message) && !/^Couldn.t/.test(message),
      ),
    ).toEqual([])
    await dialog.getByRole('button', { name: 'Try again' }).click()
    await expect(dialog).toBeHidden()
    await expect(toast(page, 'Backup imported')).toContainText('Added 6 projects')
    const db = await readDb(page)
    expect(Object.keys(db.projects)).toHaveLength(SEEDED.projects * 2)
    expect(Object.keys(db.tasks)).toHaveLength(SEEDED.tasks * 2)
    expect(Object.keys(db.dependencies)).toHaveLength(SEEDED.dependencies * 2)
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'local')
  })

  test('AC-15: preferences — a theme and a collapsed sidebar that fail to save roll back with Retry', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    await recordClaims(page)
    const aside = page.locator('aside[aria-label="Sidebar"]')
    const html = page.locator('html')

    const before = await rawDb(page)
    await failNextWrites(page)
    await page.locator('body').press('[')
    const failure = toast(page, "Couldn't save preferences")
    await expectFailedHonestly(page, failure, before)
    await expect(aside).toHaveAttribute('data-collapsed', 'false') // rolled back
    await retryButton(failure).click()
    await expect(aside).toHaveAttribute('data-collapsed', 'true')
    await expect.poll(async () => (await readDb(page)).preferences?.sidebarCollapsed).toBe(true)
    await expectRecovered(page, failure)

    await newPhase(page)
    await failNextWrites(page)
    await page
      .getByRole('banner')
      .getByRole('button', { name: /^Theme:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Dark' }).click()
    const second = toast(page, "Couldn't save preferences")
    await expect(second).toBeVisible()
    await expect(html).not.toHaveClass(/\bdark\b/)
    await retryButton(second).click()
    await expect(html).toHaveClass(/\bdark\b/)
    await expect.poll(async () => (await readDb(page)).preferences?.theme).toBe('dark')
  })
})

// ===========================================================================
// AC-15 · the sync indicator tells the truth
// ===========================================================================

test.describe('AC-15: sync indicator and offline', () => {
  test.describe.configure({ timeout: 90_000 })

  test('AC-15: the sidebar says Saving… while a slow write runs, then Local only; Settings agrees', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.flat}/list`)
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'local')
    await expect(syncIndicator(page)).toContainText('Local only — not synced')

    await setLatency(page, 1500)
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'New task' })
    await input.fill('Slow save')
    await input.press('Enter')
    // The row shows at once; the honest label says it is still being written.
    await expect(taskRow(page, 'Slow save')).toBeVisible()
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'saving')
    await expect(syncIndicator(page)).toContainText('Saving…')
    expect(await titlesStored(page, 'Slow save'), 'not stored yet').toBe(0)
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'local', { timeout: 10_000 })
    expect(await titlesStored(page, 'Slow save')).toBe(1)
    await setLatency(page, 0)

    // The Settings card: pending changes while saving, "Last saved" only after a real save.
    await page.goto('/settings/data')
    const card = page.getByRole('region', { name: 'Sync status' })
    await expect(card).toContainText('Stored in this browser only')
    await expect(card.getByText('Last saved').locator('..')).toContainText('No changes saved')
    await setLatency(page, 1500)
    await page.locator('body').press('[')
    await expect(card.getByText('Pending changes', { exact: true }).locator('..')).toContainText(
      '1 waiting',
    )
    await expect(card.getByRole('button', { name: 'Sync now' })).toBeDisabled()
    await expect(card.getByText('Last saved').locator('..')).toContainText('No changes saved')
    await expect(card.getByText('Pending changes', { exact: true }).locator('..')).toContainText(
      'None',
      {
        timeout: 10_000,
      },
    )
    await expect(card.getByText('Last saved').locator('..')).not.toContainText('No changes saved')
    await setLatency(page, 0)
  })

  test('AC-15: after a failure the sidebar and the Settings card both show it with Retry, and Retry clears both', async ({
    page,
  }) => {
    await openApp(page, '/settings/data')
    const card = page.getByRole('region', { name: 'Sync status' })
    await failNextWrites(page)
    await page.locator('body').press('[')
    const failure = toast(page, "Couldn't save preferences")
    await expect(failure).toBeVisible()
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'failed')
    await expect(card.getByText("Couldn't save your last change")).toBeVisible()
    await expect(card.getByText('Last error').locator('..')).toContainText('Network error')
    await expect(card.getByText('Last saved').locator('..')).toContainText('No changes saved')

    // The sidebar popover explains and offers Retry as well.
    await syncIndicator(page)
      .getByRole('button', { name: /^Sync status:/ })
      .click()
    const popover = page.getByRole('dialog')
    await expect(popover).toContainText("Couldn't save your last change")
    await expect(popover).toContainText('The change was undone on screen')
    await page.keyboard.press('Escape')

    await card.getByRole('button', { name: 'Retry' }).click()
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'local')
    await expect(card.getByText('Last error').locator('..')).toContainText('None')
    await expect(card.getByText('Last saved').locator('..')).not.toContainText('No changes saved')
    await expect(failure).toHaveCount(0)
  })

  test('AC-15: offline — local mode keeps saving to the browser and never claims cloud sync', async ({
    page,
    context,
  }) => {
    await openApp(page, `/projects/${ID.flat}/list`)
    // Visit Settings once while online (its code is fetched the first time), then come back.
    await sidebar(page).getByRole('link', { name: 'Settings' }).click()
    await expect(page.getByRole('region', { name: 'Sync status' })).toHaveCount(0)
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: 'Data' })
      .click()
    await expect(page.getByRole('region', { name: 'Sync status' })).toBeVisible()
    await sidebar(page).getByRole('link', { name: 'Flat project' }).click()
    await expect(taskRow(page, 'Alpha')).toBeVisible()

    await context.setOffline(true)
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false)

    // Writes still work (they never leave the browser) and are not labelled as synced.
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'New task' })
    await input.fill('Made offline')
    await input.press('Enter')
    await expect(taskRow(page, 'Made offline')).toBeVisible()
    await expect.poll(() => titlesStored(page, 'Made offline')).toBe(1)
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'local')
    await expect(syncIndicator(page)).toContainText('Local only — not synced')

    // Settings reports the connection honestly.
    await input.press('Escape')
    await sidebar(page).getByRole('link', { name: 'Settings' }).click()
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: 'Data' })
      .click()
    const card = page.getByRole('region', { name: 'Sync status' })
    await expect(card.getByText('Connection', { exact: true }).locator('..')).toContainText(
      'Offline',
    )
    await expect(card.getByText('Connection', { exact: true }).locator('..')).toContainText(
      'not needed in local mode',
    )

    await context.setOffline(false)
    await expect(card.getByText('Connection', { exact: true }).locator('..')).toContainText(
      'Online',
    )
    expect(await titlesStored(page, 'Made offline')).toBe(1)
  })

  test('AC-15: offline — a page that was never opened says it needs a connection, and opens after Try again', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await openApp(page, '/overview')
    await context.setOffline(true)
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false)

    // Timeline's code was never fetched: offline it cannot be. That is not "a new version".
    await sidebar(page).getByRole('link', { name: 'Timeline' }).click()
    const alert = page.getByRole('alert').filter({ hasText: "You're offline" })
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('Your saved data is safe')
    await expect(page.getByText(/new version/i)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Reload' })).toHaveCount(0)
    // The app around it still works, and the browser did not reload into its offline page.
    await expect(sidebar(page)).toBeVisible()
    await sidebar(page).getByRole('link', { name: 'Overview' }).click()
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible()
    await sidebar(page).getByRole('link', { name: 'Timeline' }).click()
    await expect(alert).toBeVisible()

    await context.setOffline(false)
    await alert.getByRole('button', { name: 'Try again' }).click()
    await expect(page).toHaveURL(/\/timeline$/)
    await expect(alert).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Timeline', level: 1 })).toBeVisible()
    // The failed fetches while offline are the browser's own, expected console lines.
    consoleErrors.splice(
      0,
      consoleErrors.length,
      ...consoleErrors.filter((line) => !/ERR_INTERNET_DISCONNECTED/.test(line)),
    )
  })
})

// ===========================================================================
// AC-15 · backup, spreadsheet export and freshness across tabs
// ===========================================================================

/** What a workspace means, without ids and timestamps: names instead of ids, in the saved order. */
function describeWorkspace(db: StoredDb) {
  const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const projects = Object.values(db.projects).sort((a, b) => text(a.sortOrder, b.sortOrder))
  const rank = new Map(projects.map((project, index) => [project.name, index]))
  const projectName = (id: string) => db.projects[id].name
  const phaseName = (id: string | null) => (id ? db.phases[id].name : null)
  const taskTitle = (id: string | null) => (id ? db.tasks[id].title : null)
  const inProjectOrder = <T extends { project: string }>(rows: T[], tie: (row: T) => string) =>
    rows.sort(
      (a, b) => (rank.get(a.project) ?? 0) - (rank.get(b.project) ?? 0) || text(tie(a), tie(b)),
    )
  return {
    projects: projects.map(({ name, status, color, description, scheduleMode }) => ({
      name,
      status,
      color,
      description,
      scheduleMode,
    })),
    phases: inProjectOrder(
      Object.values(db.phases).map((phase) => ({
        project: projectName(phase.projectId),
        name: phase.name,
        order: phase.sortOrder,
      })),
      (row) => row.order,
    ).map(({ project, name }) => ({ project, name })),
    // siblings keep their saved order: sorted by project, then parent, then sort key
    tasks: inProjectOrder(
      Object.values(db.tasks).map((task) => ({
        project: projectName(task.projectId),
        parent: taskTitle(task.parentTaskId),
        phase: phaseName(task.phaseId),
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        startDate: task.startDate,
        dueDate: task.dueDate,
        done: task.completedAt !== null,
        order: task.sortOrder,
      })),
      (row) => `${row.parent ?? ''}\u0000${row.order}`,
    ).map(({ order: _order, ...task }) => task),
    milestones: inProjectOrder(
      Object.values(db.milestones).map((milestone) => ({
        project: projectName(milestone.projectId),
        phase: phaseName(milestone.phaseId),
        name: milestone.name,
        date: milestone.date,
      })),
      (row) => `${row.date}\u0000${row.name}`,
    ),
    dependencies: inProjectOrder(
      Object.values(db.dependencies).map((dependency) => ({
        project: projectName(dependency.projectId),
        predecessor: taskTitle(dependency.predecessorId),
        successor: taskTitle(dependency.successorId),
      })),
      (row) => `${row.predecessor}\u0000${row.successor}`,
    ),
  }
}

/** RFC 4180 reader (quotes, doubled quotes, CRLF, line breaks inside quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char !== '"') field += char
      else if (text[index + 1] === '"') {
        field += '"'
        index++
      } else quoted = false
    } else if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\r' && text[index + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      index++
    } else field += char
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

test.describe('AC-15: backup, spreadsheet export and other tabs', () => {
  test.describe.configure({ timeout: 120_000 })

  test('AC-15: a JSON backup exported here restores everything in a fresh browser', async ({
    page,
    browser,
    baseURL,
  }) => {
    await openApp(page, '/settings/data')
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    const text = await downloadText(download)
    const exported = JSON.parse(text) as {
      app: string
      formatVersion: number
      data: Record<string, unknown[]>
    }
    expect(exported).toMatchObject({ app: 'cairn', formatVersion: 1 })
    expect(
      Object.fromEntries(Object.entries(exported.data).map(([name, rows]) => [name, rows.length])),
    ).toEqual(SEEDED)
    const source = await readDb(page)

    // A brand-new browser profile: nothing there yet.
    const fresh = await browser.newContext({
      baseURL,
      timezoneId: TIME_ZONE,
      locale: 'en-US',
      colorScheme: 'light',
      viewport: { width: 1280, height: 800 },
    })
    try {
      const other = await fresh.newPage()
      const problems: string[] = []
      other.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
      other.on('pageerror', (error) => problems.push(error.message))
      await other.clock.setFixedTime(NOW)
      await other.goto('/settings/data')
      await expect(sidebar(other)).toBeVisible()
      await expect(other.getByRole('button', { name: 'Export tasks CSV' })).toBeDisabled() // empty
      expect(Object.keys((await readDb(other)).projects ?? {})).toHaveLength(0)

      await other.getByLabel('Backup file').setInputFiles({
        name: 'cairn-backup.json',
        mimeType: 'application/json',
        buffer: Buffer.from(text),
      })
      const dialog = other.getByRole('dialog', { name: 'Import backup' })
      for (const [label, count] of [
        ['Projects', SEEDED.projects],
        ['Phases', SEEDED.phases],
        ['Tasks', SEEDED.tasks],
        ['Milestones', SEEDED.milestones],
        ['Dependencies', SEEDED.dependencies],
      ] as const) {
        await expect(dialog.getByText(label, { exact: true }).locator('..')).toContainText(
          String(count),
        )
      }
      await dialog.getByRole('button', { name: 'Import as new copies' }).click()
      await expect(dialog).toBeHidden()
      await expect(toast(other, 'Backup imported')).toContainText('4 dependencies')

      // Every row, relationship and order came back (ids and timestamps are new).
      const restored = await readDb(other)
      expect(describeWorkspace(restored)).toEqual(describeWorkspace(source))
      expect(Object.keys(restored.dependencies)).toHaveLength(SEEDED.dependencies)
      const sourceIds = new Set([
        ...Object.keys(source.projects),
        ...Object.keys(source.tasks),
        ...Object.keys(source.dependencies),
      ])
      for (const id of [...Object.keys(restored.projects), ...Object.keys(restored.tasks)]) {
        expect(sourceIds.has(id), 'imported rows get new ids').toBe(false)
      }

      // The restored app shows the same thing as the original, page by page.
      for (const path of ['/projects', '/overview', '/timeline']) {
        await page.goto(path)
        await other.goto(path)
        await expect(page.getByRole('main').locator('[aria-busy="true"]')).toHaveCount(0)
        await expect(other.getByRole('main').locator('[aria-busy="true"]')).toHaveCount(0)
        await expect
          .poll(() => other.getByRole('main').innerText(), { message: path })
          .toBe(await page.getByRole('main').innerText())
      }
      // Dependencies drawn on the restored Research Gantt: both links.
      const researchId = Object.entries(restored.projects).find(
        ([, project]) => project.name === 'Research',
      )?.[0]
      await other.goto(`/projects/${researchId}/gantt`)
      await expect(other.getByRole('region', { name: 'Gantt chart' })).toBeVisible()
      await expect(other.locator('path[data-dep-id]')).toHaveCount(2)
      expect(problems).toEqual([])
    } finally {
      await fresh.close()
    }
  })

  test('AC-15: the tasks CSV opens correctly in a spreadsheet (UTF-8 BOM, CRLF, quoting, no formulas)', async ({
    page,
  }) => {
    await openApp(page, '/settings/data')
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export tasks CSV' }).click(),
    ])
    expect(download.suggestedFilename()).toMatch(/^cairn-tasks-\d{4}-\d{2}-\d{2}\.csv$/)
    const bytes = readFileSync(await download.path())
    expect([...bytes.subarray(0, 3)], 'UTF-8 byte order mark').toEqual([0xef, 0xbb, 0xbf])
    const raw = bytes.toString('utf8').slice(1)
    expect(raw.charCodeAt(0)).not.toBe(0xfeff) // exactly one BOM
    // Records end in CRLF; the only bare line breaks are inside quoted fields.
    const unquoted = raw.replace(/"(?:[^"]|"")*"/g, '""')
    expect(unquoted).not.toMatch(/(?<!\r)\n/)
    expect(raw.endsWith('\r\n')).toBe(true)
    // Quoting follows RFC 4180: commas, quotes and line breaks inside quotes, quotes doubled.
    expect(raw).toContain('"Roadmap 規劃, ""v2"""')
    expect(raw).toContain('"Draft ""quoted"", plan"')

    const rows = parseCsv(raw)
    expect(rows[0]).toEqual([
      'Project',
      'Phase',
      'Parent task',
      'Title',
      'Status',
      'Priority',
      'Start',
      'Due',
      'Completed at',
      'Description',
    ])
    expect(rows).toHaveLength(SEEDED.tasks + 1)
    for (const row of rows) expect(row, 'every row has every column').toHaveLength(10)
    // Text round-trips exactly (CJK, emoji, commas, quotes, line breaks)…
    const body = rows.slice(1)
    const cell = (title: string) => body.find((row) => row[3] === title)
    expect(cell('Draft "quoted", plan')).toEqual([
      'Roadmap 規劃, "v2"',
      '',
      '',
      'Draft "quoted", plan',
      'To Do',
      'High',
      '',
      '',
      '',
      'line one\nline two, with a comma and a "quote"',
    ])
    expect(cell('問卷設計')?.[0]).toBe('Roadmap 規劃, "v2"')
    expect(cell('🚀 Ship it ✓')?.slice(4, 5)).toEqual(['Done'])
    // …a subtask follows its parent and names it; phases and dates are readable.
    const parentIndex = body.findIndex((row) => row[3] === 'Synthesize findings')
    expect(body[parentIndex + 1].slice(0, 4)).toEqual([
      'Research',
      'Discovery',
      'Synthesize findings',
      'Write personas',
    ])
    expect(body[parentIndex].slice(1, 8)).toEqual([
      'Discovery',
      '',
      'Synthesize findings',
      'In Progress',
      'High',
      '2026-11-05',
      '2026-11-09',
    ])
    // A title that looks like a formula is never one in the spreadsheet.
    expect(cell("'=SUM(1,2) formula")).toBeDefined()
    for (const row of body) expect(row[3]).not.toMatch(/^[=+\-@]/)
    // Project order, then the List order within a project.
    expect(body.map((row) => row[0]).filter((name, i, all) => name !== all[i - 1])).toEqual([
      'Research',
      'Flat project',
      'Roadmap 規劃, "v2"',
      'Auto plan',
      'Website redesign',
      'Legacy migration',
    ])
  })

  test('AC-15: a change made in another tab shows when this tab is focused again', async ({
    page,
    context,
  }) => {
    // Tab A edits; tab B (same browser, same storage) only learns about it on focus, at most every 30 s.
    await openApp(page, `/projects/${ID.flat}/list`, { pinTime: false })
    const b = await context.newPage()
    await b.addInitScript(() => {
      const real = Date.now.bind(Date)
      ;(window as Window & { __skew?: number }).__skew = 0
      Date.now = () => real() + ((window as Window & { __skew?: number }).__skew ?? 0)
    })
    await b.goto(`/projects/${ID.flat}/list`)
    await expect(taskRow(b, 'Alpha')).toBeVisible()
    const focusB = async (skewSeconds: number) => {
      await b.evaluate((seconds) => {
        const w = window as Window & { __skew?: number }
        w.__skew = (w.__skew ?? 0) + seconds * 1000
        window.dispatchEvent(new Event('focus'))
      }, skewSeconds)
    }

    // A: add a task, finish Beta, switch to the dark theme.
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'New task' })
    await input.fill('Added in tab A')
    await input.press('Enter')
    await input.press('Escape')
    await taskRow(page, 'Beta')
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await page
      .getByRole('banner')
      .getByRole('button', { name: /^Theme:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'local')
    await expect.poll(async () => (await readDb(page)).preferences?.theme).toBe('dark')

    // B has not heard of it, and a focus right after its own load does not ask the storage again.
    await expect(taskRow(b, 'Added in tab A')).toHaveCount(0)
    await focusB(1)
    await b.waitForTimeout(600)
    await expect(taskRow(b, 'Added in tab A')).toHaveCount(0)

    // 31 s later the focus refreshes silently: the new task, the status and the theme all arrive.
    await focusB(31)
    await expect(taskRow(b, 'Added in tab A')).toBeVisible()
    await expect(taskRow(b, 'Beta').getByRole('button', { name: 'Status: Done' })).toBeVisible()
    await expect(b.locator('html')).toHaveClass(/\bdark\b/)
    await expect(syncIndicator(b)).toHaveAttribute('data-sync', 'local')
    expect(await titlesStored(b, 'Added in tab A')).toBe(1)

    // A write still in flight in B is never replaced by a refresh; both tabs end up with both changes.
    await setLatency(b, 1500)
    await b.getByRole('button', { name: 'Add task', exact: true }).click()
    const inputB = b.getByRole('textbox', { name: 'New task' })
    await inputB.fill('Added in tab B')
    await inputB.press('Enter')
    await inputB.press('Escape')
    await expect(taskRow(b, 'Added in tab B')).toBeVisible()
    await taskRow(page, 'Delta')
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'In Progress' }).click()
    await focusB(31) // B is still saving: nothing is replaced
    await expect(syncIndicator(b)).toHaveAttribute('data-sync', 'saving')
    await expect(taskRow(b, 'Added in tab B')).toBeVisible()
    await expect(syncIndicator(b)).toHaveAttribute('data-sync', 'local', { timeout: 10_000 })
    await setLatency(b, 0)
    await focusB(31)
    await expect(
      taskRow(b, 'Delta').getByRole('button', { name: 'Status: In Progress' }),
    ).toBeVisible()
    await expect(taskRow(b, 'Added in tab B')).toHaveCount(1)
    const stored = await readDb(page)
    expect(Object.values(stored.tasks).filter((t) => t.title === 'Added in tab B')).toHaveLength(1)
    expect(Object.values(stored.tasks).filter((t) => t.title === 'Added in tab A')).toHaveLength(1)
  })
})

// ===========================================================================
// AC-15 · the awkward failures
// ===========================================================================

test.describe('AC-15: awkward failures', () => {
  test.describe.configure({ timeout: 90_000 })

  test('AC-15: a task created and edited before the server answered keeps the edit when only the create failed', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.flat}/list`)
    await recordClaims(page)
    await setLatency(page, 1500)
    await failNextWrites(page)
    const before = await rawDb(page)
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'New task' })
    await input.fill('Ghost task')
    await input.press('Enter')
    await input.press('Escape')
    await taskRow(page, 'Ghost task')
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'In Progress' }).click()
    await expect(
      taskRow(page, 'Ghost task').getByRole('button', { name: 'Status: In Progress' }),
    ).toBeVisible()

    // The create fails; the edit that followed it cannot be stored either. One failure, one Retry.
    const failure = page.locator('[data-sonner-toast]').filter({ hasText: /Couldn.t/ })
    await expect(failure.first()).toBeVisible({ timeout: 15_000 })
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'failed', { timeout: 15_000 })
    await expect(taskRow(page, 'Ghost task')).toHaveCount(0)
    await setLatency(page, 0)
    expect(await rawDb(page)).toBe(before)
    const visible = await page.locator('[data-sonner-toast]').allInnerTexts()
    expect(visible.join(' ')).not.toMatch(/not found/i) // not a confusing "Task not found"
    await expect(retryButton(page.locator('[data-sonner-toast]').last())).toBeVisible()

    await retryButton(page.locator('[data-sonner-toast]').last()).click()
    await expect(
      taskRow(page, 'Ghost task').getByRole('button', { name: 'Status: In Progress' }),
    ).toBeVisible()
    await expect.poll(() => titlesStored(page, 'Ghost task')).toBe(1)
    const [ghost] = Object.values((await readDb(page)).tasks).filter(
      (task) => task.title === 'Ghost task',
    )
    expect(ghost.status).toBe('in_progress') // the edit was not lost
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'local')
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
  })

  test('AC-15: a failed change keeps its toast Retry after an unrelated save, but never overwrites a newer change', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.flat}/list`)
    // Delta → Done fails; an unrelated save (Alpha's priority) succeeds meanwhile.
    await failNextWrites(page)
    await taskRow(page, 'Delta')
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    const failure = toast(page, "Couldn't update task")
    await expect(failure).toBeVisible()
    await taskRow(page, 'Alpha')
      .getByRole('button', { name: /^Priority:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'High' }).click()
    await expect(
      taskRow(page, 'Alpha').getByRole('button', { name: 'Priority: High' }),
    ).toBeVisible()
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'local')
    // The toast still tells the truth about Delta (it was not saved); its Retry sends it once.
    await expect(failure).toBeVisible()
    await retryButton(failure).click()
    await expect(taskRow(page, 'Delta').getByRole('button', { name: 'Status: Done' })).toBeVisible()
    await expect.poll(async () => (await readDb(page)).tasks['f-delta'].status).toBe('done')
    expect((await readDb(page)).tasks['f-alpha'].priority).toBe('high')
    await expect(failure).toHaveCount(0)

    // Beta → Done fails, then the user sets Beta to To Do and that is saved: the old toast is gone
    // (its Retry would overwrite the newer choice).
    await failNextWrites(page)
    await taskRow(page, 'Beta')
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    const second = toast(page, "Couldn't update task")
    await expect(second).toBeVisible()
    await taskRow(page, 'Beta')
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'To Do' }).click()
    await expect(second).toHaveCount(0)
    await expect(sidebarRetry(page)).toHaveCount(0)
    await expect.poll(async () => (await readDb(page)).tasks['f-beta'].status).toBe('todo')
    await page.waitForTimeout(400)
    expect((await readDb(page)).tasks['f-beta'].status).toBe('todo')
  })

  test('AC-15: storage that is full: the change is rolled back, the reason is shown, Retry saves it once the space is back', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.flat}/list`)
    await recordClaims(page)
    const before = await rawDb(page)
    await page.evaluate((storageKey) => {
      const original = Storage.prototype.setItem
      const w = window as Window & { __restoreStorage?: () => void }
      w.__restoreStorage = () => {
        Storage.prototype.setItem = original
      }
      Storage.prototype.setItem = function (name: string, value: string) {
        if (name === storageKey) {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        }
        return original.call(this, name, value)
      }
    }, LOCAL_WORKSPACE_KEY)

    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'New task' })
    await input.fill('Does not fit')
    await input.press('Enter')
    const failure = toast(page, "Couldn't create task")
    await expectFailedHonestly(page, failure, before)
    await expect(failure).toContainText('storage')
    await expect(taskRow(page, 'Does not fit')).toHaveCount(0)
    await page.evaluate(() =>
      (window as Window & { __restoreStorage?: () => void }).__restoreStorage?.(),
    )
    await retryButton(failure).click()
    await expect(taskRow(page, 'Does not fit')).toBeVisible()
    await expect.poll(() => titlesStored(page, 'Does not fit')).toBe(1)
    await expectRecovered(page, failure)
  })

  test('AC-15: a write that was stored although its answer was lost shows up again, once', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.flat}/list`)
    await page.evaluate((storageKey) => {
      const original = Storage.prototype.setItem
      let armed = true
      Storage.prototype.setItem = function (name: string, value: string) {
        original.call(this, name, value)
        if (name === storageKey && armed) {
          armed = false
          throw new DOMException('The answer never came.', 'NetworkError') // stored, then "failed"
        }
      }
    }, LOCAL_WORKSPACE_KEY)

    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'New task' })
    await input.fill('Stored, answer lost')
    await input.press('Enter')
    await input.press('Escape')
    // The failure is withdrawn once the store sees the row is there: no error left, one row, one copy.
    await expect(taskRow(page, 'Stored, answer lost')).toHaveCount(1)
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'local')
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
    await page.waitForTimeout(500)
    await expect(taskRow(page, 'Stored, answer lost')).toHaveCount(1)
    expect(await titlesStored(page, 'Stored, answer lost')).toBe(1)
  })

  test('AC-15: "Sync now" keeps the Settings page mounted and says what happened', async ({
    page,
  }) => {
    await openApp(page, '/settings/data')
    const card = page.getByRole('region', { name: 'Sync status' })
    await card.evaluate((element) => {
      ;(element as HTMLElement & { __mark?: string }).__mark = 'same node'
    })
    await setLatency(page, 900)
    const syncNow = card.getByRole('button', { name: 'Sync now' })
    await syncNow.click()
    await expect(syncNow).toHaveAttribute('aria-busy', 'true')
    // While it runs: the same page, no skeleton in the main area or the sidebar.
    expect(
      await card.evaluate((element) => (element as HTMLElement & { __mark?: string }).__mark),
    ).toBe('same node')
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
    await expect(toast(page, 'Reloaded from this browser')).toBeVisible()
    expect(
      await card.evaluate((element) => (element as HTMLElement & { __mark?: string }).__mark),
    ).toBe('same node')
    await setLatency(page, 0)
  })
})

// ===========================================================================
// AC-14 · dark and light on every page
// ===========================================================================

interface ThemeAudit {
  dark: boolean
  colorScheme: string
  panelLuminance: number
  themeColor: string | null
  /** Visible text below WCAG AA contrast ("text (ratio)"). */
  failures: string[]
}

/**
 * The theme facts of the page and every visible text inside `rootSelector` (default: everything)
 * that is below AA contrast. Skipped: screen-reader-only text, aria-hidden decoration, disabled
 * controls and anything mid-fade.
 */
function auditTheme(page: Page, rootSelector: string | null = null): Promise<ThemeAudit> {
  return page.evaluate((selector) => {
    type Rgba = { r: number; g: number; b: number; a: number }
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('no canvas')
    // The canvas turns any CSS colour syntax (rgb, oklch, color-mix…) into plain RGBA.
    const parse = (css: string): Rgba => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = css
      context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      return { r, g, b, a: a / 255 }
    }
    const over = (top: Rgba, bottom: Rgba): Rgba => {
      const a = top.a + bottom.a * (1 - top.a)
      if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
      const mix = (k: 'r' | 'g' | 'b') => (top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / a
      return { r: mix('r'), g: mix('g'), b: mix('b'), a }
    }
    const luminance = ({ r, g, b }: Rgba) => {
      const channel = (c: number) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    const ratio = (a: Rgba, b: Rgba) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (light + 0.05) / (dark + 0.05)
    }
    const backgroundOf = (element: Element): Rgba => {
      const layers: Rgba[] = []
      for (let node: Element | null = element; node; node = node.parentElement) {
        const layer = parse(getComputedStyle(node).backgroundColor)
        if (layer.a > 0) layers.push(layer)
        if (layer.a >= 1) break
      }
      let color = over(parse(getComputedStyle(document.body).backgroundColor), {
        r: 255,
        g: 255,
        b: 255,
        a: 1,
      })
      for (const layer of layers.reverse()) color = over(layer, color)
      return color
    }
    const failures: string[] = []
    const root = selector ? document.querySelector(selector) : document.body
    if (!root) failures.push(`${selector} is not on the page`)
    else {
      const seen = new Set<Element>()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent?.trim()
        const element = walker.currentNode.parentElement
        if (!text || !element || seen.has(element)) continue
        seen.add(element)
        const box = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue
        if (
          element.closest(
            '.sr-only, [aria-hidden="true"], :disabled, [aria-disabled="true"], [data-disabled], script, style',
          )
        ) {
          continue
        }
        let faded = 1
        for (let node: Element | null = element; node; node = node.parentElement) {
          faded *= Number(getComputedStyle(node).opacity)
        }
        if (faded < 0.95) continue
        const background = backgroundOf(element)
        let foreground = parse(style.color)
        if (foreground.a < 1) foreground = over(foreground, background)
        const large =
          parseFloat(style.fontSize) >= 24 ||
          (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700)
        const value = ratio(foreground, background)
        if (value < (large ? 3 : 4.5)) failures.push(`${text.slice(0, 40)} (${value.toFixed(2)}:1)`)
      }
    }
    const main = document.querySelector('main')
    const panel = main ? backgroundOf(main) : parse(getComputedStyle(document.body).backgroundColor)
    return {
      dark: document.documentElement.classList.contains('dark'),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      panelLuminance: luminance(panel),
      themeColor:
        document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
      failures,
    }
  }, rootSelector)
}

/** Esc, then waits until no dialog or menu is left (the next shortcut must not meet a closing one). */
async function closeOverlay(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('[role="dialog"], [role="alertdialog"], [role="menu"]')).toHaveCount(0)
}

const rowById = (page: Page, id: string) => page.locator(`[data-task-row="${id}"]`)
const rowOpen = (page: Page, id: string) => rowById(page, id).locator('[data-row-open]')

/** Waits until the shell and the page content have finished loading. */
async function pageReady(page: Page): Promise<void> {
  // CSS locators: while a modal is open the rest of the page is hidden from the accessibility tree.
  await expect(page.locator('aside[aria-label="Sidebar"]')).toBeVisible()
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0)
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
}

const PAGES: { path: string; ready: (page: Page) => Promise<void> }[] = [
  {
    path: '/overview',
    ready: (page) => expect(page.getByText('Active projects').first()).toBeVisible(),
  },
  {
    path: '/my-tasks/today',
    ready: (page) => expect(page.getByRole('navigation', { name: 'My Tasks' })).toBeVisible(),
  },
  { path: '/my-tasks/upcoming', ready: (page) => expect(rowById(page, 't-synth')).toBeVisible() },
  {
    path: '/my-tasks/overdue',
    ready: (page) => expect(page.getByRole('navigation', { name: 'My Tasks' })).toBeVisible(),
  },
  { path: '/my-tasks/all', ready: (page) => expect(rowById(page, 't-synth')).toBeVisible() },
  {
    path: '/projects',
    ready: (page) => expect(page.getByRole('table', { name: 'Projects' })).toBeVisible(),
  },
  {
    path: `/projects/${ID.research}/list`,
    ready: (page) => expect(taskRow(page, 'Synthesize findings')).toBeVisible(),
  },
  {
    path: `/projects/${ID.research}/board`,
    ready: (page) => expect(boardColumn(page, 'To Do')).toBeVisible(),
  },
  {
    path: `/projects/${ID.research}/gantt`,
    ready: (page) => expect(ganttBar(page, 't-synth')).toBeVisible(),
  },
  {
    path: '/timeline',
    ready: (page) =>
      expect(page.getByRole('heading', { name: 'Timeline', level: 1 })).toBeVisible(),
  },
  {
    path: '/settings/account',
    ready: (page) =>
      expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible(),
  },
  {
    path: '/settings/appearance',
    ready: (page) => expect(page.getByRole('radiogroup', { name: 'Theme' })).toBeVisible(),
  },
  {
    path: '/settings/data',
    ready: (page) => expect(page.getByRole('region', { name: 'Sync status' })).toBeVisible(),
  },
  {
    path: '/no-such-page',
    ready: (page) => expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible(),
  },
]

for (const theme of ['light', 'dark'] as const) {
  test.describe(`AC-14: the ${theme} theme`, () => {
    test.describe.configure({ timeout: 180_000 })
    test.use({ reducedMotion: 'reduce' })

    test(`AC-14: every page and overlay is readable in the ${theme} theme, whatever the OS says`, async ({
      page,
    }) => {
      // The stored choice wins over the operating system: the OS is set to the opposite.
      const db = seedWorkspace() as { preferences: { theme: string } }
      db.preferences.theme = theme
      await page.emulateMedia({ colorScheme: theme === 'dark' ? 'light' : 'dark' })
      await openApp(page, '/overview', { workspace: db })
      const wantDark = theme === 'dark'

      const expectTheme = async (where: string, selector: string | null = null) => {
        const audit = await auditTheme(page, selector)
        expect(audit.dark, `${where}: .dark on <html>`).toBe(wantDark)
        expect(audit.colorScheme, `${where}: color-scheme`).toBe(theme)
        // The panel is clearly dark (or light), never a leftover of the other theme.
        if (wantDark) expect(audit.panelLuminance, `${where}: panel`).toBeLessThan(0.2)
        else expect(audit.panelLuminance, `${where}: panel`).toBeGreaterThan(0.6)
        expect(audit.failures, `${where}: text below AA contrast`).toEqual([])
      }

      // The audit has teeth: text that is hard to read is reported.
      await page.evaluate(() => {
        const probe = document.createElement('p')
        probe.id = 'audit-probe'
        probe.textContent = 'probe text'
        probe.style.cssText =
          'position:fixed;top:60px;left:300px;z-index:9999;color:#888;background:#8a8a8a'
        document.body.append(probe)
      })
      expect((await auditTheme(page)).failures.some((line) => line.startsWith('probe text'))).toBe(
        true,
      )
      await page.evaluate(() => document.getElementById('audit-probe')?.remove())

      for (const { path, ready } of PAGES) {
        await page.goto(path)
        await pageReady(page)
        await ready(page)
        await expectTheme(path)
      }
      // The browser chrome follows too (theme-color tracks the app background).
      const themeColor = (await auditTheme(page)).themeColor
      expect(themeColor, 'theme-color is set').toMatch(/^#|^rgb/)

      // Overlays and menus over a project page.
      await page.goto(`/projects/${ID.research}/list?task=t-proto`)
      await pageReady(page)
      const modal = editModal(page, 'Prototype flow')
      await expect(modal).toBeVisible()
      await expectTheme('Task Modal', '[role="dialog"]')
      await modal.getByRole('button', { name: 'More actions' }).click()
      await page.getByRole('menuitem', { name: /Delete task/ }).click()
      const confirmation = page.getByRole('alertdialog', { name: 'Delete task?' })
      await expect(confirmation).toBeVisible()
      await expectTheme('confirm dialog', '[role="alertdialog"]')
      await confirmation.getByRole('button', { name: 'Cancel' }).click()
      await modal.getByRole('button', { name: /^Start date:/ }).click()
      await expect(page.getByRole('dialog', { name: 'Start date', exact: true })).toBeVisible()
      await expectTheme(
        'date picker',
        '[role="dialog"][aria-label="Start date"], [role="dialog"]:last-of-type',
      )
      // The picker closes first, then the modal (a tooltip fading out may take an Esc as well).
      for (let step = 0; step < 3 && (await modal.isVisible()); step++) {
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
      }
      await expect(modal).toBeHidden()

      await page.locator('body').press('c')
      await expect(newTaskModal(page)).toBeVisible()
      await expectTheme('New task modal', '[role="dialog"]')
      await closeOverlay(page)

      await page.keyboard.press(`${await modifierKey(page)}+k`)
      await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible()
      await expectTheme('Search', '[role="dialog"]')
      await page.getByRole('dialog', { name: 'Search' }).getByRole('combobox').fill('proto')
      await expect(page.getByRole('option').first()).toBeVisible()
      await expectTheme('Search results', '[role="dialog"]')
      await closeOverlay(page)

      await page.locator('body').press('?')
      await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
      await expectTheme('Shortcuts', '[role="dialog"]')
      await closeOverlay(page)

      await sidebar(page).getByRole('button', { name: 'New project' }).click()
      await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible()
      await expectTheme('New project', '[role="dialog"]')
      await closeOverlay(page)

      await page
        .getByRole('banner')
        .getByRole('button', { name: /^Theme:/ })
        .click()
      await expect(page.getByRole('menu')).toBeVisible()
      await expectTheme('Theme menu', '[role="menu"]')
      await closeOverlay(page)

      await syncIndicator(page)
        .getByRole('button', { name: /^Sync status:/ })
        .click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expectTheme('Sync popover', '[role="dialog"]')
      await closeOverlay(page)

      // An error toast (a failed save) and the sidebar's failed state.
      await failNextWrites(page)
      await page.locator('body').press('[')
      const failure = toast(page, "Couldn't save preferences")
      await expect(failure).toBeVisible()
      await expectTheme('error toast', '[data-sonner-toast]')
      await expectTheme('sidebar with a failed save', 'aside[aria-label="Sidebar"]')
      await retryButton(failure).click()
      await expect(failure).toHaveCount(0)
    })
  })
}

test.describe('AC-14: the theme choice', () => {
  test.describe.configure({ timeout: 90_000 })

  test('AC-14: the theme menu and Settings switch every page at once; System follows the OS live; it survives reloads', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await openApp(page, '/overview')
    const html = page.locator('html')
    const themeButton = page.getByRole('banner').getByRole('button', { name: /^Theme:/ })
    await expect(html).not.toHaveClass(/\bdark\b/)

    // Switch from the top bar; the page, the next page and a reload all agree.
    await themeButton.click()
    await page.getByRole('menuitemradio', { name: 'Dark' }).click()
    await expect(html).toHaveClass(/\bdark\b/)
    await expect.poll(async () => (await readDb(page)).preferences?.theme).toBe('dark')
    await expect
      .poll(async () =>
        page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}').theme, UI_PREFS_KEY),
      )
      .toBe('dark')
    await sidebar(page).getByRole('link', { name: 'Settings' }).click()
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: 'Appearance' })
      .click()
    const group = page.getByRole('radiogroup', { name: 'Theme' })
    await expect(group.getByRole('radio', { name: 'Dark' })).toBeChecked()
    await expect(html).toHaveClass(/\bdark\b/)
    await page.reload()
    await expect(html).toHaveClass(/\bdark\b/)
    await expect(group.getByRole('radio', { name: 'Dark' })).toBeChecked()

    // Settings switches it back; the top bar follows.
    await group.getByRole('radio', { name: 'Light' }).click()
    await expect(html).not.toHaveClass(/\bdark\b/)
    await expect(themeButton).toHaveAccessibleName('Theme: Light')

    // System: follows the operating system while the app is open.
    await group.getByRole('radio', { name: 'System' }).click()
    await expect(themeButton).toHaveAccessibleName('Theme: System')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(html).toHaveClass(/\bdark\b/)
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(html).not.toHaveClass(/\bdark\b/)
    await expect.poll(async () => (await readDb(page)).preferences?.theme).toBe('system')
  })
})

// ===========================================================================
// AC-14 · the collapsible sidebar
// ===========================================================================

test.describe('AC-14: sidebar', () => {
  test.describe.configure({ timeout: 90_000 })
  test.use({ reducedMotion: 'reduce' })

  test('AC-14: the sidebar collapses to an icon rail (button and "["), keeps that across pages, reloads and tabs, and stays usable', async ({
    page,
    context,
  }) => {
    await openApp(page, '/overview')
    const aside = page.locator('aside[aria-label="Sidebar"]')
    await expect(aside).toHaveAttribute('data-collapsed', 'false')
    expect((await aside.boundingBox())?.width ?? 0).toBeGreaterThan(200)

    // By keyboard: the button is replaced by its counterpart and keeps the focus.
    await sidebar(page).getByRole('button', { name: 'Collapse sidebar' }).focus()
    await page.keyboard.press('Enter')
    await expect(aside).toHaveAttribute('data-collapsed', 'true')
    await expect(sidebar(page).getByRole('button', { name: 'Expand sidebar' })).toBeFocused()
    await expect.poll(async () => (await aside.boundingBox())?.width ?? 999).toBeLessThan(80)

    // The rail stays usable: every destination and the sync state keep their names.
    for (const name of ['Overview', 'My Tasks', 'Projects', 'Timeline', 'Settings']) {
      await expect(sidebar(page).getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible()
    }
    await expect(sidebar(page).getByRole('button', { name: /^Sync status:/ })).toBeVisible()
    await sidebar(page)
      .getByRole('link', { name: /^Projects/ })
      .hover()
    await expect(page.getByRole('tooltip').filter({ hasText: 'Projects' })).toBeVisible()

    // The choice follows the user from page to page.
    await sidebar(page)
      .getByRole('link', { name: /^Projects/ })
      .click()
    await expect(page).toHaveURL(/\/projects$/)
    await expect(aside).toHaveAttribute('data-collapsed', 'true')
    await page.locator('body').press('g')
    await page.locator('body').press('t')
    await expect(page).toHaveURL(/\/timeline$/)
    await expect(aside).toHaveAttribute('data-collapsed', 'true')
    await page.goto(`/projects/${ID.research}/board`)
    await expect(aside).toHaveAttribute('data-collapsed', 'true')

    // Saved in the preferences and in the startup cache.
    await expect.poll(async () => (await readDb(page)).preferences?.sidebarCollapsed).toBe(true)
    expect(
      JSON.parse((await page.evaluate((key) => localStorage.getItem(key), UI_PREFS_KEY)) ?? '{}'),
    ).toMatchObject({ sidebarCollapsed: true })

    // A reload and a second tab open collapsed from the very first render (no wide-then-narrow jump).
    await page.reload()
    await expect(aside).toHaveAttribute('data-collapsed', 'true')
    const second = await context.newPage()
    await second.addInitScript(() => {
      const w = window as Window & { __firstSidebar?: string }
      new MutationObserver(() => {
        const element = document.querySelector('aside[aria-label="Sidebar"]')
        if (element && w.__firstSidebar === undefined) {
          w.__firstSidebar = element.getAttribute('data-collapsed') ?? ''
        }
      }).observe(document, { childList: true, subtree: true })
    })
    await second.goto('/projects')
    await expect(second.locator('aside[aria-label="Sidebar"]')).toHaveAttribute(
      'data-collapsed',
      'true',
    )
    expect(
      await second.evaluate(() => (window as Window & { __firstSidebar?: string }).__firstSidebar),
    ).toBe('true')
    await second.close()

    // "[" brings it back (and that is saved too).
    await page.locator('body').press('[')
    await expect(aside).toHaveAttribute('data-collapsed', 'false')
    await expect.poll(async () => (await aside.boundingBox())?.width ?? 0).toBeGreaterThan(200)
    await expect.poll(async () => (await readDb(page)).preferences?.sidebarCollapsed).toBe(false)
    await page.reload()
    await expect(aside).toHaveAttribute('data-collapsed', 'false')
  })
})

// ===========================================================================
// AC-14 · the Task Modal closes properly
// ===========================================================================

test.describe('AC-14: Task Modal', () => {
  test.describe.configure({ timeout: 150_000 })

  const OPENERS: {
    name: string
    path: string
    title: string
    opener: (page: Page) => Locator
    viaKeyboard?: boolean
  }[] = [
    {
      name: 'a List row title',
      path: `/projects/${ID.flat}/list`,
      title: 'Alpha',
      opener: (page) => taskRow(page, 'Alpha').getByRole('button', { name: 'Alpha', exact: true }),
    },
    {
      name: 'a Board card',
      path: `/projects/${ID.flat}/board`,
      title: 'Alpha',
      opener: (page) => boardCard(page, 'Alpha'),
    },
    {
      name: 'a My Tasks row',
      path: '/my-tasks/all',
      title: 'Synthesize findings',
      opener: (page) => rowOpen(page, 't-synth'),
    },
    {
      name: 'an Overview row',
      path: '/overview',
      title: 'Synthesize findings',
      opener: (page) => rowOpen(page, 't-synth'),
    },
    {
      name: 'a Gantt bar (Enter)',
      path: `/projects/${ID.research}/gantt`,
      title: 'Draft survey',
      opener: (page) => ganttBar(page, 't-survey'),
      viaKeyboard: true,
    },
  ]

  test('AC-14: Esc, the X, Cancel and a click outside close the Task Modal and give focus back to what opened it', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    for (const { name, path, title, opener, viaKeyboard } of OPENERS) {
      await page.goto(path)
      await pageReady(page)
      const modal = editModal(page, title)
      const open = async () => {
        if (viaKeyboard) {
          await opener(page).focus()
          await page.keyboard.press('Enter')
        } else {
          await opener(page).click()
        }
        await expect(modal, name).toBeVisible()
        await expect(page, name).toHaveURL(/[?&]task=/)
        await expect(titleBox(modal), `${name}: the title has focus`).toBeFocused()
      }
      const expectClosed = async (how: string) => {
        await expect(modal, `${name}: ${how}`).toBeHidden()
        await expect(page, `${name}: ${how}`).not.toHaveURL(/task=/)
        await expect(opener(page), `${name}: ${how} returns focus to the opener`).toBeFocused()
      }

      await open()
      await page.keyboard.press('Escape')
      await expectClosed('Esc')

      await open()
      await modal.getByRole('button', { name: 'Close' }).click()
      await expectClosed('the X')

      await open()
      await modal.getByRole('button', { name: 'Cancel' }).click()
      await expectClosed('Cancel')

      await open()
      const box = await modal.boundingBox()
      if (!box) throw new Error(`${name}: the modal is not visible`)
      await page.mouse.click(box.x + box.width + 60, box.y + 80) // on the overlay
      await expectClosed('a click outside')

      // Tab stays inside the open modal.
      await open()
      for (let step = 0; step < 14; step++) {
        await page.keyboard.press('Tab')
        expect(
          await modal.evaluate((node) => node.contains(document.activeElement)),
          `${name}: focus stays in the modal`,
        ).toBe(true)
      }
      // From a text field again (a tooltip on screen takes the first Esc, as the ARIA pattern says).
      await titleBox(modal).focus()
      await expect(page.locator('[data-slot="tooltip"]')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expectClosed('Esc after tabbing')
    }
  })

  test('AC-14: unsaved changes: every way out asks first, Keep editing keeps everything, Discard saves nothing, ⌘/Ctrl+Enter saves', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.flat}/list`)
    const opener = taskRow(page, 'Alpha').getByRole('button', { name: 'Alpha', exact: true })
    await opener.click()
    const modal = editModal(page, 'Alpha')
    await expect(titleBox(modal)).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await expect(saveButton(modal)).toBeEnabled()

    // Esc, the X, Cancel and a click outside each ask; "Keep editing" returns to the form as it was.
    await page.keyboard.press('Escape')
    await expect(discardAlert(page)).toBeVisible()
    await discardAlert(page).getByRole('button', { name: 'Keep editing' }).click()
    await expect(titleBox(modal)).toBeFocused()
    await expect(titleBox(modal)).toHaveValue('Alpha!')

    await modal.getByRole('button', { name: 'Close' }).click()
    await expect(discardAlert(page)).toBeVisible()
    await discardAlert(page).getByRole('button', { name: 'Keep editing' }).click()
    await expect(titleBox(modal)).toHaveValue('Alpha!')

    const box = await modal.boundingBox()
    if (!box) throw new Error('the modal is not visible')
    await page.mouse.click(box.x + box.width + 60, box.y + 80)
    await expect(discardAlert(page)).toBeVisible()
    await discardAlert(page).getByRole('button', { name: 'Keep editing' }).click()
    await expect(modal).toBeVisible()

    // Cancel → Discard: closed, nothing saved, focus on the row again.
    await modal.getByRole('button', { name: 'Cancel' }).click()
    await discardAlert(page).getByRole('button', { name: 'Discard' }).click()
    await expect(modal).toBeHidden()
    await expect(opener).toBeFocused()
    expect((await readDb(page)).tasks['f-alpha'].title).toBe('Alpha')
    await expect(page).not.toHaveURL(/task=/)

    // A clean form closes at once; a saved edit closes, is stored and shows in the list.
    await opener.click()
    await expect(titleBox(modal)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
    await expect(discardAlert(page)).toHaveCount(0)
    await opener.click()
    await expect(titleBox(modal)).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.type(' saved')
    await page.keyboard.press(`${await modifierKey(page)}+Enter`)
    await expect(modal).toBeHidden()
    await expect.poll(async () => (await readDb(page)).tasks['f-alpha'].title).toBe('Alpha saved')
    await expect(taskRow(page, 'Alpha saved')).toBeVisible()
    await expect(discardAlert(page)).toHaveCount(0)
  })

  test('AC-14: closing or reloading the tab is guarded only while the Task Modal holds unsaved changes', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await openApp(page, `/projects/${ID.flat}/list?task=f-beta`)
    const modal = editModal(page, 'Beta')
    await expect(titleBox(modal)).toBeFocused()
    // The browser asks "Leave site?" when a beforeunload handler cancels the event.
    const leave = () =>
      page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(event)
        return event.defaultPrevented
      })
    expect(await leave(), 'nothing to lose yet').toBe(false)
    await page.keyboard.press('End')
    await page.keyboard.type('?')
    expect(await leave(), 'unsaved edit').toBe(true)
    await page.keyboard.press('Escape')
    await discardAlert(page).getByRole('button', { name: 'Discard' }).click()
    await expect(modal).toBeHidden()
    await expect.poll(leave, { message: 'after discarding', timeout: 4000 }).toBe(false)
    // A half-typed new task is guarded as well.
    await page.locator('body').press('c')
    await titleBox(newTaskModal(page)).fill('Half typed')
    expect(await leave(), 'unsent new task').toBe(true)
  })

  test('AC-14: the browser Back and Forward buttons open and close the Task Modal', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.flat}/list`)
    await taskRow(page, 'Beta').getByRole('button', { name: 'Beta', exact: true }).click()
    const modal = editModal(page, 'Beta')
    await expect(modal).toBeVisible()
    await page.goBack()
    await expect(modal).toBeHidden()
    await expect(page).not.toHaveURL(/task=/)
    await page.goForward()
    await expect(modal).toBeVisible()
    await expect(page).toHaveURL(/task=f-beta/)
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
  })
})

// ===========================================================================
// AC-14 · basic keyboard operation
// ===========================================================================

test.describe('AC-14: keyboard', () => {
  test.describe.configure({ timeout: 120_000 })

  test('AC-14: the app can be driven from the keyboard: shortcuts, overlays, Esc, a task from name to list, and nothing fires while typing', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    const mod = await modifierKey(page)
    const aside = page.locator('aside[aria-label="Sidebar"]')
    const body = page.locator('body')

    // G then a letter goes to a page.
    for (const [keys, url] of [
      ['gm', /\/my-tasks\/today$/],
      ['gp', /\/projects$/],
      ['gt', /\/timeline$/],
      ['go', /\/overview$/],
    ] as const) {
      await body.press(keys[0])
      await body.press(keys[1])
      await expect(page, keys).toHaveURL(url)
    }

    // Open a project with Tab and Enter only, then switch views with 1, 2, 3.
    await body.press('g')
    await body.press('p')
    await expect(page).toHaveURL(/\/projects$/)
    let reached = false
    for (let step = 0; step < 60 && !reached; step++) {
      await page.keyboard.press('Tab')
      reached = await page.evaluate(() => {
        const active = document.activeElement
        return active instanceof HTMLAnchorElement && active.textContent?.trim() === 'Research'
      })
    }
    expect(reached, 'Tab reaches the Research link').toBe(true)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/projects/${ID.research}/list$`))
    // The route changes before the (lazy) project page has mounted its 1/2/3 handlers: wait for it.
    await expect(taskRow(page, 'Synthesize findings')).toBeVisible()
    await body.press('2')
    await expect(page).toHaveURL(/\/board$/)
    await body.press('3')
    await expect(page).toHaveURL(/\/gantt$/)
    await expect(ganttBar(page, 't-synth')).toBeVisible()
    await body.press('t') // Gantt: scroll to today
    await body.press('1')
    await expect(page).toHaveURL(/\/list$/)

    // C opens New task for this project; typing shortcut letters in the title is just typing.
    await body.press('c')
    const modal = newTaskModal(page)
    await expect(modal).toBeVisible()
    await expect(titleBox(modal)).toBeFocused()
    await expect(modal.getByRole('button', { name: 'Project: Research' })).toBeVisible()
    await page.keyboard.type('g o [ ? c k')
    await expect(titleBox(modal)).toHaveValue('g o [ ? c k')
    await expect(page).toHaveURL(/\/list$/)
    await expect(aside).toHaveAttribute('data-collapsed', 'false')
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0)
    // Tab stays inside the modal.
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press('Tab')
      expect(await modal.evaluate((node) => node.contains(document.activeElement))).toBe(true)
    }
    await titleBox(modal).fill('Made by keyboard')
    await titleBox(modal).press('Enter')
    await expect(modal).toBeHidden()
    await expect(toast(page, 'Task created')).toContainText('Made by keyboard')
    await expect(taskRow(page, 'Made by keyboard')).toBeVisible()
    await expect.poll(() => titlesStored(page, 'Made by keyboard')).toBe(1)

    // ? lists the shortcuts; Esc closes and gives focus back.
    await page.getByRole('button', { name: 'Project actions' }).focus()
    await page.keyboard.press('?')
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(help).toBeVisible()
    for (const text of [
      'Search',
      'New task',
      'Toggle sidebar',
      'Go to Overview',
      'Go to Timeline',
    ]) {
      await expect(help.getByText(text, { exact: true }).first()).toBeVisible()
    }
    await page.keyboard.press('Escape')
    await expect(help).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Project actions' })).toBeFocused()

    // [ collapses and expands the sidebar.
    await body.press('[')
    await expect(aside).toHaveAttribute('data-collapsed', 'true')
    await body.press('[')
    await expect(aside).toHaveAttribute('data-collapsed', 'false')

    // ⌘/Ctrl+K searches from anywhere: type, arrow, Enter opens the task; Esc closes it.
    await page.keyboard.press(`${mod}+k`)
    const search = page.getByRole('dialog', { name: 'Search' })
    await expect(search.getByRole('combobox')).toBeFocused()
    await page.keyboard.type('prototype')
    await expect(search.getByRole('option').first()).toContainText('Prototype flow')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await expect(editModal(page, 'Prototype flow')).toBeVisible()
    await expect(page).toHaveURL(/task=t-proto/)
    await page.keyboard.press('Escape')
    await expect(editModal(page, 'Prototype flow')).toBeHidden()
    await page.keyboard.press(`${mod}+k`)
    await expect(search).toBeVisible()
    await page.keyboard.press(`${mod}+k`) // toggles
    await expect(search).toHaveCount(0)
    await page.keyboard.press(`${mod}+k`)
    await page.keyboard.press('Escape')
    await expect(search).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})

// ===========================================================================
// AC-15 · every other kind of change fails just as honestly
// ===========================================================================

const group = (page: Page, name: string) =>
  page.getByRole('region', { name: new RegExp(`^${name}, \\d+ tasks?$`) })

test.describe('AC-15: phases, milestones, dependencies and subtasks', () => {
  test.describe.configure({ timeout: 120_000 })

  test('AC-15: phases — add, rename, move and delete that fail roll back; Retry saves each once', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list`)
    await recordClaims(page)
    const phaseNames = async () =>
      Object.values((await readDb(page)).phases)
        .filter((phase) => phase.projectId === ID.research)
        .sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1))
        .map((phase) => phase.name)
    const groupOrder = () =>
      page
        .locator('[data-list-scroll] section[aria-label]')
        .evaluateAll((sections) =>
          sections.map((section) =>
            section.getAttribute('aria-label')?.replace(/, \d+ tasks?$/, ''),
          ),
        )
    const phaseMenu = async (name: string, item: string) => {
      await page.getByRole('button', { name: `Actions for phase ${name}` }).click()
      await page.getByRole('menuitem', { name: item }).click()
    }

    // add
    let before = await rawDb(page)
    await failNextWrites(page)
    await page.getByRole('button', { name: 'Add phase', exact: true }).click()
    const phaseInput = page.getByRole('textbox', { name: 'New phase name' })
    await phaseInput.fill('Fresh phase')
    await phaseInput.press('Enter')
    await phaseInput.press('Escape')
    let failure = toast(page, "Couldn't create phase")
    await expectFailedHonestly(page, failure, before)
    await expect(group(page, 'Fresh phase')).toHaveCount(0)
    await retryButton(failure).click()
    await expect(group(page, 'Fresh phase')).toBeVisible()
    expect(await phaseNames()).toEqual(['Discovery', 'Build', 'Fresh phase'])
    await expectRecovered(page, failure)

    // rename
    await newPhase(page)
    before = await rawDb(page)
    await failNextWrites(page)
    await phaseMenu('Build', 'Rename phase')
    const rename = page.getByRole('textbox', { name: 'Phase name' })
    await rename.fill('Built')
    await rename.press('Enter')
    failure = toast(page, "Couldn't update phase")
    await expectFailedHonestly(page, failure, before)
    await expect(group(page, 'Build')).toBeVisible()
    await expect(group(page, 'Built')).toHaveCount(0)
    await retryButton(failure).click()
    await expect(group(page, 'Built')).toBeVisible()
    expect(await phaseNames()).toEqual(['Discovery', 'Built', 'Fresh phase'])
    await expectRecovered(page, failure)

    // move
    await newPhase(page)
    before = await rawDb(page)
    await failNextWrites(page)
    await phaseMenu('Discovery', 'Move phase down')
    failure = toast(page, "Couldn't move phase")
    await expectFailedHonestly(page, failure, before)
    expect(await groupOrder()).toEqual(['No phase', 'Discovery', 'Built', 'Fresh phase'])
    await retryButton(failure).click()
    await expect.poll(groupOrder).toEqual(['No phase', 'Built', 'Discovery', 'Fresh phase'])
    expect(await phaseNames()).toEqual(['Built', 'Discovery', 'Fresh phase'])
    await expectRecovered(page, failure)

    // delete: the phase and its tasks come back together; Retry ungroups them
    await newPhase(page)
    before = await rawDb(page)
    await phaseMenu('Built', 'Delete phase…')
    await failNextWrites(page)
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete phase' }).click()
    failure = toast(page, "Couldn't delete phase")
    await expectFailedHonestly(page, failure, before)
    await expect(
      group(page, 'Built').getByRole('button', { name: 'Prototype flow', exact: true }),
    ).toBeVisible()
    await retryButton(failure).click()
    await expect(group(page, 'Built')).toHaveCount(0)
    expect(await phaseNames()).toEqual(['Discovery', 'Fresh phase'])
    const db = await readDb(page)
    expect(db.tasks['t-proto'].phaseId, 'its tasks became ungrouped').toBeNull()
    expect(db.tasks['t-survey'].phaseId).toBeNull()
    await expectRecovered(page, failure)
  })

  test('AC-15: milestones — an edit and a delete that fail roll back; Retry saves each once', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list`)
    await recordClaims(page)
    const stored = async () => (await readDb(page)).milestones
    const openMilestone = (name: string) =>
      page.getByRole('button', { name: new RegExp(`^Milestone ${name}`) }).click()

    // edit: the dialog keeps what was typed while the toast offers Retry
    let before = await rawDb(page)
    await openMilestone('Kickoff')
    const dialog = page.getByRole('dialog', { name: 'Edit milestone' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Kickoff renamed')
    await failNextWrites(page)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    let failure = toast(page, "Couldn't update milestone")
    await expectFailedHonestly(page, failure, before)
    expect((await stored())['m-kick'].name).toBe('Kickoff')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('Kickoff renamed')
    await retryButton(failure).click()
    await expect.poll(async () => (await stored())['m-kick'].name).toBe('Kickoff renamed')
    await expectRecovered(page, failure)
    // The form now matches the stored milestone: nothing left to save, nothing to discard.
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('alertdialog', { name: 'Discard changes?' })).toHaveCount(0)
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: /^Milestone Kickoff renamed/ })).toBeVisible()

    // delete
    await newPhase(page)
    before = await rawDb(page)
    await openMilestone('Launch')
    await page
      .getByRole('dialog', { name: 'Edit milestone' })
      .getByRole('button', { name: 'Delete' })
      .click()
    await failNextWrites(page)
    await page
      .getByRole('alertdialog', { name: 'Delete milestone?' })
      .getByRole('button', { name: 'Delete' })
      .click()
    failure = toast(page, "Couldn't delete milestone")
    await expectFailedHonestly(page, failure, before)
    await expect(toast(page, 'Milestone deleted')).toHaveCount(0)
    expect((await stored())['m-launch']).toBeDefined()
    await expect(page.getByRole('button', { name: /^Milestone Launch/ })).toBeVisible()
    await retryButton(failure).click()
    await expect(page.getByRole('button', { name: /^Milestone Launch/ })).toHaveCount(0)
    await expect.poll(async () => (await stored())['m-launch']).toBeUndefined()
    await expectRecovered(page, failure)
  })

  test('AC-15: dependencies — a link added or removed in the Task Modal that fails rolls back; Retry saves it once', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=t-proto`)
    await recordClaims(page)
    const modal = editModal(page, 'Prototype flow')
    await expect(modal).toBeVisible()
    const blocking = modal.getByRole('list', { name: 'Blocking' })
    const links = async () =>
      Object.values((await readDb(page)).dependencies)
        .filter((dependency) => dependency.projectId === ID.research)
        .map((dependency) => `${dependency.predecessorId}>${dependency.successorId}`)
        .sort()

    // add: Prototype flow now blocks "Inbox idea"
    let before = await rawDb(page)
    await blocking.getByRole('button', { name: 'Add a task this one blocks' }).click()
    const picker = page.getByRole('dialog', { name: 'Add a task this one blocks' })
    await failNextWrites(page)
    await picker.getByRole('option', { name: 'Inbox idea' }).click()
    let failure = toast(page, "Couldn't add dependency")
    await expectFailedHonestly(page, failure, before)
    await expect(blocking.getByRole('button', { name: 'Inbox idea', exact: true })).toHaveCount(0)
    expect(await links()).toEqual(['t-proto>t-survey', 't-synth>t-proto'])
    await retryButton(failure).click()
    await expect(blocking.getByRole('button', { name: 'Inbox idea', exact: true })).toBeVisible()
    await expect.poll(links).toEqual(['t-proto>t-inbox', 't-proto>t-survey', 't-synth>t-proto'])
    await expectRecovered(page, failure)

    // remove: "Draft survey" from Blocking
    await newPhase(page)
    before = await rawDb(page)
    await failNextWrites(page)
    await blocking.getByRole('button', { name: 'Remove “Draft survey” from Blocking' }).click()
    failure = toast(page, "Couldn't remove dependency")
    await expectFailedHonestly(page, failure, before)
    await expect(blocking.getByRole('button', { name: 'Draft survey', exact: true })).toBeVisible()
    expect(await links()).toEqual(['t-proto>t-inbox', 't-proto>t-survey', 't-synth>t-proto'])
    await retryButton(failure).click()
    await expect(blocking.getByRole('button', { name: 'Draft survey', exact: true })).toHaveCount(0)
    await expect.poll(links).toEqual(['t-proto>t-inbox', 't-synth>t-proto'])
    await expectRecovered(page, failure)
  })

  test('AC-15: deleting a parent with subtasks and links — a failure restores all of it; Retry applies the choice once', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=t-synth`)
    await recordClaims(page)
    const modal = editModal(page, 'Synthesize findings')
    await expect(modal).toBeVisible()
    const choose = async (button: string) => {
      await modal.getByRole('button', { name: 'More actions' }).click()
      await page.getByRole('menuitem', { name: /Delete task/ }).click()
      await failNextWrites(page)
      await page
        .getByRole('alertdialog', { name: /Delete “Synthesize findings”\?/ })
        .getByRole('button', { name: button })
        .click()
    }
    const researchLinks = async () =>
      Object.values((await readDb(page)).dependencies)
        .filter((dependency) => dependency.projectId === ID.research)
        .map((dependency) => `${dependency.predecessorId}>${dependency.successorId}`)
        .sort()

    // keep the subtasks: the parent, the subtask under it and the link to Prototype flow all come back
    let before = await rawDb(page)
    await choose('Keep subtasks (move to top level)')
    let failure = toast(page, "Couldn't delete task")
    await expectFailedHonestly(page, failure, before)
    await expect(toast(page, 'Task deleted')).toHaveCount(0)
    let db = await readDb(page)
    expect(db.tasks['t-synth']).toBeDefined()
    expect(db.tasks['t-persona'].parentTaskId).toBe('t-synth')
    expect(await researchLinks()).toEqual(['t-proto>t-survey', 't-synth>t-proto'])
    await expect(taskRow(page, 'Synthesize findings')).toContainText('0/1') // its subtask is back
    await retryButton(failure).click()
    await expect.poll(async () => (await readDb(page)).tasks['t-synth']).toBeUndefined()
    db = await readDb(page)
    expect(db.tasks['t-persona'].parentTaskId, 'the subtask moved to the top level').toBeNull()
    expect(await researchLinks()).toEqual(['t-proto>t-survey'])
    await expectRecovered(page, failure)
  })
})

// ===========================================================================
// AC-15 · several failures, other tabs, stored data that cannot be read
// ===========================================================================

test.describe('AC-15: several failures, other tabs and unreadable data', () => {
  test.describe.configure({ timeout: 120_000 })

  test('AC-15: writes that fail one after another: one Retry (the toast’s or the sidebar’s) saves all of them, in order, each once', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.flat}/list`)
    await recordClaims(page)
    const status = async (id: string) => (await readDb(page)).tasks[id].status
    const failTwo = async (first: [string, string], second: [string, string]) => {
      await failNextWrites(page, 2)
      for (const [title, to] of [first, second]) {
        const was = await taskRow(page, title)
          .getByRole('button', { name: /^Status:/ })
          .getAttribute('aria-label')
        await taskRow(page, title)
          .getByRole('button', { name: /^Status:/ })
          .click()
        await page.getByRole('menuitemradio', { name: to }).click()
        // rolled back on screen
        await expect(taskRow(page, title).getByRole('button', { name: was ?? '' })).toBeVisible()
      }
    }

    // Round 1: the toast shows the newest failure, the sidebar knows there is more to retry.
    let before = await rawDb(page)
    await failTwo(['Alpha', 'In Progress'], ['Delta', 'Done'])
    let failure = page
      .locator('[data-sonner-toast][data-removed="false"]')
      .filter({ hasText: "Couldn't update task" })
    await expect(failure).toHaveCount(1) // the older toast is already leaving
    await expectFailedHonestly(page, failure, before)
    await retryButton(failure).click()
    await expect
      .poll(async () => [await status('f-alpha'), await status('f-delta')])
      .toEqual(['in_progress', 'done'])
    await expect(
      taskRow(page, 'Alpha').getByRole('button', { name: 'Status: In Progress' }),
    ).toBeVisible()
    await expect(taskRow(page, 'Delta').getByRole('button', { name: 'Status: Done' })).toBeVisible()
    await expectRecovered(page, failure)

    // Round 2: the same through the sidebar's own Retry.
    await newPhase(page)
    before = await rawDb(page)
    await failTwo(['Beta', 'Done'], ['Gamma', 'In Progress'])
    failure = page
      .locator('[data-sonner-toast][data-removed="false"]')
      .filter({ hasText: "Couldn't update task" })
    await expect(failure).toHaveCount(1)
    await expectFailedHonestly(page, failure, before)
    await sidebarRetry(page).click()
    await expect
      .poll(async () => [await status('f-beta'), await status('f-gamma')])
      .toEqual(['done', 'in_progress'])
    await expectRecovered(page, failure)
    // Nothing was sent twice: a later refresh shows exactly one task per title.
    for (const title of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
      expect(await titlesStored(page, title)).toBe(1)
    }
  })

  test('AC-15: a second tab that is out of date never loses the other tab’s changes, and says so when it edits something deleted', async ({
    page,
    context,
  }) => {
    await openApp(page, `/projects/${ID.flat}/list`, { pinTime: false })
    const b = await context.newPage()
    await b.goto(`/projects/${ID.flat}/list`)
    await expect(taskRow(b, 'Alpha')).toBeVisible()

    // Tab A adds a task and deletes Alpha; tab B has not heard of either.
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'New task' })
    await input.fill('From A')
    await input.press('Enter')
    await input.press('Escape')
    await expect.poll(() => titlesStored(page, 'From A')).toBe(1)
    await taskRow(page, 'Alpha')
      .getByRole('button', { name: /^Alpha/ })
      .click()
    await editModal(page, 'Alpha').getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: /Delete task/ }).click()
    await page
      .getByRole('alertdialog', { name: 'Delete task?' })
      .getByRole('button', { name: 'Delete' })
      .click()
    await expect.poll(async () => (await readDb(page)).tasks['f-alpha']).toBeUndefined()

    // B adds a task from its old picture: A's task is still there afterwards.
    await b.getByRole('button', { name: 'Add task', exact: true }).click()
    const inputB = b.getByRole('textbox', { name: 'New task' })
    await inputB.fill('From B')
    await inputB.press('Enter')
    await inputB.press('Escape')
    await expect.poll(() => titlesStored(b, 'From B')).toBe(1)
    expect(await titlesStored(b, 'From A'), "B's create keeps A's task").toBe(1)
    expect((await readDb(b)).tasks['f-alpha'], 'Alpha stays deleted').toBeUndefined()

    // B edits the task A deleted: a clear message, no Retry that could never work, no resurrection.
    await taskRow(b, 'Alpha')
      .getByRole('button', { name: /^Status:/ })
      .click()
    await b.getByRole('menuitemradio', { name: 'Done' }).click()
    const failure = toast(b, "Couldn't update task")
    await expect(failure).toContainText('Task not found')
    await expect(retryButton(failure)).toHaveCount(0)
    await expect(taskRow(b, 'Alpha')).toHaveCount(0)
    expect((await readDb(b)).tasks['f-alpha'], 'Alpha is not resurrected').toBeUndefined()
    expect(await titlesStored(b, 'From B')).toBe(1)
  })

  /** Plants `raw` as the stored workspace before the app starts (once per tab). */
  async function plantStoredText(page: Page, raw: string): Promise<void> {
    await page.addInitScript(
      ({ storageKey, text }) => {
        if (sessionStorage.getItem('cairn-e2e-planted')) return
        localStorage.setItem(storageKey, text)
        sessionStorage.setItem('cairn-e2e-planted', '1')
      },
      { storageKey: LOCAL_WORKSPACE_KEY, text: raw },
    )
  }
  const keptCopies = (page: Page) =>
    page.evaluate(
      (storageKey) =>
        Object.keys(localStorage)
          .filter((name) => name.startsWith(`${storageKey}:unreadable:`))
          .map((name) => localStorage.getItem(name)),
      LOCAL_WORKSPACE_KEY,
    )

  test('AC-15: stored data that cannot be read is kept aside, announced and downloadable, and a fresh workspace works', async ({
    page,
  }) => {
    const truncated = '{"version":1,"projects":{"p-1":{"id":"p-1","name":"Precious'
    await plantStoredText(page, truncated)
    await openApp(page, '/projects', { workspace: null })
    const notice = toast(page, "Your saved data couldn't be read")
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('A copy was kept')
    expect(await keptCopies(page)).toEqual([truncated])
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      notice.getByRole('button', { name: 'Download copy' }).click(),
    ])
    expect(await downloadText(download)).toBe(truncated)

    // The app works on a new workspace and never touches the kept copy.
    await page.getByRole('button', { name: 'Create your first project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('After the crash')
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await expect(page.getByRole('heading', { name: 'After the crash' })).toBeVisible()
    expect(await keptCopies(page)).toEqual([truncated])
    await page.reload()
    await pageReady(page)
    await expect(page.getByRole('heading', { name: 'After the crash' })).toBeVisible()
    await expect(toast(page, "Your saved data couldn't be read")).toHaveCount(0)
    expect(await keptCopies(page)).toEqual([truncated])
  })

  test('AC-15: a workspace from a newer version, or with one malformed row, is set aside whole, never half-read', async ({
    browser,
    baseURL,
  }) => {
    const variants: [string, string][] = [
      ['newer version', JSON.stringify({ version: 2, projects: { a: { id: 'a' } } })],
      [
        'a task with a status that does not exist',
        JSON.stringify(
          (() => {
            const db = seedWorkspace() as { tasks: Record<string, { status: string }> }
            db.tasks['t-proto'].status = 'banana'
            return db
          })(),
        ),
      ],
    ]
    for (const [name, raw] of variants) {
      const context = await browser.newContext({
        baseURL,
        timezoneId: TIME_ZONE,
        locale: 'en-US',
        viewport: { width: 1280, height: 800 },
      })
      try {
        const page = await context.newPage()
        const problems: string[] = []
        page.on('pageerror', (error) => problems.push(error.message))
        await plantStoredText(page, raw)
        await page.goto('/projects')
        await expect(page.getByRole('heading', { name: 'Projects', level: 1 }), name).toBeVisible()
        await expect(toast(page, "Your saved data couldn't be read"), name).toBeVisible()
        expect(await keptCopies(page), name).toEqual([raw])
        await expect(
          page.getByRole('button', { name: 'Create your first project' }),
          name,
        ).toBeVisible()
        expect(problems, name).toEqual([])
      } finally {
        await context.close()
      }
    }
  })
})

// ===========================================================================
// AC-14 · the theme is on before the first paint
// ===========================================================================

test.describe('AC-14: no flash of the wrong theme', () => {
  test.describe.configure({ timeout: 120_000 })

  test('AC-14: after a reload the very first frame already has the chosen theme (stored choice x operating system)', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    await page.addInitScript(() => {
      const w = window as Window & { __firstFrame?: boolean }
      const watcher = new MutationObserver(() => {
        if (document.body && w.__firstFrame === undefined) {
          w.__firstFrame = document.documentElement.classList.contains('dark')
          watcher.disconnect()
        }
      })
      watcher.observe(document, { childList: true, subtree: true })
    })
    for (const [choice, os, dark] of [
      ['dark', 'light', true],
      ['light', 'dark', false],
      ['system', 'dark', true],
      ['system', 'light', false],
    ] as const) {
      await page.emulateMedia({ colorScheme: os })
      // Choose the theme in the app (it is stored and cached for the next start), then reload.
      await page.goto('/settings/appearance')
      await pageReady(page)
      await page
        .getByRole('radiogroup', { name: 'Theme' })
        .getByRole('radio', {
          name: choice === 'system' ? 'System' : choice === 'dark' ? 'Dark' : 'Light',
        })
        .click()
      await expect.poll(async () => (await readDb(page)).preferences?.theme).toBe(choice)
      await page.reload()
      await pageReady(page)
      const first = await page.evaluate(
        () => (window as Window & { __firstFrame?: boolean }).__firstFrame,
      )
      expect(first, `stored ${choice}, operating system ${os}`).toBe(dark)
    }
  })
})

// ===========================================================================
// AC-15 · a backup that is not good is refused with the reason
// ===========================================================================

test.describe('AC-15: broken backup files', () => {
  test.describe.configure({ timeout: 120_000 })

  test('AC-15: a backup with a broken dependency, a duplicate id or an empty title imports nothing and says why', async ({
    page,
  }) => {
    await openApp(page, '/settings/data')
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    type Backup = {
      data: {
        tasks: { id: string; title: string }[]
        dependencies: { id: string; predecessorId: string; successorId: string }[]
      }
    }
    const good = JSON.parse(await downloadText(download)) as Backup
    const broken = (change: (copy: Backup) => void) => {
      const copy = structuredClone(good)
      change(copy)
      return JSON.stringify(copy)
    }
    const cases: [string, string, RegExp][] = [
      [
        'a dependency on a task that is not in the file',
        broken((copy) => {
          copy.data.dependencies[0].predecessorId = 'does-not-exist'
        }),
        /A dependency refers to a task that isn't in the file/,
      ],
      [
        'two tasks that wait for each other',
        broken((copy) => {
          const [first] = copy.data.dependencies
          copy.data.dependencies.push({
            ...first,
            id: 'extra',
            predecessorId: first.successorId,
            successorId: first.predecessorId,
          })
        }),
        /Dependencies form a cycle between "Synthesize findings", "Prototype flow"/,
      ],
      [
        'a duplicate task id',
        broken((copy) => {
          copy.data.tasks[1].id = copy.data.tasks[0].id
        }),
        /Duplicate task id/,
      ],
      [
        'a task without a title',
        broken((copy) => {
          copy.data.tasks[0].title = '   '
        }),
        /Task title is required/,
      ],
      [
        'a format from the future',
        JSON.stringify({ ...good, formatVersion: 2 }),
        /Unsupported backup format version 2/,
      ],
    ]
    const before = await rawDb(page)
    for (const [name, content, reason] of cases) {
      await page.getByLabel('Backup file').setInputFiles({
        name: 'broken.json',
        mimeType: 'application/json',
        buffer: Buffer.from(content),
      })
      const alert = page.getByRole('alert').filter({ hasText: /Couldn.t import/ })
      await expect(alert, name).toContainText(reason)
      await expect(alert, name).toContainText('broken.json')
      await expect(page.getByRole('dialog'), name).toHaveCount(0) // no "Import as new copies" offered
      expect(await rawDb(page), `${name}: nothing was stored`).toBe(before)
      await alert.getByRole('button', { name: /Dismiss|Close/ }).click()
      await expect(alert, name).toHaveCount(0)
    }
    await expect(syncIndicator(page)).toHaveAttribute('data-sync', 'local')
  })
})

// ===========================================================================
// AC-15 · a workspace that cannot be loaded
// ===========================================================================

test.describe('AC-15: a workspace that cannot be loaded', () => {
  test.describe.configure({ timeout: 180_000 })

  test('AC-15: every page says the workspace could not load, nothing keeps "loading", and Retry brings the page back', async ({
    page,
  }) => {
    // The browser refuses to read the stored workspace while sessionStorage says so.
    await page.addInitScript((storageKey) => {
      const original = Storage.prototype.getItem
      Storage.prototype.getItem = function (name: string) {
        if (name === storageKey && sessionStorage.getItem('cairn-e2e-block-reads') === '1') {
          throw new DOMException('Access is denied for this document.', 'SecurityError')
        }
        return original.call(this, name)
      }
    }, LOCAL_WORKSPACE_KEY)
    await openApp(page, '/overview')
    const setBlocked = (blocked: boolean) =>
      page.evaluate(
        (value) => sessionStorage.setItem('cairn-e2e-block-reads', value ? '1' : '0'),
        blocked,
      )

    for (const { path, ready } of PAGES.filter((entry) => entry.path !== '/no-such-page')) {
      await setBlocked(true)
      await page.goto(path)
      const failure = page.getByText('Couldn’t load your workspace')
      await expect(failure, path).toBeVisible()
      await expect(page.getByText("Couldn't read this browser's storage"), path).toBeVisible()
      // Nothing pretends to be loading, and nothing claims anything was saved.
      await expect(page.locator('[data-slot="skeleton"]'), `${path}: no skeleton left`).toHaveCount(
        0,
      )
      await expect(page.locator('main [aria-busy="true"]'), path).toHaveCount(0)
      expect(await page.locator('[data-sonner-toast]').count(), `${path}: no toast`).toBe(0)

      await setBlocked(false)
      await page.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect(failure, path).toHaveCount(0)
      await pageReady(page)
      await ready(page)
    }

    // The same for a task deep link: after Retry the Task Modal opens.
    await setBlocked(true)
    await page.goto(`/projects/${ID.research}/list?task=t-proto`)
    await expect(page.getByText('Couldn’t load your workspace')).toBeVisible()
    await setBlocked(false)
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(editModal(page, 'Prototype flow')).toBeVisible()
  })
})

test.describe('AC-15: returning to a tab, and the connection coming back', () => {
  test.describe.configure({ timeout: 120_000 })

  test('AC-15: a tab that becomes visible again refreshes like a focus does; one that goes hidden does not', async ({
    page,
    context,
  }) => {
    await openApp(page, `/projects/${ID.flat}/list`, { pinTime: false })
    const b = await context.newPage()
    await b.addInitScript(() => {
      const real = Date.now.bind(Date)
      ;(window as Window & { __skew?: number }).__skew = 0
      Date.now = () => real() + ((window as Window & { __skew?: number }).__skew ?? 0)
    })
    await b.goto(`/projects/${ID.flat}/list`)
    await expect(taskRow(b, 'Alpha')).toBeVisible()
    const visibility = (state: 'hidden' | 'visible', skewSeconds: number) =>
      b.evaluate(
        ({ next, seconds }) => {
          const w = window as Window & { __skew?: number }
          w.__skew = (w.__skew ?? 0) + seconds * 1000
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => next,
          })
          document.dispatchEvent(new Event('visibilitychange'))
        },
        { next: state, seconds: skewSeconds },
      )

    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'New task' })
    await input.fill('Added while B was hidden')
    await input.press('Enter')
    await input.press('Escape')
    await expect.poll(() => titlesStored(page, 'Added while B was hidden')).toBe(1)

    // Going to the background never reads the storage…
    await visibility('hidden', 31)
    await b.waitForTimeout(600)
    await expect(taskRow(b, 'Added while B was hidden')).toHaveCount(0)
    // …coming back does (more than 30 s after the last read).
    await visibility('visible', 0)
    await expect(taskRow(b, 'Added while B was hidden')).toBeVisible()
    await expect(syncIndicator(b)).toHaveAttribute('data-sync', 'local')
    expect(await titlesStored(b, 'Added while B was hidden')).toBe(1)
  })

  test('AC-15: a load that failed is tried again by itself when the connection comes back', async ({
    page,
    context,
  }) => {
    await page.addInitScript((storageKey) => {
      const original = Storage.prototype.getItem
      Storage.prototype.getItem = function (name: string) {
        if (name === storageKey && sessionStorage.getItem('cairn-e2e-block-reads') === '1') {
          throw new DOMException('Access is denied for this document.', 'SecurityError')
        }
        return original.call(this, name)
      }
    }, LOCAL_WORKSPACE_KEY)
    await openApp(page, '/overview')
    await page.evaluate(() => sessionStorage.setItem('cairn-e2e-block-reads', '1'))
    await page.goto('/overview')
    const failure = page.getByText('Couldn’t load your workspace')
    await expect(failure).toBeVisible()

    // The storage is readable again and the browser reports the network back: no click needed.
    await page.evaluate(() => sessionStorage.setItem('cairn-e2e-block-reads', '0'))
    await context.setOffline(true)
    await context.setOffline(false)
    await expect(failure).toHaveCount(0)
    await pageReady(page)
    await expect(page.getByText('Active projects').first()).toBeVisible()
  })
})
