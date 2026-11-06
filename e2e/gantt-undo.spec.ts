/// <reference lib="dom" />
/**
 * Date changes on the Gantt give feedback and can be undone (UX iteration 2, Feature D): move,
 * resize, draw on an undated row, keyboard nudges and an Auto-mode shift, with real mouse input.
 * Time is pinned to Wed 2026-11-04 (Asia/Taipei) by the shared helpers.
 */
import {
  bar,
  boxOf,
  chart,
  dayX,
  dragBy,
  expect,
  failNextWrites,
  moveBar,
  openGantt,
  resizeBar,
  seedWorkspace,
  stored,
  test,
} from './acceptance-gantt.helpers.ts'
import type { Page } from '@playwright/test'

test.use({ timezoneId: 'Asia/Taipei', locale: 'en-US', viewport: { width: 1280, height: 800 } })

const toasts = (page: Page) => page.locator('[data-sonner-toast]')
const undoButton = (page: Page) =>
  page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' })

function seed(mode: 'manual' | 'auto' = 'manual') {
  return seedWorkspace({
    mode,
    tasks: [
      { key: 'a', title: 'Alpha', start: '2026-11-04', due: '2026-11-06' },
      { key: 'b', title: 'Beta', start: '2026-11-09', due: '2026-11-10' },
      { key: 'c', title: 'Gamma', start: '2026-11-12', due: '2026-11-13' },
      { key: 'idea', title: 'Idea' },
    ],
    deps: [
      ['a', 'b'],
      ['b', 'c'],
    ],
  })
}

test('moving a bar shows the new range; Undo restores BOTH dates', async ({ page }) => {
  const s = seed()
  await openGantt(page, s, 'day')
  await moveBar(page, s.ids.c, 3)
  await expect.poll(() => stored(page, s.ids.c)).toEqual({ start: '2026-11-15', due: '2026-11-16' })
  const toast = toasts(page).first()
  await expect(toast).toContainText('Moved · Nov 15 – Nov 16 · 2 days')
  await expect(toast).toContainText('Gamma')
  await undoButton(page).click()
  await expect.poll(() => stored(page, s.ids.c)).toEqual({ start: '2026-11-12', due: '2026-11-13' })
  await expect(toasts(page).first()).toContainText('Dates restored')
  // The bar is back where it was.
  const box = await boxOf(bar(page, s.ids.c))
  expect(Math.abs(box.x - (await dayX(page, '2026-11-12')))).toBeLessThan(2)
})

test('resizing either end can be undone too', async ({ page }) => {
  const s = seed()
  await openGantt(page, s, 'day')
  await resizeBar(page, s.ids.c, 'end', 2)
  await expect.poll(() => stored(page, s.ids.c)).toEqual({ start: '2026-11-12', due: '2026-11-15' })
  await expect(toasts(page).first()).toContainText('Resized · Nov 12 – Nov 15 · 4 days')
  await undoButton(page).click()
  await expect.poll(() => stored(page, s.ids.c)).toEqual({ start: '2026-11-12', due: '2026-11-13' })
  await resizeBar(page, s.ids.c, 'start', -2)
  await expect.poll(() => stored(page, s.ids.c)).toEqual({ start: '2026-11-10', due: '2026-11-13' })
  await undoButton(page).click()
  await expect.poll(() => stored(page, s.ids.c)).toEqual({ start: '2026-11-12', due: '2026-11-13' })
})

test('scheduling an undated task by drawing is confirmed and undoable (back to Unscheduled)', async ({
  page,
}) => {
  const s = seed()
  await openGantt(page, s, 'day')
  const row = chart(page).locator('[data-row-key="task:' + s.ids.idea + '"] [data-handle="lane"]')
  const box = await boxOf(row)
  const from = { x: await dayX(page, '2026-11-07', 'center'), y: box.y + box.height / 2 }
  await dragBy(page, from, 36)
  await expect
    .poll(() => stored(page, s.ids.idea))
    .toEqual({ start: '2026-11-07', due: '2026-11-08' })
  await expect(toasts(page).first()).toContainText('Scheduled · Nov 7 – Nov 8 · 2 days')
  await undoButton(page).click()
  await expect.poll(() => stored(page, s.ids.idea)).toEqual({ start: null, due: null })
})

test('several changes in a row: ONE toast, and its Undo returns to before the first of them', async ({
  page,
}) => {
  const s = seed()
  await openGantt(page, s, 'day')
  await moveBar(page, s.ids.c, 1)
  await expect(toasts(page).first()).toContainText('Moved · Nov 13 – Nov 14')
  await moveBar(page, s.ids.c, 1)
  await expect.poll(() => stored(page, s.ids.c)).toEqual({ start: '2026-11-14', due: '2026-11-15' })
  await resizeBar(page, s.ids.c, 'end', 1)
  await expect.poll(() => stored(page, s.ids.c)).toEqual({ start: '2026-11-14', due: '2026-11-16' })
  await expect(toasts(page).filter({ hasText: 'Undo' })).toHaveCount(1)
  await expect(toasts(page).first()).toContainText('Resized · Nov 14 – Nov 16 · 3 days')
  await undoButton(page).click()
  // Everything of the burst is taken back at once, to the dates from before the first move.
  await expect.poll(() => stored(page, s.ids.c)).toEqual({ start: '2026-11-12', due: '2026-11-13' })
})

test('a change to another task replaces the toast: Undo only ever touches what it names', async ({
  page,
}) => {
  const s = seed()
  await openGantt(page, s, 'day')
  await moveBar(page, s.ids.c, 2)
  await expect(toasts(page).first()).toContainText('Gamma')
  await moveBar(page, s.ids.b, 1)
  await expect(toasts(page).first()).toContainText('Beta')
  await expect(toasts(page).filter({ hasText: 'Undo' })).toHaveCount(1)
  await undoButton(page).click()
  await expect.poll(() => stored(page, s.ids.b)).toEqual({ start: '2026-11-09', due: '2026-11-10' })
  // Gamma keeps its move.
  expect(await stored(page, s.ids.c)).toEqual({ start: '2026-11-14', due: '2026-11-15' })
})

test('Esc cancels a drag: nothing is written and no toast appears', async ({ page }) => {
  const s = seed()
  await openGantt(page, s, 'day')
  const box = await boxOf(bar(page, s.ids.c))
  await dragBy(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 72, 0, {
    release: false,
  })
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect(await stored(page, s.ids.c)).toEqual({ start: '2026-11-12', due: '2026-11-13' })
  await expect(toasts(page)).toHaveCount(0)
})

test('a failed save rolls the bar back with the store’s Retry — and offers no Undo', async ({
  page,
}) => {
  const s = seed()
  await openGantt(page, s, 'day')
  await failNextWrites(page, 1)
  await moveBar(page, s.ids.c, 2)
  await expect(toasts(page).filter({ hasText: /Retry/ })).toHaveCount(1)
  await expect(undoButton(page)).toHaveCount(0)
  expect(await stored(page, s.ids.c)).toEqual({ start: '2026-11-12', due: '2026-11-13' })
})

test('keyboard nudges give one toast; Undo returns to before the first nudge', async ({ page }) => {
  const s = seed()
  await openGantt(page, s, 'day')
  await bar(page, s.ids.c).focus()
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Alt+ArrowRight')
  await expect.poll(() => stored(page, s.ids.c)).toEqual({ start: '2026-11-15', due: '2026-11-16' })
  await expect(toasts(page).filter({ hasText: 'Undo' })).toHaveCount(1)
  await expect(toasts(page).first()).toContainText('Moved · Nov 15 – Nov 16 · 2 days')
  await undoButton(page).click()
  await expect.poll(() => stored(page, s.ids.c)).toEqual({ start: '2026-11-12', due: '2026-11-13' })
})

test('Auto mode: a confirmed shift is undone together with the task that caused it', async ({
  page,
}) => {
  const s = seed('auto')
  await openGantt(page, s, 'day')
  // Alpha 4–6 → 6–8 pushes Beta (9–10) only if it would collide: move far enough to need shifts.
  await moveBar(page, s.ids.a, 4)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /^Apply/ }).click()
  await expect.poll(() => stored(page, s.ids.a)).toEqual({ start: '2026-11-08', due: '2026-11-10' })
  const beta = await stored(page, s.ids.b)
  expect(beta.start).not.toBe('2026-11-09')
  await expect(toasts(page).first()).toContainText('Moved')
  await undoButton(page).click()
  await expect.poll(() => stored(page, s.ids.a)).toEqual({ start: '2026-11-04', due: '2026-11-06' })
  expect(await stored(page, s.ids.b)).toEqual({ start: '2026-11-09', due: '2026-11-10' })
  expect(await stored(page, s.ids.c)).toEqual({ start: '2026-11-12', due: '2026-11-13' })
})
