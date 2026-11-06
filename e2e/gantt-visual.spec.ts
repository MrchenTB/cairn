/// <reference lib="dom" />
/**
 * Gantt visual refinements (UX iteration 1, docs/ux-audit.md G-1 / G-3 / G-6 / G-7 / G-9), checked
 * against computed styles and geometry of the real page: a quiet grid (no weekend bands, header
 * lanes see-through), opaque bars and label chips (nothing shows through the letters), bar
 * tooltips that never get in the way of drag / resize, and the Unscheduled jump landing on the
 * tasks. Time is pinned to Wed 2026-11-04 (Asia/Taipei) by the shared helpers.
 */
import {
  bar,
  boxOf,
  chart,
  dragBy,
  expect,
  openGantt,
  seedWorkspace,
  test,
} from './acceptance-gantt.helpers.ts'
import type { Page } from '@playwright/test'

test.use({ timezoneId: 'Asia/Taipei', locale: 'en-US', viewport: { width: 1280, height: 800 } })

/** Alpha channel of a computed CSS colour ("rgb(…)", "rgba(…)", "color(srgb …)", "oklab(…)"). */
function alphaOf(color: string): number {
  if (color === 'transparent') return 0
  const slash = color.match(/\/\s*([\d.]+%?)\s*\)/)
  if (slash) return slash[1].endsWith('%') ? parseFloat(slash[1]) / 100 : parseFloat(slash[1])
  const rgba = color.match(/^rgba\(([^)]+)\)$/)
  if (rgba) return parseFloat(rgba[1].split(',')[3])
  return 1
}

function weekSeed() {
  return seedWorkspace({
    tasks: [
      { key: 'todo', title: 'Wireframes', start: '2026-11-09', due: '2026-11-13', phase: true },
      {
        key: 'active',
        title: 'Frontend shell',
        start: '2026-11-02',
        due: '2026-11-10',
        status: 'in_progress',
      },
      {
        key: 'done',
        title: 'Kickoff brief',
        start: '2026-10-26',
        due: '2026-10-28',
        status: 'done',
      },
      {
        key: 'long',
        title: 'Information architecture and navigation structure review for everything',
        start: '2026-11-12',
        due: '2026-11-13',
      },
    ],
    deps: [['done', 'todo']],
  })
}

test.describe('quiet grid (G-1)', () => {
  for (const scale of ['day', 'week', 'month'] as const) {
    test(`${scale}: no weekend bands, no per-day lines, phase header lanes see-through`, async ({
      page,
    }) => {
      const seed = weekSeed()
      await openGantt(page, seed, scale)
      const grid = chart(page).locator('div[aria-hidden="true"].z-0').first()
      const style = await grid.evaluate((el) => {
        const s = getComputedStyle(el)
        return { image: s.backgroundImage, size: s.backgroundSize }
      })
      expect(style.image).not.toContain('--gantt-weekend')
      if (scale === 'month') {
        expect(style.image).toBe('none') // month lines are DOM lines, no repeating grid
      } else {
        // exactly one repeating layer: one hairline per week
        expect(style.image.match(/linear-gradient/g)).toHaveLength(1)
        expect(style.size).toBe(`${7 * (scale === 'day' ? 36 : 16)}px 100%`)
      }
      // The phase header row's time lane paints nothing, so the grid runs through it.
      const lane = chart(page)
        .locator('[data-handle="lane"]')
        .filter({ has: page.locator('[title^="Design"]') })
      expect(alphaOf(await lane.evaluate((el) => getComputedStyle(el).backgroundColor))).toBe(0)
    })
  }

  test('the today line is a 1px hairline, translucent but present', async ({ page }) => {
    await openGantt(page, weekSeed(), 'week')
    const line = page.getByTestId('gantt-today-line')
    const box = await boxOf(line)
    expect(box.width).toBeCloseTo(1, 1)
    const opacity = await line.evaluate((el) => parseFloat(getComputedStyle(el).opacity))
    expect(opacity).toBeGreaterThan(0.4)
    expect(opacity).toBeLessThan(0.8)
  })
})

test.describe('opaque bars and labels (G-3, G-6)', () => {
  test('bar fills are opaque in every status, so lines never show through the title', async ({
    page,
  }) => {
    const seed = weekSeed()
    await openGantt(page, seed, 'day')
    for (const key of ['todo', 'active', 'done']) {
      const color = await bar(page, seed.ids[key]).evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      )
      expect(alphaOf(color), `${key}: ${color}`).toBe(1)
    }
  })

  test('a bar that cannot hold its title shows it outside: opaque chip, capped width, ellipsis', async ({
    page,
  }) => {
    const seed = weekSeed()
    await openGantt(page, seed, 'week')
    const label = page.locator('span[aria-hidden="true"]', { hasText: /^Information architecture/ })
    await expect(label).toBeVisible()
    const box = await boxOf(label)
    expect(box.width).toBeLessThanOrEqual(240)
    const color = await label.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(alphaOf(color)).toBe(1)
    const truncated = await label
      .locator('span.truncate')
      .evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(truncated).toBe(true)
    // The bar itself carries the full name for assistive tech and the tooltip.
    await expect(bar(page, seed.ids.long)).toHaveAttribute(
      'aria-label',
      /^Information architecture and navigation structure review for everything,/,
    )
  })

  test('a title that fits stays inside its bar (Day scale)', async ({ page }) => {
    const seed = weekSeed()
    await openGantt(page, seed, 'day')
    await expect(bar(page, seed.ids.todo)).toContainText('Wireframes')
  })
})

test.describe('bar tooltip (G-7)', () => {
  test('hover shows name, dates and length; it leaves on drag and resize', async ({ page }) => {
    const seed = weekSeed()
    await openGantt(page, seed, 'day')
    const target = bar(page, seed.ids.todo)
    const box = await boxOf(target)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const tip = page.getByRole('tooltip')
    await expect(tip).toBeVisible()
    await expect(tip).toContainText('Wireframes')
    await expect(tip).toContainText('Nov 9 – Nov 13 · 5 days')
    // Moving the bar: only the drag readout shows (the tooltip is gone and stays gone).
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 5 })
    await expect(tip).toBeHidden()
    await page.keyboard.press('Escape')
    await page.mouse.up()
    // Resizing from the end grip: same.
    const after = await boxOf(target)
    await page.mouse.move(after.x + after.width - 3, after.y + after.height / 2)
    await expect(tip).toBeVisible()
    await dragBy(page, { x: after.x + after.width - 3, y: after.y + after.height / 2 }, 40, 0, {
      release: false,
    })
    await expect(tip).toBeHidden()
    await page.keyboard.press('Escape')
    await page.mouse.up()
  })

  test('the tooltip never intercepts the pointer', async ({ page }) => {
    const seed = weekSeed()
    await openGantt(page, seed, 'day')
    const box = await boxOf(bar(page, seed.ids.todo))
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const tip = page.getByRole('tooltip')
    await expect(tip).toBeVisible()
    const pointerEvents = await page
      .locator('[data-slot="tooltip"]')
      .evaluate((el) => getComputedStyle(el).pointerEvents)
    expect(pointerEvents).toBe('none')
  })
})

test.describe('Unscheduled jump (G-9)', () => {
  /** Enough dated rows to need scrolling, with undated tasks at the end. */
  function manyRows() {
    const tasks = Array.from({ length: 22 }, (_, i) => ({
      key: `t${i}`,
      title: `Task ${i}`,
      start: '2026-11-04',
      due: '2026-11-06',
    }))
    return seedWorkspace({
      tasks: [
        ...tasks,
        { key: 'u1', title: 'Write release notes' },
        { key: 'u2', title: 'Plan retro' },
      ],
    })
  }

  /** The toolbar's "Unscheduled n" button (the outline's group header has its own, longer name). */
  const jumpToUnscheduled = (page: Page) =>
    page.getByRole('button', { name: 'Unscheduled 2', exact: true }).click()

  async function rowsInView(page: Page, keys: string[]) {
    return chart(page).evaluate((el, wanted) => {
      const area = el.getBoundingClientRect()
      const top = area.top + 48 // sticky time header
      return wanted.map((key) => {
        const row = el.querySelector(`[data-row-key="${key}"]`)?.getBoundingClientRect()
        return row ? row.top >= top - 0.5 && row.bottom <= area.bottom + 0.5 : false
      })
    }, keys)
  }

  test('the header and every unscheduled task are on screen after the jump', async ({ page }) => {
    const seed = manyRows()
    await openGantt(page, seed, 'week')
    await jumpToUnscheduled(page)
    await expect
      .poll(() => rowsInView(page, ['unscheduled', `task:${seed.ids.u1}`, `task:${seed.ids.u2}`]))
      .toEqual([true, true, true])
  })

  test('a collapsed group is expanded first, and a second click still lands on the tasks', async ({
    page,
  }) => {
    const seed = manyRows()
    await openGantt(page, seed, 'week')
    const toggle = page.getByRole('button', { name: /^Unscheduled, 2 tasks/ })
    // Reach the group, collapse it, scroll away, then jump.
    await jumpToUnscheduled(page)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await chart(page).evaluate((el) => {
      el.scrollTop = 0
    })
    await jumpToUnscheduled(page)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect
      .poll(() => rowsInView(page, ['unscheduled', `task:${seed.ids.u1}`, `task:${seed.ids.u2}`]))
      .toEqual([true, true, true])
    await jumpToUnscheduled(page)
    await expect
      .poll(() => rowsInView(page, [`task:${seed.ids.u1}`, `task:${seed.ids.u2}`]))
      .toEqual([true, true])
  })
})
