/// <reference lib="dom" />
/**
 * Gantt acceptance (PRD §9.1 AC-7, AC-8, AC-9 and §4.7) — LOCAL data mode against the dev server.
 *
 * One test per acceptance clause, titled "AC-n: …". Everything is observed in the real chart with
 * real pointer input, and what a reload would show is read from the stored workspace. Time is
 * pinned (Wed 2026-11-04, Asia/Taipei) unless a test needs another date.
 *
 * The broader behaviour (keyboard, focus, scrolling, performance, failure toasts) lives in
 * e2e/gantt.spec.ts; this file proves the PRD's acceptance statements one by one.
 */
import {
  bar,
  boxOf,
  chart,
  countWrites,
  dayX,
  dragBy,
  expect,
  failNextWrites,
  linkDrag,
  moveBar,
  openGantt,
  outlineRow,
  PX,
  resizeBar,
  seedWorkspace,
  stored,
  storedDependencies,
  storedMilestoneDate,
  storedScheduleMode,
  test,
  toast,
  toastButton,
  writes,
  type Scale,
  type TaskSpec,
} from './acceptance-gantt.helpers.ts'
import type { Locator, Page } from '@playwright/test'

test.use({ timezoneId: 'Asia/Taipei', locale: 'en-US', viewport: { width: 1280, height: 800 } })

/** Today is Wed Nov 4. Alpha → Bravo is NOT linked unless a test asks for it. */
const PROJECT_TASKS: TaskSpec[] = [
  { key: 'alpha', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
  { key: 'bravo', title: 'Bravo', start: '2026-11-10', due: '2026-11-12' },
  { key: 'charlie', title: 'Charlie', start: '2026-11-13', due: '2026-11-14' },
  { key: 'delta', title: 'Delta due', due: '2026-11-11', phase: true },
  { key: 'echo', title: 'Echo start', start: '2026-11-09', phase: true },
  { key: 'parent', title: 'Parent', phase: true },
  {
    key: 'sub1',
    title: 'Sub one',
    start: '2026-11-06',
    due: '2026-11-09',
    phase: true,
    parent: 'parent',
  },
  {
    key: 'sub2',
    title: 'Sub two',
    start: '2026-11-12',
    due: '2026-11-13',
    phase: true,
    parent: 'parent',
  },
  { key: 'undated1', title: 'Undated one' },
  { key: 'undated2', title: 'Undated two' },
]

/** The bar's left edge sits on `start`'s column and its right edge on the end of `end`'s column. */
async function expectBarOnDays(page: Page, id: string, start: string, end: string): Promise<void> {
  const [box, left, right] = await Promise.all([
    boxOf(bar(page, id)),
    dayX(page, start, 'left'),
    dayX(page, end, 'left'),
  ])
  expect(Math.abs(box.x - left), `bar left edge vs ${start}`).toBeLessThanOrEqual(2)
  expect(
    Math.abs(box.x + box.width - (right + PX.day)),
    `bar right edge vs ${end}`,
  ).toBeLessThanOrEqual(2)
}

/**
 * On any scale: the bar sits exactly on its days, measured from the Today line (the centre of
 * today's column) with the scale's pixels per day.
 */
async function expectBarMatchesDates(
  page: Page,
  id: string,
  start: string,
  end: string,
  scale: Scale,
): Promise<void> {
  const epoch = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000
  const px = PX[scale]
  const [box, line] = await Promise.all([
    boxOf(bar(page, id)),
    boxOf(page.getByTestId('gantt-today-line')),
  ])
  const todayCentre = line.x + line.width / 2
  const left = todayCentre - px / 2 + (epoch(start) - epoch('2026-11-04')) * px
  const width = (epoch(end) - epoch(start) + 1) * px
  expect(Math.abs(box.x - left), `${scale}: left edge of ${start}`).toBeLessThanOrEqual(1.5)
  expect(Math.abs(box.width - width), `${scale}: width of ${start} – ${end}`).toBeLessThanOrEqual(
    1.5,
  )
}

/** Where "Today" settles: one third of the visible timeline, right of the outline. */
async function todayOffset(page: Page): Promise<{ x: number; expected: number }> {
  const scroller = chart(page)
  const [line, area, client] = await Promise.all([
    page.getByTestId('gantt-today-line').boundingBox(),
    scroller.boundingBox(),
    scroller.evaluate((el) => el.clientWidth),
  ])
  if (!line || !area) return { x: Number.NaN, expected: 0 }
  return { x: line.x - area.x, expected: 300 + (client - 300) / 3 }
}

/**
 * Waits until the Today line rests on its target AND stopped moving: Today scrolls smoothly, and
 * moving the view again while that animation is still in its last pixels makes Chromium ignore the
 * next smooth scroll to the same target (a spec race, not an app bug).
 */
async function expectTodayAtTarget(page: Page): Promise<void> {
  let last = Number.NaN
  let still = 0
  await expect
    .poll(
      async () => {
        const { x, expected } = await todayOffset(page)
        still = Math.abs(x - expected) <= 3 && Math.abs(x - last) < 0.5 ? still + 1 : 0
        last = x
        return still >= 3
      },
      { intervals: [100], timeout: 10_000 },
    )
    .toBe(true)
}

/** Scrolls the timeline right and waits until the Today line is no longer on its target. */
async function scrollAwayFromToday(page: Page): Promise<void> {
  await chart(page).evaluate((el) => {
    el.scrollLeft += 900
  })
  await expect
    .poll(async () => {
      const { x, expected } = await todayOffset(page)
      return Math.abs(x - expected) > 20
    })
    .toBe(true)
}

/** Picks `iso` in the calendar of a Task Modal date chip (paging forward when needed). */
async function pickModalDate(
  page: Page,
  modal: Locator,
  field: 'Start date' | 'Due date',
  iso: string,
): Promise<void> {
  await modal.getByRole('button', { name: new RegExp(`^${field}:`) }).click()
  const picker = page.getByRole('dialog', { name: field, exact: true })
  const [year, month, day] = iso.split('-').map(Number)
  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  })
  const suffix =
    day % 10 === 1 && day !== 11
      ? 'st'
      : day % 10 === 2 && day !== 12
        ? 'nd'
        : day % 10 === 3 && day !== 13
          ? 'rd'
          : 'th'
  const cell = picker.getByRole('button', {
    name: new RegExp(`${monthName} ${day}${suffix}, ${year}`),
  })
  for (let i = 0; i < 4 && (await cell.count()) === 0; i += 1) {
    await picker.getByRole('button', { name: 'Go to the Next Month' }).click()
  }
  await cell.click()
  await expect(picker).toBeHidden()
}

// ---------------------------------------------------------------------------
// AC-7 — drag / resize dates in the Gantt, still right after a reload
// ---------------------------------------------------------------------------

test.describe('AC-7: Gantt drag and resize persist', () => {
  test('AC-7: dragging a bar and either edge changes the dates exactly; a reload shows the same dates', async ({
    page,
  }) => {
    const seed = seedWorkspace({ tasks: PROJECT_TASKS })
    const { ids } = seed
    await openGantt(page, seed)
    await countWrites(page)

    await moveBar(page, ids.alpha, 2)
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-07', due: '2026-11-09' })
    await resizeBar(page, ids.alpha, 'end', 1)
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-07', due: '2026-11-10' })
    await resizeBar(page, ids.alpha, 'start', -2)
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-05', due: '2026-11-10' })
    // One gesture, one write; the bar covers exactly the stored days.
    expect(await writes(page)).toBe(3)
    await expectBarOnDays(page, ids.alpha, '2026-11-05', '2026-11-10')

    await page.reload()
    await expect(bar(page, ids.alpha)).toHaveAccessibleName('Alpha, Nov 5 – Nov 10, 6 days, To Do')
    await expectBarOnDays(page, ids.alpha, '2026-11-05', '2026-11-10')
    expect(await stored(page, ids.alpha)).toEqual({ start: '2026-11-05', due: '2026-11-10' })
    // Nothing else moved.
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-10', due: '2026-11-12' })
    expect(await stored(page, ids.charlie)).toEqual({ start: '2026-11-13', due: '2026-11-14' })
  })

  for (const scale of ['day', 'week', 'month'] as const satisfies readonly Scale[]) {
    test(`AC-7: on the ${scale} scale a move and both resizes land on whole days and survive a reload`, async ({
      page,
    }) => {
      const seed = seedWorkspace({ tasks: PROJECT_TASKS })
      const { ids } = seed
      await openGantt(page, seed, scale)
      await expect(
        page.getByRole('radio', { name: scale[0].toUpperCase() + scale.slice(1) }),
      ).toBeChecked()

      await moveBar(page, ids.alpha, 3, scale)
      await expect
        .poll(() => stored(page, ids.alpha))
        .toEqual({ start: '2026-11-08', due: '2026-11-10' })
      await resizeBar(page, ids.alpha, 'end', 2, scale)
      await expect
        .poll(() => stored(page, ids.alpha))
        .toEqual({ start: '2026-11-08', due: '2026-11-12' })
      await resizeBar(page, ids.alpha, 'start', -1, scale)
      await expect
        .poll(() => stored(page, ids.alpha))
        .toEqual({ start: '2026-11-07', due: '2026-11-12' })
      await expectBarMatchesDates(page, ids.alpha, '2026-11-07', '2026-11-12', scale)

      await page.reload()
      await expect(bar(page, ids.alpha)).toHaveAccessibleName(
        'Alpha, Nov 7 – Nov 12, 6 days, To Do',
      )
      await expectBarMatchesDates(page, ids.alpha, '2026-11-07', '2026-11-12', scale)
      await expect(
        page.getByRole('radio', { name: scale[0].toUpperCase() + scale.slice(1) }),
      ).toBeChecked()
    })
  }

  test('AC-7: dates stay exact across a month end, a year end and a leap day', async ({ page }) => {
    // Month end: Oct 29–31 moved three days lands on Nov 1–3, and back.
    const seed = seedWorkspace({
      tasks: [{ key: 'oct', title: 'Month end', start: '2026-10-29', due: '2026-10-31' }],
    })
    const { ids } = seed
    await openGantt(page, seed, 'day', '2026-10-28T10:00:00+08:00')
    await moveBar(page, ids.oct, 3)
    await expect
      .poll(() => stored(page, ids.oct))
      .toEqual({ start: '2026-11-01', due: '2026-11-03' })
    await expectBarOnDays(page, ids.oct, '2026-11-01', '2026-11-03')
    await moveBar(page, ids.oct, -2)
    await expect
      .poll(() => stored(page, ids.oct))
      .toEqual({ start: '2026-10-30', due: '2026-11-01' })
    await resizeBar(page, ids.oct, 'end', 1)
    await expect
      .poll(() => stored(page, ids.oct))
      .toEqual({ start: '2026-10-30', due: '2026-11-02' })
    await page.reload()
    await expect(bar(page, ids.oct)).toHaveAccessibleName(
      'Month end, Oct 30 – Nov 2, 4 days, To Do',
    )
  })

  test('AC-7: a task that crosses New Year keeps its length and its dates after a reload', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      tasks: [{ key: 'ny', title: 'Year end', start: '2026-12-29', due: '2026-12-31' }],
    })
    const { ids } = seed
    await openGantt(page, seed, 'day', '2026-12-28T10:00:00+08:00')
    await moveBar(page, ids.ny, 3)
    await expect
      .poll(() => stored(page, ids.ny))
      .toEqual({ start: '2027-01-01', due: '2027-01-03' })
    await expectBarOnDays(page, ids.ny, '2027-01-01', '2027-01-03')
    await resizeBar(page, ids.ny, 'start', -2)
    await expect
      .poll(() => stored(page, ids.ny))
      .toEqual({ start: '2026-12-30', due: '2027-01-03' })
    await page.reload()
    await expect(bar(page, ids.ny)).toHaveAccessibleName(
      'Year end, Dec 30 – Jan 3, 2027, 5 days, To Do',
    )
    await expect(chart(page).getByText('Jan 2027', { exact: true })).toBeVisible()
  })

  test('AC-7: Feb 29 of a leap year is a real day on the chart (Feb 27–28 → Feb 29–Mar 1)', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      tasks: [{ key: 'leap', title: 'Leap', start: '2028-02-27', due: '2028-02-28' }],
    })
    const { ids } = seed
    await openGantt(page, seed, 'day', '2028-02-26T10:00:00+08:00')
    await moveBar(page, ids.leap, 2)
    await expect
      .poll(() => stored(page, ids.leap))
      .toEqual({ start: '2028-02-29', due: '2028-03-01' })
    await expectBarOnDays(page, ids.leap, '2028-02-29', '2028-03-01')
    await page.reload()
    await expect(bar(page, ids.leap)).toHaveAccessibleName('Leap, Feb 29 – Mar 1, 2 days, To Do')
  })

  test('AC-7: the Today line and the Today button / T key find today on every scale', async ({
    page,
  }) => {
    const seed = seedWorkspace({ tasks: PROJECT_TASKS })
    await openGantt(page, seed, 'day')
    await expectTodayAtTarget(page)
    for (const scale of ['Day', 'Week', 'Month'] as const) {
      await page.getByRole('radio', { name: scale }).click()
      await expect(page.getByRole('radio', { name: scale })).toBeChecked()
      // The line and its date pill exist on every scale…
      await expect(page.getByTestId('gantt-today-line')).toBeVisible()
      await expect(chart(page).getByText('Nov 4', { exact: true })).toBeVisible()
      // …and the Today button and the T key bring it back after the view was moved away.
      await scrollAwayFromToday(page)
      await page.getByRole('button', { name: 'Today', exact: true }).click()
      await expectTodayAtTarget(page)
      await scrollAwayFromToday(page)
      await page.keyboard.press('t')
      await expectTodayAtTarget(page)
    }
    // On the Day scale the line sits on today's own column.
    await page.getByRole('radio', { name: 'Day' }).click()
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await expectTodayAtTarget(page)
    const column = await boxOf(page.locator('[title="Wednesday, November 4, 2026"]'))
    const line = await boxOf(page.getByTestId('gantt-today-line'))
    expect(Math.abs(line.x + line.width / 2 - (column.x + column.width / 2))).toBeLessThanOrEqual(2)
  })

  test('AC-7: a due-only task is a marker (never an invented range), an undated one keeps its empty row in its phase until it is drawn', async ({
    page,
  }) => {
    const seed = seedWorkspace({ tasks: PROJECT_TASKS })
    const { ids } = seed
    await openGantt(page, seed)

    // Due-only: a flag on the due day, no start date invented; dragging moves only the due date.
    await expect(bar(page, ids.delta)).toHaveAccessibleName(
      'Delta due, Due Nov 11, no start date, To Do',
    )
    const flag = await boxOf(bar(page, ids.delta))
    await dragBy(page, { x: flag.x + flag.width / 2, y: flag.y + flag.height / 2 }, 2 * PX.day)
    await expect.poll(() => stored(page, ids.delta)).toEqual({ start: null, due: '2026-11-13' })
    // Start-only: a tick on the start day.
    await expect(bar(page, ids.echo)).toHaveAccessibleName(
      'Echo start, Starts Nov 9, no due date, To Do',
    )

    // No dates at all: it stays in the outline where it belongs (no Unscheduled group), with an
    // empty lane and no bar. The toolbar counts Parent (no dates of its own) and the two undated.
    await expect(page.getByRole('button', { name: /^Unscheduled, / })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Show only unscheduled tasks, 3' })).toBeVisible()
    await expect(outlineRow(page, `task:${ids.undated1}`)).toBeVisible()
    await expect(bar(page, ids.undated1)).toHaveCount(0)
    const order = () =>
      page
        .locator('[data-row-key]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row-key')))
    const before = await order()
    expect(before.indexOf(`task:${ids.undated1}`)).toBe(before.indexOf(`task:${ids.charlie}`) + 1)

    // Draw across the lane → start and due; its row does not move; a reload keeps all of it.
    const lane = outlineRow(page, `task:${ids.undated1}`).locator('[data-handle="lane"]')
    const laneBox = await boxOf(lane)
    const y = laneBox.y + laneBox.height / 2
    await dragBy(page, { x: await dayX(page, '2026-11-12', 'center'), y }, 2 * PX.day)
    await expect
      .poll(() => stored(page, ids.undated1))
      .toEqual({ start: '2026-11-12', due: '2026-11-14' })
    await expect(page.getByRole('button', { name: 'Show only unscheduled tasks, 2' })).toBeVisible()
    expect(await order()).toEqual(before)
    await page.reload()
    await expect(bar(page, ids.undated1)).toHaveAccessibleName(
      'Undated one, Nov 12 – Nov 14, 3 days, To Do',
    )
    await expect(bar(page, ids.delta)).toHaveAccessibleName(
      'Delta due, Due Nov 13, no start date, To Do',
    )
    await expect(page.getByRole('button', { name: 'Show only unscheduled tasks, 2' })).toBeVisible()
    await expect(bar(page, ids.undated2)).toHaveCount(0)
  })

  test('AC-7: a milestone is a draggable diamond (not a duration task) and keeps its date across a month end', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      tasks: [{ key: 'alpha', title: 'Alpha', start: '2026-11-26', due: '2026-11-28' }],
      milestones: [{ key: 'launch', name: 'Launch', date: '2026-11-30' }],
    })
    const { ids } = seed
    await openGantt(page, seed, 'day', '2026-11-28T10:00:00+08:00')
    const diamond = page.getByRole('button', { name: 'Milestone Launch, Nov 30, 2026' })
    await expect(diamond).toBeVisible()
    // A diamond has no resize grips and no dependency dots, and is no bar.
    await expect(
      page.locator(`[data-milestone-id="${ids.launch}"] [data-handle^="resize"]`),
    ).toHaveCount(0)
    await expect(page.locator(`[data-milestone-id="${ids.launch}"][data-link-target]`)).toHaveCount(
      0,
    )

    const box = await boxOf(diamond)
    await dragBy(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 2 * PX.day)
    await expect.poll(() => storedMilestoneDate(page, ids.launch)).toBe('2026-12-02')
    await expect(page.getByRole('button', { name: 'Milestone Launch, Dec 2, 2026' })).toBeVisible()
    // Keyboard: Alt+← moves it one day back, across the month end again.
    await page.getByRole('button', { name: 'Milestone Launch, Dec 2, 2026' }).focus()
    await page.keyboard.press('Alt+ArrowLeft')
    await page.keyboard.press('Alt+ArrowLeft')
    await expect.poll(() => storedMilestoneDate(page, ids.launch)).toBe('2026-11-30')
    await page.keyboard.press('Alt+ArrowRight')
    await expect.poll(() => storedMilestoneDate(page, ids.launch)).toBe('2026-12-01')
    await page.reload()
    await expect(page.getByRole('button', { name: 'Milestone Launch, Dec 1, 2026' })).toBeVisible()
    // The diamond moved, the task did not.
    expect(await stored(page, ids.alpha)).toEqual({ start: '2026-11-26', due: '2026-11-28' })
  })

  test('AC-7: phase and parent rows roll up their children, and subtasks nest, collapse and move like tasks', async ({
    page,
  }) => {
    const seed = seedWorkspace({ tasks: PROJECT_TASKS })
    const { ids, phaseId } = seed
    await openGantt(page, seed, 'day')
    const phaseBracket = outlineRow(page, `group:${phaseId}`).locator('[title^="Design:"]')
    const parentBracket = outlineRow(page, `task:${ids.parent}`).locator(
      '[title^="Parent (subtasks):"]',
    )
    // Design holds Delta (due Nov 11), Echo (starts Nov 9), Parent's subtasks (Nov 6 – Nov 13).
    await expect(phaseBracket).toHaveAttribute('title', 'Design: Nov 6 – Nov 13')
    await expect(parentBracket).toHaveAttribute('title', 'Parent (subtasks): Nov 6 – Nov 13')

    // A subtask is a normal bar: move Sub two three days later → both roll-ups grow to Nov 16.
    await moveBar(page, ids.sub2, 3)
    await expect
      .poll(() => stored(page, ids.sub2))
      .toEqual({ start: '2026-11-15', due: '2026-11-16' })
    await expect(phaseBracket).toHaveAttribute('title', 'Design: Nov 6 – Nov 16')
    await expect(parentBracket).toHaveAttribute('title', 'Parent (subtasks): Nov 6 – Nov 16')
    // And Sub one earlier → the start of both moves too.
    await moveBar(page, ids.sub1, -2)
    await expect
      .poll(() => stored(page, ids.sub1))
      .toEqual({ start: '2026-11-04', due: '2026-11-07' })
    await expect(phaseBracket).toHaveAttribute('title', 'Design: Nov 4 – Nov 16')

    // Subtasks sit under their parent, indented; collapsing hides them and the rows stay in order.
    const rowKeys = () =>
      page
        .locator('[data-row-key]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row-key')))
    const keys = await rowKeys()
    const parentIndex = keys.indexOf(`task:${ids.parent}`)
    expect(keys.slice(parentIndex, parentIndex + 3)).toEqual([
      `task:${ids.parent}`,
      `task:${ids.sub1}`,
      `task:${ids.sub2}`,
    ])
    await page.getByRole('button', { name: 'Hide 2 subtasks of Parent' }).click()
    await expect(bar(page, ids.sub1)).toHaveCount(0)
    await expect(bar(page, ids.sub2)).toHaveCount(0)
    await page.getByRole('button', { name: 'Show 2 subtasks of Parent' }).click()
    await expect(bar(page, ids.sub1)).toBeVisible()
    // The roll-ups are stored nowhere: after a reload they are recomputed from the same dates.
    await page.reload()
    await expect(
      outlineRow(page, `group:${phaseId}`).locator('[title^="Design:"]'),
    ).toHaveAttribute('title', 'Design: Nov 4 – Nov 16')
  })
})

// ---------------------------------------------------------------------------
// AC-8 — A → B dependency: conflict warning, Manual handling or a confirmed Auto preview
// ---------------------------------------------------------------------------

/** Today is Nov 4: A ends Nov 7, B starts Nov 10 (no overlap until A is delayed). */
const AB_TASKS: TaskSpec[] = [
  { key: 'alpha', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
  { key: 'bravo', title: 'Bravo', start: '2026-11-10', due: '2026-11-12' },
]
/** The same chain with a third task: A → B → C, every task directly after the previous one. */
const CHAIN_TASKS: TaskSpec[] = [
  { key: 'alpha', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
  { key: 'bravo', title: 'Bravo', start: '2026-11-08', due: '2026-11-10' },
  { key: 'charlie', title: 'Charlie', start: '2026-11-11', due: '2026-11-12' },
]

/** Row of the dependency list ("Blocked by" / "Blocking") in the open Task Modal. */
function modalOf(page: Page, title: string) {
  return page.getByRole('dialog', { name: `Edit task: ${title}`, exact: true })
}

test.describe('AC-8: dependency conflicts', () => {
  test("AC-8: dragging between two bars creates A → B; delaying A past B's start warns on the line, the successor and the chip, and Manual moves nothing", async ({
    page,
  }) => {
    const seed = seedWorkspace({ tasks: AB_TASKS })
    const { ids } = seed
    await openGantt(page, seed)

    // Draw Alpha → Bravo from Alpha's finish dot onto Bravo's bar.
    await linkDrag(page, ids.alpha, ids.bravo)
    await expect.poll(() => storedDependencies(page)).toEqual([`${ids.alpha}>${ids.bravo}`])
    await expect(page.locator('path[data-dep-id]')).toHaveCount(1)
    // Bravo starts after Alpha ends: no conflict yet.
    await expect(page.locator('g[data-conflict]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /conflict/ })).toHaveCount(0)

    // Delay Alpha by 4 days: it now ends Nov 11, a day after Bravo starts.
    await moveBar(page, ids.alpha, 4)
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-09', due: '2026-11-11' })

    // The warning is visible in all three places, and says which tasks are involved.
    const warning = toast(page, '1 dependency conflict')
    await expect(warning).toBeVisible()
    await expect(warning).toContainText('“Bravo” starts before “Alpha” finishes.')
    await expect(page.locator('g[data-conflict] path[data-dep-id]')).toHaveCount(1) // the line
    await expect(bar(page, ids.bravo)).toHaveAccessibleName(/dependency conflict/) // the successor
    await expect(page.getByRole('button', { name: '1 conflict', exact: true })).toBeVisible() // the chip
    // Manual only warns: Bravo did not move, in the chart or in the store.
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-10', due: '2026-11-12' })
    await expect(bar(page, ids.bravo)).toHaveAccessibleName(
      /^Bravo, Nov 10 – Nov 12, 3 days, To Do/,
    )

    // The warning is derived from the stored dates, so it is still there after a reload.
    await page.reload()
    await expect(page.locator('g[data-conflict] path[data-dep-id]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '1 conflict', exact: true })).toBeVisible()
    await expect(bar(page, ids.bravo)).toHaveAccessibleName(/dependency conflict/)
  })

  test('AC-8: "Review" opens a preview with old → new dates; Cancel writes nothing, Apply moves the successor', async ({
    page,
  }) => {
    const seed = seedWorkspace({ tasks: AB_TASKS, deps: [['alpha', 'bravo']] })
    const { ids } = seed
    await openGantt(page, seed)
    await countWrites(page)

    await moveBar(page, ids.alpha, 4) // Alpha Nov 9 – Nov 11 overlaps Bravo (Nov 10 – Nov 12)
    await expect(toast(page, '1 dependency conflict')).toBeVisible()
    await toastButton(page, 'Review').click()
    const dialog = page.getByRole('dialog', { name: 'Resolve dependency conflicts' })
    await expect(dialog).toBeVisible()
    // Bravo has to start on Nov 12 (the day after Alpha ends) and keeps its 3 days.
    const moves = dialog.getByRole('region', { name: 'Tasks that move' })
    await expect(moves).toContainText('Bravo')
    await expect(moves).toContainText('Nov 10 – Nov 12')
    await expect(moves).toContainText('Nov 12 – Nov 14')
    await expect(moves).toContainText('+2d')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    // Cancel: the move of Alpha was the only write.
    expect(await writes(page)).toBe(1)
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-10', due: '2026-11-12' })
    await expect(page.getByRole('button', { name: '1 conflict', exact: true })).toBeVisible()

    // Same preview from the chip, this time applied: one more write, the conflict is gone.
    await page.getByRole('button', { name: '1 conflict', exact: true }).click()
    await page.getByRole('button', { name: 'Resolve all…' }).click()
    await dialog.getByRole('button', { name: 'Apply 1 change' }).click()
    await expect
      .poll(() => stored(page, ids.bravo))
      .toEqual({ start: '2026-11-12', due: '2026-11-14' })
    expect(await writes(page)).toBe(2)
    await expect(page.locator('g[data-conflict]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /conflict/ })).toHaveCount(0)
  })

  test('AC-8: A → B created in the Task Modal; a link that is already violated warns at once and the chart shows it', async ({
    page,
  }) => {
    // Alpha already overlaps Bravo; only the link is missing.
    const seed = seedWorkspace({
      tasks: [
        { key: 'alpha', title: 'Alpha', start: '2026-11-09', due: '2026-11-11' },
        { key: 'bravo', title: 'Bravo', start: '2026-11-10', due: '2026-11-12' },
      ],
    })
    const { ids } = seed
    await openGantt(page, seed)
    await expect(page.locator('path[data-dep-id]')).toHaveCount(0)

    await outlineRow(page, `task:${ids.bravo}`)
      .getByRole('button', { name: 'Bravo', exact: true })
      .click()
    const modal = modalOf(page, 'Bravo')
    await expect(modal).toBeVisible()
    await modal.getByRole('button', { name: 'Add a task that blocks this one' }).click()
    await page
      .getByRole('dialog', { name: 'Add a task that blocks this one' })
      .getByRole('option', { name: /^Alpha/ })
      .click()
    await expect(
      modal
        .getByRole('list', { name: 'Blocked by' })
        .getByRole('button', { name: 'Alpha', exact: true }),
    ).toBeVisible()
    await expect.poll(() => storedDependencies(page)).toEqual([`${ids.alpha}>${ids.bravo}`])
    // Manual mode: the violated link is written and the user is warned (not rescheduled).
    await expect(toast(page, '1 dependency conflict')).toBeVisible()
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-10', due: '2026-11-12' })

    await modal.getByRole('button', { name: 'Done', exact: true }).click() // nothing left to save: closes
    await expect(modal).toHaveCount(0)
    await expect(page.locator('path[data-dep-id]')).toHaveCount(1)
    await expect(page.locator('g[data-conflict] path[data-dep-id]')).toHaveCount(1)
    await expect(bar(page, ids.bravo)).toHaveAccessibleName(/dependency conflict/)
    await expect(page.getByRole('button', { name: '1 conflict', exact: true })).toBeVisible()
  })

  test('AC-8: Auto — delaying A previews B and C with old → new dates; Cancel writes nothing; "Only move this task" leaves them; Apply is ONE write', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      mode: 'auto',
      tasks: CHAIN_TASKS,
      deps: [
        ['alpha', 'bravo'],
        ['bravo', 'charlie'],
      ],
    })
    const { ids } = seed
    await openGantt(page, seed)
    await countWrites(page)
    const original = {
      alpha: { start: '2026-11-05', due: '2026-11-07' },
      bravo: { start: '2026-11-08', due: '2026-11-10' },
      charlie: { start: '2026-11-11', due: '2026-11-12' },
    }

    // Delay Alpha by 2 days → a preview of what moves, with every old → new date, before any write.
    await moveBar(page, ids.alpha, 2)
    const dialog = page.getByRole('dialog', { name: 'Move dependent tasks?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Auto-schedule counts calendar days')
    await expect(dialog.getByText('Your change')).toBeVisible()
    const moves = dialog.getByRole('region', { name: 'Tasks that move' })
    const bravoRow = moves.getByRole('listitem').filter({ hasText: 'Bravo' })
    const charlieRow = moves.getByRole('listitem').filter({ hasText: 'Charlie' })
    await expect(bravoRow).toContainText('Nov 8 – Nov 10')
    await expect(bravoRow).toContainText('Nov 10 – Nov 12')
    await expect(bravoRow).toContainText('+2d')
    await expect(charlieRow).toContainText('Nov 11 – Nov 12')
    await expect(charlieRow).toContainText('Nov 13 – Nov 14')
    await expect(charlieRow).toContainText('+2d')
    expect(await writes(page)).toBe(0)
    // The chart shows where they would go (dashed ghosts) while nothing is stored.
    await expect(page.locator('span.border-dashed.border-accent')).toHaveCount(2)

    // Cancel: nothing was written and every bar is back where it was.
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    expect(await writes(page)).toBe(0)
    for (const key of ['alpha', 'bravo', 'charlie'] as const) {
      expect(await stored(page, ids[key])).toEqual(original[key])
    }
    await expect(bar(page, ids.alpha)).toHaveAccessibleName('Alpha, Nov 5 – Nov 7, 3 days, To Do')
    await expect(page.locator('span.border-dashed.border-accent')).toHaveCount(0)

    // "Only move this task": Alpha moves, the others stay (and the conflict is flagged).
    await moveBar(page, ids.alpha, 2)
    await dialog.getByRole('button', { name: 'Only move this task' }).click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-07', due: '2026-11-09' })
    expect(await stored(page, ids.bravo)).toEqual(original.bravo)
    expect(await stored(page, ids.charlie)).toEqual(original.charlie)
    expect(await writes(page)).toBe(1)
    await expect(page.getByRole('button', { name: '1 conflict', exact: true })).toBeVisible()

    // Apply, from a fresh state: the task and both successors land in ONE atomic write.
    await moveBar(page, ids.alpha, 1) // Alpha Nov 8 – Nov 10
    await dialog.getByRole('button', { name: 'Apply 3 changes' }).click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-08', due: '2026-11-10' })
    await expect
      .poll(() => stored(page, ids.bravo))
      .toEqual({ start: '2026-11-11', due: '2026-11-13' })
    await expect
      .poll(() => stored(page, ids.charlie))
      .toEqual({ start: '2026-11-14', due: '2026-11-15' })
    expect(await writes(page)).toBe(2)
    // Durations were kept (3, 3 and 2 days), and nothing is in conflict any more.
    await expect(bar(page, ids.bravo)).toHaveAccessibleName('Bravo, Nov 11 – Nov 13, 3 days, To Do')
    await expect(bar(page, ids.charlie)).toHaveAccessibleName(
      'Charlie, Nov 14 – Nov 15, 2 days, To Do',
    )
    await expect(page.getByRole('button', { name: /conflict/ })).toHaveCount(0)
    await page.reload()
    await expect(bar(page, ids.charlie)).toHaveAccessibleName(
      'Charlie, Nov 14 – Nov 15, 2 days, To Do',
    )
  })

  test('AC-8: Auto — dismissing the preview with Esc or a click outside is the same as Cancel: nothing is written and every bar is back', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      mode: 'auto',
      tasks: CHAIN_TASKS,
      deps: [
        ['alpha', 'bravo'],
        ['bravo', 'charlie'],
      ],
    })
    const { ids } = seed
    await openGantt(page, seed)
    await countWrites(page)
    const dialog = page.getByRole('dialog', { name: 'Move dependent tasks?' })
    const expectUntouched = async () => {
      await expect(dialog).toHaveCount(0)
      expect(await writes(page)).toBe(0)
      expect(await stored(page, ids.alpha)).toEqual({ start: '2026-11-05', due: '2026-11-07' })
      expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-08', due: '2026-11-10' })
      expect(await stored(page, ids.charlie)).toEqual({ start: '2026-11-11', due: '2026-11-12' })
      await expect(bar(page, ids.alpha)).toHaveAccessibleName('Alpha, Nov 5 – Nov 7, 3 days, To Do')
      await expect(page.locator('span.border-dashed.border-accent')).toHaveCount(0)
      await expect(page.getByRole('button', { name: /conflict/ })).toHaveCount(0)
    }

    await moveBar(page, ids.alpha, 2)
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expectUntouched()

    await moveBar(page, ids.alpha, 2)
    await expect(dialog).toBeVisible()
    await page.mouse.click(8, 8) // on the dimmed backdrop, far from the dialog
    await expectUntouched()

    // The user can still decide later: the same move offers the same preview again.
    await moveBar(page, ids.alpha, 2)
    await expect(dialog).toBeVisible()
    await expect(
      dialog
        .getByRole('region', { name: 'Tasks that move' })
        .getByRole('listitem')
        .filter({ hasText: 'Charlie' }),
    ).toContainText('Nov 13 – Nov 14')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expectUntouched()
  })

  test('AC-8: Auto — when the save fails EVERY bar rolls back, and Retry writes them all', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      mode: 'auto',
      tasks: CHAIN_TASKS,
      deps: [
        ['alpha', 'bravo'],
        ['bravo', 'charlie'],
      ],
    })
    const { ids } = seed
    await openGantt(page, seed)
    await countWrites(page)

    await moveBar(page, ids.alpha, 2)
    const dialog = page.getByRole('dialog', { name: 'Move dependent tasks?' })
    await failNextWrites(page, 1)
    await dialog.getByRole('button', { name: 'Apply 3 changes' }).click()
    await expect(dialog).toHaveCount(0)
    const failed = toast(page, /Couldn't/)
    await expect(failed).toBeVisible()
    // Alpha, Bravo AND Charlie are back, in the chart and in storage; no write happened.
    await expect(bar(page, ids.alpha)).toHaveAccessibleName('Alpha, Nov 5 – Nov 7, 3 days, To Do')
    await expect(bar(page, ids.bravo)).toHaveAccessibleName('Bravo, Nov 8 – Nov 10, 3 days, To Do')
    await expect(bar(page, ids.charlie)).toHaveAccessibleName(
      'Charlie, Nov 11 – Nov 12, 2 days, To Do',
    )
    expect(await stored(page, ids.alpha)).toEqual({ start: '2026-11-05', due: '2026-11-07' })
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-08', due: '2026-11-10' })
    expect(await stored(page, ids.charlie)).toEqual({ start: '2026-11-11', due: '2026-11-12' })
    expect(await writes(page)).toBe(0)

    // Retry saves the same three changes together.
    await failed.locator('[data-button]', { hasText: 'Retry' }).click()
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-07', due: '2026-11-09' })
    await expect
      .poll(() => stored(page, ids.bravo))
      .toEqual({ start: '2026-11-10', due: '2026-11-12' })
    await expect
      .poll(() => stored(page, ids.charlie))
      .toEqual({ start: '2026-11-13', due: '2026-11-14' })
    expect(await writes(page)).toBe(1)
  })

  test('AC-8: Auto — linking two tasks that already overlap in the Task Modal previews the shift; "Keep current dates" keeps the link and the dates', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      mode: 'auto',
      tasks: [
        { key: 'alpha', title: 'Alpha', start: '2026-11-09', due: '2026-11-11' },
        { key: 'bravo', title: 'Bravo', start: '2026-11-10', due: '2026-11-12' },
      ],
    })
    const { ids } = seed
    await openGantt(page, seed)
    await outlineRow(page, `task:${ids.bravo}`)
      .getByRole('button', { name: 'Bravo', exact: true })
      .click()
    const modal = modalOf(page, 'Bravo')
    await modal.getByRole('button', { name: 'Add a task that blocks this one' }).click()
    await page
      .getByRole('dialog', { name: 'Add a task that blocks this one' })
      .getByRole('option', { name: /^Alpha/ })
      .click()

    const preview = page.getByRole('dialog', { name: 'Reschedule for the new dependency?' })
    await expect(preview).toBeVisible()
    await expect(preview).toContainText('Nov 10 – Nov 12')
    await expect(preview).toContainText('Nov 12 – Nov 14')
    await expect.poll(() => storedDependencies(page)).toEqual([`${ids.alpha}>${ids.bravo}`])
    await preview.getByRole('button', { name: 'Keep current dates' }).click()
    await expect(preview).toHaveCount(0)
    // Nothing moved; the conflict stays flagged until the user resolves it.
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-10', due: '2026-11-12' })
    expect(await storedDependencies(page)).toEqual([`${ids.alpha}>${ids.bravo}`])
  })
})

test.describe('AC-8: the List and the Gantt share one rule', () => {
  /** Alpha (Nov 5 – Nov 7) → Bravo (Nov 8 – Nov 10); the List sets Alpha's due date to Nov 9. */
  const LIST_TASKS: TaskSpec[] = [
    { key: 'alpha', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
    { key: 'bravo', title: 'Bravo', start: '2026-11-08', due: '2026-11-10' },
  ]

  async function setAlphaDueInList(page: Page): Promise<void> {
    const row = page
      .locator('[data-task-row]')
      .filter({ has: page.getByRole('button', { name: 'Move Alpha', exact: true }) })
    await row.getByRole('button', { name: /^Due date:/ }).click()
    await page
      .getByRole('dialog', { name: 'Due date', exact: true })
      .getByRole('button', { name: /November 9th, 2026/ })
      .click()
  }

  test('AC-8: Auto — a due date changed in the List previews the same shifts and applies them as one write', async ({
    page,
  }) => {
    const seed = seedWorkspace({ mode: 'auto', tasks: LIST_TASKS, deps: [['alpha', 'bravo']] })
    const { ids } = seed
    await openGantt(page, seed)
    await page.goto(`/projects/${seed.projectId}/list`)
    await countWrites(page)
    await setAlphaDueInList(page)
    const dialog = page.getByRole('dialog', { name: 'Move dependent tasks?' })
    await expect(dialog).toBeVisible()
    const moves = dialog.getByRole('region', { name: 'Tasks that move' })
    await expect(moves).toContainText('Nov 8 – Nov 10')
    await expect(moves).toContainText('Nov 10 – Nov 12')
    expect(await stored(page, ids.alpha)).toEqual({ start: '2026-11-05', due: '2026-11-07' })
    await dialog.getByRole('button', { name: 'Apply 2 changes' }).click()
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-05', due: '2026-11-09' })
    await expect
      .poll(() => stored(page, ids.bravo))
      .toEqual({ start: '2026-11-10', due: '2026-11-12' })
    expect(await writes(page)).toBe(1)
  })

  test('AC-8: Manual — a due date changed in the List writes it and warns about the conflict', async ({
    page,
  }) => {
    const seed = seedWorkspace({ tasks: LIST_TASKS, deps: [['alpha', 'bravo']] })
    const { ids } = seed
    await openGantt(page, seed)
    await page.goto(`/projects/${seed.projectId}/list`)
    await setAlphaDueInList(page)
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-05', due: '2026-11-09' })
    const warning = toast(page, '1 dependency conflict')
    await expect(warning).toBeVisible()
    await expect(warning).toContainText('“Bravo” starts before “Alpha” finishes.')
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-08', due: '2026-11-10' })
    // The Gantt shows the same conflict (chip, flagged line).
    await page.getByRole('link', { name: 'Gantt', exact: true }).click()
    await expect(page.getByRole('button', { name: '1 conflict', exact: true })).toBeVisible()
    await expect(page.locator('g[data-conflict] path[data-dep-id]')).toHaveCount(1)
  })
})

test.describe('AC-8: dependencies follow their tasks', () => {
  test('AC-8: deleting the predecessor takes its link and its conflict off the chart', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      tasks: [
        { key: 'alpha', title: 'Alpha', start: '2026-11-09', due: '2026-11-11' },
        { key: 'bravo', title: 'Bravo', start: '2026-11-10', due: '2026-11-12' },
      ],
      deps: [['alpha', 'bravo']],
    })
    const { ids } = seed
    await openGantt(page, seed)
    await expect(page.locator('g[data-conflict] path[data-dep-id]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '1 conflict', exact: true })).toBeVisible()

    await outlineRow(page, `task:${ids.alpha}`)
      .getByRole('button', { name: 'Alpha', exact: true })
      .click()
    const modal = modalOf(page, 'Alpha')
    await modal.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: /Delete task/ }).click()
    const confirmation = page.getByRole('alertdialog', { name: 'Delete task?' })
    await expect(confirmation).toContainText('1 dependency')
    await confirmation.getByRole('button', { name: 'Delete' }).click()

    await expect(modal).toHaveCount(0)
    await expect(bar(page, ids.alpha)).toHaveCount(0)
    await expect(page.locator('path[data-dep-id]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /conflict/ })).toHaveCount(0)
    expect(await storedDependencies(page)).toEqual([])
    // Bravo is untouched and no longer flagged.
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-10', due: '2026-11-12' })
    await expect(bar(page, ids.bravo)).toHaveAccessibleName('Bravo, Nov 10 – Nov 12, 3 days, To Do')
  })
})

test.describe('AC-8: the mode is saved like any other change', () => {
  test('AC-8: a failed Manual → Auto switch does not pretend it worked, and Retry saves it', async ({
    page,
  }) => {
    const seed = seedWorkspace({ tasks: AB_TASKS, deps: [['alpha', 'bravo']] })
    await openGantt(page, seed)
    await failNextWrites(page, 1)
    await page.getByRole('button', { name: 'Dependencies: Manual' }).click()
    await page.getByRole('menuitemradio', { name: /^Auto/ }).click()
    const failed = toast(page, /Couldn't/)
    await expect(failed).toBeVisible()
    // Still Manual on screen and in storage.
    await expect(page.getByRole('button', { name: 'Dependencies: Manual' })).toBeVisible()
    expect(await storedScheduleMode(page, seed.projectId)).toBe('manual')
    await failed.locator('[data-button]', { hasText: 'Retry' }).click()
    await expect.poll(() => storedScheduleMode(page, seed.projectId)).toBe('auto')
    await expect(page.getByRole('button', { name: 'Dependencies: Auto' })).toBeVisible()
  })
})

test.describe('AC-8: more ways into a conflict', () => {
  test('AC-8: switching a project with a conflict from Manual to Auto moves nothing by itself and offers Review', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      tasks: [
        { key: 'alpha', title: 'Alpha', start: '2026-11-09', due: '2026-11-11' },
        { key: 'bravo', title: 'Bravo', start: '2026-11-10', due: '2026-11-12' },
      ],
      deps: [['alpha', 'bravo']],
    })
    const { ids } = seed
    await openGantt(page, seed)
    await expect(page.getByRole('button', { name: 'Dependencies: Manual' })).toBeVisible()
    await page.getByRole('button', { name: 'Dependencies: Manual' }).click()
    await page.getByRole('menuitemradio', { name: /^Auto/ }).click()
    await expect.poll(() => storedScheduleMode(page, seed.projectId)).toBe('auto')
    const note = toast(page, 'Auto scheduling is on')
    await expect(note).toBeVisible()
    await expect(note).toContainText('1 existing conflict stays until you resolve it.')
    // Nothing moved; "Review" opens the preview of what Auto would do.
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-10', due: '2026-11-12' })
    await toastButton(page, 'Review').click()
    const dialog = page.getByRole('dialog', { name: 'Resolve dependency conflicts' })
    await expect(dialog.getByRole('region', { name: 'Tasks that move' })).toContainText(
      'Nov 12 – Nov 14',
    )
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-10', due: '2026-11-12' })
  })

  test('AC-8: Auto — scheduling an undated predecessor by drawing previews the move of its successor', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      mode: 'auto',
      tasks: [
        { key: 'first', title: 'First' },
        { key: 'bravo', title: 'Bravo', start: '2026-11-10', due: '2026-11-12' },
      ],
      deps: [['first', 'bravo']],
    })
    const { ids } = seed
    await openGantt(page, seed)
    const lane = outlineRow(page, `task:${ids.first}`).locator('[data-handle="lane"]')
    const laneBox = await boxOf(lane)
    // Draw Nov 8 – Nov 10: it ends on Bravo's first day, so Bravo has to start on Nov 11.
    await dragBy(
      page,
      { x: await dayX(page, '2026-11-08', 'center'), y: laneBox.y + laneBox.height / 2 },
      2 * PX.day,
    )
    const dialog = page.getByRole('dialog', { name: 'Move dependent tasks?' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Your change')).toBeVisible()
    await expect(dialog).toContainText('No dates')
    await expect(dialog).toContainText('Nov 8 – Nov 10')
    await expect(dialog.getByRole('region', { name: 'Tasks that move' })).toContainText(
      'Nov 11 – Nov 13',
    )
    expect(await stored(page, ids.first)).toEqual({ start: null, due: null })
    await dialog.getByRole('button', { name: 'Apply 2 changes' }).click()
    await expect
      .poll(() => stored(page, ids.first))
      .toEqual({ start: '2026-11-08', due: '2026-11-10' })
    await expect
      .poll(() => stored(page, ids.bravo))
      .toEqual({ start: '2026-11-11', due: '2026-11-13' })
  })

  // Drawing a link on the chart between two bars that ALREADY overlap: the same rule as the Task
  // Modal (Manual warns at once, Auto previews), reached through the pointer.
  const OVERLAPPING: TaskSpec[] = [
    { key: 'alpha', title: 'Alpha', start: '2026-11-09', due: '2026-11-11' },
    { key: 'bravo', title: 'Bravo', start: '2026-11-10', due: '2026-11-12' },
  ]

  test('AC-8: Manual — drawing a link between bars that already overlap writes the link, warns at once and moves nothing', async ({
    page,
  }) => {
    const seed = seedWorkspace({ tasks: OVERLAPPING })
    const { ids } = seed
    await openGantt(page, seed)
    await linkDrag(page, ids.alpha, ids.bravo)
    await expect.poll(() => storedDependencies(page)).toEqual([`${ids.alpha}>${ids.bravo}`])
    const warning = toast(page, '1 dependency conflict')
    await expect(warning).toBeVisible()
    await expect(warning).toContainText('“Bravo” starts before “Alpha” finishes.')
    await expect(page.locator('g[data-conflict] path[data-dep-id]')).toHaveCount(1)
    await expect(bar(page, ids.bravo)).toHaveAccessibleName(/dependency conflict/)
    await expect(page.getByRole('button', { name: '1 conflict', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0) // Manual never opens a preview by itself
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-10', due: '2026-11-12' })
  })

  test('AC-8: Auto — drawing a link between bars that already overlap previews old → new; "Keep current dates" keeps the link and the dates', async ({
    page,
  }) => {
    const seed = seedWorkspace({ mode: 'auto', tasks: OVERLAPPING })
    const { ids } = seed
    await openGantt(page, seed)
    await countWrites(page)
    await linkDrag(page, ids.alpha, ids.bravo)
    const preview = page.getByRole('dialog', { name: 'Reschedule for the new dependency?' })
    await expect(preview).toBeVisible()
    const moves = preview.getByRole('region', { name: 'Tasks that move' })
    await expect(moves).toContainText('Bravo')
    await expect(moves).toContainText('Nov 10 – Nov 12')
    await expect(moves).toContainText('Nov 12 – Nov 14')
    await expect(moves).toContainText('+2d')
    // The link is already written (one write); the successor's dates wait for the user's answer.
    await expect.poll(() => storedDependencies(page)).toEqual([`${ids.alpha}>${ids.bravo}`])
    expect(await writes(page)).toBe(1)
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-10', due: '2026-11-12' })

    await preview.getByRole('button', { name: 'Keep current dates' }).click()
    await expect(preview).toHaveCount(0)
    expect(await writes(page)).toBe(1) // declining wrote nothing
    expect(await stored(page, ids.bravo)).toEqual({ start: '2026-11-10', due: '2026-11-12' })
    expect(await storedDependencies(page)).toEqual([`${ids.alpha}>${ids.bravo}`])
    // The overlap is still flagged, so the user can resolve it later.
    await expect(page.getByRole('button', { name: '1 conflict', exact: true })).toBeVisible()
    await expect(page.locator('g[data-conflict] path[data-dep-id]')).toHaveCount(1)
  })

  test('AC-8: Auto — applying the preview of a drawn link moves the successor in ONE write and clears the conflict', async ({
    page,
  }) => {
    const seed = seedWorkspace({ mode: 'auto', tasks: OVERLAPPING })
    const { ids } = seed
    await openGantt(page, seed)
    await countWrites(page)
    await linkDrag(page, ids.alpha, ids.bravo)
    const preview = page.getByRole('dialog', { name: 'Reschedule for the new dependency?' })
    await expect(preview).toBeVisible()
    await preview.getByRole('button', { name: 'Apply 1 change' }).click()
    await expect
      .poll(() => stored(page, ids.bravo))
      .toEqual({ start: '2026-11-12', due: '2026-11-14' })
    expect(await stored(page, ids.alpha)).toEqual({ start: '2026-11-09', due: '2026-11-11' })
    expect(await writes(page)).toBe(2) // the link, then the shift
    await expect(page.locator('g[data-conflict]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /conflict/ })).toHaveCount(0)
    await page.reload()
    await expect(bar(page, ids.bravo)).toHaveAccessibleName(/^Bravo, Nov 12 – Nov 14, 3 days/)
  })
})

// ---------------------------------------------------------------------------
// AC-9 — no circular dependency; dates never break the basic rules
// ---------------------------------------------------------------------------

const CYCLE_MESSAGE = 'This would create a circular dependency.'

/** The live tooltip next to the pointer while a link is being drawn (portalled, never a toast). */
function linkTooltip(page: Page) {
  return page.locator('div.pointer-events-none.fixed')
}

/** Starts a link from `fromId`'s dot and holds over `toId` (the mouse button stays down). */
async function hoverLink(page: Page, fromId: string, toId: string, side: 'out' | 'in' = 'out') {
  await linkDrag(page, fromId, toId, { side, release: false })
}

test.describe('AC-9: cycles and date rules', () => {
  test('AC-9: a two-task cycle (A → B, then B → A) is refused with the reason on the chart and in the Task Modal', async ({
    page,
  }) => {
    const seed = seedWorkspace({ tasks: AB_TASKS, deps: [['alpha', 'bravo']] })
    const { ids } = seed
    await openGantt(page, seed)

    // Chart: Bravo → Alpha. The drop target turns red and says why; releasing adds nothing.
    await hoverLink(page, ids.bravo, ids.alpha)
    await expect(linkTooltip(page).getByText(CYCLE_MESSAGE)).toBeVisible()
    await expect(bar(page, ids.alpha)).toHaveClass(/ring-danger/)
    await page.mouse.up()
    const refused = toast(page, "Can't add this dependency")
    await expect(refused).toBeVisible()
    await expect(refused).toContainText(CYCLE_MESSAGE)
    expect(await storedDependencies(page)).toEqual([`${ids.alpha}>${ids.bravo}`])
    await expect(page.locator('path[data-dep-id]')).toHaveCount(1)

    // Task Modal: from Alpha, "Blocked by" offers Bravo only as a disabled option with the reason.
    await outlineRow(page, `task:${ids.alpha}`)
      .getByRole('button', { name: 'Alpha', exact: true })
      .click()
    const modal = modalOf(page, 'Alpha')
    await modal.getByRole('button', { name: 'Add a task that blocks this one' }).click()
    const picker = page.getByRole('dialog', { name: 'Add a task that blocks this one' })
    const option = picker.getByRole('option', { name: /^Bravo/ })
    await expect(option).toHaveAttribute('aria-disabled', 'true')
    await expect(option).toContainText(CYCLE_MESSAGE)
    await option.click({ force: true })
    expect(await storedDependencies(page)).toEqual([`${ids.alpha}>${ids.bravo}`])
  })

  test('AC-9: a three-task cycle (A → B → C, then C → A) is refused from either end of the chart and in the Task Modal', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      tasks: CHAIN_TASKS,
      deps: [
        ['alpha', 'bravo'],
        ['bravo', 'charlie'],
      ],
    })
    const { ids } = seed
    const chain = [`${ids.alpha}>${ids.bravo}`, `${ids.bravo}>${ids.charlie}`]
    await openGantt(page, seed)

    // From Charlie's finish dot onto Alpha …
    await hoverLink(page, ids.charlie, ids.alpha)
    await expect(linkTooltip(page).getByText(CYCLE_MESSAGE)).toBeVisible()
    await page.mouse.up()
    await expect(toast(page, "Can't add this dependency")).toContainText(CYCLE_MESSAGE)
    expect(await storedDependencies(page)).toEqual(chain)

    // … and from Alpha's START dot onto Charlie (Charlie → Alpha again, drawn the other way round).
    await page.mouse.move(5, 5)
    await hoverLink(page, ids.alpha, ids.charlie, 'in')
    await expect(linkTooltip(page).getByText(CYCLE_MESSAGE)).toBeVisible()
    await page.mouse.up()
    expect(await storedDependencies(page)).toEqual(chain)

    // Task Modal on Alpha: Charlie is offered only as a disabled option that names the cycle.
    await outlineRow(page, `task:${ids.alpha}`)
      .getByRole('button', { name: 'Alpha', exact: true })
      .click()
    const modal = modalOf(page, 'Alpha')
    await modal.getByRole('button', { name: 'Add a task that blocks this one' }).click()
    const option = page
      .getByRole('dialog', { name: 'Add a task that blocks this one' })
      .getByRole('option', { name: /^Charlie/ })
    await expect(option).toHaveAttribute('aria-disabled', 'true')
    await expect(option).toContainText(CYCLE_MESSAGE)
    expect(await storedDependencies(page)).toEqual(chain)
  })

  test('AC-9: a task cannot depend on itself, and a duplicate link is refused, each with a clear message', async ({
    page,
  }) => {
    const seed = seedWorkspace({ tasks: AB_TASKS, deps: [['alpha', 'bravo']] })
    const { ids } = seed
    await openGantt(page, seed)
    const only = [`${ids.alpha}>${ids.bravo}`]

    // Self: from Alpha's dot back onto Alpha's own bar.
    await hoverLink(page, ids.alpha, ids.alpha)
    await expect(linkTooltip(page).getByText("A task can't depend on itself.")).toBeVisible()
    await expect(bar(page, ids.alpha)).toHaveClass(/ring-danger/)
    await page.mouse.up()
    await expect(toast(page, "Can't add this dependency")).toContainText(
      "A task can't depend on itself.",
    )
    expect(await storedDependencies(page)).toEqual(only)

    // Duplicate: Alpha → Bravo again.
    await page.mouse.move(5, 5)
    await hoverLink(page, ids.alpha, ids.bravo)
    await expect(linkTooltip(page).getByText('This dependency already exists.')).toBeVisible()
    await page.mouse.up()
    await expect(
      toast(page, "Can't add this dependency").filter({ hasText: 'already exists' }),
    ).toBeVisible()
    expect(await storedDependencies(page)).toEqual(only)
    await expect(page.locator('path[data-dep-id]')).toHaveCount(1)

    // Task Modal on Alpha: itself and the already-linked Bravo are never offered.
    await outlineRow(page, `task:${ids.alpha}`)
      .getByRole('button', { name: 'Alpha', exact: true })
      .click()
    const modal = modalOf(page, 'Alpha')
    await modal.getByRole('button', { name: 'Add a task this one blocks' }).click()
    const picker = page.getByRole('dialog', { name: 'Add a task this one blocks' })
    await expect(picker.getByRole('option', { name: /^Alpha/ })).toHaveCount(0)
    await expect(picker.getByRole('option', { name: /^Bravo/ })).toHaveCount(0)
    await expect(picker.getByText('No other tasks in this project yet.')).toBeVisible()
  })

  test('AC-9: a task cannot depend on its own parent or subtask', async ({ page }) => {
    const seed = seedWorkspace({
      tasks: [
        { key: 'parent', title: 'Parent', start: '2026-11-05', due: '2026-11-12' },
        { key: 'child', title: 'Child', start: '2026-11-06', due: '2026-11-08', parent: 'parent' },
      ],
    })
    const { ids } = seed
    await openGantt(page, seed)
    const message = "A task can't depend on its own parent or subtask."
    await hoverLink(page, ids.child, ids.parent)
    await expect(linkTooltip(page).getByText(message)).toBeVisible()
    await page.mouse.up()
    await expect(toast(page, "Can't add this dependency")).toContainText(message)
    await page.mouse.move(5, 5)
    await hoverLink(page, ids.parent, ids.child)
    await expect(linkTooltip(page).getByText(message)).toBeVisible()
    await page.mouse.up()
    expect(await storedDependencies(page)).toEqual([])
  })

  test('AC-9: dropping a link on an undated task explains why the chart cannot link it; the Task Modal can', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      tasks: [
        { key: 'alpha', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
        { key: 'later', title: 'Later' },
      ],
    })
    const { ids } = seed
    await openGantt(page, seed)
    const message = 'Schedule this task first to link it on the chart.'

    // Hold Alpha's finish dot over the undated task's row: the tooltip says why, the drop adds nothing.
    await bar(page, ids.alpha).hover()
    const dot = await boxOf(
      page.locator(`[data-handle="link-out"][data-task-id="${ids.alpha}"]`).first(),
    )
    const lane = await boxOf(outlineRow(page, `task:${ids.later}`).locator('[data-handle="lane"]'))
    const from = { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 }
    const to = { x: await dayX(page, '2026-11-12', 'center'), y: lane.y + lane.height / 2 }
    await dragBy(page, from, to.x - from.x, to.y - from.y, { release: false })
    await expect(linkTooltip(page).getByText(message)).toBeVisible()
    await page.mouse.up()
    await expect(toast(page, "Can't add this dependency")).toContainText(message)
    expect(await storedDependencies(page)).toEqual([])

    // The Task Modal links undated tasks (nothing is drawn until they have dates).
    await outlineRow(page, `task:${ids.later}`)
      .getByRole('button', { name: 'Later', exact: true })
      .click()
    const modal = modalOf(page, 'Later')
    await modal.getByRole('button', { name: 'Add a task that blocks this one' }).click()
    await page
      .getByRole('dialog', { name: 'Add a task that blocks this one' })
      .getByRole('option', { name: /^Alpha/ })
      .click()
    await expect.poll(() => storedDependencies(page)).toEqual([`${ids.alpha}>${ids.later}`])
  })

  test('AC-9: on the chart a due date can never end up before the start date', async ({ page }) => {
    const seed = seedWorkspace({ tasks: PROJECT_TASKS })
    const { ids } = seed
    await openGantt(page, seed)

    // Dragging the start grip far past the end leaves a one-day task (start = due).
    await resizeBar(page, ids.alpha, 'start', 9)
    await expect
      .poll(() => stored(page, ids.alpha))
      .toEqual({ start: '2026-11-07', due: '2026-11-07' })
    // Dragging the end grip far before the start does the same from the other side.
    await resizeBar(page, ids.bravo, 'end', -9)
    await expect
      .poll(() => stored(page, ids.bravo))
      .toEqual({ start: '2026-11-10', due: '2026-11-10' })
    // Moving keeps both dates together; drawing right-to-left still starts on the earlier day.
    await moveBar(page, ids.charlie, -4)
    await expect
      .poll(() => stored(page, ids.charlie))
      .toEqual({ start: '2026-11-09', due: '2026-11-10' })
    const lane = outlineRow(page, `task:${ids.undated1}`).locator('[data-handle="lane"]')
    const laneBox = await boxOf(lane)
    await dragBy(
      page,
      { x: await dayX(page, '2026-11-12', 'center'), y: laneBox.y + laneBox.height / 2 },
      -2 * PX.day,
    )
    await expect
      .poll(() => stored(page, ids.undated1))
      .toEqual({ start: '2026-11-10', due: '2026-11-12' })
    // Keyboard: Alt+Shift+← cannot pull the end before the start either.
    await bar(page, ids.alpha).focus()
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Alt+Shift+ArrowLeft')
    expect(await stored(page, ids.alpha)).toEqual({ start: '2026-11-07', due: '2026-11-07' })
  })

  test('AC-9: in the Task Modal the date calendars disable a due date before the start and a start after the due date, so nothing invalid is stored', async ({
    page,
  }) => {
    const seed = seedWorkspace({ tasks: AB_TASKS })
    const { ids } = seed
    await openGantt(page, seed)
    await outlineRow(page, `task:${ids.alpha}`)
      .getByRole('button', { name: 'Alpha', exact: true })
      .click()
    const modal = modalOf(page, 'Alpha')
    await expect(modal).toBeVisible()

    // The Due calendar cannot even offer a day before the start (Alpha starts Nov 5; today is Nov 4).
    await modal.getByRole('button', { name: /^Due date:/ }).click()
    const duePicker = page.getByRole('dialog', { name: 'Due date', exact: true })
    await expect(duePicker.getByRole('button', { name: /^Today Nov/ })).toBeDisabled()
    await expect(duePicker.getByText('Due date can’t be before the start date.')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(duePicker).toHaveCount(0)

    // The Start calendar cannot offer a day after the due date either (Alpha is due Nov 7).
    await modal.getByRole('button', { name: /^Start date:/ }).click()
    const startPicker = page.getByRole('dialog', { name: 'Start date', exact: true })
    await expect(startPicker.getByRole('button', { name: /^Next week/ })).toBeDisabled()
    await expect(startPicker.getByRole('button', { name: /November 9th, 2026/ })).toBeDisabled()
    await expect(startPicker.getByText('The start can’t be after the due date.')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(startPicker).toHaveCount(0)
    // No inline error, nothing to block: the stored dates were never touched.
    await expect(modal.getByRole('alert')).toHaveCount(0)
    expect(await stored(page, ids.alpha)).toEqual({ start: '2026-11-05', due: '2026-11-07' })
  })

  test('AC-9: in the List the date pickers disable every day that would put the due date before the start', async ({
    page,
  }) => {
    const seed = seedWorkspace({ tasks: AB_TASKS })
    const { ids } = seed
    await openGantt(page, seed)
    await page.goto(`/projects/${seed.projectId}/list`)
    const row = page
      .locator('[data-task-row]')
      .filter({ has: page.getByRole('button', { name: 'Move Alpha', exact: true }) })

    // Due: "Today" (Nov 4) is before Alpha's start (Nov 5) — disabled; so are the calendar days.
    await row.getByRole('button', { name: /^Due date:/ }).click()
    const due = page.getByRole('dialog', { name: 'Due date', exact: true })
    await expect(due.getByRole('button', { name: /^Today Nov/ })).toBeDisabled()
    await expect(due.getByRole('button', { name: /November 4th, 2026/ })).toBeDisabled()
    await expect(due.getByRole('button', { name: /November 8th, 2026/ })).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(due).toHaveCount(0)

    // Start: "Next week" (after Alpha's due date Nov 7) is disabled the same way.
    await row.getByRole('button', { name: /^Start date:/ }).click()
    const start = page.getByRole('dialog', { name: 'Start date', exact: true })
    await expect(start.getByRole('button', { name: /^Next week Nov/ })).toBeDisabled()
    await expect(start.getByRole('button', { name: /November 9th, 2026/ })).toBeDisabled()
    await expect(start.getByRole('button', { name: /November 6th, 2026/ })).toBeEnabled()
    await page.keyboard.press('Escape')
    expect(await stored(page, ids.alpha)).toEqual({ start: '2026-11-05', due: '2026-11-07' })
  })
})

// ---------------------------------------------------------------------------
// §4.7 — clause by clause: what the acceptance statements above do not already prove
// ---------------------------------------------------------------------------

test.describe('§4.7: Gantt page requirements', () => {
  test('§4.7: the task outline and the time header stay put while the timeline scrolls in both directions', async ({
    page,
  }) => {
    // 40 dated tasks so the chart scrolls vertically too.
    const filler: TaskSpec[] = Array.from({ length: 40 }, (_, i) => ({
      key: `f${i}`,
      title: `Filler ${i}`,
      start: '2026-11-06',
      due: '2026-11-08',
    }))
    const seed = seedWorkspace({ tasks: [...AB_TASKS, ...filler] })
    const { ids } = seed
    await openGantt(page, seed)
    const outlineTitle = outlineRow(page, `task:${ids.alpha}`).getByRole('button', {
      name: 'Alpha',
      exact: true,
    })
    const dayCell = page.locator('[title="Wednesday, November 4, 2026"]')
    const outlineBefore = await boxOf(outlineTitle)
    const headerBefore = await boxOf(dayCell)

    // Scroll the timeline right: the outline does not move, the day cell moves by what was scrolled.
    const scrolledFrom = await chart(page).evaluate((el) => el.scrollLeft)
    await chart(page).evaluate((el) => {
      el.scrollLeft += 400
    })
    const scrolledBy = (await chart(page).evaluate((el) => el.scrollLeft)) - scrolledFrom
    expect(scrolledBy).toBeGreaterThan(100)
    await expect
      .poll(async () => Math.round((await boxOf(dayCell)).x))
      .toBe(Math.round(headerBefore.x - scrolledBy))
    const outlineRight = await boxOf(outlineTitle)
    expect(outlineRight.x).toBe(outlineBefore.x)
    expect(outlineRight.y).toBe(outlineBefore.y)

    // Scroll down: the header stays at the top while the rows move.
    await chart(page).evaluate((el) => {
      el.scrollTop += 300
    })
    await expect
      .poll(async () => Math.round((await boxOf(dayCell)).y))
      .toBe(Math.round(headerBefore.y))
    await expect(page.getByRole('separator', { name: 'Resize task list' })).toBeVisible()
    const outlineDown = await boxOf(
      page.locator('[data-row-key^="task:"]').nth(3).getByRole('button').first(),
    )
    expect(outlineDown.x).toBeGreaterThanOrEqual(outlineBefore.x - 40) // still in the sticky column
  })

  test('§4.7: Manual is the default for a project created in the app', async ({ page }) => {
    await page.clock.setFixedTime('2026-11-04T10:00:00+08:00')
    await page.goto('/projects')
    await page
      .getByRole('button', { name: /new project/i })
      .first()
      .click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name').fill('Fresh project')
    await dialog.getByRole('button', { name: /^create/i }).click()
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+/)
    await page.getByRole('link', { name: 'Gantt', exact: true }).click()
    await expect(page.getByText('No tasks yet')).toBeVisible()
    // The mode lives in the view bar once the project has something to show: add a task, then look.
    await page.getByRole('button', { name: 'New task' }).first().click()
    await page.getByRole('dialog').getByRole('textbox', { name: /title/i }).fill('First')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Dependencies: Manual' })).toBeVisible()
  })

  test('§4.7: Auto never moves the task you just dragged — a successor pulled before its predecessor is written and warned about', async ({
    page,
  }) => {
    const seed = seedWorkspace({ mode: 'auto', tasks: AB_TASKS, deps: [['alpha', 'bravo']] })
    const { ids } = seed
    await openGantt(page, seed)
    await moveBar(page, ids.bravo, -4) // Bravo Nov 6 – Nov 8 starts inside Alpha (Nov 5 – Nov 7)
    await expect
      .poll(() => stored(page, ids.bravo))
      .toEqual({ start: '2026-11-06', due: '2026-11-08' })
    // No preview (nothing else would move); the user's edit stands and the conflict is flagged.
    await expect(page.getByRole('dialog', { name: 'Move dependent tasks?' })).toHaveCount(0)
    expect(await stored(page, ids.alpha)).toEqual({ start: '2026-11-05', due: '2026-11-07' })
    await expect(toast(page, '1 dependency conflict')).toBeVisible()
    await expect(page.getByRole('button', { name: '1 conflict', exact: true })).toBeVisible()
  })

  test('§4.7: a dependency on an undated task draws nothing until it is scheduled; scheduling it onto the predecessor warns', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      tasks: [
        { key: 'alpha', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
        { key: 'later', title: 'Later' },
      ],
      deps: [['alpha', 'later']],
    })
    const { ids } = seed
    await openGantt(page, seed)
    // No bar, no line, no conflict for an undated successor.
    await expect(page.locator('path[data-dep-id]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /conflict/ })).toHaveCount(0)
    // Draw it across Nov 6 – Nov 8: it starts before Alpha ends → the line appears, flagged.
    const lane = outlineRow(page, `task:${ids.later}`).locator('[data-handle="lane"]')
    const laneBox = await boxOf(lane)
    await dragBy(
      page,
      { x: await dayX(page, '2026-11-06', 'center'), y: laneBox.y + laneBox.height / 2 },
      2 * PX.day,
    )
    await expect
      .poll(() => stored(page, ids.later))
      .toEqual({ start: '2026-11-06', due: '2026-11-08' })
    await expect(toast(page, '1 dependency conflict')).toBeVisible()
    await expect(page.locator('g[data-conflict] path[data-dep-id]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '1 conflict', exact: true })).toBeVisible()
  })

  test('§4.7: a failed save puts a dragged diamond back and Retry moves it; a failed link leaves no line behind', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      tasks: AB_TASKS,
      milestones: [{ key: 'launch', name: 'Launch', date: '2026-11-15' }],
    })
    const { ids } = seed
    await openGantt(page, seed)
    const diamond = page.getByRole('button', { name: 'Milestone Launch, Nov 15, 2026' })
    const box = await boxOf(diamond)
    await failNextWrites(page, 1)
    await dragBy(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, -2 * PX.day)
    const failed = toast(page, /Couldn't/)
    await expect(failed).toBeVisible()
    await expect(page.getByRole('button', { name: 'Milestone Launch, Nov 15, 2026' })).toBeVisible()
    expect(await storedMilestoneDate(page, ids.launch)).toBe('2026-11-15')
    await failed.locator('[data-button]', { hasText: 'Retry' }).click()
    await expect.poll(() => storedMilestoneDate(page, ids.launch)).toBe('2026-11-13')

    // A link whose save fails disappears again (nothing stored) and the toast offers Retry.
    await failNextWrites(page, 1)
    await linkDrag(page, ids.alpha, ids.bravo)
    const linkFailed = toast(page, /Couldn't/).first()
    await expect(linkFailed).toBeVisible()
    await expect(page.locator('path[data-dep-id]')).toHaveCount(0)
    expect(await storedDependencies(page)).toEqual([])
    await linkFailed.locator('[data-button]', { hasText: 'Retry' }).click()
    await expect.poll(() => storedDependencies(page)).toEqual([`${ids.alpha}>${ids.bravo}`])
    await expect(page.locator('path[data-dep-id]')).toHaveCount(1)
  })

  test('§4.7: moving the earliest task later does not shift the days on screen (the timeline never shrinks under the user)', async ({
    page,
  }) => {
    const seed = seedWorkspace({
      tasks: [
        { key: 'early', title: 'Early', start: '2026-10-20', due: '2026-10-22' },
        { key: 'alpha', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
        { key: 'late', title: 'Late', start: '2026-12-20', due: '2026-12-22' },
      ],
    })
    const { ids } = seed
    await openGantt(page, seed, 'day')
    // Look at the early part of the timeline (left of Nov, clear of the growth zone at the edge).
    await chart(page).evaluate((el) => {
      el.scrollLeft = 300
    })
    const marker = page.locator('[title="Sunday, October 25, 2026"]')
    await expect(marker).toBeVisible()
    const before = (await boxOf(marker)).x
    await expect.poll(async () => (await boxOf(marker)).x).toBe(before)

    // Edit the early task through the Task Modal: it now starts far later (Nov 25 – Nov 27), so the
    // data's first date moves from Oct 20 to Nov 5 and the timeline's natural start moves with it.
    await outlineRow(page, `task:${ids.early}`)
      .getByRole('button', { name: 'Early', exact: true })
      .click()
    const modal = modalOf(page, 'Early')
    await pickModalDate(page, modal, 'Due date', '2026-11-27')
    await pickModalDate(page, modal, 'Start date', '2026-11-25')
    await modal.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(modal).toHaveCount(0)
    await expect
      .poll(() => stored(page, ids.early))
      .toEqual({ start: '2026-11-25', due: '2026-11-27' })

    // The days the user was looking at are exactly where they were.
    await expect(marker).toBeVisible()
    await expect.poll(async () => Math.abs((await boxOf(marker)).x - before)).toBeLessThanOrEqual(1)
  })

  for (const timezone of ['America/Los_Angeles', 'Pacific/Auckland', 'Pacific/Kiritimati']) {
    test(`§4.7: no one-day jump in ${timezone}: a move, a resize, a milestone drag and a reload keep the same calendar dates`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        timezoneId: timezone,
        locale: 'en-US',
        viewport: { width: 1280, height: 800 },
        baseURL: 'http://localhost:5180',
      })
      const page = await context.newPage()
      try {
        const seed = seedWorkspace({
          tasks: [{ key: 'alpha', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' }],
          milestones: [{ key: 'launch', name: 'Launch', date: '2026-11-15' }],
        })
        const { ids } = seed
        await openGantt(page, seed, 'day', '2026-11-04T12:00:00Z')
        await moveBar(page, ids.alpha, 2)
        await expect
          .poll(() => stored(page, ids.alpha))
          .toEqual({ start: '2026-11-07', due: '2026-11-09' })
        await resizeBar(page, ids.alpha, 'end', 1)
        await expect
          .poll(() => stored(page, ids.alpha))
          .toEqual({ start: '2026-11-07', due: '2026-11-10' })
        const diamond = page.getByRole('button', { name: 'Milestone Launch, Nov 15, 2026' })
        const box = await boxOf(diamond)
        await dragBy(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, -3 * PX.day)
        await expect.poll(() => storedMilestoneDate(page, ids.launch)).toBe('2026-11-12')
        await page.reload()
        await expect(bar(page, ids.alpha)).toHaveAccessibleName(
          'Alpha, Nov 7 – Nov 10, 4 days, To Do',
        )
        await expect(
          page.getByRole('button', { name: 'Milestone Launch, Nov 12, 2026' }),
        ).toBeVisible()
        await expectBarOnDays(page, ids.alpha, '2026-11-07', '2026-11-10')
      } finally {
        await context.close()
      }
    })
  }
})
