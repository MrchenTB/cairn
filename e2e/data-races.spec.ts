/// <reference lib="dom" />
/**
 * Data races a user can cause with two tabs (or two devices): a row deleted elsewhere while it is
 * being dragged here, and a delete from a tab that has not seen the subtasks added elsewhere.
 */
import { randomUUID } from 'node:crypto'
import { generateNKeysBetween } from 'fractional-indexing'
import { expect, test as base, type Page, type BrowserContext } from '@playwright/test'

const KEY = 'cairn:local:workspace:v1'
const NOW = '2026-11-03T08:00:00.000Z'

const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text())
      })
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
      await use(errors)
      expect(errors).toEqual([])
    },
    { auto: true },
  ],
})
test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US', reducedMotion: 'reduce' })

function seed(titles: string[], dated = true) {
  const projectId = randomUUID()
  const ids: Record<string, string> = {}
  const tasks: Record<string, unknown> = {}
  const keys = generateNKeysBetween(null, null, titles.length)
  titles.forEach((title, i) => {
    const id = randomUUID()
    ids[title] = id
    tasks[id] = {
      id,
      projectId,
      phaseId: null,
      parentTaskId: null,
      title,
      description: null,
      status: 'todo',
      priority: 'none',
      startDate: dated ? `2026-11-${String(3 + i).padStart(2, '0')}` : null,
      dueDate: dated ? `2026-11-${String(6 + i).padStart(2, '0')}` : null,
      sortOrder: keys[i],
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
        name: 'Race',
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

async function open(context: BrowserContext, page: Page, s: ReturnType<typeof seed>, view: string) {
  await context.addInitScript(
    ({ key, db }) => {
      if (!localStorage.getItem(key) && !sessionStorage.getItem('seeded-x'))
        localStorage.setItem(key, JSON.stringify(db))
      sessionStorage.setItem('seeded-x', '1')
      const real = Date.now.bind(Date)
      ;(window as Window & { __skew?: number }).__skew = 0
      Date.now = () => real() + ((window as Window & { __skew?: number }).__skew ?? 0)
    },
    { key: KEY, db: s.db },
  )
  await page.goto(`/projects/${s.projectId}/${view}`)
}

/** The other tab (or device) deletes a task; this tab learns of it on focus. */
async function deleteElsewhereAndFocus(page: Page, id: string) {
  await page.evaluate(
    ({ key, id }) => {
      const db = JSON.parse(localStorage.getItem(key) as string)
      delete db.tasks[id]
      localStorage.setItem(key, JSON.stringify(db))
      const w = window as Window & { __skew?: number }
      w.__skew = (w.__skew ?? 0) + 120_000
      window.dispatchEvent(new Event('focus'))
    },
    { key: KEY, id },
  )
}

const stored = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) as string), KEY)

test('board: pointer drag of a card the other tab deleted', async ({ page, context }) => {
  const s = seed(['A', 'B', 'C'], false)
  await open(context, page, s, 'board')
  const card = page.getByRole('button', { name: 'A', exact: true })
  await expect(card).toBeVisible()
  const box = (await card.boundingBox())!
  const target = (await page
    .getByRole('region', { name: /^In Progress \d+ tasks?$/ })
    .boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8, { steps: 3 })
  await page.mouse.move(target.x + target.width / 2, target.y + 80, { steps: 8 })
  await deleteElsewhereAndFocus(page, s.ids.A)
  await page.waitForTimeout(300)
  await page.mouse.up()
  await page.waitForTimeout(400)
  const db = await stored(page)
  expect(Object.keys(db.tasks)).toHaveLength(2)
  expect(db.tasks[s.ids.A]).toBeUndefined()
  await expect(page.getByRole('button', { name: 'A', exact: true })).toHaveCount(0)
  // The board still works.
  const b = page.getByRole('button', { name: 'B', exact: true })
  const bb = (await b.boundingBox())!
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2)
  await page.mouse.down()
  await page.mouse.move(bb.x + bb.width / 2 + 8, bb.y + bb.height / 2 + 8, { steps: 3 })
  await page.mouse.move(target.x + target.width / 2, target.y + 80, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await stored(page)).tasks[s.ids.B].status).toBe('in_progress')
})

test('board: keyboard drag, neighbour deleted, then dropped', async ({ page, context }) => {
  const s = seed(['A', 'B', 'C'], false)
  await open(context, page, s, 'board')
  const card = page.getByRole('button', { name: 'C', exact: true })
  await card.focus()
  await page.waitForTimeout(50)
  await page.keyboard.press('Space')
  await page.waitForTimeout(100)
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(100)
  await deleteElsewhereAndFocus(page, s.ids.A)
  await page.waitForTimeout(300)
  await page.keyboard.press('Space')
  await page.waitForTimeout(300)
  const db = await stored(page)
  expect(Object.keys(db.tasks)).toHaveLength(2)
  await expect(page.getByRole('button', { name: 'C', exact: true })).toBeVisible()
})

test('list: pointer drag of a row the other tab deleted', async ({ page, context }) => {
  const s = seed(['A', 'B', 'C'], false)
  await open(context, page, s, 'list')
  await expect(page.getByRole('button', { name: /^Move / }).first()).toBeAttached()
  const row = page
    .locator('[data-task-row], li, tr')
    .filter({ has: page.getByRole('button', { name: /^Move A/ }) })
    .first()
  await row.hover()
  const source = page.getByRole('button', { name: /^Move A/ }).first()
  const box = (await source.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 8, { steps: 3 })
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 90, { steps: 8 })
  await deleteElsewhereAndFocus(page, s.ids.A)
  await page.waitForTimeout(300)
  await page.mouse.up()
  await page.waitForTimeout(400)
  const db = await stored(page)
  expect(db.tasks[s.ids.A]).toBeUndefined()
  expect(Object.keys(db.tasks)).toHaveLength(2)
})

test('gantt: bar drag of a task the other tab deleted', async ({ page, context }) => {
  const s = seed(['A', 'B', 'C'])
  await open(context, page, s, 'gantt')
  const bar = page.locator(`[data-task-id="${s.ids.A}"], [data-bar-id="${s.ids.A}"]`).first()
  await page.waitForTimeout(800)
  let box = await bar.boundingBox()
  if (!box) {
    box = (await page.getByRole('button', { name: /^A\b/ }).first().boundingBox())!
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 })
  await deleteElsewhereAndFocus(page, s.ids.A)
  await page.waitForTimeout(300)
  await page.mouse.up()
  await expect(page.getByText('That task no longer exists.')).toBeVisible()
  const db = await stored(page)
  expect(db.tasks[s.ids.A]).toBeUndefined()
  expect(Object.keys(db.tasks)).toHaveLength(2)
  expect(db.tasks[s.ids.B].startDate).toBe('2026-11-04')
})

test('list: a delete from a stale tab never takes subtasks added elsewhere', async ({
  page,
  context,
}) => {
  const s = seed(['Parent', 'Other'], false)
  await open(context, page, s, 'list')
  const row = page
    .locator('[data-task-row]')
    .filter({ has: page.getByRole('button', { name: 'Move Parent', exact: true }) })
  await expect(row).toBeVisible()
  // The other tab adds a subtask; this tab has not refreshed.
  const other = await context.newPage()
  await other.goto(`/projects/${s.projectId}/list`)
  const otherRow = other
    .locator('[data-task-row]')
    .filter({ has: other.getByRole('button', { name: 'Move Parent', exact: true }) })
  await otherRow.click({ button: 'right' })
  await other.getByRole('menuitem', { name: 'Add subtask' }).click()
  const input = other.getByRole('textbox', { name: 'New subtask of Parent' })
  await input.fill('Made elsewhere')
  await input.press('Enter')
  await expect.poll(async () => Object.keys((await stored(other)).tasks)).toHaveLength(3)
  await other.close()

  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete task…' }).click()
  // Only "Delete task": this tab knows of no subtasks, so it cannot ask what to do with them.
  await page.getByRole('button', { name: 'Delete task', exact: true }).click()

  await expect(page.getByText("Couldn't delete task")).toBeVisible()
  const titles = Object.values((await stored(page)).tasks as Record<string, { title: string }>)
    .map((task) => task.title)
    .sort()
  expect(titles).toEqual(['Made elsewhere', 'Other', 'Parent'])
  // The refresh that follows brings the parent back with the subtask, so a new delete asks.
  await expect(row).toBeVisible()
  await expect(row).toContainText('0/1')
})
