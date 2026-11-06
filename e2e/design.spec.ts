/// <reference lib="dom" />
/**
 * Design regressions (PRD §7): layout that must hold at narrow widths and across state changes.
 */
import {
  expect,
  seedWorkspace,
  LOCAL_WORKSPACE_KEY,
  NOW,
  test,
} from './acceptance-gantt.helpers.ts'

const seed = seedWorkspace({
  tasks: [
    { key: 'a', title: 'Late design task', start: '2026-11-02', due: '2026-11-09', phase: true },
    { key: 'b', title: 'Build', start: '2026-11-05', due: '2026-11-12' },
    { key: 'c', title: 'Unplanned' },
  ],
  deps: [['a', 'b']],
})

const phased = seedWorkspace({
  tasks: [{ key: 'a', title: 'Only task', start: '2026-11-02', due: '2026-11-03', phase: true }],
})

const conflicting = seedWorkspace({
  tasks: [
    {
      key: 'a',
      title: 'Information architecture 資訊架構',
      start: '2026-11-02',
      due: '2026-11-10',
    },
    {
      key: 'b',
      title: 'Visual design: homepage 首頁視覺設計',
      start: '2026-11-09',
      due: '2026-11-20',
    },
  ],
  deps: [['a', 'b']],
})

const wrapped = seedWorkspace({
  tasks: [
    {
      key: 'a',
      title: 'Visual design: homepage 首頁視覺設計',
      start: '2026-11-09',
      due: '2026-11-20',
    },
  ],
})

test.use({ timezoneId: 'Asia/Taipei', locale: 'en-US' })

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW)
  await page.addInitScript(
    ({ k, db }) => {
      if (!sessionStorage.getItem('s')) {
        localStorage.setItem(k, JSON.stringify(db))
        sessionStorage.setItem('s', '1')
      }
    },
    {
      k: LOCAL_WORKSPACE_KEY,
      db: (test.info().title.includes('filtered')
        ? phased
        : test.info().title.includes('wrapped')
          ? wrapped
          : test.info().title.includes('conflict list')
            ? conflicting
            : seed
      ).db,
    },
  )
})

test('the Gantt view bar never overlaps its tabs at 860px wide', async ({ page }) => {
  await page.setViewportSize({ width: 860, height: 800 })
  await page.goto(`/projects/${seed.projectId}/gantt`)
  const bar = page.locator('[data-slot="view-bar"]')
  await expect(bar).toBeVisible()
  const boxes = await bar.evaluate((el) => {
    const tabs = el.children[0]!.getBoundingClientRect()
    const actions = el.children[1]!.getBoundingClientRect()
    const tabButtons = [...el.children[0]!.querySelectorAll('a,button')].map((b) =>
      b.getBoundingClientRect(),
    )
    return {
      tabsRight: Math.max(...tabButtons.map((b) => b.right)),
      tabsBoxRight: tabs.right,
      actionsLeft: actions.left,
    }
  })
  expect(boxes.tabsRight).toBeLessThanOrEqual(boxes.actionsLeft + 0.5)
  expect(boxes.tabsBoxRight).toBeLessThanOrEqual(boxes.actionsLeft + 0.5)
})

test('an empty filtered board does not push the columns down', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${phased.projectId}/board`)
  const column = page.getByRole('heading', { name: /To Do/ }).first()
  await expect(column).toBeVisible()
  const before = (await column.boundingBox())!.y
  await page.goto(`/projects/${phased.projectId}/board?phase=none`)
  await expect(page.getByRole('status').filter({ hasText: /Every task|No tasks in/ })).toBeVisible()
  const after = (await page.getByRole('heading', { name: /To Do/ }).first().boundingBox())!.y
  expect(after).toBe(before)
})

test('a wrapped board card title is balanced, not left with a one-character last line', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${wrapped.projectId}/board`)
  const title = page.locator('[class*="line-clamp-2"]', { hasText: 'Visual design' }).first()
  await expect(title).toBeVisible()
  const lines = await title.evaluate((el) => {
    const tops = new Map<number, number>()
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text
      for (let index = 0; index < text.length; index += 1) {
        const range = document.createRange()
        range.setStart(text, index)
        range.setEnd(text, index + 1)
        const rect = range.getClientRects()[0]
        if (rect) tops.set(Math.round(rect.top), (tops.get(Math.round(rect.top)) ?? 0) + 1)
      }
    }
    return [...tops.values()]
  })
  expect(lines.length).toBe(2)
  // Balanced: the last line carries a real share of the text (an orphan "計" would be 1 of 30).
  expect(lines[1]).toBeGreaterThanOrEqual(Math.floor(lines[0] / 3))
})

test('the conflict list shows both task names in full at 1280px (conflict list)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/projects/${conflicting.projectId}/gantt`)
  await page.locator('button[title="1 dependency conflict"]').click()
  const names = page.getByRole('list', { name: 'Conflicts' }).locator('span.truncate')
  await expect(names).toHaveCount(2)
  for (const name of await names.all()) {
    const clipped = await name.evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(clipped, await name.innerText()).toBe(false)
  }
})
