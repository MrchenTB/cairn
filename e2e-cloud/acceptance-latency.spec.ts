/// <reference lib="dom" />
/**
 * Cloud mode at real network speed (PRD §5.4, §9.2): every API request takes 200 to 400 ms. Drags
 * followed at once by another edit, the focus refresh, a slow failure and its Retry, and a whole
 * session in the owner's profile. Expected every time: the server ends in the state the person
 * made, and the screen never shows an older value again once a newer one was on it (no flicker).
 * `CAIRN_SIM_LATENCY=200-400 npm run test:cloud` re-runs every other cloud spec the same way.
 */
import { type Locator, type Page } from '@playwright/test'
import {
  accessToken,
  expect,
  expectShell,
  listScroll,
  phaseGroup,
  rest,
  rowTitles,
  seedProject,
  sidebar,
  signUpNew,
  sim,
  syncIndicator,
  taskRow,
  test,
  toast,
} from './support.ts'

test.use({ locale: 'en-US', timezoneId: 'Asia/Taipei', viewport: { width: 1280, height: 800 } })

const LATENCY = [200, 400] as const

const statusButton = (page: Page, id: string) =>
  page.locator(`[data-task-row="${id}"]`).getByRole('button', { name: /^Status:/ })

async function setStatus(page: Page, id: string, status: string): Promise<void> {
  await statusButton(page, id).click()
  await page.getByRole('menuitemradio', { name: status }).click()
}

const dbTasks = (projectId: string) =>
  sim.sql<{
    id: string
    title: string
    status: string
    sort_order: string
    completed_at: string | null
  }>(
    'select id, title, status, sort_order, completed_at from public.tasks where project_id = $1 order by sort_order',
    [projectId],
  )

const dbStatuses = async (projectId: string) =>
  Object.fromEntries((await dbTasks(projectId)).map((t) => [t.title, t.status]))

const dbOrder = async (projectId: string) => (await dbTasks(projectId)).map((t) => t.title)

/** Every distinct picture of the list ("title:status" per row) or the board from now on. */
async function recordScreen(page: Page, kind: 'list' | 'board'): Promise<void> {
  await page.evaluate((what) => {
    const history: string[] = []
    const read = () => {
      let signature = ''
      if (what === 'list') {
        signature = Array.from(document.querySelectorAll('[data-task-row]'))
          .map((row) => {
            const title = row
              .querySelector('button[aria-label^="Move "]')
              ?.getAttribute('aria-label')
            const status = row
              .querySelector('button[aria-label^="Status:"]')
              ?.getAttribute('aria-label')
            return `${title?.slice(5)}:${status?.slice(8)}`
          })
          .join('|')
      } else {
        signature = Array.from(document.querySelectorAll('section[aria-label], [role="region"]'))
          .filter((region) =>
            /^(To Do|In Progress|Done) \d+ tasks?$/.test(region.getAttribute('aria-label') ?? ''),
          )
          .map((region) => {
            const name = (region.getAttribute('aria-label') ?? '').replace(/ \d+ tasks?$/, '')
            const cards = Array.from(region.querySelectorAll('[data-card-activator]')).map(
              (card) => card.getAttribute('aria-label') ?? '',
            )
            return `${name}=${cards.join(',')}`
          })
          .join('|')
      }
      if (signature && history[history.length - 1] !== signature) history.push(signature)
    }
    new MutationObserver(read).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    read()
    ;(window as unknown as { __screens: string[] }).__screens = history
  }, kind)
}

const screens = (page: Page) =>
  page.evaluate(() => (window as unknown as { __screens: string[] }).__screens)

/** A picture seen again after a different one is a flicker back to an older state. */
function flickers(history: string[]): string[] {
  return history.filter((shot, index) => history.indexOf(shot) !== index)
}

async function dragRow(page: Page, title: string, overTitle: string): Promise<void> {
  const source = taskRow(page, title)
  await source.hover()
  const handle = await source.getByRole('button', { name: /^Move / }).boundingBox()
  const target = await taskRow(page, overTitle).boundingBox()
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle!.x + handle!.width / 2 + 6, handle!.y - 6, { steps: 3 })
  await page.mouse.move(target!.x + 300, target!.y + target!.height * 0.2, { steps: 14 })
  await expect(page.locator('[id^="DndLiveRegion"]')).toHaveText(
    new RegExp(`^${title} is over ${overTitle}\\.$`),
  )
  await page.mouse.up()
}

const column = (page: Page, name: string) =>
  page.getByRole('region', { name: new RegExp(`^${name} \\d+ tasks?$`) })
const card = (page: Page, title: string) => page.getByRole('button', { name: title, exact: true })
const cardTitles = (region: Locator) =>
  region
    .locator('[data-card-activator]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label') ?? ''))

async function dragCard(page: Page, title: string, to: { x: number; y: number }): Promise<void> {
  const box = await card(page, title).boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width / 2 + 6, box!.y + box!.height / 2 + 6, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.waitForTimeout(150)
  await page.mouse.up()
}

const FOUR = {
  tasks: [
    { key: 'a', title: 'Alpha' },
    { key: 'b', title: 'Beta' },
    { key: 'c', title: 'Gamma' },
    { key: 'd', title: 'Delta' },
  ],
}

test.describe('every request takes 200 to 400 ms', () => {
  test('List: a drag, then a status change and another drag before the first answer: server and screen agree, no flicker', async ({
    page,
  }) => {
    await signUpNew(page)
    const { projectId } = await seedProject(page, FOUR)
    await expect
      .poll(() => rowTitles(listScroll(page)))
      .toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
    await sim.latency(...LATENCY)
    const startedAt = Date.now()
    await rest(await accessToken(page), 'projects?select=id')
    expect(Date.now() - startedAt, 'the simulator really delays requests').toBeGreaterThanOrEqual(
      190,
    )
    await recordScreen(page, 'list')

    await dragRow(page, 'Delta', 'Alpha')
    await expect
      .poll(() => rowTitles(listScroll(page)))
      .toEqual(['Delta', 'Alpha', 'Beta', 'Gamma'])
    // The first write is still on its way when the next edits happen.
    await setStatus(page, (await dbTasks(projectId)).find((t) => t.title === 'Beta')!.id, 'Done')
    await dragRow(page, 'Gamma', 'Delta')
    await expect
      .poll(() => rowTitles(listScroll(page)))
      .toEqual(['Gamma', 'Delta', 'Alpha', 'Beta'])

    await expect(syncIndicator(page, 'Saved')).toBeVisible({ timeout: 15_000 })
    expect(await dbOrder(projectId)).toEqual(['Gamma', 'Delta', 'Alpha', 'Beta'])
    expect(await dbStatuses(projectId)).toMatchObject({ Beta: 'done', Alpha: 'todo' })
    expect(flickers(await screens(page))).toEqual([])
    expect((await screens(page)).at(-1)).toContain('Beta:Done')

    await sim.latency(0, 0)
    await page.reload()
    await expect
      .poll(() => rowTitles(listScroll(page)))
      .toEqual(['Gamma', 'Delta', 'Alpha', 'Beta'])
  })

  test('Board: drags into other columns one after another, without waiting for the server', async ({
    page,
  }) => {
    await signUpNew(page)
    const { projectId } = await seedProject(page, {
      tasks: [...FOUR.tasks.slice(0, 3), { key: 'd', title: 'Delta', status: 'in_progress' }],
    })
    await page.getByRole('link', { name: 'Board', exact: true }).click()
    await expect(column(page, 'To Do')).toBeVisible()
    await expect.poll(() => cardTitles(column(page, 'To Do'))).toEqual(['Alpha', 'Beta', 'Gamma'])
    await sim.latency(...LATENCY)
    await recordScreen(page, 'board')

    const delta = (await card(page, 'Delta').boundingBox())!
    await dragCard(page, 'Alpha', { x: delta.x + delta.width / 2, y: delta.y + 6 })
    await expect.poll(() => cardTitles(column(page, 'In Progress'))).toEqual(['Alpha', 'Delta'])
    const done = (await column(page, 'Done').boundingBox())!
    await dragCard(page, 'Beta', { x: done.x + done.width / 2, y: done.y + 120 })
    await expect.poll(() => cardTitles(column(page, 'Done'))).toEqual(['Beta'])
    await dragCard(page, 'Delta', { x: done.x + done.width / 2, y: done.y + 120 })
    await expect
      .poll(() => cardTitles(column(page, 'Done')).then((t) => t.sort()))
      .toEqual(['Beta', 'Delta'])

    await expect(syncIndicator(page, 'Saved')).toBeVisible({ timeout: 15_000 })
    expect(await dbStatuses(projectId)).toEqual({
      Alpha: 'in_progress',
      Beta: 'done',
      Gamma: 'todo',
      Delta: 'done',
    })
    expect(flickers(await screens(page))).toEqual([])
    const stamped = (await dbTasks(projectId)).filter((t) => t.status === 'done')
    expect(stamped.every((t) => t.completed_at !== null)).toBe(true)

    await sim.latency(0, 0)
    await page.reload()
    await expect.poll(() => cardTitles(column(page, 'To Do'))).toEqual(['Gamma'])
    await expect.poll(() => cardTitles(column(page, 'In Progress'))).toEqual(['Alpha'])
    await expect
      .poll(() => cardTitles(column(page, 'Done')).then((t) => t.sort()))
      .toEqual(['Beta', 'Delta'])
  })

  test('a focus refresh already on its way when edits start: the edits stay, the other device’s change arrives', async ({
    page,
  }) => {
    await page.clock.install()
    await signUpNew(page)
    const { projectId, ids } = await seedProject(page, FOUR)
    await sim.latency(...LATENCY)
    await recordScreen(page, 'list')
    // Another device renames Gamma.
    const token = await accessToken(page)
    const renamed = await rest(token, `tasks?id=eq.${ids.c}`, {
      method: 'PATCH',
      body: { title: 'Gamma (remote)' },
    })
    expect(renamed.status).toBeLessThan(300)

    // The window gets focus (its refresh read takes 200 to 400 ms), and two edits follow at once.
    await page.clock.fastForward('00:31')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await setStatus(page, ids.a, 'Done')
    await setStatus(page, ids.b, 'In Progress')

    await expect(syncIndicator(page, 'Saved')).toBeVisible({ timeout: 15_000 })
    await expect(taskRow(page, 'Gamma (remote)')).toBeVisible({ timeout: 15_000 })
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: Done')
    await expect(statusButton(page, ids.b)).toHaveAccessibleName('Status: In Progress')
    expect(await dbStatuses(projectId)).toMatchObject({ Alpha: 'done', Beta: 'in_progress' })
    const history = await screens(page)
    expect(flickers(history), JSON.stringify(history, null, 1)).toEqual([])
  })

  test('a slow failure and its slow Retry: rolled back once, applied once, the later edit untouched', async ({
    page,
  }) => {
    await signUpNew(page)
    const { projectId, ids } = await seedProject(page, FOUR)
    await sim.latency(...LATENCY)
    await recordScreen(page, 'list')
    await sim.fault({
      method: 'PATCH',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'status',
      status: 500,
    })

    await setStatus(page, ids.a, 'Done')
    await setStatus(page, ids.b, 'In Progress')
    const failure = toast(page, "Couldn't update task")
    await expect(failure).toBeVisible({ timeout: 15_000 })
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: To Do')
    await expect(statusButton(page, ids.b)).toHaveAccessibleName('Status: In Progress')
    // Beta's later write saved, which by design ends the earlier failure's sidebar state; the
    // toast's Retry still sends Alpha's change.
    expect((await dbStatuses(projectId)).Alpha).toBe('todo')

    await expect(syncIndicator(page, 'Saved')).toBeVisible({ timeout: 15_000 })
    const applied = async () =>
      (await sim.requests()).filter(
        (r) => r.method === 'PATCH' && r.path === '/rest/v1/tasks' && r.status === 200,
      ).length
    const before = await applied()
    await failure.getByRole('button', { name: 'Retry' }).click()
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: Done', {
      timeout: 15_000,
    })
    await expect(syncIndicator(page, 'Saved')).toBeVisible({ timeout: 15_000 })
    await expect(sidebar(page).getByRole('button', { name: 'Retry' })).toHaveCount(0)
    expect(await dbStatuses(projectId)).toMatchObject({ Alpha: 'done', Beta: 'in_progress' })
    expect(await applied()).toBe(before + 1)

    // Alpha went To Do → Done → back (the honest rollback) → Done again: nothing else.
    const alpha = (await screens(page)).map((s) => /Alpha:([A-Za-z ]+?)\|/.exec(s)?.[1])
    const compact = alpha.filter((v, i) => v !== alpha[i - 1])
    expect(compact).toEqual(['To Do', 'Done', 'To Do', 'Done'])
    await sim.latency(0, 0)
    await page.reload()
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: Done')
  })
})

test.describe('the owner’s profile, cloud, 200 to 400 ms per request', () => {
  test.use({ locale: 'zh-TW', deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } })

  test('one session: sign up, project, tasks, phase, status, board, reload: the server holds exactly what was done', async ({
    page,
  }) => {
    test.setTimeout(150_000)
    await sim.latency(...LATENCY)
    await signUpNew(page)
    await page.goto('/projects')
    await page.getByRole('button', { name: 'Create your first project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('研究專案 Slow')
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/list$/)
    const projectId = /\/projects\/([0-9a-f-]+)\/list$/.exec(page.url())![1]

    const first = page.getByRole('textbox', { name: 'Add your first task' })
    await first.fill('文獻回顧')
    await first.press('Enter')
    const next = page.getByRole('textbox', { name: 'New task' })
    await expect(next).toBeFocused()
    for (const title of ['問卷設計', '資料分析']) {
      await next.fill(title)
      await next.press('Enter')
    }
    await next.press('Escape')
    await expect
      .poll(() => rowTitles(listScroll(page)))
      .toEqual(['文獻回顧', '問卷設計', '資料分析'])

    await page.getByRole('button', { name: 'Add phase', exact: true }).click()
    const phaseInput = page.getByRole('textbox', { name: 'New phase name' })
    await phaseInput.fill('收集')
    await phaseInput.press('Enter')
    await phaseInput.press('Escape')
    await expect(phaseGroup(page, '收集')).toBeVisible()
    await taskRow(page, '問卷設計').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to phase' }).hover()
    await page.getByRole('menuitem', { name: '收集' }).click()
    await expect.poll(() => rowTitles(phaseGroup(page, '收集'))).toEqual(['問卷設計'])

    await expect.poll(async () => (await dbTasks(projectId)).length).toBe(3)
    const rows = await dbTasks(projectId)
    const id = (title: string) => rows.find((t) => t.title === title)!.id
    await setStatus(page, id('文獻回顧'), 'Done')
    await setStatus(page, id('資料分析'), 'In Progress')

    await page.getByRole('link', { name: 'Board', exact: true }).click()
    await expect(column(page, 'To Do')).toBeVisible()
    const done = (await column(page, 'Done').boundingBox())!
    await dragCard(page, '資料分析', { x: done.x + done.width / 2, y: done.y + 120 })
    await expect
      .poll(() => cardTitles(column(page, 'Done')).then((t) => t.sort()))
      .toEqual(['文獻回顧', '資料分析'])
    await expect(syncIndicator(page, 'Saved')).toBeVisible({ timeout: 15_000 })

    expect(await dbStatuses(projectId)).toEqual({
      文獻回顧: 'done',
      問卷設計: 'todo',
      資料分析: 'done',
    })
    await sim.latency(0, 0)
    await page.reload()
    await expectShell(page)
    await expect.poll(() => cardTitles(column(page, 'To Do'))).toEqual(['問卷設計'])
    await expect
      .poll(() => cardTitles(column(page, 'Done')).then((t) => t.sort()))
      .toEqual(['文獻回顧', '資料分析'])
  })
})
