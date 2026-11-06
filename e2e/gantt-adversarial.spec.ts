/// <reference lib="dom" />
/**
 * Adversarial Gantt regressions: what a drag engine and a scheduler typically get wrong, each one
 * found by trying to break the real chart. The acceptance statements live in
 * e2e/acceptance-gantt.spec.ts; the scheduler's own properties in
 * src/domain/scheduling.property.test.ts.
 */
import {
  bar,
  boxOf,
  chart,
  linkDrag,
  LOCAL_WORKSPACE_KEY,
  storedDependencies,
  countWrites,
  dragBy,
  expect,
  failNextWrites,
  moveBar,
  openGantt,
  resizeBar,
  seedWorkspace,
  stored,
  test,
  toast,
  toastButton,
  writes,
} from './acceptance-gantt.helpers.ts'

test.use({ timezoneId: 'Asia/Taipei', locale: 'en-US', viewport: { width: 1280, height: 800 } })

test('scrolling with the wheel during a drag keeps the bar under the pointer and commits what it shows', async ({
  page,
}) => {
  const seed = seedWorkspace({
    tasks: [{ key: 'a', title: 'Alpha', start: '2026-11-10', due: '2026-11-12' }],
  })
  await openGantt(page, seed)
  const box = await boxOf(bar(page, seed.ids.a))
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 72, y, { steps: 5 })
  await expect(page.getByText('+2 days')).toBeVisible()
  const before = await boxOf(bar(page, seed.ids.a))

  // The pointer does not move: only the days under it change.
  await page.mouse.wheel(360, 0)
  await expect(page.getByText('+12 days')).toBeVisible()
  const after = await boxOf(bar(page, seed.ids.a))
  expect(Math.abs(after.x - before.x)).toBeLessThan(2)

  await page.mouse.up()
  await expect
    .poll(() => stored(page, seed.ids.a))
    .toEqual({
      start: '2026-11-22',
      due: '2026-11-24',
    })
})

test('a date at the very end of the calendar does not take the chart down, and moving past it is refused', async ({
  page,
}) => {
  const seed = seedWorkspace({
    tasks: [
      { key: 'a', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
      { key: 'z', title: 'Zeta', start: '9999-11-05', due: '9999-12-31' },
    ],
    milestones: [{ key: 'm', name: 'Gate', date: '9999-11-20' }],
  })
  await openGantt(page, seed, 'month')
  await expect(bar(page, seed.ids.a)).toBeVisible()

  await chart(page).evaluate((element) => {
    element.scrollLeft = element.scrollWidth
  })
  await expect(bar(page, seed.ids.z)).toBeVisible()
  await bar(page, seed.ids.z).focus()
  await page.keyboard.press('Alt+ArrowRight')
  await expect(toast(page, "Couldn't change dates")).toContainText('outside the supported calendar')
  expect(await stored(page, seed.ids.z)).toEqual({ start: '9999-11-05', due: '9999-12-31' })

  // A drag toward the end leaves the chart up and writes what the tooltip last said.
  const box = await boxOf(bar(page, seed.ids.z))
  await dragBy(page, { x: box.x + 20, y: box.y + box.height / 2 }, 40)
  await expect(chart(page)).toBeVisible()
  const { due } = await stored(page, seed.ids.z)
  expect(due && due <= '9999-12-31').toBeTruthy()
})

test('a conflict nothing can resolve is called that, not "no conflicts"', async ({ page }) => {
  const seed = seedWorkspace({
    tasks: [
      { key: 'a', title: 'Alpha', start: '9999-12-20', due: '9999-12-30' },
      { key: 'b', title: 'Beta', start: '9999-12-25', due: '9999-12-31' },
    ],
    deps: [['a', 'b']],
  })
  await openGantt(page, seed, 'month')
  await page
    .getByRole('button', { name: /conflict/i })
    .first()
    .click()
  await page
    .getByRole('button', { name: /Resolve/ })
    .first()
    .click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading')).toHaveText("Can't resolve this automatically")
  await expect(dialog).toContainText('past the end of the supported calendar')
  await expect(dialog).not.toContainText('No conflicts')
  await expect(dialog.getByRole('button', { name: /Apply/ })).toHaveCount(0)
})

test('a chain of 40: the preview fits the screen, a failed apply rolls all of it back in one write, Retry applies all of it', async ({
  page,
}) => {
  const dayOf = (offset: number) =>
    new Date(Date.UTC(2026, 10, 5 + offset)).toISOString().slice(0, 10)
  const tasks = Array.from({ length: 40 }, (_, index) => ({
    key: `t${index}`,
    title: `Step ${index}`,
    start: dayOf(index),
    due: dayOf(index),
  }))
  const deps = tasks.slice(1).map((task, index) => [`t${index}`, task.key] as [string, string])
  const seed = seedWorkspace({ mode: 'auto', tasks, deps })
  await openGantt(page, seed)
  await countWrites(page)
  const first = await boxOf(bar(page, seed.ids.t0))
  await moveBar(page, seed.ids.t0, 3)

  const dialog = page.getByRole('dialog')
  const apply = dialog.getByRole('button', { name: 'Apply 40 changes' })
  await expect(apply).toBeInViewport()
  const box = await boxOf(dialog)
  expect(box.y + box.height).toBeLessThanOrEqual(800)
  await expect(dialog.getByRole('listitem')).toHaveCount(39)

  await failNextWrites(page, 1)
  await apply.click()
  await expect(toast(page, "Couldn't reschedule tasks")).toBeVisible()
  await expect(dialog).toBeHidden()
  // Nothing half-written, on screen or in storage.
  for (const index of [0, 1, 20, 39]) {
    const day = dayOf(index)
    expect(await stored(page, seed.ids[`t${index}`])).toEqual({ start: day, due: day })
  }
  expect((await boxOf(bar(page, seed.ids.t0))).x).toBe(first.x)

  await toastButton(page, 'Retry').click()
  await expect.poll(() => stored(page, seed.ids.t39)).toEqual({ start: dayOf(42), due: dayOf(42) })
  for (const index of [0, 1, 20]) {
    const day = dayOf(index + 3)
    expect(await stored(page, seed.ids[`t${index}`])).toEqual({ start: day, due: day })
  }
  await expect(page.getByRole('button', { name: /conflict/i })).toHaveCount(0)
  expect(await writes(page)).toBe(1) // the failed attempt never reached storage
})

test('a diamond with partial dates: the join lands after the later branch, undated tasks stay, and doing it again changes nothing', async ({
  page,
}) => {
  const seed = seedWorkspace({
    mode: 'auto',
    tasks: [
      { key: 'a', title: 'Root', start: '2026-11-05', due: '2026-11-06' },
      { key: 'b', title: 'Range branch', start: '2026-11-07', due: '2026-11-09' },
      { key: 'c', title: 'Due-only branch', due: '2026-11-08' },
      { key: 'u', title: 'Undated branch' },
      { key: 'd', title: 'Start-only join', start: '2026-11-11' },
      { key: 'e', title: 'Range tail', start: '2026-11-12', due: '2026-11-13' },
    ],
    deps: [
      ['a', 'b'],
      ['a', 'c'],
      ['a', 'u'],
      ['b', 'd'],
      ['c', 'd'],
      ['u', 'd'],
      ['d', 'e'],
    ],
  })
  await openGantt(page, seed)
  await resizeBar(page, seed.ids.a, 'end', 3) // Root now ends Nov 9

  const dialog = page.getByRole('dialog')
  const items = dialog.getByRole('listitem')
  await expect(items).toHaveCount(4)
  await expect(items.filter({ hasText: 'Range branch' })).toContainText('Nov 10')
  await expect(items.filter({ hasText: 'Due-only branch' })).toContainText('Due Nov 10')
  await expect(items.filter({ hasText: 'Start-only join' })).toContainText('+2d')
  await expect(items.filter({ hasText: 'Range tail' })).toContainText('+2d')
  await expect(items.filter({ hasText: 'Undated' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Apply 5 changes' }).click()
  await expect(dialog).toBeHidden()

  expect(await stored(page, seed.ids.b)).toEqual({ start: '2026-11-10', due: '2026-11-12' })
  expect(await stored(page, seed.ids.c)).toEqual({ start: null, due: '2026-11-10' })
  expect(await stored(page, seed.ids.u)).toEqual({ start: null, due: null })
  expect(await stored(page, seed.ids.d)).toEqual({ start: '2026-11-13', due: null })
  expect(await stored(page, seed.ids.e)).toEqual({ start: '2026-11-14', due: '2026-11-15' })
  await expect(page.getByRole('button', { name: /conflict/i })).toHaveCount(0)

  // Same end date again: nothing to ask, nothing to move.
  await countWrites(page)
  await bar(page, seed.ids.a).focus()
  await page.keyboard.press('Alt+Shift+ArrowLeft')
  await expect
    .poll(() => stored(page, seed.ids.a))
    .toEqual({ start: '2026-11-05', due: '2026-11-08' })
  await expect(dialog).toHaveCount(0)
  expect(await stored(page, seed.ids.b)).toEqual({ start: '2026-11-10', due: '2026-11-12' })
})

test('the sidebar collapsing during a drag does not tear the bar away from the pointer', async ({
  page,
}) => {
  const seed = seedWorkspace({
    tasks: [{ key: 'a', title: 'Alpha', start: '2026-11-10', due: '2026-11-12' }],
  })
  await openGantt(page, seed)
  const box = await boxOf(bar(page, seed.ids.a))
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await dragBy(page, { x, y }, 36, 0, { release: false })
  await page.keyboard.press('[')
  await page.waitForTimeout(400) // the sidebar's transition
  await page.mouse.move(x + 37, y)
  await expect(async () => {
    const moved = await boxOf(bar(page, seed.ids.a))
    expect(Math.abs(moved.x + moved.width / 2 - (x + 37))).toBeLessThan(20)
  }).toPass({ timeout: 2000 })
  await page.mouse.up()
})

test('nudging a bar wider than the view keeps the view where it is', async ({ page }) => {
  const seed = seedWorkspace({
    tasks: [{ key: 'a', title: 'Alpha', start: '2026-10-01', due: '2027-02-28' }],
  })
  await openGantt(page, seed)
  await bar(page, seed.ids.a).focus()
  await page.keyboard.press('Alt+ArrowRight')
  await expect
    .poll(() => stored(page, seed.ids.a))
    .toEqual({
      start: '2026-10-02',
      due: '2027-03-01',
    })
  const scrollLeft = () => chart(page).evaluate((element) => element.scrollLeft)
  const before = await scrollLeft()
  await page.keyboard.press('Alt+ArrowLeft')
  await expect
    .poll(() => stored(page, seed.ids.a))
    .toEqual({
      start: '2026-10-01',
      due: '2027-02-28',
    })
  await page.keyboard.press('Alt+ArrowRight')
  await expect
    .poll(() => stored(page, seed.ids.a))
    .toEqual({
      start: '2026-10-02',
      due: '2027-03-01',
    })
  expect(await scrollLeft()).toBe(before)
  await expect(bar(page, seed.ids.a)).toBeFocused()
})

test('rollups follow an applied shift, and a year-9999 date leaves the Timeline up too', async ({
  page,
}) => {
  const seed = seedWorkspace({
    mode: 'auto',
    tasks: [
      { key: 'p', title: 'Parent', phase: true },
      { key: 's1', title: 'One', start: '2026-11-06', due: '2026-11-07', parent: 'p', phase: true },
      { key: 's2', title: 'Two', start: '2026-11-08', due: '2026-11-09', parent: 'p', phase: true },
    ],
    milestones: [{ key: 'm', name: 'Far', date: '9999-12-31' }],
    deps: [['s1', 's2']],
  })
  await openGantt(page, seed)
  await expect(page.locator('[title^="Parent (subtasks): Nov 6"]')).toHaveCount(1)
  await moveBar(page, seed.ids.s1, 2)
  await page.getByRole('dialog').getByRole('button', { name: 'Apply 2 changes' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.locator('[title="Parent (subtasks): Nov 8 – Nov 11"]')).toHaveCount(1)
  await expect(page.locator('[title="Design: Nov 8 – Nov 11"]')).toHaveCount(1)

  await page.goto('/timeline')
  await expect(page.getByText('Launch plan').first()).toBeVisible()
  await page.getByRole('radio', { name: 'Month' }).click()
  await expect(page.getByText(/went wrong/i)).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// D15: a schedule preview left open while another tab changes the data
// ---------------------------------------------------------------------------

test('a preview left open while another tab moves a task in the plan: a tab return refreshes it, and Apply writes what is listed', async ({
  page,
  context,
}) => {
  const seed = seedWorkspace({
    mode: 'auto',
    tasks: [
      { key: 'a', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
      { key: 'b', title: 'Beta', start: '2026-11-08', due: '2026-11-10' },
    ],
    deps: [['a', 'b']],
  })
  await openGantt(page, seed)
  await moveBar(page, seed.ids.a, 3)
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Apply 2 changes' })).toBeVisible()

  // Tab 2 (same storage) makes Beta four days long and earlier.
  const other = await context.newPage()
  await other.goto(`/projects/${seed.projectId}/gantt`)
  await other.evaluate(
    ({ key, id }) => {
      const db = JSON.parse(localStorage.getItem(key) as string)
      db.tasks[id].startDate = '2026-11-09'
      db.tasks[id].dueDate = '2026-11-12'
      localStorage.setItem(key, JSON.stringify(db))
    },
    { key: LOCAL_WORKSPACE_KEY, id: seed.ids.b },
  )
  await other.close()

  // Back on tab 1, inside the store's 30 s throttle (the clock is pinned): the list changes.
  await expect(dialog).not.toContainText('Nov 14')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(dialog).toContainText('Nov 14')
  await expect(dialog).toContainText('Nov 9')

  await dialog.getByRole('button', { name: /^Apply/ }).click()
  await expect(dialog).toBeHidden()
  await expect
    .poll(() => stored(page, seed.ids.b))
    .toEqual({ start: '2026-11-11', due: '2026-11-14' })
  expect(await stored(page, seed.ids.a)).toEqual({ start: '2026-11-08', due: '2026-11-10' })
})

test('a preview left open while another tab deletes a task in the plan: nothing half-written', async ({
  page,
  context,
}) => {
  const seed = seedWorkspace({
    mode: 'auto',
    tasks: [
      { key: 'a', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
      { key: 'b', title: 'Beta', start: '2026-11-08', due: '2026-11-10' },
    ],
    deps: [['a', 'b']],
  })
  await openGantt(page, seed)
  await moveBar(page, seed.ids.a, 3)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Beta')

  const other = await context.newPage()
  await other.goto(`/projects/${seed.projectId}/gantt`)
  await other.evaluate(
    ({ key, id }) => {
      const db = JSON.parse(localStorage.getItem(key) as string)
      delete db.tasks[id]
      for (const dep of Object.keys(db.dependencies)) delete db.dependencies[dep]
      localStorage.setItem(key, JSON.stringify(db))
    },
    { key: LOCAL_WORKSPACE_KEY, id: seed.ids.b },
  )
  await other.close()

  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(dialog).not.toContainText('Beta')
  const apply = dialog.getByRole('button', { name: /^Apply/ })
  if (await apply.count()) await apply.first().click()
  else
    await dialog
      .getByRole('button', { name: /Cancel|Close|Keep/ })
      .first()
      .click()
  await expect(dialog).toBeHidden()
  const db = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) as string),
    LOCAL_WORKSPACE_KEY,
  )
  expect(db.tasks[seed.ids.b]).toBeUndefined()
  expect(Object.keys(db.tasks)).toEqual([seed.ids.a])
})

// ---------------------------------------------------------------------------
// Shortcuts pressed mid-drag, and a link dropped on rows that are not tasks
// ---------------------------------------------------------------------------

for (const key of ['c', '?']) {
  test(`pressing "${key}" during a bar drag: no stuck ghost, one write at most, the bar drags again`, async ({
    page,
  }) => {
    const seed = seedWorkspace({
      tasks: [{ key: 'a', title: 'Alpha', start: '2026-11-10', due: '2026-11-12' }],
    })
    await openGantt(page, seed)
    await countWrites(page)
    const box = await boxOf(bar(page, seed.ids.a))
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 72, y, { steps: 5 })
    await expect(page.getByText('+2 days')).toBeVisible()
    await page.keyboard.press(key)
    await page.mouse.move(x + 108, y, { steps: 3 })
    await page.mouse.up()

    // Close whatever the key opened.
    const overlay = page.getByRole('dialog')
    if (await overlay.count()) {
      await page.keyboard.press('Escape')
      await expect(overlay).toHaveCount(0)
    }
    await expect(page.getByText(/^[+-]\d+ days?$/)).toHaveCount(0)
    expect(await writes(page)).toBeLessThanOrEqual(1)

    // The chart shows what is stored.
    const { start, due } = await stored(page, seed.ids.a)
    expect(start).not.toBeNull()
    const shown = await boxOf(bar(page, seed.ids.a))
    const days = Math.round((shown.x - box.x) / 36)
    const shifted = new Date(Date.UTC(2026, 10, 10 + days)).toISOString().slice(0, 10)
    expect(start).toBe(shifted)
    expect(due).not.toBeNull()

    // And it drags again.
    await moveBar(page, seed.ids.a, 1)
    await expect
      .poll(async () => (await stored(page, seed.ids.a)).start)
      .toBe(new Date(Date.UTC(2026, 10, 11 + days)).toISOString().slice(0, 10))
  })
}

for (const target of ['milestone', 'phase row'] as const) {
  test(`a dependency link dropped on a ${target}: nothing is written and the chart still works`, async ({
    page,
  }) => {
    const seed = seedWorkspace({
      tasks: [
        { key: 'a', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
        { key: 'p', title: 'In phase', start: '2026-11-09', due: '2026-11-10', phase: true },
      ],
      milestones: [{ key: 'm', name: 'Gate', date: '2026-11-12' }],
    })
    await openGantt(page, seed)
    await countWrites(page)
    const before = await storedDependencies(page)
    await bar(page, seed.ids.a).hover()
    const dot = await boxOf(
      page.locator(`[data-handle="link-out"][data-task-id="${seed.ids.a}"]`).first(),
    )
    const from = { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 }
    const lane =
      target === 'milestone'
        ? page.locator(`[data-milestone-id="${seed.ids.m}"]`).first()
        : page
            .locator('[data-row-key]')
            .filter({ hasText: 'Design' })
            .first()
            .locator('[data-handle="lane"]')
    const box = await boxOf(lane)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 4, from.y + 4, { steps: 2 })
    await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(300)

    expect(await writes(page)).toBe(0)
    expect(await storedDependencies(page)).toEqual(before)
    await expect(page.getByText(/Dependency added/)).toHaveCount(0)
    await expect(chart(page)).toBeVisible()
    // Still linkable to a real task afterwards.
    await linkDrag(page, seed.ids.a, seed.ids.p)
    await expect.poll(() => storedDependencies(page)).toHaveLength(before.length + 1)
  })
}
