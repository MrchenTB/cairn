/// <reference lib="dom" />
/**
 * Completed tasks and scheduling (UX iteration 2, Feature E), through the real UI: a done task is
 * never rescheduled by "Resolve all" or an Auto preview, the conflict signals count only what can
 * still be fixed, and the historical inconsistency stays visible in the task.
 * Time is pinned to Wed 2026-11-04 (Asia/Taipei) by the shared helpers.
 */
import {
  bar,
  chart,
  expect,
  moveBar,
  openGantt,
  seedWorkspace,
  stored,
  test,
} from './acceptance-gantt.helpers.ts'

test.use({ timezoneId: 'Asia/Taipei', locale: 'en-US', viewport: { width: 1280, height: 800 } })

function seed(mode: 'manual' | 'auto' = 'manual') {
  return seedWorkspace({
    mode,
    tasks: [
      { key: 'a', title: 'Alpha', start: '2026-11-04', due: '2026-11-08' },
      // Done, but starts before Alpha ends: a historical inconsistency.
      {
        key: 'done',
        title: 'Shipped early',
        start: '2026-11-06',
        due: '2026-11-07',
        status: 'done',
      },
      // Open and starts before Alpha ends: a real conflict.
      { key: 'open', title: 'Still open', start: '2026-11-07', due: '2026-11-09' },
    ],
    deps: [
      ['a', 'done'],
      ['a', 'open'],
    ],
  })
}

test('only the open successor counts as a conflict; the done one is not flagged', async ({
  page,
}) => {
  const s = seed()
  await openGantt(page, s, 'day')
  await expect(page.getByRole('button', { name: '1 conflict', exact: true })).toBeVisible()
  await expect(bar(page, s.ids.open)).toHaveAccessibleName(/dependency conflict/)
  await expect(bar(page, s.ids.done)).not.toHaveAccessibleName(/conflict/)
  await expect(page.locator('g[data-conflict] path[data-dep-id]')).toHaveCount(1)
})

test('Resolve all moves the open task and leaves the completed one exactly as it was', async ({
  page,
}) => {
  const s = seed()
  await openGantt(page, s, 'day')
  await page.getByRole('button', { name: '1 conflict', exact: true }).click()
  await page.getByRole('button', { name: 'Resolve all…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Resolve dependency conflicts' })
  await expect(dialog.getByRole('region', { name: 'Tasks that move' })).toContainText('Still open')
  await expect(dialog.getByRole('region', { name: 'Tasks that move' })).not.toContainText(
    'Shipped early',
  )
  const kept = dialog.getByRole('region', { name: 'Completed tasks kept as they are' })
  await expect(kept).toContainText('Shipped early')
  await expect(kept).toContainText('never changes their dates')
  await dialog.getByRole('button', { name: 'Apply 1 change' }).click()
  await expect(dialog).toHaveCount(0)
  await expect
    .poll(() => stored(page, s.ids.open))
    .toEqual({ start: '2026-11-09', due: '2026-11-11' })
  expect(await stored(page, s.ids.done)).toEqual({ start: '2026-11-06', due: '2026-11-07' })
  expect(await stored(page, s.ids.a)).toEqual({ start: '2026-11-04', due: '2026-11-08' })
  // Nothing left to fix: the chip is gone, although the history is still out of order.
  await expect(page.getByRole('button', { name: /conflict/ })).toHaveCount(0)
})

test('Auto mode: dragging the predecessor later previews only open tasks; the done one stays', async ({
  page,
}) => {
  const s = seed('auto')
  await openGantt(page, s, 'day')
  await moveBar(page, s.ids.a, 3)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('region', { name: 'Tasks that move' })).toContainText('Still open')
  await expect(
    dialog.getByRole('region', { name: 'Completed tasks kept as they are' }),
  ).toContainText('Shipped early')
  await dialog.getByRole('button', { name: /^Apply/ }).click()
  await expect.poll(() => stored(page, s.ids.a)).toEqual({ start: '2026-11-07', due: '2026-11-11' })
  expect(await stored(page, s.ids.done)).toEqual({ start: '2026-11-06', due: '2026-11-07' })
  const open = await stored(page, s.ids.open)
  expect(open.start! > '2026-11-11').toBe(true)
})

test('the task keeps the information: "Completed out of order", with no conflict banner', async ({
  page,
}) => {
  const s = seed()
  await openGantt(page, s, 'day')
  await bar(page, s.ids.done).click()
  const modal = page.getByRole('dialog')
  await expect(modal).toBeVisible()
  const note = modal.getByRole('note')
  await expect(note).toContainText('Completed out of order')
  await expect(note).toContainText('before “Alpha” finished')
  await expect(note).toContainText('never rescheduled automatically')
  await expect(modal).not.toContainText('Dependency conflict')
  await modal.getByRole('button', { name: 'Cancel' }).click()
  // The predecessor's modal mentions it too, from the other side.
  await bar(page, s.ids.a).click()
  await expect(page.getByRole('dialog').getByRole('note')).toContainText(
    '“Shipped early” was completed before this task finished',
  )
})

test('a done chain: nothing is dragged into an impossible schedule', async ({ page }) => {
  const s = seedWorkspace({
    mode: 'auto',
    tasks: [
      { key: 'a', title: 'Alpha', start: '2026-11-02', due: '2026-11-03' },
      { key: 'b', title: 'Beta', start: '2026-11-04', due: '2026-11-05', status: 'done' },
      { key: 'c', title: 'Gamma', start: '2026-11-06', due: '2026-11-07' },
    ],
    deps: [
      ['a', 'b'],
      ['b', 'c'],
    ],
  })
  await openGantt(page, s, 'day')
  await moveBar(page, s.ids.a, 6) // Alpha now overlaps and passes Beta (done) and Gamma
  // Beta is history, Gamma follows Beta's real finish: nothing else needs to move, so there is no
  // preview — the edit is written and the user is told Beta was left alone.
  await expect.poll(() => stored(page, s.ids.a)).toEqual({ start: '2026-11-08', due: '2026-11-09' })
  expect(await stored(page, s.ids.b)).toEqual({ start: '2026-11-04', due: '2026-11-05' })
  expect(await stored(page, s.ids.c)).toEqual({ start: '2026-11-06', due: '2026-11-07' })
  await expect(
    page.locator('[data-sonner-toast]', { hasText: '1 completed task was not moved' }),
  ).toBeVisible()
  await expect(chart(page)).toBeVisible()
})
