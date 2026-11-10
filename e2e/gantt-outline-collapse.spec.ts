/// <reference lib="dom" />
/**
 * UX-02 — hiding and showing the Gantt outline pane (task list) — LOCAL data mode against the dev
 * server. Hidden = the timeline uses the full width: no outline column, no splitter, and bars,
 * dependencies, the time header, the Today line and the drag auto-scroll edges all work from the
 * scroller's left edge. The setting is per device (localStorage), global, and Gantt only.
 *
 * Time is pinned (Wed 2026-11-04, Asia/Taipei); pointer input is the real mouse.
 */
import {
  bar,
  boxOf,
  chart,
  countWrites,
  dayTitle,
  dragBy,
  expect,
  linkDrag,
  moveBar,
  openGantt,
  outlineRow,
  PX,
  resizeBar,
  seedWorkspace,
  stored,
  storedDependencies,
  test,
  writes,
  depPath,
  pointOnPath,
  type TaskSpec,
} from './acceptance-gantt.helpers.ts'
import type { Page } from '@playwright/test'

test.use({ timezoneId: 'Asia/Taipei', locale: 'en-US', viewport: { width: 1280, height: 800 } })

const TASKS: TaskSpec[] = [
  { key: 'alpha', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
  { key: 'bravo', title: 'Bravo', start: '2026-11-10', due: '2026-11-12' },
  { key: 'charlie', title: 'Charlie', start: '2026-11-13', due: '2026-11-14' },
  { key: 'delta', title: 'Delta', start: '2026-11-08', due: '2026-11-09', phase: true },
  { key: 'undated1', title: 'Undated one' },
  { key: 'undated2', title: 'Undated two', phase: true },
]

function seed() {
  return seedWorkspace({
    tasks: TASKS,
    milestones: [{ key: 'launch', name: 'Launch', date: '2026-11-15', phase: true }],
    deps: [['alpha', 'bravo']],
  })
}

const hideButton = (page: Page) => page.getByRole('button', { name: 'Hide task list' })
const showButton = (page: Page) => page.getByRole('button', { name: 'Show task list' })
const splitter = (page: Page) => page.getByRole('separator', { name: 'Resize task list' })

async function hide(page: Page) {
  await hideButton(page).click()
  await expect(showButton(page)).toBeVisible()
  await expect(splitter(page)).toHaveCount(0)
}

async function show(page: Page) {
  await showButton(page).click()
  await expect(hideButton(page)).toBeVisible()
  await expect(splitter(page)).toBeVisible()
}

/** Viewport x of each bar / marker (and the milestone), to compare across hide and show. */
async function barXs(page: Page, keys: string[], ids: Record<string, string>) {
  const result: number[] = []
  for (const key of keys) result.push((await boxOf(bar(page, ids[key]))).x)
  return result
}

/** Widens the pane to 340 with the splitter (a drag of +40 from the default 300). */
async function widenTo340(page: Page) {
  const box = await boxOf(splitter(page))
  await dragBy(page, { x: box.x + box.width / 2, y: box.y + 200 }, 40)
  await expect(splitter(page)).toHaveAttribute('aria-valuenow', '340')
}

/** Outline cells of every rendered row: the row's children that are not the timeline lane. */
function outlineCells(page: Page) {
  return page.locator('[data-row-key] > div:not([data-handle="lane"])')
}

test.describe('Gantt outline pane toggle', () => {
  test('is shown by default and hiding it leaves no outline column: the timeline starts at the left edge', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await expect(hideButton(page)).toBeVisible()
    await expect(splitter(page)).toHaveAttribute('aria-valuenow', '300')
    await expect(outlineCells(page).first()).toBeVisible()

    await hide(page)
    await expect(outlineCells(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Alpha', exact: true })).toHaveCount(0)
    // Not a single focusable control is left in the outline: only bars and markers in the chart.
    await expect(
      chart(page).locator('button:not([data-link-target]):not([data-handle])'),
    ).toHaveCount(0)

    // The first visible timeline pixel is the scroller's left edge: a lane (not an outline cell)
    // is what is under it, in the rows and at the header's day cells.
    const area = await boxOf(chart(page))
    const rowBox = await boxOf(outlineRow(page, `task:${s.ids.alpha}`))
    const underLeftEdge = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-handle="lane"]') != null,
      { x: area.x + 2, y: rowBox.y + rowBox.height / 2 },
    )
    expect(underLeftEdge).toBe(true)
    const headerCellUnderEdge = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[title]') != null,
      { x: area.x + 2, y: area.y + 36 },
    )
    expect(headerCellUnderEdge).toBe(true)
    // Rows span the whole width, bars and the Launch milestone are still there.
    await expect(bar(page, s.ids.alpha)).toBeVisible()
    await expect(page.getByRole('button', { name: /^Milestone Launch/ })).toBeVisible()
  })

  test('the toolbar button is named after what it does, with a tooltip', async ({ page }) => {
    await openGantt(page, seed(), 'day')
    await hideButton(page).hover()
    await expect(page.getByRole('tooltip')).toHaveText('Hide task list')
    await hide(page)
    await page.mouse.move(5, 400)
    await showButton(page).hover()
    await expect(page.getByRole('tooltip')).toHaveText('Show task list')
  })

  test('bars keep their screen position across hide and show; the width comes back after show and after a reload', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await widenTo340(page)
    // Far enough from both ends that no range growth interferes with the exact scroll maths:
    // grow the range to the right first, then rest in the middle of the longer timeline.
    const scroller = chart(page)
    const width = () => scroller.evaluate((el) => el.scrollWidth)
    const initial = await width()
    await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth
    })
    await expect.poll(width).toBeGreaterThan(initial)
    await scroller.evaluate((el) => {
      el.scrollLeft = Math.round((el.scrollWidth - el.clientWidth) / 2)
    })
    await expect.poll(width).toBeGreaterThan(initial)
    const keys = ['alpha', 'bravo', 'charlie', 'delta']
    // Let any layout settle (the pane drag may grow the range) before measuring.
    await expect.poll(() => barXs(page, keys, s.ids).then((xs) => xs.join())).not.toBe('')
    const before = await barXs(page, keys, s.ids)
    const scrollBefore = await chart(page).evaluate((el) => el.scrollLeft)
    expect(scrollBefore).toBeGreaterThan(340 + 260)

    await hide(page)
    await expect
      .poll(async () => {
        const after = await barXs(page, keys, s.ids)
        return Math.max(...after.map((x, i) => Math.abs(x - before[i])))
      })
      .toBeLessThanOrEqual(1)
    // The pane's 340px of earlier days were added on the left: the scroll position dropped by 340.
    expect(await chart(page).evaluate((el) => el.scrollLeft)).toBe(scrollBefore - 340)

    await show(page)
    await expect
      .poll(async () => {
        const after = await barXs(page, keys, s.ids)
        return Math.max(...after.map((x, i) => Math.abs(x - before[i])))
      })
      .toBeLessThanOrEqual(1)
    expect(await chart(page).evaluate((el) => el.scrollLeft)).toBe(scrollBefore)
    await expect(splitter(page)).toHaveAttribute('aria-valuenow', '340')
    const cell = await boxOf(outlineCells(page).first())
    expect(cell.width).toBe(340)

    // Hidden state survives a reload, and the width is still 340 after showing it again.
    await hide(page)
    await page.reload()
    await expect(showButton(page)).toBeVisible()
    await expect(splitter(page)).toHaveCount(0)
    await expect(outlineCells(page)).toHaveCount(0)
    await show(page)
    await expect(splitter(page)).toHaveAttribute('aria-valuenow', '340')
    expect(await page.evaluate(() => localStorage.getItem('cairn:gantt-pane-width'))).toBe('340')
  })

  test('hiding near the left end still keeps the days where they are (the range grows first)', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    const scroller = chart(page)
    const startWidth = await scroller.evaluate((el) => el.scrollWidth)
    // Closer to the left end than the pane is wide: the days to its left do not exist yet.
    await scroller.evaluate((el) => {
      el.scrollLeft = 120
    })
    await expect.poll(() => scroller.evaluate((el) => el.scrollWidth)).toBeGreaterThan(startWidth)
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(120)
    const alpha = bar(page, s.ids.alpha)
    const before = (await boxOf(alpha)).x
    await hide(page)
    await expect.poll(async () => Math.abs((await boxOf(alpha)).x - before)).toBeLessThanOrEqual(1)
    await show(page)
    await expect.poll(async () => Math.abs((await boxOf(alpha)).x - before)).toBeLessThanOrEqual(1)
  })

  test('Day, Week and Month work while hidden', async ({ page }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await hide(page)
    for (const scale of ['Week', 'Month', 'Day'] as const) {
      await page.getByRole('radio', { name: scale }).click()
      await expect(page.getByRole('radio', { name: scale })).toBeChecked()
      await expect(bar(page, s.ids.alpha)).toBeVisible()
      await expect(splitter(page)).toHaveCount(0)
      await expect(outlineCells(page)).toHaveCount(0)
    }
    await expect(page.locator(`[title="${dayTitle('2026-11-04')}"]`)).toBeVisible()
  })

  test('moving and resizing a bar while hidden save exactly the dates the tooltip showed', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await hide(page)
    const tip = page.locator('div.pointer-events-none.fixed')
    const range = async () => (await tip.innerText()).split(' · ')[0]

    // Move Alpha (Nov 5 – 7) two days later, reading the tooltip before the drop.
    let box = await boxOf(bar(page, s.ids.alpha))
    let from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await dragBy(page, from, 2 * PX.day, 0, { release: false })
    await expect(tip).toContainText('Nov 7 – Nov 9')
    expect(await range()).toBe('Nov 7 – Nov 9')
    await page.mouse.up()
    await expect
      .poll(() => stored(page, s.ids.alpha))
      .toEqual({
        start: '2026-11-07',
        due: '2026-11-09',
      })

    // Resize Charlie's end (Nov 14) by +1 day.
    box = await boxOf(bar(page, s.ids.charlie))
    from = { x: box.x + box.width - 3, y: box.y + box.height / 2 }
    await dragBy(page, from, PX.day, 0, { release: false })
    expect(await range()).toBe('Nov 13 – Nov 15')
    await page.mouse.up()
    await expect
      .poll(() => stored(page, s.ids.charlie))
      .toEqual({
        start: '2026-11-13',
        due: '2026-11-15',
      })

    // The shared helpers (which avoid the auto-scroll zones) agree.
    await moveBar(page, s.ids.delta, 1)
    await expect
      .poll(() => stored(page, s.ids.delta))
      .toEqual({
        start: '2026-11-09',
        due: '2026-11-10',
      })
    await resizeBar(page, s.ids.delta, 'start', -1)
    await expect
      .poll(() => stored(page, s.ids.delta))
      .toEqual({
        start: '2026-11-08',
        due: '2026-11-10',
      })
  })

  test('adds and removes a dependency while hidden', async ({ page }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await hide(page)
    expect(await storedDependencies(page)).toEqual([`${s.ids.alpha}>${s.ids.bravo}`])

    await linkDrag(page, s.ids.bravo, s.ids.charlie)
    await expect.poll(() => storedDependencies(page)).toContain(`${s.ids.bravo}>${s.ids.charlie}`)

    const point = await pointOnPath(depPath(page, s.ids['alpha->bravo']))
    await page.mouse.click(point.x, point.y)
    await page.getByRole('button', { name: 'Remove dependency: Alpha → Bravo' }).click()
    await expect.poll(() => storedDependencies(page)).toEqual([`${s.ids.bravo}>${s.ids.charlie}`])
  })

  test('Today (button and T) centres on a third of the full width while hidden', async ({
    page,
  }) => {
    await openGantt(page, seed(), 'day')
    await hide(page)
    const scroller = chart(page)
    await scroller.evaluate((el) => {
      el.scrollLeft += 900
    })
    await page.keyboard.press('t')
    const target = async () => {
      const [line, area, client] = await Promise.all([
        page.getByTestId('gantt-today-line').boundingBox(),
        scroller.boundingBox(),
        scroller.evaluate((el) => el.clientWidth),
      ])
      return Math.round((line?.x ?? Number.NaN) - (area?.x ?? 0) - client / 3)
    }
    // Settled at one third of the whole chart width (no outline to subtract).
    await expect.poll(target, { timeout: 10_000 }).toBeLessThanOrEqual(3)
    await expect.poll(target, { timeout: 10_000 }).toBeGreaterThanOrEqual(-3)
  })

  test('the Unscheduled filter and the phase collapse (saved) are untouched by the toggle', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await page.getByRole('button', { name: /^Design, \d+ tasks?$/ }).click()
    const saved = await page.evaluate(() => localStorage.getItem('cairn:gantt-collapsed'))
    expect(saved).not.toBeNull()

    await hide(page)
    expect(await page.evaluate(() => localStorage.getItem('cairn:gantt-collapsed'))).toBe(saved)
    // Design's tasks stay collapsed away.
    await expect(outlineRow(page, `task:${s.ids.delta}`)).toHaveCount(0)

    const filter = page.getByRole('button', { name: /^Show only unscheduled tasks, / })
    await filter.click()
    await expect(page.locator('[data-row-key^="task:"]')).toHaveCount(2)
    await expect(outlineRow(page, `task:${s.ids.undated1}`)).toBeVisible()
    await expect(outlineRow(page, `task:${s.ids.alpha}`)).toHaveCount(0)
    await filter.click()
    await expect(outlineRow(page, `task:${s.ids.alpha}`)).toBeVisible()

    await show(page)
    expect(await page.evaluate(() => localStorage.getItem('cairn:gantt-collapsed'))).toBe(saved)
    await expect(outlineRow(page, `task:${s.ids.delta}`)).toHaveCount(0)
  })

  test('a bar opens the Task Modal while hidden', async ({ page }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await hide(page)
    await bar(page, s.ids.bravo).click()
    await expect(page).toHaveURL(new RegExp(`task=${s.ids.bravo}`))
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('at 860px the list can be hidden and shown again, and the button does not overlap the tabs', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 860, height: 800 })
    await openGantt(page, seed(), 'day')
    const check = async (button: ReturnType<typeof hideButton>) => {
      const box = await boxOf(button)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(860)
      const overlap = await page.evaluate(
        ({ x, width }) => {
          const bar = document.querySelector('[data-slot="view-bar"]')
          const tabs = [...(bar?.children[0]?.querySelectorAll('a,button') ?? [])]
          return tabs.some((tab) => {
            const r = tab.getBoundingClientRect()
            return r.left < x + width - 0.5 && r.right > x + 0.5 && r.width > 0
          })
        },
        { x: box.x, width: box.width },
      )
      expect(overlap).toBe(false)
    }
    await check(hideButton(page))
    await hide(page)
    await check(showButton(page))
    await page.reload()
    await show(page)
    await expect(splitter(page)).toHaveAttribute('aria-valuenow', '300')
  })

  test('keyboard: Tab reaches the button, Enter toggles it, and its focus ring is visible', async ({
    page,
  }) => {
    await openGantt(page, seed(), 'day')
    const focusRing = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement
        const style = getComputedStyle(el)
        return {
          label: el.getAttribute('aria-label'),
          focusVisible: el.matches(':focus-visible'),
          ring: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
          shadow: style.boxShadow !== 'none',
        }
      })
    await page.getByRole('link', { name: 'Gantt', exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(hideButton(page)).toBeFocused()
    const ring = await focusRing()
    expect(ring.focusVisible).toBe(true)
    expect(ring.ring || ring.shadow).toBe(true)

    await page.keyboard.press('Enter')
    await expect(showButton(page)).toBeFocused()
    await expect(splitter(page)).toHaveCount(0)
    expect((await focusRing()).focusVisible).toBe(true)
    await page.keyboard.press('Enter')
    await expect(hideButton(page)).toBeFocused()
    await expect(splitter(page)).toBeVisible()
  })

  test('focus inside the outline moves to the button when the list is hidden', async ({ page }) => {
    await openGantt(page, seed(), 'day')
    await page.getByRole('button', { name: 'Alpha', exact: true }).focus()
    await hideButton(page).dispatchEvent('click')
    await expect(showButton(page)).toBeFocused()
  })

  test('hiding while a drag is in progress cancels it: nothing is written', async ({ page }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await countWrites(page)
    const box = await boxOf(bar(page, s.ids.charlie))
    await dragBy(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 2 * PX.day, 0, {
      release: false,
    })
    await expect(page.locator('div.pointer-events-none.fixed')).toContainText('+')
    // Enter on the (keyboard-focused) button while the mouse button is still down.
    await hideButton(page).focus()
    await page.keyboard.press('Enter')
    await expect(showButton(page)).toBeVisible()
    await expect(page.locator('div.pointer-events-none.fixed')).toHaveCount(0)
    await page.mouse.up()
    expect(await writes(page)).toBe(0)
    expect(await stored(page, s.ids.charlie)).toEqual({ start: '2026-11-13', due: '2026-11-14' })
  })

  test('while hidden, the left edge zone starts at the scroller edge and auto-scrolls the timeline back', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await hide(page)
    await countWrites(page)
    const scroller = chart(page)
    const area = await boxOf(scroller)
    // Make room to scroll back, then press Bravo and hold in the left edge zone (x ≈ edge + 12).
    await scroller.evaluate((el) => {
      el.scrollLeft += 1200
    })
    const box = await boxOf(bar(page, s.ids.bravo))
    const before = await scroller.evaluate((el) => el.scrollLeft)
    const from = { x: Math.max(box.x + 6, area.x + 60), y: box.y + box.height / 2 }
    await dragBy(page, from, area.x + 12 - from.x, 0, { release: false })
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeLessThan(before - 100)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect(await writes(page)).toBe(0)
    expect(await stored(page, s.ids.bravo)).toEqual({ start: '2026-11-10', due: '2026-11-12' })
  })

  test('hidden: a drop after auto-scrolling saves exactly the dates the tooltip showed', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await hide(page)
    const scroller = chart(page)
    const before = await scroller.evaluate((el) => el.scrollLeft)
    const box = await boxOf(bar(page, s.ids.charlie))
    const area = await boxOf(scroller)
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
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
    const tip = page.locator('div.pointer-events-none.fixed')
    await expect(tip).toContainText('+')
    const range = (await tip.innerText()).split(' · ')[0]
    const [start, due] = range.split(' – ').map((monthDay) => {
      const [month, day] = monthDay.split(' ')
      const m = ['Nov', 'Dec'].indexOf(month)
      if (m < 0) throw new Error(`unexpected tooltip date ${monthDay}`)
      return `2026-${String(11 + m)}-${day.padStart(2, '0')}`
    })
    expect(start > '2026-11-13').toBe(true)
    await page.mouse.up()
    await expect.poll(() => stored(page, s.ids.charlie)).toEqual({ start, due })
    await expect(bar(page, s.ids.charlie)).toHaveAccessibleName(new RegExp(`, ${range}, `))
  })

  test('the cross-project Timeline keeps its pane when the Gantt outline is hidden', async ({
    page,
  }) => {
    await openGantt(page, seed(), 'day')
    await hide(page)
    await page.goto('/timeline')
    await expect(page.getByRole('region', { name: 'Timeline of all projects' })).toBeVisible()
    await expect(page.getByRole('separator', { name: 'Resize project list' })).toBeVisible()
    await expect(page.getByRole('button', { name: /task list$/ })).toHaveCount(0)
  })
})
