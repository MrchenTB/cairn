/// <reference lib="dom" />
/**
 * UX-03 — row dividers in the Gantt outline (the task list on the left) — LOCAL data mode against
 * the dev server. Every outline row (phase header, "No phase" header, task, subtask, milestone)
 * ends in a 1px `--border-subtle` hairline drawn by an `::after` on the cell's clipping box (the
 * box that is as wide as the visible pane, so the line follows a hide / show motion and the pane
 * resizer). The timeline lane gets nothing, the row stays 32px, a selected row keeps its 2px
 * accent edge whole, and the cross-project Timeline page is unchanged.
 *
 * Time is pinned (Wed 2026-11-04, Asia/Taipei) by the shared helpers.
 */
import {
  bar,
  boxOf,
  chart,
  expect,
  moveBar,
  openGantt,
  outlineRow,
  seedWorkspace,
  stored,
  test,
  LOCAL_WORKSPACE_KEY,
  type Scale,
  type Seed,
} from './acceptance-gantt.helpers.ts'
import type { Locator, Page } from '@playwright/test'

test.use({ timezoneId: 'Asia/Taipei', locale: 'en-US', viewport: { width: 1280, height: 800 } })

const ROW_HEIGHT = 32
/** Row kinds under test: how to find the row key and what the row is called in the messages. */
const KINDS = ['phase', 'nophase', 'task', 'subtask', 'milestone', 'nophase-milestone'] as const
type Kind = (typeof KINDS)[number]

function seed(): Seed {
  return seedWorkspace({
    tasks: [
      { key: 'wire', title: 'Wireframes', start: '2026-11-09', due: '2026-11-13', phase: true },
      {
        key: 'parent',
        title: 'Frontend shell',
        start: '2026-11-02',
        due: '2026-11-10',
        phase: true,
      },
      {
        key: 'sub',
        title: 'Routing',
        start: '2026-11-03',
        due: '2026-11-05',
        phase: true,
        parent: 'parent',
      },
      { key: 'loose', title: 'Loose end', start: '2026-11-05', due: '2026-11-07' },
      { key: 'undated', title: 'Undated one' },
    ],
    milestones: [
      { key: 'launch', name: 'Launch', date: '2026-11-15', phase: true },
      { key: 'kickoff', name: 'Kickoff', date: '2026-11-06' },
    ],
  })
}

function keyOf(s: Seed, kind: Kind): string {
  switch (kind) {
    case 'phase':
      return `group:${s.phaseId}`
    case 'nophase':
      return 'group:none'
    case 'task':
      return `task:${s.ids.wire}`
    case 'subtask':
      return `task:${s.ids.sub}`
    case 'milestone':
      return `milestone:${s.ids.launch}`
    case 'nophase-milestone':
      return `milestone:${s.ids.kickoff}`
  }
}

/** The outline cell's clipping box of a row (the element carrying the divider). */
const cellOf = (page: Page, key: string) =>
  outlineRow(page, key).locator(':scope > [data-outline-divider]')

interface Divider {
  height: string
  width: string
  bottom: string
  left: string
  right: string
  position: string
  background: string
  pointerEvents: string
  content: string
  cellWidth: number
  cellHeight: number
  cellBottom: number
  rowHeight: number
  rowBottom: number
}

/** The divider's computed `::after` style next to the geometry of its cell and row. */
function dividerOf(cell: Locator): Promise<Divider> {
  return cell.evaluate((el) => {
    const after = getComputedStyle(el, '::after')
    const rect = el.getBoundingClientRect()
    const row = el.parentElement as HTMLElement
    const rowRect = row.getBoundingClientRect()
    return {
      height: after.height,
      width: after.width,
      bottom: after.bottom,
      left: after.left,
      right: after.right,
      position: after.position,
      background: after.backgroundColor,
      pointerEvents: after.pointerEvents,
      content: after.content,
      cellWidth: rect.width,
      cellHeight: rect.height,
      cellBottom: rect.bottom,
      rowHeight: rowRect.height,
      rowBottom: rowRect.bottom,
    }
  })
}

/** The resolved `--border-subtle` (through a probe element, so `color-mix` etc. resolve as paint). */
function borderSubtle(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.background = 'var(--border-subtle)'
    document.body.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  })
}

/** The pane width the chart reports (what the splitter shows when the outline is visible). */
async function paneWidth(page: Page): Promise<number> {
  return Number(await chart(page).getAttribute('data-pane-width'))
}

/** A divider spans the whole (visible) cell, drawn from the left edge. */
function expectFullWidth(divider: Divider, left = 0) {
  expect(divider.position).toBe('absolute')
  expect(parseFloat(divider.left)).toBe(left)
  expect(parseFloat(divider.right)).toBe(0)
  expect(parseFloat(divider.width)).toBeCloseTo(divider.cellWidth - left, 1)
}

const hideButton = (page: Page) => page.getByRole('button', { name: 'Hide task list' })
const showButton = (page: Page) => page.getByRole('button', { name: 'Show task list' })
const splitter = (page: Page) => page.getByRole('separator', { name: 'Resize task list' })

const dividers = (page: Page) => chart(page).locator('[data-outline-divider]')
const settled = (page: Page, state: 'shown' | 'hidden') =>
  expect(chart(page)).toHaveAttribute('data-outline', state)

test.describe('divider on every outline row kind', () => {
  for (const kind of KINDS) {
    test(`${kind}: 1px --border-subtle line along the very bottom of a 32px row, pane wide, click-through`, async ({
      page,
    }) => {
      const s = seed()
      await openGantt(page, s, 'day')
      const token = await borderSubtle(page)
      const cell = cellOf(page, keyOf(s, kind))
      await expect(cell).toHaveCount(1)
      const divider = await dividerOf(cell)

      expect(divider.content).not.toBe('none')
      expect(divider.height).toBe('1px')
      expect(divider.background).toBe(token)
      // Not a transparent "no line" (the token resolves to a real, non-opaque grey).
      expect(token).not.toBe('rgba(0, 0, 0, 0)')
      expect(parseFloat(divider.bottom)).toBe(0)
      expect(divider.pointerEvents).toBe('none')
      expectFullWidth(divider)
      expect(parseFloat(divider.width)).toBeCloseTo(await paneWidth(page), 1)
      // The cell is the whole row: its bottom edge is the row's, so the line is the row's last pixel.
      expect(divider.rowHeight).toBe(ROW_HEIGHT)
      expect(divider.cellHeight).toBe(ROW_HEIGHT)
      expect(divider.cellBottom).toBeCloseTo(divider.rowBottom, 1)
    })
  }

  test('the undated and the other No phase rows are covered too: one divider per outline row', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    const rows = chart(page).locator('[data-row-key]')
    // 2 headers + wire, parent, sub, launch + loose, undated, kickoff
    await expect(rows).toHaveCount(9)
    await expect(dividers(page)).toHaveCount(9)
    for (const key of await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-row-key')),
    )) {
      await expect(cellOf(page, key as string)).toHaveCount(1)
    }
    const token = await borderSubtle(page)
    for (const cell of await dividers(page).all()) {
      const divider = await dividerOf(cell)
      expect(divider.height).toBe('1px')
      expect(divider.background).toBe(token)
    }
  })
})

test.describe('not on the timeline lane, not on the Timeline page', () => {
  test('lanes carry no divider, shadow or bottom border; the count equals the outline rows', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    const lanes = chart(page).locator('[data-handle="lane"]')
    const rowCount = await chart(page).locator('[data-row-key]').count()
    expect(rowCount).toBeGreaterThan(0)
    await expect(lanes).toHaveCount(rowCount)
    await expect(chart(page).locator('[data-handle="lane"][data-outline-divider]')).toHaveCount(0)
    for (const lane of await lanes.all()) {
      const style = await lane.evaluate((el) => {
        const own = getComputedStyle(el)
        const after = getComputedStyle(el, '::after')
        return {
          shadow: own.boxShadow,
          border: parseFloat(own.borderBottomWidth),
          afterContent: after.content,
          beforeContent: getComputedStyle(el, '::before').content,
        }
      })
      expect(style.shadow).toBe('none')
      expect(style.border).toBe(0)
      expect(style.afterContent).toBe('none')
      expect(style.beforeContent).toBe('none')
    }
    await expect(dividers(page)).toHaveCount(rowCount)
  })

  test('the cross-project Timeline page has no divider: no marker, its outline cells have no ::after', async ({
    page,
  }) => {
    const s = seed()
    await page.clock.setFixedTime('2026-11-04T10:00:00+08:00')
    await page.addInitScript(
      ({ key, db, expandedKey, expanded }) => {
        if (sessionStorage.getItem('cairn-e2e-dividers-seeded')) return
        localStorage.setItem(key, JSON.stringify(db))
        sessionStorage.setItem(expandedKey, JSON.stringify(expanded))
        sessionStorage.setItem('cairn-e2e-dividers-seeded', '1')
      },
      {
        key: LOCAL_WORKSPACE_KEY,
        db: s.db,
        expandedKey: 'cairn:timeline-expanded',
        expanded: [s.projectId],
      },
    )
    await page.goto('/timeline')
    const timeline = page.getByRole('region', { name: 'Timeline of all projects' })
    await expect(timeline).toBeVisible()
    const rows = timeline.locator('[data-row-key]')
    // The project row and its expanded tasks render.
    await expect(rows.first()).toBeVisible()
    expect(await rows.count()).toBeGreaterThan(1)
    await expect(page.locator('[data-outline-divider]')).toHaveCount(0)
    const cells = timeline.locator('[data-row-key] > div:not([data-handle="lane"])')
    expect(await cells.count()).toBeGreaterThan(0)
    const contents = await cells.evaluateAll((els) =>
      els.map((el) => getComputedStyle(el, '::after').content),
    )
    expect(contents.every((content) => content === 'none')).toBe(true)
  })
})

test.describe('row height', () => {
  test('stays 32px for every kind and rows are stacked 32px apart', async ({ page }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    const tops: number[] = []
    for (const kind of KINDS) {
      const row = outlineRow(page, keyOf(s, kind))
      const box = await boxOf(row)
      expect(box.height, kind).toBe(ROW_HEIGHT)
      expect((await boxOf(cellOf(page, keyOf(s, kind)))).height, kind).toBe(ROW_HEIGHT)
      tops.push(box.y)
    }
    // Consecutive rows (document order) have a top spacing of exactly one row height.
    const all = await chart(page)
      .locator('[data-row-key]')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().y))
    for (let i = 1; i < all.length; i++) expect(all[i] - all[i - 1]).toBe(ROW_HEIGHT)
  })
})

test.describe('hover and selected rows', () => {
  test('hovering a task row leaves the divider as it was', async ({ page }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    const cell = cellOf(page, `task:${s.ids.wire}`)
    await page.mouse.move(640, 700) // somewhere neutral
    const before = await dividerOf(cell)
    await cell.getByRole('button', { name: 'Wireframes', exact: true }).hover()
    const after = await dividerOf(cell)
    expect(after).toEqual(before)
    expect(after.height).toBe('1px')
    // The row's hover tint is really on (the cell background changed under the line).
    const tint = await cell
      .locator(':scope > div')
      .evaluate((el) => getComputedStyle(el).backgroundImage)
    expect(tint).not.toBe('none')
  })

  test('a selected task row: the line starts after the 2px accent edge, which stays whole; other rows start at 0', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await cellOf(page, `task:${s.ids.wire}`)
      .getByRole('button', { name: 'Wireframes', exact: true })
      .click()
    await expect(page).toHaveURL(new RegExp(`task=${s.ids.wire}`))
    await expect(page.getByRole('dialog')).toBeVisible()

    const selected = cellOf(page, `task:${s.ids.wire}`)
    const divider = await dividerOf(selected)
    expect(divider.left).toBe('2px')
    expect(divider.height).toBe('1px')
    expect(parseFloat(divider.width)).toBeCloseTo(divider.cellWidth - 2, 1)
    // The accent edge: an inset 2px shadow on the content box, a full row tall.
    const shadow = await selected
      .locator(':scope > div')
      .evaluate((el) => getComputedStyle(el).boxShadow)
    expect(shadow).toMatch(/inset/)
    expect(shadow).toMatch(/\s2px\s+0px\s+0px/)
    expect((await boxOf(selected.locator(':scope > div'))).height).toBe(ROW_HEIGHT)

    for (const kind of KINDS.filter((kind) => kind !== 'task')) {
      const other = await dividerOf(cellOf(page, keyOf(s, kind)))
      expect(other.left, kind).toBe('0px')
    }
    const plain = await cellOf(page, `task:${s.ids.loose}`)
      .locator(':scope > div')
      .evaluate((el) => getComputedStyle(el).boxShadow)
    expect(plain).toBe('none')
  })

  test('a selected milestone row (its dialog is open) is the same', async ({ page }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await cellOf(page, `milestone:${s.ids.launch}`)
      .getByRole('button', { name: /Launch/ })
      .click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const selected = cellOf(page, `milestone:${s.ids.launch}`)
    const divider = await dividerOf(selected)
    expect(divider.left).toBe('2px')
    expect(divider.height).toBe('1px')
    const shadow = await selected
      .locator(':scope > div')
      .evaluate((el) => getComputedStyle(el).boxShadow)
    expect(shadow).toMatch(/inset/)
    expect((await dividerOf(cellOf(page, `task:${s.ids.wire}`))).left).toBe('0px')
    expect((await dividerOf(cellOf(page, `milestone:${s.ids.kickoff}`))).left).toBe('0px')
  })
})

test.describe('focus ring and pointer', () => {
  test('the line sits below the title button: the focus ring is not covered and the button keeps the pointer', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    const rowKey = `task:${s.ids.wire}`
    const cell = cellOf(page, rowKey)
    const title = cell.getByRole('button', { name: 'Wireframes', exact: true })

    // Reach the title button with the keyboard so :focus-visible is real.
    await page.getByRole('radio', { name: 'Month' }).focus()
    for (let i = 0; i < 40 && !(await title.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab')
    }
    await expect(title).toBeFocused()
    const ring = await title.evaluate((el) => {
      const style = getComputedStyle(el)
      return {
        focusVisible: el.matches(':focus-visible'),
        ring: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
        shadow: style.boxShadow !== 'none',
      }
    })
    expect(ring.focusVisible).toBe(true)
    expect(ring.ring || ring.shadow).toBe(true)

    const button = await boxOf(title)
    const divider = await dividerOf(cell)
    const lineTop = divider.rowBottom - 1
    // The button (and so its inset ring) ends above the line.
    expect(button.y + button.height).toBeLessThanOrEqual(lineTop + 0.01)
    expect(button.y).toBeGreaterThanOrEqual(divider.rowBottom - ROW_HEIGHT)

    // The pointer still lands on the button: in its middle and at its very bottom edge.
    const centre = { x: button.x + button.width / 2, y: button.y + button.height / 2 }
    const hit = (point: { x: number; y: number }) =>
      page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y)
        return el?.closest('button')?.getAttribute('title') ?? el?.tagName ?? null
      }, point)
    expect(await hit(centre)).toBe('Wireframes')
    expect(await hit({ x: centre.x, y: button.y + button.height - 1 })).toBe('Wireframes')
    // The line itself takes no pointer: a click on it opens nothing.
    await page.mouse.click(centre.x, divider.rowBottom - 0.5)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // A click on the button's lowest pixel row still opens the task.
    await page.mouse.click(centre.x, button.y + button.height - 1)
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`task=${s.ids.wire}`))
  })
})

/** One animation frame of the hide / show motion. */
interface Frame {
  state: string | null
  pane: number
  cells: { cell: number; line: number; left: number }[]
}

async function startFrames(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: Frame[]; __stop: boolean }
    const region = document.querySelector<HTMLElement>(
      '[role="region"][aria-label="Gantt chart"]',
    ) as HTMLElement
    w.__frames = []
    w.__stop = false
    const tick = () => {
      w.__frames.push({
        state: region.getAttribute('data-outline'),
        pane: Number(region.getAttribute('data-pane-width')),
        cells: [...region.querySelectorAll<HTMLElement>('[data-outline-divider]')].map((el) => ({
          cell: el.getBoundingClientRect().width,
          line: parseFloat(getComputedStyle(el, '::after').width),
          left: parseFloat(getComputedStyle(el, '::after').left),
        })),
      })
      if (!w.__stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopFrames(page: Page): Promise<Frame[]> {
  return page.evaluate(
    () =>
      new Promise<Frame[]>((resolve) => {
        const w = window as unknown as { __frames: Frame[]; __stop: boolean }
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            w.__stop = true
            resolve(w.__frames)
          }),
        )
      }),
  )
}

test.describe('hide and show the task list', () => {
  test('hidden leaves no line; during the 200ms motion every line is as wide as its box and the pane; shown is full again', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await expect(dividers(page)).toHaveCount(9)
    const full = await paneWidth(page)
    expect(full).toBe(300)

    await startFrames(page)
    await hideButton(page).click()
    await settled(page, 'hidden')
    const hiding = await stopFrames(page)
    // Hidden: no cell, so no line left behind (and no divider anywhere in the chart).
    await expect(dividers(page)).toHaveCount(0)
    await expect(showButton(page)).toBeVisible()
    const moving = hiding.filter((frame) => frame.cells.length > 0 && frame.pane > 0)
    expect(moving.length).toBeGreaterThan(0)
    for (const frame of moving) {
      for (const { cell, line, left } of frame.cells) {
        expect(Math.abs(cell - frame.pane)).toBeLessThanOrEqual(0.5)
        expect(Math.abs(line + left - cell)).toBeLessThanOrEqual(0.5)
      }
    }
    // Part way through the motion the lines were really narrower than the full pane.
    expect(moving.some((frame) => frame.pane < full - 1)).toBe(true)

    await startFrames(page)
    await showButton(page).click()
    await settled(page, 'shown')
    const showing = await stopFrames(page)
    for (const frame of showing.filter((f) => f.cells.length > 0)) {
      for (const { cell, line, left } of frame.cells) {
        expect(Math.abs(cell - frame.pane)).toBeLessThanOrEqual(0.5)
        expect(Math.abs(line + left - cell)).toBeLessThanOrEqual(0.5)
      }
    }
    await expect(dividers(page)).toHaveCount(9)
    for (const cell of await dividers(page).all()) {
      const divider = await dividerOf(cell)
      expect(divider.cellWidth).toBeCloseTo(full, 1)
      expect(parseFloat(divider.width)).toBeCloseTo(full, 1)
      expect(divider.height).toBe('1px')
    }
  })
})

test.describe('pane resizer', () => {
  test('the line follows the pane width: wider, narrower, back to the default', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    const handle = splitter(page)
    const key = `task:${s.ids.wire}`
    await handle.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(handle).toHaveAttribute('aria-valuenow', '332')
    for (const kind of KINDS) {
      const divider = await dividerOf(cellOf(page, keyOf(s, kind)))
      expect(parseFloat(divider.width), kind).toBeCloseTo(332, 1)
      expect(divider.cellWidth, kind).toBeCloseTo(332, 1)
    }
    await page.keyboard.press('Home')
    await expect(handle).toHaveAttribute('aria-valuenow', '220')
    expect(parseFloat((await dividerOf(cellOf(page, key))).width)).toBeCloseTo(220, 1)
    await page.keyboard.press('Enter')
    await expect(handle).toHaveAttribute('aria-valuenow', '300')
    expect(parseFloat((await dividerOf(cellOf(page, key))).width)).toBeCloseTo(300, 1)

    // A real drag does the same.
    const box = await boxOf(handle)
    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + 200, { steps: 6 })
    await page.mouse.up()
    await expect(handle).toHaveAttribute('aria-valuenow', '340')
    for (const kind of KINDS) {
      expect(parseFloat((await dividerOf(cellOf(page, keyOf(s, kind)))).width), kind).toBeCloseTo(
        340,
        1,
      )
    }
  })
})

test.describe('scales, theme and narrow screens', () => {
  for (const scale of ['day', 'week', 'month'] as Scale[]) {
    test(`${scale}: every kind has the same 1px full-width line`, async ({ page }) => {
      const s = seed()
      await openGantt(page, s, scale)
      const token = await borderSubtle(page)
      await expect(dividers(page)).toHaveCount(9)
      for (const kind of KINDS) {
        const divider = await dividerOf(cellOf(page, keyOf(s, kind)))
        expect(divider.height, kind).toBe('1px')
        expect(divider.background, kind).toBe(token)
        expect(parseFloat(divider.width), kind).toBeCloseTo(300, 1)
        expect(divider.rowHeight, kind).toBe(ROW_HEIGHT)
      }
    })
  }

  test('dark mode: the dark --border-subtle, still 1px, and it differs from the light one', async ({
    page,
  }) => {
    const s = seed()
    await page.emulateMedia({ colorScheme: 'light' })
    await openGantt(page, s, 'day')
    const lightToken = await borderSubtle(page)
    const light = await dividerOf(cellOf(page, `task:${s.ids.wire}`))
    expect(light.background).toBe(lightToken)

    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => borderSubtle(page)).not.toBe(lightToken)
    const darkToken = await borderSubtle(page)
    for (const kind of KINDS) {
      const divider = await dividerOf(cellOf(page, keyOf(s, kind)))
      expect(divider.height, kind).toBe('1px')
      expect(divider.background, kind).toBe(darkToken)
    }
  })

  for (const viewport of [
    { width: 860, height: 700 },
    { width: 390, height: 844 },
  ]) {
    test(`${viewport.width}px wide: the line spans the visible pane`, async ({ page }) => {
      await page.setViewportSize(viewport)
      const s = seed()
      await openGantt(page, s, 'day')
      await expect(dividers(page)).toHaveCount(9)
      const pane = await paneWidth(page)
      expect(pane).toBeGreaterThan(0)
      for (const kind of KINDS) {
        const divider = await dividerOf(cellOf(page, keyOf(s, kind)))
        expect(divider.height, kind).toBe('1px')
        expect(parseFloat(divider.width), kind).toBeCloseTo(pane, 1)
        expect(divider.cellWidth, kind).toBeCloseTo(pane, 1)
      }
    })
  }
})

test.describe('regression smoke', () => {
  test('phase and subtask collapse still toggle and the remaining rows keep their lines', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await expect(dividers(page)).toHaveCount(9)

    // Subtask collapse: Routing goes, 8 rows with a line each.
    await page.getByRole('button', { name: 'Hide 1 subtask of Frontend shell' }).click()
    await expect(outlineRow(page, `task:${s.ids.sub}`)).toHaveCount(0)
    await expect(dividers(page)).toHaveCount(8)
    await page.getByRole('button', { name: 'Show 1 subtask of Frontend shell' }).click()
    await expect(outlineRow(page, `task:${s.ids.sub}`)).toHaveCount(1)
    await expect(dividers(page)).toHaveCount(9)

    // Phase collapse: Design's four rows (wire, parent, sub, launch) go.
    await page.getByRole('button', { name: /^Design, \d+ tasks?$/ }).click()
    await expect(outlineRow(page, `task:${s.ids.wire}`)).toHaveCount(0)
    await expect(dividers(page)).toHaveCount(5)
    const token = await borderSubtle(page)
    for (const cell of await dividers(page).all()) {
      const divider = await dividerOf(cell)
      expect(divider.height).toBe('1px')
      expect(divider.background).toBe(token)
    }
    await page.getByRole('button', { name: /^Design, \d+ tasks?$/ }).click()
    await expect(outlineRow(page, `task:${s.ids.wire}`)).toHaveCount(1)
    await expect(dividers(page)).toHaveCount(9)
  })

  test('moving a bar still saves, and the row keeps its line', async ({ page }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    expect(await stored(page, s.ids.loose)).toEqual({ start: '2026-11-05', due: '2026-11-07' })
    await moveBar(page, s.ids.loose, 2)
    await expect
      .poll(() => stored(page, s.ids.loose))
      .toEqual({ start: '2026-11-07', due: '2026-11-09' })
    await expect(bar(page, s.ids.loose)).toBeVisible()
    const divider = await dividerOf(cellOf(page, `task:${s.ids.loose}`))
    expect(divider.height).toBe('1px')
    expect(divider.rowHeight).toBe(ROW_HEIGHT)
  })
})
