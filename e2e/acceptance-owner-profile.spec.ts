/// <reference lib="dom" />
/**
 * The owner's machine profile: a Mac user agent, zh-TW browser, Taipei, Retina (DPR 2), 1440x900, the
 * real clock, nothing seeded, no test hooks: PRD 9.1 items 1-12 and 14 in one sitting, UI only. The
 * other acceptance specs pin the clock, seed the data and run en-US at DPR 1.
 */
import { type Locator, type Page } from '@playwright/test'
import {
  bar,
  expect,
  linkDrag,
  moveBar,
  resizeBar,
  stored,
  storedDependencies,
  test,
  toast,
  toastButton,
} from './acceptance-gantt.helpers.ts'

test.use({
  locale: 'zh-TW',
  timezoneId: 'Asia/Taipei',
  deviceScaleFactor: 2,
  viewport: { width: 1440, height: 900 },
  actionTimeout: 20_000,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
})
test.setTimeout(280_000)

const KEY = 'cairn:local:workspace:v1'
type Db = {
  projects: Record<
    string,
    { id: string; name: string; startDate: string | null; dueDate: string | null }
  >
  tasks: Record<
    string,
    { id: string; title: string; status: string; startDate: string | null; dueDate: string | null }
  >
}
const db = (page: Page) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}') as Db, KEY)
const idOf = async (page: Page, title: string) =>
  Object.values((await db(page)).tasks).find((t) => t.title === title)!.id

function plus(today: string, n: number): string {
  const [y, m, d] = today.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
const todayInTaipei = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date())

function dayPattern(date: string): RegExp {
  const [year, month, day] = date.split('-').map(Number)
  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  })
  const s =
    day % 10 === 1 && day !== 11
      ? 'st'
      : day % 10 === 2 && day !== 12
        ? 'nd'
        : day % 10 === 3 && day !== 13
          ? 'rd'
          : 'th'
  return new RegExp(`${monthName} ${day}${s}, ${year}`)
}

async function pickDate(page: Page, scope: Locator, field: string, date: string) {
  await scope.getByRole('button', { name: new RegExp(`^${field}:`) }).click()
  const picker = page.getByRole('dialog', { name: field, exact: true })
  const day = picker.getByRole('button', { name: dayPattern(date) })
  for (let step = 0; step < 4 && (await day.count()) === 0; step++) {
    await picker.getByRole('button', { name: 'Go to the Next Month' }).click()
  }
  await day.click()
  await expect(picker).toBeHidden()
}

const listArea = (page: Page) => page.locator('[data-list-scroll]')
const taskRow = (page: Page, title: string) =>
  page
    .locator('[data-task-row]')
    .filter({ has: page.getByRole('button', { name: `Move ${title}`, exact: true }) })
const rowTitles = (scope: Locator) =>
  scope.locator('[data-task-row]').evaluateAll((rows) =>
    rows.map((row) => {
      const title = row.querySelector('button[aria-label^="Move "]')?.getAttribute('aria-label')
      return (row.getAttribute('data-depth') === '1' ? '↳ ' : '') + (title ?? '?').slice(5)
    }),
  )

async function editTask(
  page: Page,
  title: string,
  change: (dialog: Locator) => Promise<void>,
): Promise<void> {
  await taskRow(page, title).getByRole('button', { name: title, exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: `Edit task: ${title}` })
  await change(dialog)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog).toBeHidden()
}

test('owner profile: every main flow, unseeded, real clock, zh-TW, Retina', async ({ page }) => {
  const today = todayInTaipei()
  const A = '文獻回顧'
  const B = '撰寫初稿'
  const C = '口試準備'
  const D = '投稿'

  // AC-1 + AC-2
  await page.goto('/overview')
  await expect(page.getByRole('heading', { name: 'Overview' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Create project' }).click()
  const newProject = page.getByRole('dialog', { name: 'New project' })
  await newProject.getByRole('textbox', { name: 'Name' }).fill('研究計畫 Research')
  await newProject.getByRole('button', { name: 'Create project' }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/list$/)

  // AC-3 name only, then the rest in the modal
  const first = page.getByRole('textbox', { name: 'Add your first task' })
  await first.fill(A)
  await first.press('Enter')
  await expect(taskRow(page, A)).toBeVisible()
  const input = page.getByRole('textbox', { name: 'New task' })
  if (!(await input.isVisible())) {
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
  }
  for (const title of [B, C, D]) {
    await input.fill(title)
    await input.press('Enter')
  }
  await input.press('Escape')
  await expect.poll(() => rowTitles(listArea(page))).toEqual([A, B, C, D])

  await editTask(page, A, async (dialog) => {
    await dialog.getByRole('textbox', { name: 'Description' }).fill('讀十篇論文\n並摘要')
    await dialog.getByRole('button', { name: /^Priority:/ }).click()
    await page.getByRole('menuitemradio', { name: /High/ }).click()
    await pickDate(page, dialog, 'Start date', plus(today, 1))
    await pickDate(page, dialog, 'Due date', plus(today, 3))
  })
  await editTask(page, B, async (dialog) => {
    await pickDate(page, dialog, 'Start date', plus(today, 6))
    await pickDate(page, dialog, 'Due date', plus(today, 8))
  })
  await editTask(page, C, async (dialog) => {
    await pickDate(page, dialog, 'Due date', today)
  })
  // Dates show in English, whatever the browser's language.
  await expect(taskRow(page, A)).toContainText(/[A-Z][a-z]{2} \d+/)
  await expect(taskRow(page, A)).not.toContainText(/\d+月/)

  // AC-4 subtasks and a milestone
  await taskRow(page, D).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add subtask' }).click()
  const sub = page.getByRole('textbox', { name: `New subtask of ${D}` })
  await sub.fill('選期刊')
  await sub.press('Enter')
  await sub.fill('整理格式')
  await sub.press('Enter')
  await sub.press('Escape')
  await expect.poll(() => rowTitles(listArea(page))).toEqual([A, B, C, D, '↳ 選期刊', '↳ 整理格式'])
  await page.getByRole('button', { name: 'Project actions' }).click()
  await page.getByRole('menuitem', { name: 'Add milestone…' }).click()
  const ms = page.getByRole('dialog', { name: 'New milestone' })
  await ms.getByRole('textbox', { name: 'Name' }).fill('口試')
  await pickDate(page, ms, 'Date', plus(today, 10))
  await ms.getByRole('button', { name: 'Create milestone' }).click()
  await expect(toast(page, 'Milestone created')).toBeVisible()

  // Progress: 1 of 5 leaves, the parent and the milestone do not count.
  await taskRow(page, '選期刊')
    .getByRole('button', { name: /^Status:/ })
    .click()
  await page.getByRole('menuitemradio', { name: 'Done' }).click()
  const progress = page.getByRole('progressbar', { name: 'Project progress' })
  await expect(progress).toHaveAttribute('aria-valuenow', '20')

  // Toasts leave by themselves on the real clock, also across a page change (JOURNEY-TOASTS-CLOCK).
  await page.mouse.move(720, 880)
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 25_000 })

  // AC-5 drag + reload
  await taskRow(page, C).hover()
  const handle = await taskRow(page, C)
    .getByRole('button', { name: /^Move / })
    .boundingBox()
  const target = await taskRow(page, A).boundingBox()
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle!.x + 8, handle!.y - 6, { steps: 3 })
  await page.mouse.move(target!.x + 300, target!.y + target!.height * 0.2, { steps: 14 })
  await page.waitForTimeout(120)
  await page.mouse.up()
  const order = [C, A, B, D, '↳ 選期刊', '↳ 整理格式']
  await expect.poll(() => rowTitles(listArea(page))).toEqual(order)
  await page.reload()
  await expect.poll(() => rowTitles(listArea(page))).toEqual(order)

  // AC-6 Board
  await page.getByRole('link', { name: 'Board', exact: true }).click()
  const column = (name: string) =>
    page.getByRole('region', { name: new RegExp(`^${name} \\d+ tasks?$`) })
  await expect(column('To Do')).toHaveAccessibleName('To Do 4 tasks')
  const cardA = column('To Do').getByText(A, { exact: true })
  const box = await cardA.boundingBox()
  const prog = await column('In Progress').boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + 12, box!.y + 12, { steps: 3 })
  await page.mouse.move(prog!.x + prog!.width / 2, prog!.y + 120, { steps: 12 })
  await page.waitForTimeout(120)
  await page.mouse.up()
  await expect(column('In Progress')).toHaveAccessibleName('In Progress 1 task')
  await page.getByRole('link', { name: 'List', exact: true }).click()
  await expect(taskRow(page, A).getByRole('button', { name: 'Status: In Progress' })).toBeVisible()
  await expect.poll(() => rowTitles(listArea(page))).toEqual(order)

  // AC-7 Gantt on all three scales, with a reload after each
  await page.getByRole('link', { name: 'Gantt', exact: true }).click()
  await page.getByRole('radio', { name: /^day$/i }).click()
  const idA = await idOf(page, A)
  const idB = await idOf(page, B)
  await expect(bar(page, idA)).toBeVisible()
  await moveBar(page, idA, 1)
  await expect.poll(() => stored(page, idA)).toEqual({ start: plus(today, 2), due: plus(today, 4) })
  await resizeBar(page, idA, 'end', 1)
  await expect.poll(() => stored(page, idA)).toEqual({ start: plus(today, 2), due: plus(today, 5) })
  await resizeBar(page, idA, 'start', -1)
  await expect.poll(() => stored(page, idA)).toEqual({ start: plus(today, 1), due: plus(today, 5) })
  await page.reload()
  await expect(bar(page, idA)).toBeVisible()
  expect(await stored(page, idA)).toEqual({ start: plus(today, 1), due: plus(today, 5) })
  await page.getByRole('radio', { name: /^week$/i }).click()
  await expect(bar(page, idB)).toBeVisible()
  await moveBar(page, idB, 7, 'week')
  await expect
    .poll(() => stored(page, idB))
    .toEqual({ start: plus(today, 13), due: plus(today, 15) })
  await page.getByRole('radio', { name: /^month$/i }).click()
  await moveBar(page, idB, -6, 'month')
  await expect.poll(() => stored(page, idB)).toEqual({ start: plus(today, 7), due: plus(today, 9) })
  await page.reload()
  await expect(page.getByRole('radio', { name: /^month$/i })).toBeChecked()
  expect(await stored(page, idB)).toEqual({ start: plus(today, 7), due: plus(today, 9) })

  // AC-8 A -> B, delay A, conflict, review + apply
  await page.getByRole('radio', { name: /^day$/i }).click()
  await expect(bar(page, idB)).toBeVisible()
  await page.keyboard.press('t') // back to Today so both bars are in the window
  await page.waitForTimeout(800)
  await linkDrag(page, idA, idB)
  await expect.poll(() => storedDependencies(page)).toEqual([`${idA}>${idB}`])
  await moveBar(page, idA, 3) // A +4..+8 overlaps B +7..+9
  await expect(toast(page, '1 dependency conflict')).toBeVisible()
  expect(await stored(page, idB)).toEqual({ start: plus(today, 7), due: plus(today, 9) })
  await toastButton(page, 'Review').click()
  const preview = page.getByRole('dialog', { name: 'Resolve dependency conflicts' })
  await expect(preview).toBeVisible()
  await preview.getByRole('button', { name: 'Apply 1 change' }).click()
  await expect
    .poll(() => stored(page, idB))
    .toEqual({ start: plus(today, 9), due: plus(today, 11) })
  await page.reload()
  await expect(bar(page, idB)).toBeVisible()
  expect(await stored(page, idB)).toEqual({ start: plus(today, 9), due: plus(today, 11) })
  await expect(page.getByRole('button', { name: /conflict/ })).toHaveCount(0)

  // AC-9 the cycle is refused
  await linkDrag(page, idB, idA)
  await expect.poll(() => storedDependencies(page)).toEqual([`${idA}>${idB}`])
  await page.mouse.move(720, 880)

  // AC-10 + AC-11 + AC-12
  await page.getByRole('link', { name: 'Overview', exact: true }).click()
  await expect(page.getByText('20%').first()).toBeVisible()
  await expect(page.getByText('口試', { exact: false }).first()).toBeVisible()
  await page.getByRole('link', { name: /^My Tasks/ }).click()
  await page.getByRole('link', { name: /^Today/ }).click()
  await expect(page.getByText(C, { exact: true }).first()).toBeVisible()
  await expect(page.getByText(A, { exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: /^All/ }).click()
  await expect(page.getByText(A, { exact: true }).first()).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  const search = page.getByRole('dialog', { name: 'Search' })
  await search.getByRole('combobox').fill('初稿')
  await expect(search.getByRole('option').filter({ hasText: B })).toBeVisible()
  await search.getByRole('option').filter({ hasText: B }).click()
  await expect(page.getByRole('dialog', { name: `Edit task: ${B}` })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('link', { name: 'Timeline', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Milestone 口試/ }).first()).toBeVisible()

  // AC-14 dark, collapse, reload keeps both
  await page
    .getByRole('button', { name: /^Theme:/ })
    .first()
    .click()
  await page.getByRole('menuitemradio', { name: 'Dark' }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
  await page.keyboard.press('[')
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeLessThan(80)
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 999).toBeLessThan(80)
})

test('AC-9: project dates cannot be illegal in the project dialog', async ({ page }) => {
  const today = todayInTaipei()
  await page.goto('/projects')
  await page
    .getByRole('button', { name: /New project|Create project/ })
    .first()
    .click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Name' }).fill('日期測試')
  await pickDate(page, dialog, 'Start date', plus(today, 5))
  await dialog.getByRole('button', { name: /^Due date:/ }).click()
  const picker = page.getByRole('dialog', { name: 'Due date', exact: true })
  const earlier = picker.getByRole('button', { name: dayPattern(plus(today, 2)) })
  if ((await earlier.count()) && (await earlier.isEnabled())) {
    await earlier.click()
    await expect(dialog.getByRole('button', { name: 'Create project' })).toBeDisabled()
  } else {
    await page.keyboard.press('Escape')
  }
  const projects = Object.values((await db(page)).projects ?? {})
  for (const project of projects) {
    if (project.startDate && project.dueDate)
      expect(project.dueDate >= project.startDate).toBe(true)
  }
})
