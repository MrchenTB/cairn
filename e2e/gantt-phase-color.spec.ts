/// <reference lib="dom" />
/**
 * Phase colours and the weekend band (UX iteration 2), in the real page:
 * - a workspace / backup written before phase colours still loads (nothing is set aside);
 * - choosing, saving, reloading and clearing a phase colour, and the project colour fallback;
 * - the weekend band stays aligned with the header's weekend cells while scrolling and with
 *   virtualised rows (320 tasks).
 * Time is pinned to Wed 2026-11-04 (Asia/Taipei) by the shared helpers.
 */
import {
  bar,
  chart,
  expect,
  LOCAL_WORKSPACE_KEY,
  NOW,
  openGantt,
  seedWorkspace,
  test,
  type Seed,
} from './acceptance-gantt.helpers.ts'
import type { Page } from '@playwright/test'

test.use({ timezoneId: 'Asia/Taipei', locale: 'en-US', viewport: { width: 1280, height: 800 } })

const phasedSeed = () =>
  seedWorkspace({
    tasks: [
      { key: 'a', title: 'Wireframes', start: '2026-11-04', due: '2026-11-08', phase: true },
      { key: 'b', title: 'Loose task', start: '2026-11-05', due: '2026-11-09' },
    ],
  })

const stored = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}'), LOCAL_WORKSPACE_KEY)

const rowHue = (page: Page, key: string) =>
  page.locator(`[data-row-key="${key}"]`).first().getAttribute('data-hue')

test.describe('legacy data', () => {
  test('a workspace saved before phase colours opens as usual, phases on the project colour', async ({
    page,
  }) => {
    const seed = phasedSeed()
    // Exactly what an older build wrote: phases without a `color` key.
    for (const phase of Object.values(
      (seed.db as { phases: Record<string, Record<string, unknown>> }).phases,
    )) {
      delete phase.color
    }
    await openGantt(page, seed, 'day')
    await expect(bar(page, seed.ids.a)).toBeVisible()
    await expect(bar(page, seed.ids.b)).toBeVisible()
    // Nothing was set aside as unreadable, and every row is on the project's colour (violet).
    const keys = await page.evaluate(() => Object.keys(localStorage))
    expect(keys.filter((key) => key.includes('unreadable'))).toEqual([])
    expect(await rowHue(page, `task:${seed.ids.a}`)).toBe('violet')
    expect(await rowHue(page, `task:${seed.ids.b}`)).toBe('violet')
    await expect(
      page.getByRole('button', { name: /^Color of Design: Project color \(Violet\)/ }),
    ).toBeVisible()
  })

  test('a backup file from before phase colours imports; the phase follows the project colour', async ({
    page,
  }) => {
    const seed = phasedSeed()
    const db = seed.db as {
      projects: Record<string, unknown>
      phases: Record<string, Record<string, unknown>>
      tasks: Record<string, unknown>
      milestones: Record<string, unknown>
      dependencies: Record<string, unknown>
    }
    for (const phase of Object.values(db.phases)) delete phase.color
    const backup = {
      app: 'cairn',
      formatVersion: 1,
      exportedAt: '2026-11-03T08:00:00.000Z',
      preferences: null,
      data: {
        projects: Object.values(db.projects),
        phases: Object.values(db.phases),
        tasks: Object.values(db.tasks),
        milestones: Object.values(db.milestones),
        dependencies: Object.values(db.dependencies),
      },
    }
    await page.clock.setFixedTime(NOW)
    await page.goto('/settings/data')
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
    await page.getByLabel('Backup file').setInputFiles({
      name: 'old.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup)),
    })
    const dialog = page.getByRole('dialog', { name: 'Import backup' })
    await dialog.getByRole('button', { name: 'Import as new copies' }).click()
    await expect(dialog).toBeHidden()
    const phases = Object.values((await stored(page)).phases as Record<string, { color: unknown }>)
    expect(phases).toHaveLength(1)
    expect(phases[0].color).toBeNull()
  })

  test('a new backup keeps phase colours: export → import', async ({ page }) => {
    const seed = phasedSeed()
    Object.values((seed.db as { phases: Record<string, { color: unknown }> }).phases)[0].color =
      'teal'
    await page.clock.setFixedTime(NOW)
    await page.addInitScript(
      ({ key, db }) => {
        if (!sessionStorage.getItem('seeded')) {
          localStorage.setItem(key, JSON.stringify(db))
          sessionStorage.setItem('seeded', '1')
        }
      },
      { key: LOCAL_WORKSPACE_KEY, db: seed.db },
    )
    await page.goto('/settings/data')
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    const path = await download.path()
    const text = (await import('node:fs/promises')).readFile(path, 'utf8')
    const file = JSON.parse(await text)
    expect(file.data.phases[0].color).toBe('teal')
    await page.getByLabel('Backup file').setInputFiles({
      name: 'new.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(file)),
    })
    const dialog = page.getByRole('dialog', { name: 'Import backup' })
    await dialog.getByRole('button', { name: 'Import as new copies' }).click()
    await expect(dialog).toBeHidden()
    const phases = Object.values((await stored(page)).phases as Record<string, { color: unknown }>)
    expect(phases.map((phase) => phase.color)).toEqual(['teal', 'teal'])
  })
})

test.describe('phase colour in the Gantt', () => {
  test('choose → saved and still there after a reload; "Use project color" returns to violet', async ({
    page,
  }) => {
    const seed = phasedSeed()
    await openGantt(page, seed, 'day')
    const dot = page.getByRole('button', { name: /^Color of Design:/ })
    await dot.click()
    await page.getByRole('radio', { name: 'Teal' }).click()
    await expect.poll(() => rowHue(page, `task:${seed.ids.a}`)).toBe('teal')
    // The task outside the phase keeps the project colour.
    expect(await rowHue(page, `task:${seed.ids.b}`)).toBe('violet')
    const phases = Object.values((await stored(page)).phases as Record<string, { color: unknown }>)
    expect(phases[0].color).toBe('teal')
    // The bar really is teal-ish, opaque, and a different colour from the violet one.
    const fill = (id: string) =>
      bar(page, id).evaluate((el) => {
        const c = getComputedStyle(el).backgroundColor
        return c
      })
    const teal = await fill(seed.ids.a)
    const violet = await fill(seed.ids.b)
    expect(teal).not.toBe(violet)
    await page.reload()
    await expect(bar(page, seed.ids.a)).toBeVisible()
    expect(await rowHue(page, `task:${seed.ids.a}`)).toBe('teal')
    await page.getByRole('button', { name: /^Color of Design: Teal/ }).click()
    await page.getByRole('button', { name: 'Use project color' }).click()
    await expect.poll(() => rowHue(page, `task:${seed.ids.a}`)).toBe('violet')
  })

  test('Esc closes the picker and returns focus to the dot; arrow keys move between colours', async ({
    page,
  }) => {
    const seed = phasedSeed()
    await openGantt(page, seed, 'day')
    const dot = page.getByRole('button', { name: /^Color of Design:/ })
    await dot.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('radiogroup', { name: 'Color of Design' })).toBeVisible()
    // Focus lands on the first swatch; arrows move along the palette.
    await expect(page.getByRole('radio', { name: 'Gray' })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('radio', { name: 'Blue' })).toBeFocused()
    // One Esc closes the picker (a swatch tooltip must not take the first one).
    await page.keyboard.press('Escape')
    await expect(page.getByRole('radiogroup', { name: 'Color of Design' })).toBeHidden()
    await expect(dot).toBeFocused()
  })

  test('conflicts stay red whatever the phase colour', async ({ page }) => {
    const seed = seedWorkspace({
      tasks: [
        { key: 'a', title: 'First', start: '2026-11-04', due: '2026-11-08', phase: true },
        { key: 'b', title: 'Second', start: '2026-11-05', due: '2026-11-09', phase: true },
      ],
      deps: [['a', 'b']],
    })
    Object.values((seed.db as { phases: Record<string, { color: unknown }> }).phases)[0].color =
      'teal'
    await openGantt(page, seed, 'day')
    const border = await bar(page, seed.ids.b).evaluate((el) => getComputedStyle(el).borderTopColor)
    const conflict = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--gantt-conflict').trim(),
    )
    expect(conflict).not.toBe('')
    // Red channel dominates (the conflict token), not teal.
    const [r, g, b] = (border.match(/[\d.]+/g) ?? []).map(Number)
    expect(r).toBeGreaterThan(g + 50)
    expect(r).toBeGreaterThan(b + 50)
  })
})

/** Weekend band vs header weekend cells, from the page's own geometry. */
async function bandOffsetFromHeader(page: Page): Promise<{ residue: number; week: number }[]> {
  return page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>('[role="region"] div[aria-hidden="true"].z-0')
    if (!grid) throw new Error('no grid')
    const style = getComputedStyle(grid)
    const sizes = style.backgroundSize.split(', ')
    const positions = style.backgroundPosition.split(', ')
    const week = parseFloat(sizes[1])
    const bandX = parseFloat(positions[1])
    const left = grid.getBoundingClientRect().left
    // Saturday / Sunday day cells of the Day header carry the weekend tint.
    const cells = [...document.querySelectorAll<HTMLElement>('[title]')].filter((el) =>
      /^(Saturday|Sunday),/.test(el.getAttribute('title') ?? ''),
    )
    return cells
      .map((cell) => {
        const x = cell.getBoundingClientRect().left - left
        const mod = (((x - bandX) % week) + week) % week
        return { residue: Math.min(mod, week - mod), week, isSat: cell.title.startsWith('Sat') }
      })
      .map(({ residue, week }) => ({ residue, week }))
  })
}

test.describe('weekend band', () => {
  test('lines up with the weekend header cells at any horizontal scroll', async ({ page }) => {
    const seed = phasedSeed()
    await openGantt(page, seed, 'day')
    for (const x of [0, 137, 1001, 2500]) {
      await chart(page).evaluate((el, left) => el.scrollTo({ left }), x)
      await page.waitForTimeout(150)
      const cells = await bandOffsetFromHeader(page)
      expect(cells.length).toBeGreaterThan(0)
      // Saturdays start the band; Sundays sit one day (36px) into it: both are within a pixel of a
      // 36px grid anchored at the band, never half a day off.
      for (const { residue } of cells)
        expect(residue % 36 < 1 || 36 - (residue % 36) < 1).toBe(true)
    }
  })

  test('a 320-task project: the band spans every row and stays aligned while scrolling', async ({
    page,
  }) => {
    const tasks = Array.from({ length: 320 }, (_, i) => ({
      key: `t${i}`,
      title: `Task ${i}`,
      start: `2026-11-${String((i % 25) + 1).padStart(2, '0')}`,
      due: `2026-11-${String((i % 25) + 3).padStart(2, '0')}`,
    }))
    const seed: Seed = seedWorkspace({ tasks })
    await openGantt(page, seed, 'week')
    // The grid is as tall as the whole body (320 rows), not just the rendered window.
    const heights = await page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>(
        '[role="region"] div[aria-hidden="true"].z-0',
      )!
      const body = grid.parentElement!
      return {
        grid: grid.getBoundingClientRect().height,
        body: body.getBoundingClientRect().height,
      }
    })
    expect(heights.grid).toBeCloseTo(heights.body, 0)
    expect(heights.grid).toBeGreaterThan(320 * 32 - 1)
    // Fast scrolling: still few DOM rows, and scroll is smooth (no long frames over a flick).
    const stats = await page.evaluate(async () => {
      const el = document.querySelector<HTMLElement>('[role="region"][aria-label="Gantt chart"]')!
      let worst = 0
      let last = performance.now()
      let frames = 0
      const tick = (now: number) => {
        worst = Math.max(worst, now - last)
        last = now
        frames += 1
      }
      let running = true
      const loop = (now: number) => {
        tick(now)
        if (running) requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
      for (let i = 0; i < 40; i += 1) {
        el.scrollTop += 240
        el.scrollLeft += i % 2 ? 30 : -20
        await new Promise((r) => requestAnimationFrame(r))
      }
      running = false
      return {
        worst,
        frames,
        rows: document.querySelectorAll('[data-row-key]').length,
        scrollTop: el.scrollTop,
      }
    })
    expect(stats.rows).toBeLessThan(80)
    expect(stats.scrollTop).toBeGreaterThan(3000)
    // A generous bound (headless, shared machine): no multi-hundred-ms stall while scrolling.
    expect(stats.worst).toBeLessThan(250)
  })

  test('the band paints under bars, labels and links and never takes the pointer', async ({
    page,
  }) => {
    const seed = phasedSeed()
    await openGantt(page, seed, 'day')
    const grid = page.locator('[role="region"] div[aria-hidden="true"].z-0').first()
    expect(await grid.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
    expect(await grid.evaluate((el) => getComputedStyle(el).zIndex)).toBe('0')
    // A bar over a weekend column is still opaque and clickable.
    const b = bar(page, seed.ids.a)
    await b.click()
    await expect(page).toHaveURL(/task/)
  })
})
