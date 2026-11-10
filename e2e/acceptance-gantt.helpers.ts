/// <reference lib="dom" />
/**
 * Shared helpers of the Gantt acceptance spec (e2e/acceptance-gantt.spec.ts): a seeded local
 * workspace (the same shape the store writes), time pinned to Wed 2026-11-04 in Asia/Taipei, and
 * real-mouse drag helpers that read pixel positions from the rendered time header.
 *
 * Not a spec itself (the file name does not match Playwright's test pattern).
 */
import { randomUUID } from 'node:crypto'
import { expect, test as base, type Locator, type Page } from '@playwright/test'
import { AUTO_SCROLL_EDGE_PX, RESIZE_HANDLE_WIDTH } from '../src/features/gantt/model/constants.ts'

export const LOCAL_WORKSPACE_KEY = 'cairn:local:workspace:v1'
export const SCALES_KEY = 'cairn:gantt-scales'
export const NOW = '2026-11-04T10:00:00+08:00'
const TIMESTAMP = '2026-11-03T08:00:00.000Z'
/** Pixels per day on each scale (SCALES in src/features/gantt/model/scale.ts). */
export const PX = { day: 36, week: 16, month: 5 } as const

/** Every test fails if the page logs a console error or throws. */
export const test = base.extend<{ consoleErrors: string[] }>({
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
export { expect }

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export type Scale = 'day' | 'week' | 'month'
type Status = 'todo' | 'in_progress' | 'done'

export interface TaskSpec {
  key: string
  title: string
  start?: string
  due?: string
  status?: Status
  phase?: boolean
  parent?: string
}

export interface MilestoneSpec {
  key: string
  name: string
  date: string
  phase?: boolean
}

export interface Seed {
  projectId: string
  phaseId: string
  /** id by key (tasks, milestones, "a->b" dependencies) */
  ids: Record<string, string>
  db: unknown
}

export interface SeedOptions {
  mode?: 'manual' | 'auto'
  tasks?: TaskSpec[]
  milestones?: MilestoneSpec[]
  deps?: [string, string][]
}

export function seedWorkspace(options: SeedOptions = {}): Seed {
  const { mode = 'manual', tasks: specs = [], milestones: milestoneSpecs = [], deps = [] } = options
  const projectId = randomUUID()
  const phaseId = randomUUID()
  const ids: Record<string, string> = {}
  const tasks: Record<string, unknown> = {}
  for (const spec of specs) ids[spec.key] = randomUUID()
  let topOrder = 0
  const subOrder: Record<string, number> = {}
  for (const spec of specs) {
    const id = ids[spec.key]
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
      parentTaskId: spec.parent ? ids[spec.parent] : null,
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
export async function openGantt(
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

export function chart(page: Page): Locator {
  return page.getByRole('region', { name: 'Gantt chart' })
}

/** A task's bar / marker (a focusable button named "<title>, <dates>, <status>"). */
export function bar(page: Page, id: string): Locator {
  return page.locator(`[data-task-id="${id}"][data-link-target]`)
}

export function outlineRow(page: Page, key: string): Locator {
  return page.locator(`[data-row-key="${key}"]`)
}

/** Day-cell title in the time header (Day scale), e.g. "Wednesday, November 4, 2026". */
export function dayTitle(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/** Viewport x of the left edge / centre of a day column (Day scale). */
export async function dayX(
  page: Page,
  iso: string,
  at: 'left' | 'center' = 'left',
): Promise<number> {
  const box = await page.locator(`[title="${dayTitle(iso)}"]`).boundingBox()
  if (!box) throw new Error(`day ${iso} is not rendered`)
  return at === 'left' ? box.x : box.x + box.width / 2
}

export async function boxOf(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element is not visible')
  return box
}

/** Pointer drag with intermediate moves; `release: false` keeps the button down. */
export async function dragBy(
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

/** The element's box once it is the same on two animation frames in a row (layout and scroll settled). */
async function settledBox(locator: Locator) {
  await expect(locator).toBeVisible()
  return locator.evaluate(
    (element) =>
      new Promise<{ x: number; y: number; width: number; height: number }>((resolve) => {
        let last = ''
        const check = () => {
          const { x, y, width, height } = element.getBoundingClientRect()
          const key = `${x},${y},${width},${height}`
          if (key === last) resolve({ x, y, width, height })
          else {
            last = key
            requestAnimationFrame(check)
          }
        }
        requestAnimationFrame(check)
      }),
  )
}

/**
 * The viewport x range where a drag can press and release without the chart auto-scrolling: right
 * of the outline pane, left of a vertical scrollbar, and AUTO_SCROLL_EDGE_PX inside both ends of
 * the visible timeline. Inside those edge zones the chart scrolls once per animation frame, so how
 * far a drag lands there depends on the frame rate (a busy machine drops frames), not on the mouse.
 */
async function quietBand(page: Page): Promise<{ left: number; right: number }> {
  const paneWidth = Number(
    await page.getByRole('separator', { name: 'Resize task list' }).getAttribute('aria-valuenow'),
  )
  const scroller = await chart(page).evaluate((element) => ({
    left: element.getBoundingClientRect().left,
    width: element.clientWidth,
  }))
  // The same bounds as `autoScrollStep`: it scrolls only strictly closer than the edge distance.
  return {
    left: scroller.left + paneWidth + AUTO_SCROLL_EDGE_PX,
    right: scroller.left + scroller.width - AUTO_SCROLL_EDGE_PX,
  }
}

function outsideBand(band: { left: number; right: number }, x: number): boolean {
  return x < band.left || x > band.right
}

/**
 * Moves a bar by `days` (drag its body) at the given scale. It presses the bar's centre, or, when
 * the centre is hidden under the outline pane or in an auto-scroll zone (or the release point
 * would be), the nearest point of the bar where neither press nor release auto-scrolls; so the
 * pointer travel alone decides the new dates.
 */
export async function moveBar(
  page: Page,
  id: string,
  days: number,
  scale: Scale = 'day',
): Promise<void> {
  const box = await settledBox(bar(page, id))
  const dx = days * PX[scale]
  const band = await quietBand(page)
  const grip = Math.min(RESIZE_HANDLE_WIDTH + 1, box.width / 2)
  const lo = Math.max(box.x + grip, band.left, band.left - dx)
  const hi = Math.min(box.x + box.width - grip, band.right, band.right - dx)
  if (lo > hi) {
    throw new Error(
      `bar ${id} (x ${Math.round(box.x)}–${Math.round(box.x + box.width)}) cannot be moved ` +
        `${days} days between ${Math.round(band.left)} and ${Math.round(band.right)} without ` +
        'auto-scrolling: scroll it into view first',
    )
  }
  const x = Math.min(hi, Math.max(lo, box.x + box.width / 2))
  await dragBy(page, { x, y: box.y + box.height / 2 }, dx)
}

/** Resizes one end of a bar by `days` (drag its grip); the grip must not be in an auto-scroll zone. */
export async function resizeBar(
  page: Page,
  id: string,
  edge: 'start' | 'end',
  days: number,
  scale: Scale = 'day',
): Promise<void> {
  const box = await settledBox(bar(page, id))
  const x = edge === 'start' ? box.x + 3 : box.x + box.width - 3
  const dx = days * PX[scale]
  const band = await quietBand(page)
  if (outsideBand(band, x) || outsideBand(band, x + dx)) {
    throw new Error(
      `the ${edge} grip of bar ${id} (x ${Math.round(x)} → ${Math.round(x + dx)}) is outside ` +
        `${Math.round(band.left)}–${Math.round(band.right)}: the chart would auto-scroll`,
    )
  }
  await dragBy(page, { x, y: box.y + box.height / 2 }, dx)
}

/**
 * Draws a dependency from `from`'s finish dot (side "out") or start dot ("in") onto `to`'s bar.
 * `release: false` stops before the mouse button goes up (to read the live tooltip).
 */
export async function linkDrag(
  page: Page,
  fromId: string,
  toId: string,
  options: { side?: 'out' | 'in'; release?: boolean } = {},
): Promise<void> {
  const side = options.side ?? 'out'
  await bar(page, fromId).hover()
  const dot = await boxOf(
    page.locator(`[data-handle="link-${side}"][data-task-id="${fromId}"]`).first(),
  )
  const target = await boxOf(bar(page, toId))
  const from = { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 }
  await dragBy(
    page,
    from,
    target.x + target.width / 2 - from.x,
    target.y + target.height / 2 - from.y,
    { release: options.release },
  )
}

// ---------------------------------------------------------------------------
// Store inspection (what a reload would show) and failure injection
// ---------------------------------------------------------------------------

/** The task as stored in the local "database". */
export function stored(
  page: Page,
  id: string,
): Promise<{ start: string | null; due: string | null }> {
  return page.evaluate(
    ({ key, id }) => {
      const task = JSON.parse(localStorage.getItem(key) ?? '{}')?.tasks?.[id]
      return { start: task?.startDate ?? null, due: task?.dueDate ?? null }
    },
    { key: LOCAL_WORKSPACE_KEY, id },
  )
}

export function storedMilestoneDate(page: Page, id: string): Promise<string | null> {
  return page.evaluate(
    ({ key, id }) => JSON.parse(localStorage.getItem(key) ?? '{}')?.milestones?.[id]?.date ?? null,
    { key: LOCAL_WORKSPACE_KEY, id },
  )
}

/** Stored dependencies as "predecessorId>successorId" strings. */
export function storedDependencies(page: Page): Promise<string[]> {
  return page.evaluate(
    (key) =>
      Object.values(
        (JSON.parse(localStorage.getItem(key) ?? '{}')?.dependencies ?? {}) as Record<
          string,
          { predecessorId: string; successorId: string }
        >,
      ).map((d) => `${d.predecessorId}>${d.successorId}`),
    LOCAL_WORKSPACE_KEY,
  )
}

export function storedScheduleMode(page: Page, projectId: string): Promise<string | null> {
  return page.evaluate(
    ({ key, id }) => JSON.parse(localStorage.getItem(key) ?? '{}')?.projects?.[id]?.scheduleMode,
    { key: LOCAL_WORKSPACE_KEY, id: projectId },
  )
}

/** Counts writes of the local database (one store action = one write). */
export async function countWrites(page: Page): Promise<void> {
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

export function writes(page: Page): Promise<number> {
  return page.evaluate(() => (window as Window & { __writes?: number }).__writes ?? 0)
}

type TestHooks = { failNextWrites(count: number): void; setLatency(ms: number): void }
export function failNextWrites(page: Page, count: number): Promise<void> {
  return page.evaluate((n) => {
    ;(window as Window & { __cairnTest?: TestHooks }).__cairnTest?.failNextWrites(n)
  }, count)
}

export function toast(page: Page, text: string | RegExp): Locator {
  return page.locator('[data-sonner-toast]', { hasText: text })
}

export function toastButton(page: Page, label: string): Locator {
  return page.locator('[data-sonner-toast] [data-button]', { hasText: label })
}

/** The dependency line between two tasks (the 10px hit path of the SVG layer). */
export function depPath(page: Page, depId: string): Locator {
  return page.locator(`path[data-dep-id="${depId}"]`)
}

/** A point on a dependency line in viewport coordinates (its middle). */
export async function pointOnPath(path: Locator): Promise<{ x: number; y: number }> {
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
