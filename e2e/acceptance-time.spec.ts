/// <reference lib="dom" />
/**
 * Time acceptance (PRD §5.3 / §9.2): a task date is a calendar DAY, never an instant. Whatever the
 * browser time zone and the "Time zone" preference are, the day the user picked or dragged to is
 * the day that is stored and shown, and Today / Overdue / Upcoming follow the preference only.
 * LOCAL data mode against the dev server; time pinned with page.clock.
 */
import { readFileSync } from 'node:fs'
import { type Page } from '@playwright/test'
import {
  LOCAL_WORKSPACE_KEY,
  bar,
  boxOf,
  chart,
  dayX,
  expect,
  moveBar,
  openGantt,
  resizeBar,
  seedWorkspace,
  stored,
  test,
  type Seed,
} from './acceptance-gantt.helpers.ts'

test.use({ locale: 'en-US', viewport: { width: 1440, height: 900 } })

function withPrefs(seed: Seed, timezone: string, weekStartsOn: 0 | 1 = 1): Seed {
  ;(seed.db as { preferences: unknown }).preferences = {
    theme: 'light',
    sidebarCollapsed: false,
    timezone,
    weekStartsOn,
  }
  return seed
}

function dayPattern(date: string): RegExp {
  const [year, month, day] = date.split('-').map(Number)
  const name = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
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
  return new RegExp(`${name} ${day}${suffix}, ${year}`)
}

/** Opens a date chip inside `scope` and picks `date` in its calendar. */
async function pickDate(
  page: Page,
  scope: ReturnType<Page['locator']>,
  field: 'Start date' | 'Due date',
  date: string,
): Promise<void> {
  await scope
    .getByRole('button', { name: new RegExp(`^${field}:`) })
    .first()
    .click()
  const picker = page.getByRole('dialog', { name: field, exact: true })
  const cell = picker.getByRole('button', { name: dayPattern(date) })
  for (let i = 0; i < 14 && (await cell.count()) === 0; i++) {
    await picker.getByRole('button', { name: 'Go to the Next Month' }).click()
  }
  await cell.click()
  await expect(picker).toBeHidden()
}

const ZONES: Array<{ browser: string; pref: string }> = [
  { browser: 'Asia/Taipei', pref: 'America/New_York' },
  { browser: 'America/Los_Angeles', pref: 'Pacific/Auckland' },
  { browser: 'Pacific/Auckland', pref: 'America/Los_Angeles' },
  { browser: 'UTC', pref: 'Asia/Taipei' },
]

for (const zone of ZONES) {
  test.describe(`browser ${zone.browser}, preference ${zone.pref}`, () => {
    test.use({ timezoneId: zone.browser })

    test('Gantt drag/resize, List picker and Task Modal store exactly the chosen day', async ({
      page,
    }) => {
      const seed = withPrefs(
        seedWorkspace({
          tasks: [
            { key: 'a', title: 'Alpha', start: '2026-11-10', due: '2026-11-12' },
            { key: 'b', title: 'Bravo', start: '2026-11-20', due: '2026-11-21' },
          ],
        }),
        zone.pref,
      )
      await openGantt(page, seed, 'day', '2026-11-04T12:00:00Z')
      const a = seed.ids.a

      // The bar sits on its day columns, whatever the zone.
      const box = await boxOf(bar(page, a))
      expect(box.x).toBeCloseTo(await dayX(page, '2026-11-10'), 0)
      expect(box.width).toBeCloseTo(3 * 36, 0)

      await moveBar(page, a, 3)
      await expect.poll(() => stored(page, a)).toEqual({ start: '2026-11-13', due: '2026-11-15' })
      await resizeBar(page, a, 'end', 2)
      await expect.poll(() => stored(page, a)).toEqual({ start: '2026-11-13', due: '2026-11-17' })
      await resizeBar(page, a, 'start', -1)
      await expect.poll(() => stored(page, a)).toEqual({ start: '2026-11-12', due: '2026-11-17' })
      const moved = await boxOf(bar(page, a))
      expect(moved.x).toBeCloseTo(await dayX(page, '2026-11-12'), 0)
      expect(moved.width).toBeCloseTo(6 * 36, 0)
      await expect(chart(page)).toBeVisible()

      // List: pick a due date in the row's picker.
      await page.goto(`/projects/${seed.projectId}/list`)
      const row = page.locator(`[data-task-row="${seed.ids.b}"]`)
      await expect(row).toBeVisible()
      await pickDate(page, row, 'Due date', '2026-12-31')
      await expect
        .poll(() => stored(page, seed.ids.b))
        .toEqual({
          start: '2026-11-20',
          due: '2026-12-31',
        })

      // Task Modal.
      await page.goto(`/projects/${seed.projectId}/list`)
      await page.locator(`[data-task-row="${seed.ids.a}"]`).getByText('Alpha').click()
      const modal = page.getByRole('dialog', { name: 'Edit task: Alpha' })
      await expect(modal).toBeVisible()
      // The range only widens, so each pick is valid on its own (and saved on its own).
      await pickDate(page, modal, 'Start date', '2026-11-01')
      await pickDate(page, modal, 'Due date', '2027-01-01')
      await modal.getByRole('button', { name: 'Done', exact: true }).click()
      await expect(modal).toBeHidden()
      await expect
        .poll(() => stored(page, seed.ids.a))
        .toEqual({
          start: '2026-11-01',
          due: '2027-01-01',
        })

      // Board shows the same days.
      await page.goto(`/projects/${seed.projectId}/board`)
      await expect(page.getByText('Jan 1').first()).toBeVisible()
      await expect(page.getByText('Dec 31').first()).toBeVisible()
    })
  })
}

test.describe('DST and calendar edges', () => {
  test.use({ timezoneId: 'America/New_York' })

  const cases = [
    {
      name: 'spring forward 2026-03-08',
      now: '2026-03-04T17:00:00Z',
      start: '2026-03-06',
      due: '2026-03-10',
      mv: ['2026-03-09', '2026-03-13'],
    },
    {
      name: 'fall back 2026-11-01',
      now: '2026-10-29T16:00:00Z',
      start: '2026-10-30',
      due: '2026-11-03',
      mv: ['2026-11-02', '2026-11-06'],
    },
    {
      name: 'leap day 2028',
      now: '2028-02-25T17:00:00Z',
      start: '2028-02-27',
      due: '2028-02-28',
      mv: ['2028-03-01', '2028-03-02'],
    },
    {
      name: 'onto leap day 2028',
      now: '2028-02-23T17:00:00Z',
      start: '2028-02-26',
      due: '2028-02-26',
      mv: ['2028-02-29', '2028-02-29'],
    },
    {
      name: 'month end 2026-01-31 into February',
      now: '2026-01-27T17:00:00Z',
      start: '2026-01-30',
      due: '2026-01-31',
      mv: ['2026-02-02', '2026-02-03'],
    },
    {
      name: 'year end',
      now: '2026-12-28T17:00:00Z',
      start: '2026-12-30',
      due: '2026-12-31',
      mv: ['2027-01-02', '2027-01-03'],
    },
  ]
  for (const c of cases) {
    test(`${c.name}: bars keep whole-day width and a 3-day move lands on the right days`, async ({
      page,
    }) => {
      const seed = withPrefs(
        seedWorkspace({ tasks: [{ key: 'a', title: 'Edge', start: c.start, due: c.due }] }),
        'America/New_York',
      )
      await openGantt(page, seed, 'day', c.now)
      const days = (Date.parse(c.due) - Date.parse(c.start)) / 86_400_000 + 1
      const box = await boxOf(bar(page, seed.ids.a))
      expect(box.x).toBeCloseTo(await dayX(page, c.start), 0)
      expect(box.width).toBeCloseTo(days * 36, 0)
      await moveBar(page, seed.ids.a, 3)
      await expect.poll(() => stored(page, seed.ids.a)).toEqual({ start: c.mv[0], due: c.mv[1] })
      const after = await boxOf(bar(page, seed.ids.a))
      expect(after.x).toBeCloseTo(await dayX(page, c.mv[0]), 0)
      expect(after.width).toBeCloseTo(days * 36, 0)
    })
  }
})

test.describe('Today / Overdue / Upcoming follow the preference across midnight', () => {
  const runs = [
    { browser: 'America/Los_Angeles', pref: 'Pacific/Auckland', at: '2026-11-04T10:59:00Z' },
    { browser: 'Pacific/Auckland', pref: 'UTC', at: '2026-11-04T23:59:00Z' },
    { browser: 'Asia/Taipei', pref: 'America/New_York', at: '2026-11-05T04:59:00Z' },
  ]
  for (const r of runs) {
    test(`browser ${r.browser}, preference ${r.pref}: the open app flips at the preference's midnight`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ timezoneId: r.browser, locale: 'en-US' })
      const page = await context.newPage()
      const seed = withPrefs(
        seedWorkspace({
          tasks: [
            { key: 'o', title: 'Over', due: '2026-11-03' },
            { key: 't', title: 'Tod', due: '2026-11-04' },
            { key: 'u', title: 'Up', due: '2026-11-05' },
            { key: 'w', title: 'Wk', due: '2026-11-11' },
            { key: 'x', title: 'Far', due: '2026-11-12' },
          ],
        }),
        r.pref,
      )
      // pref-local date at r.at is Nov 4 (23:59 or similar); 2 minutes later it is Nov 5.
      await page.clock.install({ time: new Date(r.at) })
      await page.addInitScript(({ key, db }) => localStorage.setItem(key, JSON.stringify(db)), {
        key: LOCAL_WORKSPACE_KEY,
        db: seed.db,
      })
      await page.goto('/my-tasks/today')
      const tab = (name: string) =>
        page.getByRole('main').getByRole('link', { name: new RegExp(`^${name} ,`) })
      await expect(tab('Today')).toHaveAccessibleName(/, 1 task$/)
      await expect(tab('Upcoming')).toHaveAccessibleName(/, 2 tasks$/)
      await expect(tab('Overdue')).toHaveAccessibleName(/, 1 task$/)
      await expect(page.getByText('Tod', { exact: true })).toBeVisible()

      await page.clock.runFor(120_000)
      await expect(tab('Today')).toHaveAccessibleName(/, 1 task$/)
      await expect(page.getByText('Up', { exact: true })).toBeVisible()
      await expect(page.getByText('Tod', { exact: true })).toBeHidden()
      await expect(tab('Upcoming')).toHaveAccessibleName(/, 2 tasks$/)
      await expect(tab('Overdue')).toHaveAccessibleName(/, 2 tasks$/)
      await context.close()
    })
  }
})

test.describe('Overview, badge, Gantt and Timeline roll over at the preference midnight while open', () => {
  test('browser Pacific/Auckland, preference America/Los_Angeles', async ({ browser }) => {
    // 2026-11-05T07:59Z = Nov 4 23:59 in Los Angeles (PST, UTC-8) but Nov 5 20:59 in Auckland.
    const context = await browser.newContext({
      timezoneId: 'Pacific/Auckland',
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
    })
    const page = await context.newPage()
    const seed = withPrefs(
      seedWorkspace({
        tasks: [
          { key: 'o', title: 'Over', due: '2026-11-03' },
          { key: 't', title: 'Tod', due: '2026-11-04' },
          { key: 'u', title: 'Up', due: '2026-11-05' },
          { key: 'w', title: 'Wk', due: '2026-11-11' },
          { key: 'x', title: 'Far', due: '2026-11-12' },
        ],
      }),
      'America/Los_Angeles',
    )
    await page.clock.install({ time: new Date('2026-11-05T07:59:00Z') })
    await page.addInitScript(
      ({ key, db, scalesKey, scales }) => {
        localStorage.setItem(key, JSON.stringify(db))
        localStorage.setItem(scalesKey, JSON.stringify(scales))
      },
      {
        key: LOCAL_WORKSPACE_KEY,
        db: seed.db,
        scalesKey: 'cairn:gantt-scales',
        scales: { [seed.projectId]: 'day' },
      },
    )
    const metric = (name: string) => page.locator(`[data-metric="${name}"] dd`)
    const badge = page.locator('a[href="/my-tasks"]')
    await page.goto('/overview')
    await expect(metric('overdue')).toHaveText('1')
    await expect(metric('soon')).toHaveText('3')
    await expect(badge).toHaveAccessibleName(/2 due today or overdue \(1 overdue\)/)
    await page.clock.runFor(120_000)
    await expect(metric('overdue')).toHaveText('2')
    await expect(metric('soon')).toHaveText('3')
    await expect(badge).toHaveAccessibleName(/3 due today or overdue \(2 overdue\)/)

    // Gantt: the today column sits on the day of the preference, and moves when midnight passes.
    const fresh = await context.newPage()
    await fresh.clock.install({ time: new Date('2026-11-05T07:59:00Z') })
    await fresh.goto(`/projects/${seed.projectId}/gantt`)
    await expect(chart(fresh)).toBeVisible()
    const line = fresh.getByTestId('gantt-today-line')
    const centre = async () => {
      const box = await boxOf(line)
      return box.x + box.width / 2
    }
    await expect(line).toHaveCount(1)
    expect(await centre()).toBeCloseTo((await dayX(fresh, '2026-11-04')) + 18, 0)
    await fresh.clock.runFor(120_000)
    await expect
      .poll(async () => await centre())
      .toBeCloseTo((await dayX(fresh, '2026-11-05')) + 18, 0)

    // Cross-project Timeline: the today column advances by exactly one day column.
    await fresh.goto('/timeline')
    const tl = fresh.locator('[data-today-column]')
    await expect(tl).toHaveCount(1)
    const w = (await boxOf(tl)).width
    await fresh.clock.fastForward(60 * 60 * 1000) // 2 minutes past midnight + 1 h: still Nov 5 in LA
    const x1 = (await boxOf(tl)).x
    await fresh.clock.fastForward(24 * 60 * 60 * 1000)
    await expect(tl).toHaveCount(1)
    await expect.poll(async () => (await boxOf(tl)).x).toBeCloseTo(x1 + w, 0)
    await context.close()
  })
})

test.describe('Date picker: quick picks, week start and keyboard entry follow the preference', () => {
  test.use({ timezoneId: 'Asia/Taipei' })
  // 12:00Z = Nov 4 20:00 in Taipei but Nov 5 01:00 (Thu) in Auckland: the preference wins.
  const NOW_UTC = '2026-11-04T12:00:00Z'

  for (const weekStartsOn of [1, 0] as const) {
    test(`weekStartsOn ${weekStartsOn}: Today / Tomorrow / Next week and the calendar header`, async ({
      page,
    }) => {
      const seed = withPrefs(
        seedWorkspace({ tasks: [{ key: 'c', title: 'Charlie' }] }),
        'Pacific/Auckland',
        weekStartsOn,
      )
      await page.clock.setFixedTime(NOW_UTC)
      await page.addInitScript(({ key, db }) => localStorage.setItem(key, JSON.stringify(db)), {
        key: LOCAL_WORKSPACE_KEY,
        db: seed.db,
      })
      await page.goto(`/projects/${seed.projectId}/list`)
      const row = page.locator(`[data-task-row="${seed.ids.c}"]`)
      const open = async () => {
        await row
          .getByRole('button', { name: /^Due date:/ })
          .first()
          .click()
        return page.getByRole('dialog', { name: 'Due date', exact: true })
      }
      let picker = await open()
      // November 2026 starts on a Sunday: the first cell of the grid is Mon Oct 26 or Sun Nov 1.
      await expect(picker.getByRole('gridcell').first().getByRole('button')).toHaveAccessibleName(
        weekStartsOn === 1 ? /^Monday, October 26th, 2026/ : /^Sunday, November 1st, 2026/,
      )
      await picker.getByRole('button', { name: /^Today [A-Z][a-z]{2} \d/ }).click()
      await expect.poll(() => stored(page, seed.ids.c)).toEqual({ start: null, due: '2026-11-05' })
      picker = await open()
      await picker.getByRole('button', { name: /^Tomorrow/ }).click()
      await expect.poll(() => stored(page, seed.ids.c)).toEqual({ start: null, due: '2026-11-06' })
      picker = await open()
      await picker.getByRole('button', { name: /^Next week/ }).click()
      await expect
        .poll(() => stored(page, seed.ids.c))
        .toEqual({ start: null, due: weekStartsOn === 1 ? '2026-11-09' : '2026-11-08' })
    })
  }

  test('keyboard: arrows and PageDown move the calendar focus, Enter stores that exact day', async ({
    page,
  }) => {
    const seed = withPrefs(
      seedWorkspace({
        tasks: [
          { key: 'c', title: 'Charlie' },
          { key: 'd', title: 'Delta', due: '2026-12-31' },
        ],
      }),
      'Pacific/Auckland',
    )
    await page.clock.setFixedTime(NOW_UTC)
    await page.addInitScript(({ key, db }) => localStorage.setItem(key, JSON.stringify(db)), {
      key: LOCAL_WORKSPACE_KEY,
      db: seed.db,
    })
    await page.goto(`/projects/${seed.projectId}/list`)
    const open = async (id: string) => {
      await page
        .locator(`[data-task-row="${id}"]`)
        .getByRole('button', { name: /^Due date:/ })
        .first()
        .click()
      return page.getByRole('dialog', { name: 'Due date', exact: true })
    }
    // No date yet: focus starts on the preference's today (Nov 5); +2 days, +1 week, +1 month.
    let picker = await open(seed.ids.c)
    await expect(picker.getByRole('button', { name: dayPattern('2026-11-05') })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('PageDown')
    await expect(picker.getByRole('button', { name: dayPattern('2026-12-14') })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(picker).toBeHidden()
    await expect.poll(() => stored(page, seed.ids.c)).toEqual({ start: null, due: '2026-12-14' })

    // From Dec 31: one ArrowRight crosses the year end, Enter stores Jan 1.
    picker = await open(seed.ids.d)
    await expect(picker.getByRole('button', { name: dayPattern('2026-12-31') })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(picker.getByRole('button', { name: dayPattern('2027-01-01') })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(() => stored(page, seed.ids.d)).toEqual({ start: null, due: '2027-01-01' })
  })
})

test.describe('Backup: export in one time zone, import in another', () => {
  const DATES: Array<[string | null, string | null]> = [
    ['2026-03-08', '2026-03-09'], // US spring forward
    ['2026-11-01', '2026-11-02'], // US fall back
    ['2028-02-29', '2028-02-29'], // leap day, one-day task
    ['2026-12-31', '2027-01-01'], // year end
    [null, '2026-11-04'],
    ['2026-11-30', null],
  ]
  const datesOf = (db: {
    tasks?: Record<string, { title: string; startDate: string | null; dueDate: string | null }>
  }) =>
    Object.values(db.tasks ?? {})
      .map((t) => `${t.title}|${t.startDate}|${t.dueDate}`)
      .sort()

  test('dates survive Auckland -> Los Angeles unchanged; invalid dates are refused', async ({
    browser,
    baseURL,
  }) => {
    const seed = withPrefs(
      seedWorkspace({
        tasks: DATES.map(([start, due], i) => ({
          key: `t${i}`,
          title: `T${i}`,
          ...(start ? { start } : {}),
          ...(due ? { due } : {}),
        })),
      }),
      'Pacific/Auckland',
    )
    const source = await browser.newContext({
      baseURL,
      timezoneId: 'Pacific/Auckland',
      locale: 'en-US',
    })
    const sp = await source.newPage()
    await sp.clock.setFixedTime('2026-11-04T11:00:00Z')
    await sp.addInitScript(({ key, db }) => localStorage.setItem(key, JSON.stringify(db)), {
      key: LOCAL_WORKSPACE_KEY,
      db: seed.db,
    })
    await sp.goto('/settings/data')
    const [download] = await Promise.all([
      sp.waitForEvent('download'),
      sp.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    const text = readFileSync(await download.path(), 'utf8')
    const [csvDownload] = await Promise.all([
      sp.waitForEvent('download'),
      sp.getByRole('button', { name: 'Export tasks CSV' }).click(),
    ])
    const csv = readFileSync(await csvDownload.path(), 'utf8')
    for (const [start, due] of DATES) {
      for (const d of [start, due]) if (d) expect(csv, `CSV has ${d}`).toContain(d)
    }
    const expected = datesOf(
      await sp.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), LOCAL_WORKSPACE_KEY),
    )
    expect(expected).toHaveLength(DATES.length)
    for (const row of expected)
      expect(text).toContain(row.split('|')[1] === 'null' ? row.split('|')[2] : row.split('|')[1])
    await source.close()

    const target = await browser.newContext({
      baseURL,
      timezoneId: 'America/Los_Angeles',
      locale: 'en-US',
    })
    const tp = await target.newPage()
    await tp.clock.setFixedTime('2026-11-04T11:00:00Z')
    await tp.goto('/settings/data')
    const importFile = (name: string, content: string) =>
      tp
        .getByLabel('Backup file')
        .setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(content) })
    const read = () => tp.evaluate((k) => localStorage.getItem(k), LOCAL_WORKSPACE_KEY)

    // Invalid dates are refused with a reason and nothing is stored.
    const before = await read()
    const bad: Array<[string, (d: { data: { tasks: Array<Record<string, unknown>> } }) => void]> = [
      [
        'an impossible day',
        (d) => {
          d.data.tasks[0].dueDate = '2026-02-30'
        },
      ],
      [
        'month 13',
        (d) => {
          d.data.tasks[0].startDate = '2026-13-01'
        },
      ],
      [
        'a timestamp instead of a day',
        (d) => {
          d.data.tasks[0].dueDate = '2026-11-04T00:00:00Z'
        },
      ],
      [
        'a non-leap Feb 29',
        (d) => {
          d.data.tasks[0].dueDate = '2027-02-29'
        },
      ],
    ]
    for (const [name, change] of bad) {
      const copy = JSON.parse(text)
      change(copy)
      await importFileAndExpectRefused(tp, importFile, name, JSON.stringify(copy))
      expect(await read(), `${name}: nothing stored`).toBe(before)
    }

    await importFile('good.json', text)
    const dialog = tp.getByRole('dialog', { name: 'Import backup' })
    await dialog.getByRole('button', { name: 'Import as new copies' }).click()
    await expect(dialog).toBeHidden()
    const imported = datesOf(
      await tp.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), LOCAL_WORKSPACE_KEY),
    )
    expect(imported).toEqual(expected)
    await target.close()
  })
})

async function importFileAndExpectRefused(
  page: Page,
  importFile: (name: string, content: string) => Promise<void>,
  name: string,
  content: string,
): Promise<void> {
  await importFile('broken.json', content)
  const alert = page.getByRole('alert').filter({ hasText: /Couldn.t import/ })
  await expect(alert, name).toBeVisible()
  await expect(page.getByRole('dialog'), name).toHaveCount(0)
  await alert.getByRole('button', { name: /Dismiss|Close/ }).click()
  await expect(alert, name).toHaveCount(0)
}

test.describe('Board and List due labels roll over at the preference midnight', () => {
  test('browser Asia/Taipei, preference America/Los_Angeles', async ({ browser }) => {
    // 2026-11-05T07:59Z = Nov 4 23:59 in Los Angeles, already Nov 5 15:59 in Taipei.
    const context = await browser.newContext({
      timezoneId: 'Asia/Taipei',
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
    })
    const page = await context.newPage()
    const seed = withPrefs(
      seedWorkspace({
        tasks: [
          { key: 't', title: 'Tod', due: '2026-11-04' },
          { key: 'u', title: 'Up', due: '2026-11-05' },
        ],
      }),
      'America/Los_Angeles',
    )
    await page.clock.install({ time: new Date('2026-11-05T07:59:00Z') })
    await page.addInitScript(({ key, db }) => localStorage.setItem(key, JSON.stringify(db)), {
      key: LOCAL_WORKSPACE_KEY,
      db: seed.db,
    })
    // Board cards (DueLabel).
    await page.goto(`/projects/${seed.projectId}/board`)
    await expect(page.locator('[data-bucket="today"]')).toHaveCount(1)
    await expect(page.locator('[data-bucket="today"]')).toHaveText('Today')
    await expect(page.locator('[data-bucket="overdue"]')).toHaveCount(0)
    await page.clock.runFor(120_000)
    await expect(page.locator('[data-bucket="overdue"]')).toContainText('Yesterday')
    await expect(page.locator('[data-bucket="overdue"]')).toHaveCount(1)
    await expect(page.locator('[data-bucket="today"]')).toHaveText('Today')

    // List rows (date chips) on a fresh page at the same instant.
    const fresh = await context.newPage()
    await fresh.clock.install({ time: new Date('2026-11-05T07:59:00Z') })
    await fresh.goto(`/projects/${seed.projectId}/list`)
    const chip = (name: string) => fresh.getByRole('button', { name })
    await expect(chip('Due date: Wednesday, November 4, 2026')).toHaveText('Today')
    await expect(chip('Due date: Thursday, November 5, 2026')).toHaveText('Tomorrow')
    await fresh.clock.runFor(120_000)
    await expect(chip('Due date: Wednesday, November 4, 2026')).toHaveText('Yesterday')
    await expect(chip('Due date: Thursday, November 5, 2026')).toHaveText('Today')
    await context.close()
  })
})

test.describe('Week start: Gantt, Timeline and Overview headers follow the preference', () => {
  test.use({ timezoneId: 'Asia/Taipei' })
  const NOW_TAIPEI = '2026-11-04T10:00:00+08:00'

  /** Weekday (0 = Sunday) of every "Week of <date>" header cell in `scope`, plus their titles. */
  async function weekHeaders(scope: ReturnType<Page['locator']>) {
    await expect(scope.locator('[title^="Week of "]').first()).toBeVisible()
    return scope.locator('[title^="Week of "]').evaluateAll((cells) =>
      cells.map((cell) => {
        const title = cell.getAttribute('title') ?? ''
        const date = new Date(`${title.slice('Week of '.length)} UTC`)
        return { title, weekday: date.getUTCDay() }
      }),
    )
  }

  /** Titles of the Month-scale header cells ("November 2026", "2026"). */
  async function monthHeaders(scope: ReturnType<Page['locator']>) {
    await expect(scope.locator('[title="November 2026"]').first()).toBeVisible()
    return scope
      .locator('[title]')
      .evaluateAll((cells) =>
        cells
          .map((cell) => cell.getAttribute('title') ?? '')
          .filter((title) => /^([A-Z][a-z]+ )?\d{4}$/.test(title)),
      )
  }

  for (const weekStartsOn of [1, 0] as const) {
    const first = weekStartsOn === 1 ? 'Nov 2, 2026' : 'Nov 1, 2026'
    const other = weekStartsOn === 1 ? 'Nov 1, 2026' : 'Nov 2, 2026'

    test(`weekStartsOn ${weekStartsOn}: Gantt and Timeline week headers, Overview window`, async ({
      page,
    }) => {
      const seed = withPrefs(
        seedWorkspace({
          tasks: [{ key: 'a', title: 'Alpha', start: '2026-11-05', due: '2026-11-09' }],
        }),
        'Asia/Taipei',
        weekStartsOn,
      )
      await page.clock.setFixedTime(NOW_TAIPEI)
      await page.addInitScript(
        ({ key, db, scalesKey, scales }) => {
          localStorage.setItem(key, JSON.stringify(db))
          localStorage.setItem(scalesKey, JSON.stringify(scales))
        },
        {
          key: LOCAL_WORKSPACE_KEY,
          db: seed.db,
          scalesKey: 'cairn:gantt-scales',
          scales: { [seed.projectId]: 'week' },
        },
      )

      // (1) Gantt Week scale.
      await page.goto(`/projects/${seed.projectId}/gantt`)
      await expect(chart(page)).toBeVisible()
      const gantt = await weekHeaders(chart(page))
      expect(gantt.length).toBeGreaterThan(3)
      expect(gantt.every((cell) => cell.weekday === weekStartsOn)).toBe(true)
      await expect(chart(page).locator(`[title="Week of ${first}"]`)).toHaveCount(1)
      await expect(chart(page).locator(`[title="Week of ${other}"]`)).toHaveCount(0)

      // (3) Cross-project Timeline Week scale (its stored scale is Week by default).
      await page.goto('/timeline')
      const timeline = page.getByRole('region', { name: 'Timeline of all projects' })
      await expect(timeline.first()).toBeVisible()
      const tl = await weekHeaders(page.locator('main'))
      expect(tl.length).toBeGreaterThan(3)
      expect(tl.every((cell) => cell.weekday === weekStartsOn)).toBe(true)
      await expect(page.locator(`main [title="Week of ${first}"]`)).toHaveCount(1)
      await expect(page.locator(`main [title="Week of ${other}"]`)).toHaveCount(0)

      // (4) Overview "Next 6 weeks": the window starts on the week's first day.
      await page.goto('/overview')
      const mini = page.locator('section', {
        has: page.getByRole('heading', { name: 'Next 6 weeks' }),
      })
      await expect(
        mini.getByText(weekStartsOn === 1 ? 'Nov 2 – Dec 13' : 'Nov 1 – Dec 12'),
      ).toBeVisible()
    })
  }

  test('Month headers do not depend on the preference', async ({ browser }) => {
    const titles: string[][] = []
    for (const weekStartsOn of [1, 0] as const) {
      const context = await browser.newContext({
        timezoneId: 'Asia/Taipei',
        locale: 'en-US',
        viewport: { width: 1440, height: 900 },
      })
      const page = await context.newPage()
      const seed = withPrefs(
        seedWorkspace({
          tasks: [{ key: 'a', title: 'Alpha', start: '2026-11-05', due: '2026-11-09' }],
        }),
        'Asia/Taipei',
        weekStartsOn,
      )
      await openGantt(page, seed, 'month', NOW_TAIPEI)
      titles.push(await monthHeaders(chart(page)))
      await context.close()
    }
    expect(titles[0].length).toBeGreaterThan(3)
    expect(titles[1]).toEqual(titles[0])
  })

  test('changing "Week starts on" moves no bar and changes no stored date', async ({ page }) => {
    const seed = withPrefs(
      seedWorkspace({
        tasks: [{ key: 'a', title: 'Alpha', start: '2026-11-05', due: '2026-11-09' }],
      }),
      'Asia/Taipei',
      1,
    )
    await openGantt(page, seed, 'week', NOW_TAIPEI)
    const offset = async () => {
      const b = await boxOf(bar(page, seed.ids.a))
      const line = await boxOf(chart(page).getByTestId('gantt-today-line'))
      return { gap: b.x - (line.x + line.width / 2), width: b.width }
    }
    const before = await offset()
    expect(before.width).toBeCloseTo(5 * 16, 0) // Nov 5 - Nov 9 inclusive, 16 px a day
    expect(await stored(page, seed.ids.a)).toEqual({ start: '2026-11-05', due: '2026-11-09' })

    await page.goto('/settings/appearance')
    await page
      .getByRole('radiogroup', { name: 'Week starts on' })
      .getByRole('radio', { name: 'Sunday' })
      .click()
    await expect
      .poll(() =>
        page.evaluate(
          (key) =>
            (
              JSON.parse(localStorage.getItem(key) ?? '{}') as {
                preferences?: { weekStartsOn?: number }
              }
            ).preferences?.weekStartsOn,
          LOCAL_WORKSPACE_KEY,
        ),
      )
      .toBe(0)

    await page.goto(`/projects/${seed.projectId}/gantt`)
    await expect(chart(page)).toBeVisible()
    await expect(chart(page).locator('[title="Week of Nov 1, 2026"]')).toHaveCount(1)
    const after = await offset()
    expect(after.gap).toBeCloseTo(before.gap, 0)
    expect(after.width).toBeCloseTo(before.width, 0)
    expect(await stored(page, seed.ids.a)).toEqual({ start: '2026-11-05', due: '2026-11-09' })

    await page.reload()
    await expect(chart(page)).toBeVisible()
    await expect(chart(page).locator('[title="Week of Nov 1, 2026"]')).toHaveCount(1)
    const reloaded = await offset()
    expect(reloaded.gap).toBeCloseTo(before.gap, 0)
    expect(await stored(page, seed.ids.a)).toEqual({ start: '2026-11-05', due: '2026-11-09' })
  })
})
