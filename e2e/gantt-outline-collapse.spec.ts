/// <reference lib="dom" />
/**
 * UX-02 — hiding and showing the Gantt outline pane (task list) — LOCAL data mode against the dev
 * server. Hidden = the timeline uses the full width: no outline column, no splitter, and bars,
 * dependencies, the time header, the Today line and the drag auto-scroll edges all work from the
 * scroller's left edge. The setting is per device (localStorage), global, and Gantt only.
 *
 * The toggle lives in the Gantt header: "Hide task list" in the upper tier of the pane header,
 * "Show task list" in the top-left corner of the timeline header while hidden. The pane width
 * animates (200ms): `data-outline` on the chart region is shown | hiding | hidden | showing, and
 * `data-pane-width` the width at that moment; completion is always awaited through
 * `data-outline`, never a sleep.
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
const settled = (page: Page, state: 'shown' | 'hidden') =>
  expect(chart(page)).toHaveAttribute('data-outline', state)

async function hide(page: Page) {
  await hideButton(page).click()
  await settled(page, 'hidden')
  await expect(showButton(page)).toBeVisible()
  await expect(splitter(page)).toHaveCount(0)
}

async function show(page: Page) {
  await showButton(page).click()
  await settled(page, 'shown')
  await expect(hideButton(page)).toBeVisible()
  await expect(splitter(page)).toBeVisible()
}

/** One animation frame as the page saw it. */
interface Frame {
  state: string | null
  width: number
  /** Width of the first outline cell (null = none rendered). */
  cell: number | null
  /** Viewport x of each watched bar. */
  xs: number[]
  scroll: number
}

/** Geometry of one task row's outline cell, per frame. */
interface Slide {
  title: number
  dueRight: number
  paneRight: number
}

const REGION = '[role="region"][aria-label="Gantt chart"]'

/** Records every animation frame in the page (state, pane width, bar x…) until `stopFrames`. */
async function startFrames(page: Page, selectors: string[]) {
  await page.evaluate(
    ({ region, bars }) => {
      const w = window as unknown as { __frames: Frame[]; __stop: boolean }
      const el = document.querySelector<HTMLElement>(region) as HTMLElement
      w.__frames = []
      w.__stop = false
      const tick = () => {
        const cell = el.querySelector('[data-row-key] > div:not([data-handle="lane"])')
        w.__frames.push({
          state: el.getAttribute('data-outline'),
          width: Number(el.getAttribute('data-pane-width')),
          cell: cell ? cell.getBoundingClientRect().width : null,
          xs: bars.map(
            (selector) => document.querySelector(selector)?.getBoundingClientRect().x ?? NaN,
          ),
          scroll: el.scrollLeft,
        })
        if (!w.__stop) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    { region: REGION, bars: selectors },
  )
}

async function stopFrames(page: Page): Promise<Frame[]> {
  return page.evaluate(
    () =>
      new Promise<Frame[]>((resolve) => {
        const w = window as unknown as { __frames: Frame[]; __stop: boolean }
        // Two more frames after the caller saw the final state.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            w.__stop = true
            resolve(w.__frames)
          }),
        )
      }),
  )
}

const barSelector = (id: string) => `[data-task-id="${id}"][data-link-target]`

/** Every frame kept every watched bar within 1px of where it started. */
function expectStill(frames: Frame[], reference: number[]) {
  for (const frame of frames) {
    frame.xs.forEach((x, i) => expect(Math.abs(x - reference[i])).toBeLessThanOrEqual(1))
  }
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
      chart(page).locator(
        'button:not([data-link-target]):not([data-handle]):not([aria-label="Show task list"])',
      ),
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

  test('the button is in the Gantt header, not the toolbar: pane header upper tier when shown, timeline corner when hidden', async ({
    page,
  }) => {
    await openGantt(page, seed(), 'day')
    const toolbar = page.locator('[data-slot="view-bar"]')
    const header = async () => {
      const area = await boxOf(chart(page))
      return { top: area.y, left: area.x }
    }
    // Shown: the upper 24px tier of the pane header, right side, left of the splitter.
    let origin = await header()
    let box = await boxOf(hideButton(page))
    expect(box.y).toBeGreaterThanOrEqual(origin.top)
    expect(box.y + box.height).toBeLessThanOrEqual(origin.top + 24 + 1)
    const split = await boxOf(splitter(page))
    expect(box.x + box.width).toBeLessThanOrEqual(split.x + split.width / 2)
    expect(box.x).toBeGreaterThan(origin.left + 300 - 60)
    await expect(toolbar.getByRole('button', { name: /task list$/ })).toHaveCount(0)
    // The lower tier still holds Task / Due, the header is still 48px tall.
    const task = await boxOf(page.getByText('Task', { exact: true }).first())
    expect(task.y).toBeGreaterThanOrEqual(origin.top + 24)
    const dayCell = await boxOf(page.locator(`[title="${dayTitle('2026-11-04')}"]`))
    expect(dayCell.y).toBeGreaterThanOrEqual(origin.top + 24 - 1)
    expect(dayCell.y + dayCell.height).toBeLessThanOrEqual(origin.top + 48 + 1)

    await hideButton(page).hover()
    await expect(page.getByRole('tooltip')).toHaveText('Hide task list')
    await hide(page)
    await page.mouse.move(400, 500)

    // Hidden: top-left corner of the timeline header, upper tier only.
    origin = await header()
    box = await boxOf(showButton(page))
    expect(box.x).toBeGreaterThanOrEqual(origin.left)
    expect(box.x + box.width).toBeLessThanOrEqual(origin.left + 32)
    expect(box.y).toBeGreaterThanOrEqual(origin.top)
    expect(box.y + box.height).toBeLessThanOrEqual(origin.top + 24 + 1)
    await expect(toolbar.getByRole('button', { name: /task list$/ })).toHaveCount(0)
    await showButton(page).hover()
    await expect(page.getByRole('tooltip')).toHaveText('Show task list')
  })

  test('the hidden-state button covers no month label, no day label and not the Today pill', async ({
    page,
  }) => {
    await openGantt(page, seed(), 'day')
    await hide(page)
    const scroller = chart(page)
    const area = await boxOf(scroller)
    const button = await boxOf(showButton(page))
    const overlaps = (r: { x: number; y: number; width: number; height: number }) =>
      r.x < button.x + button.width &&
      r.x + r.width > button.x &&
      r.y < button.y + button.height &&
      r.y + r.height > button.y

    // The lower tier below it is the real header: days (and the pill) are under those pixels,
    // and nothing of the corner reaches down there.
    const lowerTierProbe = await page.evaluate(
      ({ x, y }) => {
        const hit = document.elementFromPoint(x, y)
        return (
          hit?.closest('button') === null && hit?.closest('[aria-label="Show task list"]') === null
        )
      },
      { x: button.x + button.width / 2, y: area.y + 36 },
    )
    expect(lowerTierProbe).toBe(true)

    // Scroll so that a month label is stuck at the left, then so that Today sits under the corner.
    for (const scrollTo of ['month-label', 'today'] as const) {
      if (scrollTo === 'month-label') {
        await scroller.evaluate((el) => {
          el.scrollLeft = el.scrollLeft + 400
        })
      } else {
        const line = await boxOf(page.getByTestId('gantt-today-line'))
        await scroller.evaluate(
          (el, delta) => {
            el.scrollLeft = el.scrollLeft + delta
          },
          line.x - area.x - 16,
        )
      }
      // Wait for the render window to follow the scroll.
      await expect(page.locator('[title="Wednesday, November 4, 2026"]')).toBeAttached()
      const boxes = await page.evaluate((region) => {
        const header = document.querySelector(region)?.querySelector('.sticky.top-0.z-20')
        const rect = (e: Element) => {
          const r = e.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        }
        return {
          monthLabels: [...(header?.querySelectorAll('span.sticky') ?? [])].map(rect),
          lowerTier: [...(header?.querySelectorAll('.top-6') ?? [])].map(rect),
        }
      }, REGION)
      expect(boxes.monthLabels.length).toBeGreaterThan(0)
      expect(boxes.monthLabels.some(overlaps)).toBe(false)
      expect(boxes.lowerTier.length).toBeGreaterThan(0)
      expect(boxes.lowerTier.some(overlaps)).toBe(false)
    }
    // Today's pill really is in the lower tier near the left edge, uncovered and clickable-through.
    const pill = await boxOf(page.getByTestId('gantt-today-line'))
    expect(pill.x - area.x).toBeLessThan(40)
  })

  test('bars keep their screen position on every frame of hide and show; the width comes back after show and after a reload', async ({
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
    const selectors = keys.map((key) => barSelector(s.ids[key]))
    // Let any layout settle (the pane drag may grow the range) before measuring.
    await expect.poll(() => barXs(page, keys, s.ids).then((xs) => xs.join())).not.toBe('')
    const before = await barXs(page, keys, s.ids)
    const scrollBefore = await scroller.evaluate((el) => el.scrollLeft)
    expect(scrollBefore).toBeGreaterThan(340 + 260)

    // ---- hide: a real horizontal transition, bars never move ----
    await startFrames(page, selectors)
    await hideButton(page).click()
    await settled(page, 'hidden')
    let frames = await stopFrames(page)
    const hiding = frames.filter((frame) => frame.state === 'hiding')
    // Observable intermediate widths, strictly between the two ends, shrinking monotonically.
    const mid = hiding.filter((frame) => frame.width > 0 && frame.width < 340)
    expect(mid.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < hiding.length; i++) {
      expect(hiding[i].width).toBeLessThanOrEqual(hiding[i - 1].width)
    }
    // The pane's own box is that width (not just the attribute) on every frame it exists.
    for (const frame of hiding.filter((f) => f.cell !== null)) {
      expect(Math.abs((frame.cell ?? 0) - frame.width)).toBeLessThanOrEqual(0.5)
    }
    expectStill(frames, before)
    // Exact landing: width 0, and the scroll position dropped by exactly the pane width.
    expect(frames.at(-1)?.state).toBe('hidden')
    expect(frames.at(-1)?.width).toBe(0)
    expect(frames.at(-1)?.scroll).toBe(scrollBefore - 340)
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(scrollBefore - 340)
    expect(await splitter(page).count()).toBe(0)

    // ---- show ----
    await startFrames(page, selectors)
    await showButton(page).click()
    await settled(page, 'shown')
    frames = await stopFrames(page)
    const showing = frames.filter((frame) => frame.state === 'showing')
    expect(showing.filter((f) => f.width > 0 && f.width < 340).length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < showing.length; i++) {
      expect(showing[i].width).toBeGreaterThanOrEqual(showing[i - 1].width)
    }
    expectStill(frames, before)
    expect(frames.at(-1)?.width).toBe(340)
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(scrollBefore)
    await expect(splitter(page)).toHaveAttribute('aria-valuenow', '340')
    const cell = await boxOf(outlineCells(page).first())
    expect(cell.width).toBe(340)
    expect(await barXs(page, keys, s.ids)).toEqual(before)

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

  test('the pane content slides instead of re-wrapping: titles keep their width, the Due column rides the edge', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    const rowKey = `task:${s.ids.alpha}`
    const before = (await boxOf(page.getByRole('button', { name: 'Alpha', exact: true }))).width
    await page.evaluate(
      ({ region, key }) => {
        const w = window as unknown as { __slide: Slide[]; __stop: boolean }
        const el = document.querySelector(region) as HTMLElement
        w.__slide = []
        w.__stop = false
        const tick = () => {
          const row = el.querySelector(`[data-row-key="${key}"]`) as HTMLElement
          const titleEl = row.querySelector('button.truncate')
          const dueEl = [...row.querySelectorAll('span.justify-end')].at(-1)
          const cell = row.firstElementChild
          if (titleEl && dueEl && cell && cell.getAttribute('data-handle') !== 'lane') {
            w.__slide.push({
              title: titleEl.getBoundingClientRect().width,
              dueRight: dueEl.getBoundingClientRect().right,
              paneRight: cell.getBoundingClientRect().right,
            })
          }
          if (!w.__stop) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      },
      { region: REGION, key: rowKey },
    )
    await hideButton(page).click()
    await settled(page, 'hidden')
    const samples = await page.evaluate(
      () =>
        new Promise<Slide[]>((resolve) => {
          const w = window as unknown as { __slide: Slide[]; __stop: boolean }
          requestAnimationFrame(() => {
            w.__stop = true
            resolve(w.__slide)
          })
        }),
    )
    expect(samples.length).toBeGreaterThanOrEqual(2)
    for (const sample of samples) {
      // The title keeps the width it has at rest (no re-truncation) …
      expect(sample.title).toBeCloseTo(before, 0)
      // … and the Due column is glued to the pane's moving edge: it slides, it does not crawl.
      expect(Math.abs(sample.dueRight - (sample.paneRight - 12))).toBeLessThanOrEqual(1)
    }
  })

  test('rapid toggling (5x, then 5x again) lands exactly, with the bars never off their day', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await widenTo340(page)
    const scroller = chart(page)
    const initial = await scroller.evaluate((el) => el.scrollWidth)
    await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth
    })
    await expect.poll(() => scroller.evaluate((el) => el.scrollWidth)).toBeGreaterThan(initial)
    await scroller.evaluate((el) => {
      el.scrollLeft = Math.round((el.scrollWidth - el.clientWidth) / 2)
    })
    const keys = ['alpha', 'bravo', 'charlie']
    const selectors = keys.map((key) => barSelector(s.ids[key]))
    await expect.poll(() => barXs(page, keys, s.ids).then((xs) => xs.join())).not.toBe('')
    const before = await barXs(page, keys, s.ids)
    const scrollBefore = await scroller.evaluate((el) => el.scrollLeft)
    const dates = async () => [await stored(page, s.ids.alpha), await stored(page, s.ids.bravo)]
    const datesBefore = await dates()

    // Focus follows the toggle, so Enter on the focused button flips it again straight away.
    await hideButton(page).focus()
    await startFrames(page, selectors)
    for (let i = 0; i < 5; i++) await page.keyboard.press('Enter')
    await settled(page, 'hidden')
    let frames = await stopFrames(page)
    expectStill(frames, before)
    expect(frames.at(-1)?.width).toBe(0)
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(scrollBefore - 340)
    await expect(showButton(page)).toBeFocused()

    await startFrames(page, selectors)
    for (let i = 0; i < 5; i++) await page.keyboard.press('Enter')
    await settled(page, 'shown')
    frames = await stopFrames(page)
    expectStill(frames, before)
    expect(frames.at(-1)?.width).toBe(340)
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(scrollBefore)
    expect(await barXs(page, keys, s.ids)).toEqual(before)
    await expect(splitter(page)).toHaveAttribute('aria-valuenow', '340')
    expect(await dates()).toEqual(datesBefore)
    expect(await page.evaluate(() => localStorage.getItem('cairn:gantt-pane-width'))).toBe('340')
  })

  test('a toggle during the motion turns around from the width it has reached', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    await widenTo340(page)
    const keys = ['alpha', 'bravo']
    const before = await barXs(page, keys, s.ids)
    await hideButton(page).focus()
    await startFrames(
      page,
      keys.map((key) => barSelector(s.ids[key])),
    )
    // Reverse from inside the page on the first frame that is visibly under way (a poll from the
    // test could miss the 200ms window on a busy machine).
    await page.evaluate((region) => {
      const area = document.querySelector(region) as HTMLElement
      const watch = () => {
        const width = Number(area.getAttribute('data-pane-width'))
        if (area.getAttribute('data-outline') === 'hiding' && width > 0 && width < 340) {
          document.querySelector<HTMLElement>('[aria-label="Show task list"]')?.click()
        } else {
          requestAnimationFrame(watch)
        }
      }
      requestAnimationFrame(watch)
    }, REGION)
    await page.keyboard.press('Enter')
    await settled(page, 'shown')
    const frames = await stopFrames(page)
    expectStill(frames, before)
    const turned = frames.findIndex((frame) => frame.state === 'showing')
    expect(turned).toBeGreaterThan(0)
    // No restart from the end: the first widening frame is close to where hiding stopped.
    expect(Math.abs(frames[turned].width - frames[turned - 1].width)).toBeLessThan(120)
    expect(frames.at(-1)?.width).toBe(340)
  })

  test('a press on a bar, a double-click and a nudge are ignored while the pane moves, and work again after', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    // One synchronous page task: click the toggle, then press / nudge before any frame runs.
    const gesture = (id: string) =>
      page.evaluate(
        async ({ id, region }) => {
          const area = document.querySelector(region) as HTMLElement
          const toggle = [...document.querySelectorAll('button')].find((b) =>
            /^(Hide|Show) task list$/.test(b.getAttribute('aria-label') ?? ''),
          ) as HTMLButtonElement
          toggle.click()
          // React renders the click in a microtask; no animation frame has run by then.
          await Promise.resolve()
          const state = area.getAttribute('data-outline')
          const barEl = document.querySelector<HTMLElement>(
            `[data-task-id="${id}"][data-link-target]`,
          ) as HTMLElement
          const rect = barEl.getBoundingClientRect()
          const x = rect.x + rect.width / 2
          const y = rect.y + rect.height / 2
          const pointer = (type: string, target: Element, dx: number) =>
            target.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                pointerId: 7,
                isPrimary: true,
                button: 0,
                buttons: type === 'pointerup' ? 0 : 1,
                clientX: x + dx,
                clientY: y,
              }),
            )
          pointer('pointerdown', barEl, 0)
          pointer('pointermove', area, 40)
          pointer('pointermove', area, 72)
          pointer('pointerup', area, 72)
          barEl.focus()
          barEl.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'ArrowRight',
              altKey: true,
              bubbles: true,
              cancelable: true,
            }),
          )
          return state
        },
        { id, region: REGION },
      )
    const original = { start: '2026-11-13', due: '2026-11-14' }
    expect(await stored(page, s.ids.charlie)).toEqual(original)

    // Hiding: still moving when the gesture lands, so none of it counts.
    expect(await gesture(s.ids.charlie)).toBe('hiding')
    await settled(page, 'hidden')
    expect(await stored(page, s.ids.charlie)).toEqual(original)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(page.url()).not.toContain('task=')

    // At rest the very same pointer sequence is a real drag (+2 days): the check above is not
    // passing because the gesture never works.
    await moveBar(page, s.ids.charlie, 2)
    const moved = { start: '2026-11-15', due: '2026-11-16' }
    await expect.poll(() => stored(page, s.ids.charlie)).toEqual(moved)
    await page.keyboard.press('Escape')

    // Showing: same story.
    expect(await gesture(s.ids.charlie)).toBe('showing')
    await settled(page, 'shown')
    expect(await stored(page, s.ids.charlie)).toEqual(moved)
    // And a nudge works again once settled.
    await bar(page, s.ids.charlie).focus()
    await page.keyboard.press('Alt+ArrowRight')
    await expect
      .poll(() => stored(page, s.ids.charlie))
      .toEqual({ start: '2026-11-16', due: '2026-11-17' })
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

  test('at 860px both buttons are on screen and usable', async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 800 })
    await openGantt(page, seed(), 'day')
    const inside = async (button: ReturnType<typeof hideButton>) => {
      const box = await boxOf(button)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(860)
      expect(box.width).toBeGreaterThanOrEqual(16)
    }
    await inside(hideButton(page))
    await hide(page)
    await inside(showButton(page))
    await page.reload()
    await expect(showButton(page)).toBeVisible()
    await show(page)
    await expect(splitter(page)).toHaveAttribute('aria-valuenow', '300')
    await inside(hideButton(page))
  })

  test('keyboard: Tab reaches each button, Enter toggles it, focus moves to the other one, and the ring is visible', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
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
    // The last toolbar control comes right before the chart.
    const lastToolbarControl = page.getByRole('radio', { name: 'Month' })
    await lastToolbarControl.focus()
    await page.keyboard.press('Tab')
    await expect(hideButton(page)).toBeFocused()
    const ring = await focusRing()
    expect(ring.focusVisible).toBe(true)
    expect(ring.ring || ring.shadow).toBe(true)

    await page.keyboard.press('Enter')
    await settled(page, 'hidden')
    await expect(showButton(page)).toBeFocused()
    await expect(splitter(page)).toHaveCount(0)
    const hiddenRing = await focusRing()
    expect(hiddenRing.focusVisible).toBe(true)
    expect(hiddenRing.ring || hiddenRing.shadow).toBe(true)

    // Tab order while hidden: the corner button, then the first bar (no leftover outline stops).
    await lastToolbarControl.focus()
    await page.keyboard.press('Tab')
    await expect(showButton(page)).toBeFocused()

    await page.keyboard.press('Enter')
    await settled(page, 'shown')
    await expect(hideButton(page)).toBeFocused()
    await expect(splitter(page)).toBeVisible()
  })

  test('clicking either button moves focus to the other one', async ({ page }) => {
    await openGantt(page, seed(), 'day')
    await hideButton(page).click()
    await settled(page, 'hidden')
    await expect(showButton(page)).toBeFocused()
    await showButton(page).click()
    await settled(page, 'shown')
    await expect(hideButton(page)).toBeFocused()
  })

  test('the outline cells are out of the Tab order and the pointer while the pane moves', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    // Checked in the same page task as the click, before the first frame.
    const inertWhileHiding = await page.evaluate(
      async ({ region }) => {
        const area = document.querySelector(region) as HTMLElement
        const toggle = document.querySelector<HTMLElement>('[aria-label="Hide task list"]')
        toggle?.click()
        await Promise.resolve() // React renders the click in a microtask, before any frame
        const cells = [
          ...area.querySelectorAll('[data-row-key] > div:not([data-handle="lane"])'),
        ] as HTMLElement[]
        return {
          state: area.getAttribute('data-outline'),
          count: cells.length,
          allInert: cells.every((cell) => cell.inert),
        }
      },
      { region: REGION },
    )
    expect(inertWhileHiding.state).toBe('hiding')
    expect(inertWhileHiding.count).toBeGreaterThan(0)
    expect(inertWhileHiding.allInert).toBe(true)
    await settled(page, 'hidden')
    await expect(outlineCells(page)).toHaveCount(0)
    await showButton(page).click()
    await settled(page, 'shown')
    // Interactive again at rest.
    expect(
      await outlineCells(page)
        .first()
        .evaluate((cell) => (cell as HTMLElement).inert),
    ).toBe(false)
    await page.getByRole('button', { name: 'Alpha', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`task=${s.ids.alpha}`))
  })

  test('focus inside the outline moves to the button when the list is hidden', async ({ page }) => {
    await openGantt(page, seed(), 'day')
    await page.getByRole('button', { name: 'Alpha', exact: true }).focus()
    await hideButton(page).dispatchEvent('click')
    await expect(showButton(page)).toBeFocused()
    await settled(page, 'hidden')
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
    await settled(page, 'hidden')
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

  test('the cross-project Timeline keeps its pane and header: no toggle button at all', async ({
    page,
  }) => {
    await openGantt(page, seed(), 'day')
    await hide(page)
    await page.goto('/timeline')
    const timeline = page.getByRole('region', { name: 'Timeline of all projects' })
    await expect(timeline).toBeVisible()
    await expect(page.getByRole('separator', { name: 'Resize project list' })).toBeVisible()
    await expect(page.getByRole('button', { name: /task list$/ })).toHaveCount(0)
    // Its header is the old one: no button in it, and no data-outline motion state.
    await expect(timeline.locator('.sticky.top-0.z-20 button')).toHaveCount(0)
    await expect(timeline).not.toHaveAttribute('data-outline', /.*/)
  })
})

test.describe('Gantt outline toggle: themes', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(scheme, () => {
      test.use({ colorScheme: scheme })

      test(`both buttons are visible, readable and usable in ${scheme} mode`, async ({ page }) => {
        await openGantt(page, seed(), 'day')
        /** Contrast of the icon against the header it sits on (WCAG non-text: 3:1). */
        const contrast = (button: ReturnType<typeof hideButton>) =>
          button.evaluate((el) => {
            const parse = (color: string) => {
              const m = color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0]
              return m.slice(0, 3)
            }
            const luminance = ([r, g, b]: number[]) => {
              const f = (v: number) => {
                const c = v / 255
                return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
              }
              return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
            }
            let background = el.parentElement
            while (
              background &&
              getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)'
            ) {
              background = background.parentElement
            }
            const fg = luminance(parse(getComputedStyle(el).color))
            const bg = luminance(parse(getComputedStyle(background ?? el).backgroundColor))
            return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
          })
        await expect(hideButton(page)).toBeVisible()
        expect(await contrast(hideButton(page))).toBeGreaterThanOrEqual(3)
        await hide(page)
        await expect(showButton(page)).toBeVisible()
        expect(await contrast(showButton(page))).toBeGreaterThanOrEqual(3)
        await show(page)
      })
    })
  }
})

test.describe('Gantt outline toggle: reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('the pane switches at once: no intermediate state or width, bars stay put', async ({
    page,
  }) => {
    const s = seed()
    await openGantt(page, s, 'day')
    const before = await barXs(page, ['alpha', 'bravo'], s.ids)
    await startFrames(page, [barSelector(s.ids.alpha), barSelector(s.ids.bravo)])
    await hideButton(page).click()
    // No 'hiding' state to wait through: it is hidden as soon as the click is handled.
    await expect(chart(page)).toHaveAttribute('data-outline', 'hidden')
    await expect(chart(page)).toHaveAttribute('data-pane-width', '0')
    await expect(showButton(page)).toBeFocused()
    await showButton(page).click()
    await expect(chart(page)).toHaveAttribute('data-outline', 'shown')
    await expect(chart(page)).toHaveAttribute('data-pane-width', '300')
    const frames = await stopFrames(page)
    expect(frames.every((frame) => frame.state === 'shown' || frame.state === 'hidden')).toBe(true)
    expect(frames.every((frame) => frame.width === 0 || frame.width === 300)).toBe(true)
    expectStill(frames, before)
    expect(await barXs(page, ['alpha', 'bravo'], s.ids)).toEqual(before)
  })
})
