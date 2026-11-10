/// <reference lib="dom" />
/**
 * Gantt E2E — runs in LOCAL data mode against the dev server (playwright.config.ts).
 *
 * PRD acceptance §9.1 #7 (drag / resize dates in the Gantt, still right after a reload),
 * #8 (A → B dependency, delay A → conflict warning; Manual handling or a confirmed Auto preview)
 * and #9 (no circular dependency, dates stay valid), plus the failure paths of §5.4: a failed write
 * rolls the bar back with a Retry toast, and a slow write keeps the bar where it was dropped.
 *
 * Time is pinned (Wed 2026-11-04, Asia/Taipei) so every date below is a fixed calendar date. Pointer
 * input uses the real mouse; positions come from the time header's day cells (Day scale, 36px/day).
 */
import { randomUUID } from 'node:crypto'
import { expect, test as base, type Locator, type Page } from '@playwright/test'

const LOCAL_WORKSPACE_KEY = 'cairn:local:workspace:v1'
const SCALES_KEY = 'cairn:gantt-scales'
const NOW = '2026-11-04T10:00:00+08:00'
const TIMESTAMP = '2026-11-03T08:00:00.000Z'
/** Pixels per day on the Day scale (SCALES.day.dayWidth). */
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
test.use({ timezoneId: 'Asia/Taipei', locale: 'en-US', viewport: { width: 1280, height: 800 } })

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

type Scale = 'day' | 'week' | 'month'
type Status = 'todo' | 'in_progress' | 'done'

interface TaskSpec {
  key: string
  title: string
  start?: string
  due?: string
  status?: Status
  phase?: boolean
  parent?: string
}

interface MilestoneSpec {
  key: string
  name: string
  date: string
  phase?: boolean
}

interface Seed {
  projectId: string
  phaseId: string
  /** id by key (tasks, milestones) */
  ids: Record<string, string>
  db: unknown
}

/**
 * Today is Wed Nov 4. Alpha → Bravo is the one dependency (Bravo starts after Alpha ends, so no
 * conflict). Parent has no dates of its own (its bracket rolls up "Sub one").
 */
const DEFAULT_TASKS: TaskSpec[] = [
  { key: 'alpha', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
  { key: 'bravo', title: 'Bravo', start: '2026-11-10', due: '2026-11-12' },
  { key: 'charlie', title: 'Charlie', start: '2026-11-13', due: '2026-11-14' },
  { key: 'delta', title: 'Delta due', due: '2026-11-11', phase: true },
  { key: 'echo', title: 'Echo start', start: '2026-11-09', phase: true },
  { key: 'parent', title: 'Parent', phase: true },
  {
    key: 'sub',
    title: 'Sub one',
    start: '2026-11-06',
    due: '2026-11-09',
    phase: true,
    parent: 'parent',
  },
  { key: 'undated1', title: 'Undated one' },
  { key: 'undated2', title: 'Undated two' },
]

function seedWorkspace(
  options: {
    mode?: 'manual' | 'auto'
    tasks?: TaskSpec[]
    milestones?: MilestoneSpec[]
    deps?: [string, string][]
  } = {},
): Seed {
  const {
    mode = 'manual',
    tasks: specs = DEFAULT_TASKS,
    milestones: milestoneSpecs = [
      { key: 'launch', name: 'Launch', date: '2026-11-15', phase: true },
    ],
    deps = [['alpha', 'bravo']],
  } = options
  const projectId = randomUUID()
  const phaseId = randomUUID()
  const ids: Record<string, string> = {}
  const tasks: Record<string, unknown> = {}
  for (const spec of specs) ids[spec.key] = randomUUID()
  let topOrder = 0
  const subOrder: Record<string, number> = {}
  for (const spec of specs) {
    const id = ids[spec.key]
    const parentId = spec.parent ? ids[spec.parent] : null
    let order: number
    if (spec.parent) {
      order = subOrder[spec.parent] ?? 0
      subOrder[spec.parent] = order + 1
    } else {
      order = topOrder++
    }
    tasks[id] = {
      id,
      projectId,
      phaseId: spec.phase ? phaseId : null,
      parentTaskId: parentId,
      title: spec.title,
      description: null,
      status: spec.status ?? 'todo',
      priority: 'none',
      startDate: spec.start ?? null,
      dueDate: spec.due ?? null,
      sortOrder: `a${order}`,
      completedAt: spec.status === 'done' ? TIMESTAMP : null,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    }
  }
  const milestones: Record<string, unknown> = {}
  for (const spec of milestoneSpecs) {
    const id = randomUUID()
    ids[spec.key] = id
    milestones[id] = {
      id,
      projectId,
      phaseId: spec.phase ? phaseId : null,
      name: spec.name,
      date: spec.date,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    }
  }
  const dependencies: Record<string, unknown> = {}
  for (const [predecessor, successor] of deps) {
    const id = randomUUID()
    ids[`${predecessor}->${successor}`] = id
    dependencies[id] = {
      id,
      projectId,
      predecessorId: ids[predecessor],
      successorId: ids[successor],
      type: 'FS',
      createdAt: TIMESTAMP,
    }
  }
  const db = {
    version: 1,
    projects: {
      [projectId]: {
        id: projectId,
        name: 'Launch plan',
        description: null,
        status: 'active',
        color: 'violet',
        startDate: null,
        dueDate: null,
        scheduleMode: mode,
        sortOrder: 'a0',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    },
    phases: {
      [phaseId]: {
        id: phaseId,
        projectId,
        name: 'Design',
        sortOrder: 'a0',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    },
    tasks,
    milestones,
    dependencies,
    preferences: null,
  }
  return { projectId, phaseId, ids, db }
}

/** Seeds the local workspace once per tab (reloads keep what the test changed) and opens it. */
async function openGantt(
  page: Page,
  seed: Seed,
  scale: Scale = 'day',
  now: string = NOW,
): Promise<void> {
  await page.clock.setFixedTime(now)
  await page.addInitScript(
    ({ key, db, scalesKey, scales }) => {
      if (sessionStorage.getItem('cairn-e2e-gantt-seeded')) return
      localStorage.setItem(key, JSON.stringify(db))
      localStorage.setItem(scalesKey, JSON.stringify(scales))
      sessionStorage.setItem('cairn-e2e-gantt-seeded', '1')
    },
    {
      key: LOCAL_WORKSPACE_KEY,
      db: seed.db,
      scalesKey: SCALES_KEY,
      scales: { [seed.projectId]: scale },
    },
  )
  await page.goto(`/projects/${seed.projectId}/gantt`)
  await expect(chart(page)).toBeVisible()
}

// ---------------------------------------------------------------------------
// Locators and pointer helpers
// ---------------------------------------------------------------------------

function chart(page: Page): Locator {
  return page.getByRole('region', { name: 'Gantt chart' })
}

/** A task's bar / marker (a focusable button named "<title>, <dates>, <status>"). */
function bar(page: Page, id: string): Locator {
  return page.locator(`[data-task-id="${id}"][data-link-target]`)
}

function outlineRow(page: Page, key: string): Locator {
  return page.locator(`[data-row-key="${key}"]`)
}

/** Day-cell title in the time header (Day scale), e.g. "Wednesday, November 4, 2026". */
function dayTitle(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/** Viewport x of the left edge / centre of a day column (Day scale). */
async function dayX(page: Page, iso: string, at: 'left' | 'center' = 'left'): Promise<number> {
  const box = await page.locator(`[title="${dayTitle(iso)}"]`).boundingBox()
  if (!box) throw new Error(`day ${iso} is not rendered`)
  return at === 'left' ? box.x : box.x + box.width / 2
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element is not visible')
  return box
}

/** Pointer drag with intermediate moves; `hold` keeps the button down (returns before release). */
async function dragBy(
  page: Page,
  from: { x: number; y: number },
  dx: number,
  dy = 0,
  options: { release?: boolean } = {},
): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + Math.sign(dx) * 4, from.y + Math.sign(dy) * 4, { steps: 2 })
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 10 })
  if (options.release !== false) await page.mouse.up()
}

/** Moves a bar by `days` (drag its body). */
async function moveBar(page: Page, id: string, days: number): Promise<void> {
  const box = await boxOf(bar(page, id))
  await dragBy(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, days * DAY_PX)
}

/** Resizes one end of a bar by `days` (drag its 8px grip). */
async function resizeBar(page: Page, id: string, edge: 'start' | 'end', days: number) {
  const box = await boxOf(bar(page, id))
  const x = edge === 'start' ? box.x + 3 : box.x + box.width - 3
  await dragBy(page, { x, y: box.y + box.height / 2 }, days * DAY_PX)
}

/** The task as stored in the local "database" (what a reload would show). */
function stored(page: Page, id: string): Promise<{ start: string | null; due: string | null }> {
  return page.evaluate(
    ({ key, id }) => {
      const task = JSON.parse(localStorage.getItem(key) ?? '{}')?.tasks?.[id]
      return { start: task?.startDate ?? null, due: task?.dueDate ?? null }
    },
    { key: LOCAL_WORKSPACE_KEY, id },
  )
}

function storedMilestoneDate(page: Page, id: string): Promise<string | null> {
  return page.evaluate(
    ({ key, id }) => JSON.parse(localStorage.getItem(key) ?? '{}')?.milestones?.[id]?.date ?? null,
    { key: LOCAL_WORKSPACE_KEY, id },
  )
}

function storedDependencyCount(page: Page): Promise<number> {
  return page.evaluate(
    (key) => Object.keys(JSON.parse(localStorage.getItem(key) ?? '{}')?.dependencies ?? {}).length,
    LOCAL_WORKSPACE_KEY,
  )
}

/** Counts writes of the local database (one action = one write). */
async function countWrites(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const w = window as Window & { __writes?: number }
    w.__writes = 0
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (name: string, value: string) {
      if (name === key) w.__writes = (w.__writes ?? 0) + 1
      return original.call(this, name, value)
    }
  }, LOCAL_WORKSPACE_KEY)
}

function writes(page: Page): Promise<number> {
  return page.evaluate(() => (window as Window & { __writes?: number }).__writes ?? 0)
}

type TestHooks = { failNextWrites(count: number): void; setLatency(ms: number): void }
function failNextWrites(page: Page, count: number): Promise<void> {
  return page.evaluate((n) => {
    ;(window as Window & { __cairnTest?: TestHooks }).__cairnTest?.failNextWrites(n)
  }, count)
}
function setLatency(page: Page, ms: number): Promise<void> {
  return page.evaluate((n) => {
    ;(window as Window & { __cairnTest?: TestHooks }).__cairnTest?.setLatency(n)
  }, ms)
}

function toast(page: Page, text: string | RegExp): Locator {
  return page.locator('[data-sonner-toast]', { hasText: text })
}

function toastButton(page: Page, label: string): Locator {
  return page.locator('[data-sonner-toast] [data-button]', { hasText: label })
}

/** The dependency line between two tasks (the 10px hit path of the SVG layer). */
function depPath(page: Page, depId: string): Locator {
  return page.locator(`path[data-dep-id="${depId}"]`)
}

/** A point on a dependency line in viewport coordinates (its middle). */
async function pointOnPath(path: Locator): Promise<{ x: number; y: number }> {
  return path.evaluate((element) => {
    const svgPath = element as unknown as SVGPathElement
    const point = svgPath.getPointAtLength(svgPath.getTotalLength() / 2)
    const matrix = svgPath.getScreenCTM()
    if (!matrix) throw new Error('no CTM')
    return {
      x: matrix.a * point.x + matrix.c * point.y + matrix.e,
      y: matrix.b * point.x + matrix.d * point.y + matrix.f,
    }
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('gantt (local mode)', () => {
  test('renders the outline, every bar kind and the time header from the store', async ({
    page,
  }) => {
    const seed = seedWorkspace()
    const { ids } = seed
    await openGantt(page, seed, 'week')

    // Outline order: Design (tasks, subtasks, milestones) → No phase. Undated tasks stay where they are.
    const keys = await page
      .locator('[data-row-key]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row-key')))
    expect(keys).toEqual([
      `group:${seed.phaseId}`,
      `task:${ids.delta}`,
      `task:${ids.echo}`,
      `task:${ids.parent}`,
      `task:${ids.sub}`,
      `milestone:${ids.launch}`,
      'group:none',
      `task:${ids.alpha}`,
      `task:${ids.bravo}`,
      `task:${ids.charlie}`,
      `task:${ids.undated1}`,
      `task:${ids.undated2}`,
    ])

    // Range bar, due marker, start marker, subtask bar and the diamond: dates in the name.
    await expect(bar(page, ids.alpha)).toHaveAccessibleName('Alpha, Nov 5 – Nov 7, 3 days, To Do')
    await expect(bar(page, ids.delta)).toHaveAccessibleName(
      'Delta due, Due Nov 11, no start date, To Do',
    )
    await expect(bar(page, ids.echo)).toHaveAccessibleName(
      'Echo start, Starts Nov 9, no due date, To Do',
    )
    await expect(bar(page, ids.sub)).toHaveAccessibleName('Sub one, Nov 6 – Nov 9, 4 days, To Do')
    await expect(page.getByRole('button', { name: 'Milestone Launch, Nov 15, 2026' })).toBeVisible()
    // The dependency is drawn (one line); there is no Unscheduled group, the toolbar toggle counts
    // Parent (no dates of its own) and the two undated tasks, and group headers count every task.
    await expect(page.locator('path[data-dep-id]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: /^Unscheduled, / })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Show only unscheduled tasks, 3' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Design, 4 tasks' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'No phase, 5 tasks' })).toBeVisible()

    // Header: month tier + week tier, today highlighted.
    await expect(chart(page).getByText('Nov 2026', { exact: true }).first()).toBeVisible()
    await expect(page.getByTestId('gantt-today-line')).toBeVisible()
  })

  test('Today (button and T) scrolls back; the scale is saved per project and kept across reloads', async ({
    page,
  }) => {
    const seed = seedWorkspace()
    await openGantt(page, seed, 'week')
    const scroller = chart(page)
    const today = page.getByTestId('gantt-today-line')
    const inView = async () => {
      const [line, area] = await Promise.all([today.boundingBox(), scroller.boundingBox()])
      return Boolean(line && area && line.x > area.x + 300 && line.x < area.x + area.width)
    }
    // "Today" rests one third into the timeline (right of the 300px outline). Wait for it to REST
    // there: Today scrolls smoothly, and moving the view again while that is still in flight makes
    // Chromium ignore the next smooth scroll to the same target (a spec race, not an app bug).
    let lastX = Number.NaN
    let still = 0
    const atTarget = async () => {
      const [line, area, client] = await Promise.all([
        today.boundingBox(),
        scroller.boundingBox(),
        scroller.evaluate((el) => el.clientWidth),
      ])
      if (!line || !area) return false
      const x = line.x - area.x
      // On its target and no longer moving (the smooth scroll has finished).
      still =
        Math.abs(x - (300 + (client - 300) / 3)) <= 3 && Math.abs(x - lastX) < 0.5 ? still + 1 : 0
      lastX = x
      return still >= 3
    }
    await expect.poll(atTarget, { intervals: [100], timeout: 10_000 }).toBe(true)

    await scroller.evaluate((el) => {
      el.scrollLeft += 900
    })
    await expect.poll(inView).toBe(false)
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await expect.poll(atTarget, { intervals: [100], timeout: 10_000 }).toBe(true)

    await scroller.evaluate((el) => {
      el.scrollLeft += 900
    })
    await expect.poll(inView).toBe(false)
    await page.keyboard.press('t')
    await expect.poll(atTarget, { intervals: [100], timeout: 10_000 }).toBe(true)

    // Day → Month → reload: the choice (and the same project) is remembered.
    await page.getByRole('radio', { name: 'Month' }).click()
    await expect(page.getByRole('radio', { name: 'Month' })).toBeChecked()
    await expect.poll(inView).toBe(true)
    await page.reload()
    await expect(page.getByRole('radio', { name: 'Month' })).toBeChecked()
    await expect.poll(inView).toBe(true)
    await page.getByRole('radio', { name: 'Day' }).click()
    await expect(page.getByRole('radio', { name: 'Day' })).toBeChecked()
    await expect(page.locator(`[title="${dayTitle('2026-11-04')}"]`)).toBeVisible()
  })

  test('dragging a bar moves it (duration kept), shows the new dates live, and survives a reload', async ({
    page,
  }) => {
    const seed = seedWorkspace()
    const { ids } = seed
    await openGantt(page, seed)
    await countWrites(page)

    const box = await boxOf(bar(page, ids.alpha))
    await dragBy(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 2 * DAY_PX, 0, {
      release: false,
    })
    // Live tooltip with the new dates and the shift; nothing is written until the drop.
    await expect(page.getByText('Nov 7 – Nov 9 · 3 days')).toBeVisible()
    await expect(page.getByText('+2 days')).toBeVisible()
    expect(await stored(page, ids.alpha)).toEqual({ start: '2026-11-05', due: '2026-11-07' })
    await page.mouse.up()

    await expect(bar(page, ids.alpha)).toHaveAccessibleName('Alpha, Nov 7 – Nov 9, 3 days, To Do')
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-07', due: '2026-11-09' })
    expect(await writes(page)).toBe(1)
    // The drop did not open the task. A successful move is confirmed with ONE quiet toast that
    // names the new range and offers Undo (UX iteration 2); see gantt-undo.spec.ts for the Undo.
    await expect(page).not.toHaveURL(/task=/)
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(1)
    await expect(page.locator('[data-sonner-toast]')).toContainText(
      'Moved · Nov 7 – Nov 9 · 3 days',
    )

    await page.reload()
    await expect(bar(page, ids.alpha)).toHaveAccessibleName('Alpha, Nov 7 – Nov 9, 3 days, To Do')
    // Back and forward in time, and a move left of today.
    await moveBar(page, ids.charlie, -3)
    await expect
      .poll(() => stored(page, ids.charlie))
      .toEqual({ start: '2026-11-10', due: '2026-11-11' })
  })

  test('resizing either end snaps to whole days and never inverts the range', async ({ page }) => {
    const seed = seedWorkspace({ deps: [] })
    const { ids } = seed
    await openGantt(page, seed)

    await resizeBar(page, ids.alpha, 'end', 2)
    await expect(bar(page, ids.alpha)).toHaveAccessibleName('Alpha, Nov 5 – Nov 9, 5 days, To Do')
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-05', due: '2026-11-09' })

    await resizeBar(page, ids.alpha, 'start', -1)
    await expect(bar(page, ids.alpha)).toHaveAccessibleName('Alpha, Nov 4 – Nov 9, 6 days, To Do')
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-04', due: '2026-11-09' })

    // Dragging the left grip far past the end leaves a one-day task (start ≤ due).
    await resizeBar(page, ids.alpha, 'start', 9)
    await expect(bar(page, ids.alpha)).toHaveAccessibleName('Alpha, Nov 9, 1 day, To Do')
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-09', due: '2026-11-09' })

    // And the right grip far before the start.
    await resizeBar(page, ids.bravo, 'end', -9)
    await expect
      .poll(() => stored(page, ids.bravo))
      .toEqual({ start: '2026-11-10', due: '2026-11-10' })
  })

  test('Esc cancels a drag and writes nothing; a click without movement opens the task', async ({
    page,
  }) => {
    const seed = seedWorkspace()
    const { ids } = seed
    await openGantt(page, seed)
    await countWrites(page)

    const box = await boxOf(bar(page, ids.charlie))
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await dragBy(page, centre, -2 * DAY_PX, 0, { release: false })
    await expect(page.getByText('Nov 11 – Nov 12 · 2 days')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByText('Nov 11 – Nov 12 · 2 days')).toHaveCount(0)
    await page.mouse.up()
    await expect(bar(page, ids.charlie)).toHaveAccessibleName(
      'Charlie, Nov 13 – Nov 14, 2 days, To Do',
    )
    expect(await writes(page)).toBe(0)
    expect(await stored(page, ids.charlie)).toEqual({ start: '2026-11-13', due: '2026-11-14' })
    await expect(page).not.toHaveURL(/task=/)

    // Under the 3px slop it is a click: the Task Modal opens for that task.
    await page.mouse.click(centre.x, centre.y)
    await expect(page).toHaveURL(new RegExp(`task=${ids.charlie}`))
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page).not.toHaveURL(/task=/)
    expect(await writes(page)).toBe(0)
  })

  test('markers and milestones drag too; an undated task is scheduled by drawing across its row', async ({
    page,
  }) => {
    const seed = seedWorkspace()
    const { ids } = seed
    await openGantt(page, seed)

    // Due marker: the due date moves (still no start date).
    const flag = await boxOf(bar(page, ids.delta))
    await dragBy(page, { x: flag.x + flag.width / 2, y: flag.y + flag.height / 2 }, 2 * DAY_PX)
    await expect.poll(() => stored(page, ids.delta)).toEqual({ start: null, due: '2026-11-13' })

    // Start marker: the start date moves.
    const tick = await boxOf(bar(page, ids.echo))
    await dragBy(page, { x: tick.x + 4, y: tick.y + tick.height / 2 }, -1 * DAY_PX)
    await expect.poll(() => stored(page, ids.echo)).toEqual({ start: '2026-11-08', due: null })

    // Milestone diamond: saved through updateMilestone, not the planner.
    const diamond = await boxOf(page.getByRole('button', { name: /^Milestone Launch/ }))
    await dragBy(
      page,
      { x: diamond.x + diamond.width / 2, y: diamond.y + diamond.height / 2 },
      -2 * DAY_PX,
    )
    await expect.poll(() => storedMilestoneDate(page, ids.launch)).toBe('2026-11-13')
    await expect(page.getByRole('button', { name: 'Milestone Launch, Nov 13, 2026' })).toBeVisible()

    // Draw: pointer-down day → release day becomes start → due.
    const lane = outlineRow(page, `task:${ids.undated1}`).locator('[data-handle="lane"]')
    const laneBox = await boxOf(lane)
    const y = laneBox.y + laneBox.height / 2
    const from = await dayX(page, '2026-11-11', 'center')
    await dragBy(page, { x: from, y }, 3 * DAY_PX)
    await expect
      .poll(() => stored(page, ids.undated1))
      .toEqual({ start: '2026-11-11', due: '2026-11-14' })
    await expect(bar(page, ids.undated1)).toHaveAccessibleName(
      'Undated one, Nov 11 – Nov 14, 4 days, To Do',
    )
    // It still sits in its place; the toolbar count dropped (Parent + Undated two are left).
    await expect(page.getByRole('button', { name: 'Show only unscheduled tasks, 2' })).toBeVisible()

    // Double-click an empty lane: a one-day task on that day.
    const lane2 = outlineRow(page, `task:${ids.undated2}`).locator('[data-handle="lane"]')
    const lane2Box = await boxOf(lane2)
    await page.mouse.dblclick(
      await dayX(page, '2026-11-08', 'center'),
      lane2Box.y + lane2Box.height / 2,
    )
    await expect
      .poll(() => stored(page, ids.undated2))
      .toEqual({ start: '2026-11-08', due: '2026-11-08' })
    await expect(page.getByRole('button', { name: 'Show only unscheduled tasks, 1' })).toBeVisible()
  })

  test('keyboard: Tab to a bar, Alt+arrows move / resize it, Enter opens it and focus returns', async ({
    page,
  }) => {
    const seed = seedWorkspace({ deps: [] })
    const { ids } = seed
    await openGantt(page, seed)

    const alpha = bar(page, ids.alpha)
    await alpha.focus()
    await expect(alpha).toBeFocused()
    await page.keyboard.press('Alt+ArrowRight')
    await expect(alpha).toHaveAccessibleName('Alpha, Nov 6 – Nov 8, 3 days, To Do')
    await page.keyboard.press('Alt+ArrowLeft')
    await page.keyboard.press('Alt+ArrowLeft')
    await expect(alpha).toHaveAccessibleName('Alpha, Nov 4 – Nov 6, 3 days, To Do')
    await page.keyboard.press('Alt+Shift+ArrowRight')
    await expect(alpha).toHaveAccessibleName('Alpha, Nov 4 – Nov 7, 4 days, To Do')
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-04', due: '2026-11-07' })
    // The change is announced for screen readers.
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'Alpha:' })).toHaveText(
      /Alpha: Nov 4 – Nov 7/,
    )
    // The due date cannot pass the start date.
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('Alt+Shift+ArrowLeft')
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-04', due: '2026-11-04' })

    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`task=${ids.alpha}`))
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(alpha).toBeFocused()
  })

  test('Manual mode: delaying a predecessor warns, lists the conflict and resolves it only when asked', async ({
    page,
  }) => {
    const seed = seedWorkspace()
    const { ids } = seed
    await openGantt(page, seed)

    // Alpha now ends on Nov 10, Bravo's start day: Bravo would have to start on Nov 11 or later.
    await moveBar(page, ids.alpha, 3)
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-08', due: '2026-11-10' })
    // Manual never moves the successor.
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-10', due: '2026-11-12' })

    const warning = toast(page, '1 dependency conflict')
    await expect(warning).toBeVisible()
    await expect(warning).toContainText('“Bravo” starts before “Alpha” finishes.')
    // The line is drawn as a conflict, the successor carries the explanation, the chip shows 1.
    await expect(page.locator('g[data-conflict] path[data-dep-id]')).toHaveCount(1)
    await expect(bar(page, ids.bravo)).toHaveAccessibleName(/dependency conflict/)
    const chip = page.getByRole('button', { name: '1 conflict', exact: true })
    await expect(chip).toBeVisible()

    // Review → the "Resolve" preview lists what would move; Cancel writes nothing.
    await toastButton(page, 'Review').click()
    const dialog = page.getByRole('dialog', { name: 'Resolve dependency conflicts' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('region', { name: 'Tasks that move' })).toContainText('Bravo')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-10', due: '2026-11-12' })

    // The chip's popover names the pair and offers "Resolve all…".
    await chip.click()
    const list = page.getByRole('list', { name: 'Conflicts' })
    await expect(list).toContainText('Alpha')
    await expect(list).toContainText('Bravo')
    await expect(list).toContainText('Needs to start Nov 11 or later')
    await page.getByRole('button', { name: 'Resolve all…' }).click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Apply 1 change' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Apply 1 change' }).click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(() => stored(page, ids.bravo))
      .toEqual({ start: '2026-11-11', due: '2026-11-13' })
    await expect(chip).toHaveCount(0)
    await expect(page.locator('g[data-conflict]')).toHaveCount(0)
  })

  test('Auto mode: a preview lists every shifted task; Cancel keeps all dates, Apply writes them atomically', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      mode: 'auto',
      deps: [
        ['alpha', 'bravo'],
        ['bravo', 'charlie'],
      ],
      tasks: [
        { key: 'alpha', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
        { key: 'bravo', title: 'Bravo', start: '2026-11-08', due: '2026-11-10' },
        { key: 'charlie', title: 'Charlie', start: '2026-11-11', due: '2026-11-12' },
      ],
      milestones: [],
    })
    const { ids } = seed
    await openGantt(page, seed)
    await expect(page.getByRole('button', { name: 'Dependencies: Auto' })).toBeVisible()
    await countWrites(page)

    const original = {
      alpha: { start: '2026-11-05', due: '2026-11-07' },
      bravo: { start: '2026-11-08', due: '2026-11-10' },
      charlie: { start: '2026-11-11', due: '2026-11-12' },
    }
    await moveBar(page, ids.alpha, 2)
    const dialog = page.getByRole('dialog', { name: 'Move dependent tasks?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Auto-schedule counts calendar days')
    const shifts = dialog.getByRole('region', { name: 'Tasks that move' })
    await expect(shifts).toContainText('Bravo')
    await expect(shifts).toContainText('Charlie')
    await expect(shifts).toContainText('+2d')
    // Held at the drop while it asks: nothing is written yet, the bar shows where it was dropped.
    expect(await writes(page)).toBe(0)
    await expect(bar(page, ids.alpha)).toHaveAttribute(
      'aria-label',
      'Alpha, Nov 7 – Nov 9, 3 days, To Do',
    )

    // Cancel → the bar goes back and nothing was written.
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(bar(page, ids.alpha)).toHaveAccessibleName('Alpha, Nov 5 – Nov 7, 3 days, To Do')
    expect(await writes(page)).toBe(0)
    expect(await stored(page, ids.bravo)).toEqual(original.bravo)

    // "Only move this task" leaves the successors (and a conflict warning).
    await moveBar(page, ids.alpha, 2)
    await dialog.getByRole('button', { name: 'Only move this task' }).click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-07', due: '2026-11-09' })
    expect(await stored(page, ids.bravo)).toEqual(original.bravo)
    expect(await writes(page)).toBe(1)
    await expect(toast(page, '1 dependency conflict')).toBeVisible()

    // Resolve all: Bravo and Charlie move in ONE write.
    await page.getByRole('button', { name: '1 conflict', exact: true }).click()
    await page.getByRole('button', { name: 'Resolve all…' }).click()
    const resolve = page.getByRole('dialog', { name: 'Resolve dependency conflicts' })
    await expect(resolve.getByRole('button', { name: 'Apply 2 changes' })).toBeVisible()
    await resolve.getByRole('button', { name: 'Apply 2 changes' }).click()
    await expect
      .poll(() => stored(page, ids.bravo))
      .toEqual({ start: '2026-11-10', due: '2026-11-12' })
    await expect
      .poll(() => stored(page, ids.charlie))
      .toEqual({ start: '2026-11-13', due: '2026-11-14' })
    expect(await writes(page)).toBe(2)
    await expect(page.getByRole('button', { name: /conflict/ })).toHaveCount(0)
    await expect(resolve).toHaveCount(0)

    // One more drag, applied in full: the task and its two successors in a single write.
    await moveBar(page, ids.alpha, 1)
    await dialog.getByRole('button', { name: 'Apply 3 changes' }).click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-08', due: '2026-11-10' })
    await expect
      .poll(() => stored(page, ids.bravo))
      .toEqual({ start: '2026-11-11', due: '2026-11-13' })
    await expect
      .poll(() => stored(page, ids.charlie))
      .toEqual({ start: '2026-11-14', due: '2026-11-15' })
    expect(await writes(page)).toBe(3)
  })

  test('dependencies: draw one, a cycle is refused with the reason, select + Delete removes it and Undo restores it', async ({
    page,
  }) => {
    const seed = seedWorkspace()
    const { ids } = seed
    await openGantt(page, seed)
    expect(await storedDependencyCount(page)).toBe(1)

    // Hover reveals the connector dots; drag from Bravo's finish dot onto Charlie.
    const bravo = bar(page, ids.bravo)
    await bravo.hover()
    const out = page.locator(`[data-handle="link-out"][data-task-id="${ids.bravo}"]`)
    await expect(out).toBeVisible()
    const dot = await boxOf(out)
    const target = await boxOf(bar(page, ids.charlie))
    await dragBy(
      page,
      { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 },
      target.x + target.width / 2 - (dot.x + dot.width / 2),
      target.y + target.height / 2 - (dot.y + dot.height / 2),
    )
    await expect.poll(() => storedDependencyCount(page)).toBe(2)
    await expect(page.locator('path[data-dep-id]')).toHaveCount(2)
    // No conflict: Charlie starts after Bravo ends.
    await expect(page.locator('g[data-conflict]')).toHaveCount(0)

    // Charlie → Alpha would close the loop Alpha → Bravo → Charlie → Alpha.
    await bar(page, ids.charlie).hover()
    const charlieOut = page.locator(`[data-handle="link-out"][data-task-id="${ids.charlie}"]`)
    const charlieDot = await boxOf(charlieOut)
    const alpha = await boxOf(bar(page, ids.alpha))
    await dragBy(
      page,
      { x: charlieDot.x + charlieDot.width / 2, y: charlieDot.y + charlieDot.height / 2 },
      alpha.x + alpha.width / 2 - (charlieDot.x + charlieDot.width / 2),
      alpha.y + alpha.height / 2 - (charlieDot.y + charlieDot.height / 2),
      { release: false },
    )
    await expect(page.getByText('This would create a circular dependency.')).toBeVisible()
    await page.mouse.up()
    await expect(toast(page, 'This would create a circular dependency.')).toBeVisible()
    expect(await storedDependencyCount(page)).toBe(2)

    // Duplicate: Alpha → Bravo again.
    await bar(page, ids.alpha).hover()
    const alphaOut = await boxOf(
      page.locator(`[data-handle="link-out"][data-task-id="${ids.alpha}"]`),
    )
    const bravoBox = await boxOf(bar(page, ids.bravo))
    await dragBy(
      page,
      { x: alphaOut.x + alphaOut.width / 2, y: alphaOut.y + alphaOut.height / 2 },
      bravoBox.x + bravoBox.width / 2 - (alphaOut.x + alphaOut.width / 2),
      bravoBox.y + bravoBox.height / 2 - (alphaOut.y + alphaOut.height / 2),
    )
    await expect(toast(page, 'This dependency already exists.')).toBeVisible()
    expect(await storedDependencyCount(page)).toBe(2)

    // Select the Alpha → Bravo line and remove it with the keyboard.
    const line = depPath(page, ids['alpha->bravo'])
    const point = await pointOnPath(line)
    await page.mouse.click(point.x, point.y)
    await expect(
      page.getByRole('button', { name: 'Remove dependency: Alpha → Bravo' }),
    ).toBeVisible()
    await page.keyboard.press('Delete')
    await expect.poll(() => storedDependencyCount(page)).toBe(1)
    const removed = toast(page, 'Dependency removed')
    await expect(removed).toBeVisible()
    await removed.locator('[data-button]', { hasText: 'Undo' }).click()
    await expect.poll(() => storedDependencyCount(page)).toBe(2)
    await expect(page.locator('path[data-dep-id]')).toHaveCount(2)

    // Reload: both lines are still there.
    await page.reload()
    await expect(page.locator('path[data-dep-id]')).toHaveCount(2)
  })

  test('a failed save rolls the bar back with a Retry toast, and Retry saves the same change', async ({
    page,
  }) => {
    const seed = seedWorkspace()
    const { ids } = seed
    await openGantt(page, seed)

    await failNextWrites(page, 1)
    await moveBar(page, ids.charlie, -2)
    const failed = toast(page, "Couldn't change dates")
    await expect(failed).toBeVisible()
    // Back where it was, and nothing stored.
    await expect(bar(page, ids.charlie)).toHaveAccessibleName(
      'Charlie, Nov 13 – Nov 14, 2 days, To Do',
    )
    expect(await stored(page, ids.charlie)).toEqual({ start: '2026-11-13', due: '2026-11-14' })

    await failed.locator('[data-button]', { hasText: 'Retry' }).click()
    await expect(bar(page, ids.charlie)).toHaveAccessibleName(
      'Charlie, Nov 11 – Nov 12, 2 days, To Do',
    )
    await expect
      .poll(() => stored(page, ids.charlie))
      .toEqual({ start: '2026-11-11', due: '2026-11-12' })
    await expect(failed).toHaveCount(0)
  })

  test('a slow save keeps the bar where it was dropped (no flicker, one write) until it lands', async ({
    page,
  }) => {
    const seed = seedWorkspace()
    const { ids } = seed
    await openGantt(page, seed)
    await countWrites(page)

    await setLatency(page, 1500)
    await moveBar(page, ids.charlie, -2)
    const moved = 'Charlie, Nov 11 – Nov 12, 2 days, To Do'
    await expect(bar(page, ids.charlie)).toHaveAccessibleName(moved)
    await expect(page.getByRole('button', { name: /Sync status: Saving/ })).toBeVisible()
    // While it is saving the label never reverts (sampled until the sidebar stops saying so).
    await expect(async () => {
      await expect(bar(page, ids.charlie)).toHaveAccessibleName(moved)
      await expect(page.getByRole('button', { name: /Sync status: Saving/ })).toHaveCount(0)
    }).toPass({ timeout: 10_000 })
    await expect
      .poll(() => stored(page, ids.charlie))
      .toEqual({ start: '2026-11-11', due: '2026-11-12' })
    expect(await writes(page)).toBe(1)
    await setLatency(page, 0)
  })

  test('phases and parents collapse (and stay collapsed after a reload); the empty states explain what to do', async ({
    page,
  }) => {
    const seed = seedWorkspace()
    const { ids } = seed
    await openGantt(page, seed, 'week')

    await expect(bar(page, ids.sub)).toBeVisible()
    await page.getByRole('button', { name: 'Hide 1 subtask of Parent' }).click()
    await expect(bar(page, ids.sub)).toHaveCount(0)
    await page.getByRole('button', { name: 'Design, 4 tasks' }).click()
    await expect(bar(page, ids.delta)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Milestone Launch/ })).toHaveCount(0)
    await page.reload()
    await expect(bar(page, ids.alpha)).toBeVisible()
    await expect(bar(page, ids.delta)).toHaveCount(0)
    await page.getByRole('button', { name: 'Design, 4 tasks' }).click()
    await expect(bar(page, ids.delta)).toBeVisible()
    // The parent is still collapsed.
    await expect(bar(page, ids.sub)).toHaveCount(0)
  })

  test('an empty project offers New task; a project of only undated tasks says how to schedule them', async ({
    page,
  }) => {
    const empty = seedWorkspace({ tasks: [], milestones: [], deps: [] })
    await openGantt(page, empty, 'week').catch(() => undefined)
    await expect(page.getByText('No tasks yet')).toBeVisible()
    await page.getByRole('button', { name: 'New task' }).first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('the all-unscheduled state shows the drawing hint', async ({ page }) => {
    const seed = seedWorkspace({
      tasks: [
        { key: 'one', title: 'One' },
        { key: 'two', title: 'Two' },
      ],
      milestones: [],
      deps: [],
    })
    await openGantt(page, seed, 'week')
    await expect(
      page.getByText('Drag across a row to schedule it', { exact: false }).first(),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Show only unscheduled tasks, 2' })).toBeVisible()
    // Nothing is scheduled, so the filter would show the very same rows: no extra hint in filter mode.
    await page.getByRole('button', { name: 'Show only unscheduled tasks, 2' }).click()
    await expect(page.getByText('Drag across a row to schedule it', { exact: false })).toHaveCount(
      0,
    )
  })

  test('the outline pane resizes by pointer and keyboard (min 220) and keeps its width after a reload', async ({
    page,
  }) => {
    await openGantt(page, seedWorkspace(), 'week')
    const handle = page.getByRole('separator', { name: 'Resize task list' })
    await expect(handle).toHaveAttribute('aria-valuenow', '300')

    const box = await boxOf(handle)
    await dragBy(page, { x: box.x + box.width / 2, y: box.y + 200 }, 100)
    await expect(handle).toHaveAttribute('aria-valuenow', '400')
    await handle.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(handle).toHaveAttribute('aria-valuenow', '384')
    await page.keyboard.press('Home')
    await expect(handle).toHaveAttribute('aria-valuenow', '220')
    // Dragging further left stays at the minimum.
    const min = await boxOf(handle)
    await dragBy(page, { x: min.x + min.width / 2, y: min.y + 200 }, -150)
    await expect(handle).toHaveAttribute('aria-valuenow', '220')
    await page.keyboard.press('ArrowRight')
    await expect(handle).toHaveAttribute('aria-valuenow', '236')

    await page.reload()
    await expect(page.getByRole('separator', { name: 'Resize task list' })).toHaveAttribute(
      'aria-valuenow',
      '236',
    )
  })

  test('the timeline grows at both ends without moving what is on screen', async ({ page }) => {
    await openGantt(page, seedWorkspace(), 'day')
    const scroller = chart(page)
    const width = () => scroller.evaluate((el) => el.scrollWidth)
    const initial = await width()

    // Scroll away from the left end first, then measure a day's position.
    await scroller.evaluate((el) => {
      el.scrollLeft = 400
    })
    const marker = page.locator(`[title="${dayTitle('2026-11-02')}"]`)
    await expect(marker).toBeVisible()
    const before = (await boxOf(marker)).x
    // 150px from the left end is inside the growth zone: days are added in front.
    await scroller.evaluate((el) => {
      el.scrollLeft = 150
    })
    await expect.poll(width).toBeGreaterThan(initial)
    // The day moved by exactly the 250px we scrolled, not by the days that were added.
    await expect
      .poll(async () => Math.round((await boxOf(marker)).x))
      .toBe(Math.round(before + 250))

    // The right end grows too.
    const grown = await width()
    await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth
    })
    await expect.poll(width).toBeGreaterThan(grown)
  })

  test('dragging a bar to the edge scrolls the timeline; Esc ends it without writing', async ({
    page,
  }) => {
    const seed = seedWorkspace()
    const { ids } = seed
    await openGantt(page, seed)
    await countWrites(page)
    const scroller = chart(page)
    const before = await scroller.evaluate((el) => el.scrollLeft)

    const box = await boxOf(bar(page, ids.charlie))
    const area = await boxOf(scroller)
    // Hold the pointer inside the right edge zone: the chart keeps scrolling by itself.
    await dragBy(
      page,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      area.x + area.width - 12 - (box.x + box.width / 2),
      0,
      { release: false },
    )
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before + 100)
    await page.keyboard.press('Escape')
    const settled = await scroller.evaluate((el) => el.scrollLeft)
    await page.mouse.up()
    // Cancelled: nothing written, and the auto-scroll stopped.
    expect(await writes(page)).toBe(0)
    expect(await stored(page, ids.charlie)).toEqual({ start: '2026-11-13', due: '2026-11-14' })
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(settled)
  })

  test('a drop after auto-scrolling saves exactly the dates the tooltip showed, however fast the frames ran', async ({
    page,
  }) => {
    const seed = seedWorkspace()
    const { ids } = seed
    await openGantt(page, seed)
    const scroller = chart(page)
    const before = await scroller.evaluate((el) => el.scrollLeft)
    const box = await boxOf(bar(page, ids.charlie))
    const area = await boxOf(scroller)
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    // Into the right edge zone: the chart scrolls once per frame, so how far it gets depends on
    // the machine. Then back to where the drag began, where it stops.
    await dragBy(page, from, area.x + area.width - 12 - from.x, 0, { release: false })
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before + 100)
    await page.mouse.move(from.x, from.y, { steps: 5 })
    const scrolled = await scroller.evaluate(
      (el) =>
        new Promise<number>((resolve) => {
          let last = -1
          const check = () => {
            if (el.scrollLeft === last) resolve(last)
            else {
              last = el.scrollLeft
              requestAnimationFrame(check)
            }
          }
          requestAnimationFrame(check)
        }),
    )
    expect(scrolled).toBeGreaterThan(before + 100)
    // The bar went along with the timeline: the pointer is back, the dates are not.
    const tip = page.locator('div.pointer-events-none.fixed')
    await expect(tip).toContainText('+')
    const range = (await tip.innerText()).split(' · ')[0] // e.g. "Nov 18 – Nov 19"
    const [start, due] = range.split(' – ').map((monthDay) => {
      const [month, day] = monthDay.split(' ')
      const m = ['Nov', 'Dec'].indexOf(month)
      if (m < 0) throw new Error(`unexpected tooltip date ${monthDay}`)
      return `2026-${String(11 + m)}-${day.padStart(2, '0')}`
    })
    expect(start > '2026-11-13').toBe(true)
    await page.mouse.up()
    // What was shown is what was saved, and the bar says the same.
    await expect.poll(() => stored(page, ids.charlie)).toEqual({ start, due })
    await expect(bar(page, ids.charlie)).toHaveAccessibleName(new RegExp(`, ${range}, `))
  })

  test('the dependency mode menu switches Manual ↔ Auto and remembers it', async ({ page }) => {
    const seed = seedWorkspace()
    await openGantt(page, seed)
    await page.getByRole('button', { name: 'Dependencies: Manual' }).click()
    await page.getByRole('menuitemradio', { name: /^Auto/ }).click()
    await expect(page.getByRole('button', { name: 'Dependencies: Auto' })).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(
          ({ key, id }) =>
            JSON.parse(localStorage.getItem(key) ?? '{}')?.projects?.[id]?.scheduleMode,
          { key: LOCAL_WORKSPACE_KEY, id: seed.projectId },
        ),
      )
      .toBe('auto')
    await page.reload()
    await expect(page.getByRole('button', { name: 'Dependencies: Auto' })).toBeVisible()
  })

  test('the conflicts chip opens the successor task; the × button removes a selected line', async ({
    page,
  }) => {
    const seed = seedWorkspace()
    const { ids } = seed
    await openGantt(page, seed)
    await moveBar(page, ids.alpha, 3) // Alpha now ends Nov 10, on Bravo's start day
    await page.getByRole('button', { name: '1 conflict', exact: true }).click()
    await page.getByRole('list', { name: 'Conflicts' }).getByRole('button').first().click()
    await expect(page).toHaveURL(new RegExp(`task=${ids.bravo}`))
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await expect(modal).toContainText('Dependency conflict')
    await modal.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(modal).toHaveCount(0)

    // Click the line, then the × button (no keyboard).
    const point = await pointOnPath(depPath(page, ids['alpha->bravo']))
    await page.mouse.click(point.x, point.y)
    await page.getByRole('button', { name: 'Remove dependency: Alpha → Bravo' }).click()
    await expect.poll(() => storedDependencyCount(page)).toBe(0)
    await expect(toast(page, 'Dependency removed')).toBeVisible()
    await expect(page.getByRole('button', { name: /conflict/ })).toHaveCount(0)
  })

  test('Unscheduled filter: tasks keep their phase, the toggle lists only tasks without dates, drawing one removes it, and it turns off at 0', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      deps: [],
      tasks: [
        { key: 'planned', title: 'Planned', start: '2026-11-05', due: '2026-11-06', phase: true },
        { key: 'p1', title: 'Phase idea', phase: true },
        { key: 'n1', title: 'Loose idea' },
        { key: 'n2', title: 'Planned too', start: '2026-11-10', due: '2026-11-11' },
        { key: 'epic', title: 'Epic', start: '2026-11-09', due: '2026-11-12' },
        { key: 'epicsub', title: 'Epic leftover', parent: 'epic' },
      ],
    })
    const { ids } = seed
    await openGantt(page, seed)
    const keys = () =>
      page
        .locator('[data-row-key]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row-key')))
    const all = [
      `group:${seed.phaseId}`,
      `task:${ids.planned}`,
      `task:${ids.p1}`,
      `milestone:${ids.launch}`,
      'group:none',
      `task:${ids.n1}`,
      `task:${ids.n2}`,
      `task:${ids.epic}`,
      `task:${ids.epicsub}`,
    ]
    // Phase grouping: the undated "Phase idea" stays in Design, "Loose idea" in No phase.
    expect(await keys()).toEqual(all)
    const toggle = (count: number) =>
      page.getByRole('button', { name: `Show only unscheduled tasks, ${count}` })
    await expect(toggle(3)).toHaveAttribute('aria-pressed', 'false')

    // Filter on: matches only; the dated parent "Epic" stays as a context row for its leftover.
    await toggle(3).click()
    await expect(toggle(3)).toHaveAttribute('aria-pressed', 'true')
    expect(await keys()).toEqual([
      `group:${seed.phaseId}`,
      `task:${ids.p1}`,
      'group:none',
      `task:${ids.n1}`,
      `task:${ids.epic}`,
      `task:${ids.epicsub}`,
    ])
    await expect(page.getByRole('button', { name: 'Design, 1 task' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'No phase, 2 tasks' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Epic, has dates/ })).toBeVisible()
    await expect(page.getByText('Drag across a row to schedule it')).toHaveCount(0)

    // Toggling it off restores the full outline exactly.
    await toggle(3).click()
    expect(await keys()).toEqual(all)
    await toggle(3).click()

    // Draw across the lanes in filter mode: each task leaves the list; nothing else moves.
    const draw = async (key: string, from: string) => {
      const lane = outlineRow(page, `task:${ids[key]}`).locator('[data-handle="lane"]')
      const box = await boxOf(lane)
      await dragBy(
        page,
        { x: await dayX(page, from, 'center'), y: box.y + box.height / 2 },
        2 * DAY_PX,
      )
    }
    await draw('p1', '2026-11-12')
    await expect
      .poll(() => stored(page, ids.p1))
      .toEqual({ start: '2026-11-12', due: '2026-11-14' })
    await expect(toggle(2)).toBeVisible()
    await expect(outlineRow(page, `task:${ids.p1}`)).toHaveCount(0)
    await expect(outlineRow(page, `group:${seed.phaseId}`)).toHaveCount(0)
    await draw('n1', '2026-11-12')
    await expect
      .poll(() => stored(page, ids.n1))
      .toEqual({ start: '2026-11-12', due: '2026-11-14' })
    await draw('epicsub', '2026-11-12')
    await expect
      .poll(() => stored(page, ids.epicsub))
      .toEqual({ start: '2026-11-12', due: '2026-11-14' })

    // Nothing left: the toggle stays (pressed, 0) and an empty state offers the way back.
    await expect(toggle(0)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('No tasks without dates')).toBeVisible()
    expect(await keys()).toEqual([])
    await page.getByRole('button', { name: 'Show all tasks' }).click()
    expect(await keys()).toEqual(all)
    await expect(page.getByRole('button', { name: /^Show only unscheduled tasks/ })).toHaveCount(0)
    // The overlay and the toggle are gone: focus lands on a row in view, not on <body>.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('[data-row-key]') !== null))
      .toBe(true)
    // The rows did not move, and the scheduled tasks now have bars.
    await expect(bar(page, ids.p1)).toHaveAccessibleName(
      'Phase idea, Nov 12 – Nov 14, 3 days, To Do',
    )
  })

  test('across a year boundary a bar keeps its length, and the header shows the new year', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      deps: [],
      milestones: [],
      tasks: [{ key: 'across', title: 'Across', start: '2026-12-30', due: '2027-01-02' }],
    })
    const { ids } = seed
    await openGantt(page, seed, 'day', '2026-12-30T10:00:00+08:00')
    await expect(bar(page, ids.across)).toHaveAccessibleName(
      'Across, Dec 30 – Jan 2, 2027, 4 days, To Do',
    )
    await expect(chart(page).getByText('Jan 2027', { exact: true })).toBeVisible()

    await moveBar(page, ids.across, 3)
    await expect
      .poll(() => stored(page, ids.across))
      .toEqual({ start: '2027-01-02', due: '2027-01-05' })
    await moveBar(page, ids.across, -5)
    await expect
      .poll(() => stored(page, ids.across))
      .toEqual({ start: '2026-12-28', due: '2026-12-31' })
    await expect(bar(page, ids.across)).toHaveAccessibleName(
      'Across, Dec 28 – Dec 31, 4 days, To Do',
    )
  })

  test('Tab never leaves a focused bar hidden behind the sticky outline (and a click never moves the view)', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      deps: [],
      milestones: [],
      tasks: [{ key: 'old', title: 'Old', start: '2026-10-27', due: '2026-10-29' }],
    })
    const { ids } = seed
    await openGantt(page, seed, 'day')
    const scroller = chart(page)
    const old = bar(page, ids.old)
    const area = await boxOf(scroller)
    const relX = async () => Math.round((await boxOf(old)).x - area.x)

    // Scroll right until the whole bar (3 days = 108px) sits under the 300px outline.
    const start = await relX()
    await scroller.evaluate((el, delta) => {
      el.scrollLeft += delta
    }, start - 100)
    await expect.poll(relX).toBe(100)

    await page.getByRole('button', { name: 'Old', exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(old).toBeFocused()
    // It scrolled into the visible part of the timeline, clear of the outline.
    await expect.poll(relX).toBeGreaterThanOrEqual(300)

    // A click on a half-hidden bar does NOT make the view jump under the pointer.
    await scroller.evaluate((el) => {
      el.scrollLeft += 90
    })
    await expect.poll(relX).toBeLessThan(300)
    const hidden = await boxOf(old)
    await page.mouse.click(hidden.x + hidden.width - 15, hidden.y + hidden.height / 2)
    await expect(page).toHaveURL(new RegExp(`task=${ids.old}`))
    expect(Math.abs((await boxOf(old)).x - hidden.x)).toBeLessThan(1.5)
  })

  test('Auto mode: a failed Apply rolls every task back, and Retry writes them all', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      mode: 'auto',
      deps: [['alpha', 'bravo']],
      tasks: [
        { key: 'alpha', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
        { key: 'bravo', title: 'Bravo', start: '2026-11-08', due: '2026-11-10' },
      ],
      milestones: [],
    })
    const { ids } = seed
    await openGantt(page, seed)
    await moveBar(page, ids.alpha, 2)
    const dialog = page.getByRole('dialog', { name: 'Move dependent tasks?' })
    await failNextWrites(page, 1)
    await dialog.getByRole('button', { name: 'Apply 2 changes' }).click()
    await expect(dialog).toHaveCount(0)
    const failed = toast(page, /Couldn't/)
    await expect(failed).toBeVisible()
    // Nothing moved, in the chart or in storage.
    await expect(bar(page, ids.alpha)).toHaveAccessibleName('Alpha, Nov 5 – Nov 7, 3 days, To Do')
    await expect(bar(page, ids.bravo)).toHaveAccessibleName('Bravo, Nov 8 – Nov 10, 3 days, To Do')
    expect(await stored(page, ids.alpha)).toEqual({ start: '2026-11-05', due: '2026-11-07' })
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-08', due: '2026-11-10' })

    await failed.locator('[data-button]', { hasText: 'Retry' }).click()
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-07', due: '2026-11-09' })
    await expect
      .poll(() => stored(page, ids.bravo))
      .toEqual({ start: '2026-11-10', due: '2026-11-12' })
  })

  test('Week scale: the today pill replaces the label it would cover instead of overlapping it', async ({
    page,
  }) => {
    await openGantt(page, seedWorkspace(), 'week')
    // Today (Wed Nov 4) falls in the week of Nov 2, whose label would sit under the pill.
    await expect(chart(page).getByText('Nov 4', { exact: true })).toBeVisible()
    await expect(page.locator('[title="Week of Nov 2, 2026"]')).toHaveText('')
    await expect(page.locator('[title="Week of Oct 26, 2026"]')).toHaveText('Oct 26')
    await expect(page.locator('[title="Week of Nov 9, 2026"]')).toHaveText('Nov 9')
  })

  test('the view bar stays usable at 1024px: icon-only controls keep their names and clear the tabs', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 700 })
    const seed = seedWorkspace({
      deps: [['alpha', 'bravo']],
      milestones: [],
      tasks: [
        { key: 'alpha', title: 'Alpha', start: '2026-11-05', due: '2026-11-10' },
        { key: 'bravo', title: 'Bravo', start: '2026-11-08', due: '2026-11-11' },
        { key: 'undated', title: 'Undated' },
      ],
    })
    await openGantt(page, seed, 'week')

    // Words give way to icons (the names stay for screen readers)…
    const chip = page.getByRole('button', { name: '1 conflict', exact: true })
    const unscheduled = page.getByRole('button', { name: 'Show only unscheduled tasks, 1' })
    const mode = page.getByRole('button', { name: 'Dependencies: Manual' })
    for (const control of [chip, unscheduled, mode]) await expect(control).toBeVisible()
    expect((await boxOf(chip)).width).toBeLessThan(70)
    expect((await boxOf(unscheduled)).width).toBeLessThan(70)
    expect((await boxOf(mode)).width).toBeLessThan(70)
    // …so nothing runs into the Board / Gantt tabs on the left.
    const tabs = await boxOf(page.getByRole('link', { name: 'Gantt', exact: true }))
    expect((await boxOf(chip)).x).toBeGreaterThanOrEqual(tabs.x + tabs.width)
    const month = await boxOf(page.getByRole('radio', { name: 'Month' }))
    expect(month.x + month.width).toBeLessThanOrEqual(1024)
  })

  test('keyboard nudging keeps the bar in view: it never slides under the outline or off the edge', async ({
    page,
  }) => {
    const seed = seedWorkspace({ deps: [], milestones: [] })
    const { ids } = seed
    await openGantt(page, seed, 'day')
    const scroller = chart(page)
    const alpha = bar(page, ids.alpha)
    const visible = async () => {
      const [b, s] = await Promise.all([boxOf(alpha), boxOf(scroller)])
      return { left: b.x - s.x, right: b.x + b.width - s.x, area: s.width }
    }

    await alpha.focus()
    // 15 days earlier = Oct 21, far left of the 300px outline on screen.
    for (let i = 0; i < 15; i += 1) await page.keyboard.press('Alt+ArrowLeft')
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-10-21', due: '2026-10-23' })
    await expect.poll(async () => (await visible()).left).toBeGreaterThanOrEqual(300)
    // And 30 days later it is still on screen, not past the right edge.
    for (let i = 0; i < 30; i += 1) await page.keyboard.press('Alt+ArrowRight')
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-20', due: '2026-11-22' })
    await expect
      .poll(async () => (await visible()).right)
      .toBeLessThanOrEqual((await visible()).area)
    await expect.poll(async () => (await visible()).left).toBeGreaterThanOrEqual(300)
    await expect(alpha).toBeFocused()
  })
})
