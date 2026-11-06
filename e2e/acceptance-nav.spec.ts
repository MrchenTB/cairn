/// <reference lib="dom" />
/**
 * Navigation, keyboard and accessibility acceptance (qa2 nav-a11y): history around the Task
 * Modal, deep URLs with bad ids, console cleanliness, the ? dialog, focus handling, zoom/width.
 * LOCAL data mode; "today" is pinned (Wed 4 Nov 2026).
 */
import { expect, test as base, type Page } from '@playwright/test'
import { seedWorkspace, LOCAL_WORKSPACE_KEY, NOW } from './acceptance-gantt.helpers.ts'

/** Every test fails on any console error OR warning, or an uncaught exception. */
const test = base.extend<{ consoleNoise: string[] }>({
  consoleNoise: [
    async ({ page }, use) => {
      const noise: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
          noise.push(`${message.type()}: ${message.text()}`)
        }
      })
      page.on('pageerror', (error) => noise.push(`pageerror: ${error.message}`))
      await use(noise)
      expect(noise, 'console errors / warnings / uncaught exceptions').toEqual([])
    },
    { auto: true },
  ],
})

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'Asia/Taipei' })

const seed = seedWorkspace({
  tasks: [
    { key: 'a', title: 'Alpha task', start: '2026-11-02', due: '2026-11-06' },
    { key: 'b', title: 'Beta task', start: '2026-11-05', due: '2026-11-10' },
    { key: 'c', title: 'Gamma sub', parent: 'a', start: '2026-11-03', due: '2026-11-04' },
  ],
  milestones: [{ key: 'm', name: 'Launch day', date: '2026-11-12' }],
})

async function boot(page: Page, route: string, db: unknown = seed.db): Promise<void> {
  await page.clock.setFixedTime(NOW)
  await page.addInitScript(
    ({ key, db }) => {
      try {
        if (sessionStorage.getItem('cairn-e2e-nav-seeded')) return
        localStorage.setItem(key, JSON.stringify(db))
        sessionStorage.setItem('cairn-e2e-nav-seeded', '1')
      } catch {
        // an opaque / error document has no storage: nothing to seed there
      }
    },
    { key: LOCAL_WORKSPACE_KEY, db },
  )
  await page.goto(route)
}
const here = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search

test.describe('history around the Task Modal', () => {
  test('closing a task leaves Back going to the page before it, Forward reopens it', async ({
    page,
  }) => {
    await boot(page, '/overview')
    await page.getByRole('link', { name: 'Projects', exact: true }).first().click()
    await expect(page).toHaveURL(/\/projects$/)
    await page.goto(`/projects/${seed.projectId}/list`)
    await page.getByText('Beta task', { exact: true }).first().click()
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`task=${seed.ids.b}`))
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
    expect(here(page)).toBe(`/projects/${seed.projectId}/list`)
    // The very first Back must leave the list (not stay on an identical entry).
    await page.goBack()
    await expect(page).not.toHaveURL(new RegExp(`/projects/${seed.projectId}/list`))
    await page.goForward()
    await expect(page).toHaveURL(new RegExp(`/projects/${seed.projectId}/list$`))
  })

  test('a subtask opened from its parent returns to the parent on close, and a second close leaves', async ({
    page,
  }) => {
    await boot(page, `/projects/${seed.projectId}/list`)
    await page.getByText('Alpha task', { exact: true }).first().click()
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await modal.getByText('Gamma sub', { exact: true }).first().click()
    await expect(page).toHaveURL(new RegExp(`task=${seed.ids.c}`))
    await expect(modal.getByRole('textbox', { name: 'Title' })).toHaveValue('Gamma sub')
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(new RegExp(`task=${seed.ids.a}`))
    await expect(modal.getByRole('textbox', { name: 'Title' })).toHaveValue('Alpha task')
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
    expect(here(page)).toBe(`/projects/${seed.projectId}/list`)
  })

  test('a subtask opened directly (a deep link) just closes', async ({ page }) => {
    await boot(page, `/projects/${seed.projectId}/list?task=${seed.ids.c}`)
    const modal = page.getByRole('dialog')
    await expect(modal.getByRole('textbox', { name: 'Title' })).toHaveValue('Gamma sub')
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
    expect(here(page)).toBe(`/projects/${seed.projectId}/list`)
  })

  test('a task opened from inside another task (a dependency chip) still closes in one step', async ({
    page,
  }) => {
    const linked = seedWorkspace({
      tasks: [
        { key: 'a', title: 'Alpha task', start: '2026-11-02', due: '2026-11-06' },
        { key: 'b', title: 'Beta task', start: '2026-11-07', due: '2026-11-10' },
      ],
      deps: [['a', 'b']],
    })
    await boot(page, `/projects/${linked.projectId}/list`, linked.db)
    await page.getByText('Alpha task', { exact: true }).first().click()
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await modal
      .getByRole('list', { name: 'Blocking' })
      .getByRole('button', { name: 'Beta task', exact: true })
      .click()
    await expect(page).toHaveURL(new RegExp(`task=${linked.ids.b}`))
    await expect(modal.getByRole('textbox', { name: 'Title' })).toHaveValue('Beta task')
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
    expect(here(page)).toBe(`/projects/${linked.projectId}/list`)
  })

  test('a deep link to a task closes in place and Back leaves the app page properly', async ({
    page,
  }) => {
    await boot(page, `/overview?task=${seed.ids.a}`)
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
    expect(here(page)).toBe('/overview')
  })
})

test.describe('URLs', () => {
  const urls: [string, RegExp, RegExp][] = [
    // [url, final path, text that must be on the page]
    ['/', /^\/overview$/, /Overview/],
    ['/my-tasks', /^\/my-tasks\/today$/, /My Tasks/],
    ['/my-tasks/bogus', /^\/my-tasks\/today$/, /My Tasks/],
    ['/settings', /^\/settings\/account$/, /Settings/],
    ['/settings/bogus', /^\/settings\/account$/, /Settings/],
    ['/settings/data', /^\/settings\/data$/, /Export/],
    ['/timeline', /^\/timeline$/, /Timeline/],
    ['/projects', /^\/projects$/, /Launch plan/],
    ['/projects/{P}', /^\/projects\/[^/]+\/(list|board|gantt)$/, /Launch plan/],
    ['/projects/{P}/bogus', /\/bogus$/, /not found|Not found|doesn.t exist/i],
    ['/projects/nope', /\/projects\/nope/, /not found|Not found|doesn.t exist|Couldn.t find/i],
    [
      '/projects/nope/gantt',
      /\/projects\/nope\/gantt/,
      /not found|Not found|doesn.t exist|Couldn.t find/i,
    ],
    [
      '/projects/nope/board',
      /\/projects\/nope\/board/,
      /not found|Not found|doesn.t exist|Couldn.t find/i,
    ],
    ['/nowhere/at/all', /\/nowhere\/at\/all/, /not found|Not found|doesn.t exist|Couldn.t find/i],
    [`/overview?task=missing`, /^\/overview$/, /Overview/],
    ['/projects/{P}/list?task=missing', /^\/projects\/[^/]+\/list$/, /Launch plan/],
    ['/projects/{P}/board?phase=bogus', /board/, /Launch plan/],
    ['/projects?status=bogus', /\/projects/, /Launch plan/],
    ['/my-tasks/all?completed=banana', /\/my-tasks\/all/, /My Tasks/],
  ]
  for (const [url, finalPath, text] of urls) {
    test(`${url} loads, never blank, survives a reload`, async ({ page }) => {
      await boot(page, url.replace('{P}', seed.projectId))
      await expect(page.locator('#main')).toContainText(text)
      await expect.poll(() => new URL(page.url()).pathname).toMatch(finalPath)
      const landed = here(page)
      await page.reload()
      await expect(page.locator('#main')).toContainText(text)
      expect(here(page)).toBe(landed)
      // Never a blank screen or a crash page.
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0)
    })
  }
})

const GLOBAL_HELP = [
  'Search|Ctrl K',
  'New task|C',
  'Toggle sidebar|[',
  'Keyboard shortcuts|?',
  'Close dialog or menu|Esc',
  'Focus notifications|Alt T',
  'Go to Overview|G then O',
  'Go to My Tasks|G then M',
  'Go to Projects|G then P',
  'Go to Timeline|G then T',
]
const modKey = (page: Page) =>
  page.evaluate(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
    const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent
    return /mac|iphone|ipad|ipod/i.test(platform) ? 'Meta' : 'Control'
  })

async function helpRows(page: Page): Promise<string[]> {
  await page.keyboard.press('?')
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(dialog).toBeVisible()
  const rows = (await dialog.locator('li').allInnerTexts()).map((t) =>
    t.replace(/\s*\n+\s*/g, '|').replace(/^(.*)\|(.*)$/s, '$1|$2'),
  )
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  return rows
}

test.describe('keyboard', () => {
  test.describe.configure({ timeout: 120_000 })

  test('the ? dialog lists exactly what each page offers, and each of those keys works', async ({
    page,
  }) => {
    const p = seed.projectId
    await boot(page, '/overview')
    await expect(page.getByRole('heading', { name: 'Overview' }).first()).toBeVisible()
    const mod = await modKey(page)
    // "Description|Ctrl|K" -> "Description|Ctrl K" (the keys are separate <kbd> elements).
    const normalise = (rows: string[]) =>
      rows.map((r) => {
        const [description, ...keys] = r.split('|')
        return `${description}|${keys.join(' ')}`.replace('Search|⌘ K', 'Search|Ctrl K')
      })

    expect(normalise(await helpRows(page))).toEqual(GLOBAL_HELP)

    // Shortcuts that other tests do not already drive.
    await page.goto('/my-tasks/today')
    await expect(page.getByRole('heading', { name: 'My Tasks' }).first()).toBeVisible()
    expect(normalise(await helpRows(page))).toEqual([...GLOBAL_HELP, 'New task due today|C'])
    await page.goto('/my-tasks/all')
    await expect(page.getByRole('heading', { name: 'My Tasks' }).first()).toBeVisible()
    expect(normalise(await helpRows(page))).toEqual(GLOBAL_HELP)

    await page.goto('/projects')
    await expect(page.getByRole('heading', { name: 'Projects' }).first()).toBeVisible()
    await expect(page.locator('#main').getByText('Launch plan').first()).toBeVisible()
    expect(normalise(await helpRows(page))).toEqual([...GLOBAL_HELP, 'Filter projects|/'])
    await page.keyboard.press('/')
    await expect(
      page
        .getByRole('searchbox')
        .or(page.getByPlaceholder(/filter/i))
        .first(),
    ).toBeFocused()
    await page.keyboard.type('c k [ ?')
    await expect(page).toHaveURL(/\/projects/)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.goto(`/projects/${p}/list`)
    await expect(page.getByText('Alpha task').first()).toBeVisible()
    const view = ['List view|1', 'Board view|2', 'Gantt view|3']
    expect(normalise(await helpRows(page))).toEqual([...GLOBAL_HELP, ...view])
    await page.goto(`/projects/${p}/gantt`)
    await expect(page.locator('[data-task-id]').first()).toBeVisible()
    expect(normalise(await helpRows(page))).toEqual([...GLOBAL_HELP, 'Scroll to today|T', ...view])
    await page.goto('/timeline')
    await expect(page.getByRole('heading', { name: 'Timeline' }).first()).toBeVisible()
    expect(normalise(await helpRows(page))).toEqual([...GLOBAL_HELP, 'Scroll to today|T'])
    await page.goto('/settings/data')
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    expect(normalise(await helpRows(page))).toEqual(GLOBAL_HELP)

    // C on Today: New task due today.
    await page.goto('/my-tasks/today')
    await expect(page.getByRole('heading', { name: 'My Tasks' }).first()).toBeVisible()
    await page.keyboard.press('c')
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await expect(modal.getByText('Today', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()

    // Alt+T moves focus into the notification stack (reach a toast's Retry/Undo by keyboard).
    await page.keyboard.press('c')
    await page.keyboard.type('Toast maker')
    await page.keyboard.press(`${mod}+Enter`)
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible()
    await page.keyboard.press('Alt+t')
    await expect
      .poll(() =>
        page.evaluate(
          () => !!document.activeElement?.closest('[data-sonner-toaster], [data-sonner-toast]'),
        ),
      )
      .toBe(true)
  })

  test('shortcuts never fire for modified keys, in fields, menus or over dialogs', async ({
    page,
  }) => {
    await boot(page, `/projects/${seed.projectId}/list`)
    await expect(page.getByText('Alpha task').first()).toBeVisible()
    const mod = await modKey(page)
    // Copy / select-all style combos are not "C" / "A".
    await page.keyboard.press(`${mod}+c`)
    await page.keyboard.press('Shift+c')
    await page.keyboard.press('Alt+c')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // A held C opens one New task dialog; the repeats are just typing in its title.
    await page.keyboard.down('c')
    for (let i = 0; i < 5; i++) await page.keyboard.down('c')
    await page.keyboard.up('c')
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue(/^c+$/)
    await page.keyboard.press('Escape')
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    // With a dialog open, page shortcuts stay quiet.
    await page.keyboard.press('?')
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(help).toBeVisible()
    await page.keyboard.press('g')
    await page.keyboard.press('t')
    await page.keyboard.press('c')
    await page.keyboard.press('2')
    await expect(page).toHaveURL(/\/list$/)
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // Typing in the search box.
    await page.keyboard.press(`${mod}+k`)
    await page.keyboard.type('g t 2 c [')
    await expect(page.getByRole('combobox')).toHaveValue('g t 2 c [')
    await expect(page).toHaveURL(/\/list$/)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // Pending "G" is dropped when the next key is not a target (and by a pause).
    await page.keyboard.press('g')
    await page.keyboard.press('x')
    await page.keyboard.press('o')
    await expect(page).toHaveURL(/\/list$/)
  })
})

/** Tab / Shift+Tab `presses` times; every stop must stay inside `container`. */
async function tabStaysInside(page: Page, container: string, presses: number): Promise<void> {
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press(key)
      const inside = await page.evaluate(
        (selector) => !!document.activeElement?.closest(selector),
        container,
      )
      expect(inside, `${key} #${i + 1} left ${container}`).toBe(true)
    }
  }
}

/** Esc closes the dialog; a tooltip showing on the focused control may take the first Esc. */
async function escapeCloses(page: Page, dialog: ReturnType<Page['locator']>): Promise<void> {
  await page.keyboard.press('Escape')
  if ((await dialog.count()) > 0) {
    await page.waitForTimeout(150)
    await page.keyboard.press('Escape')
  }
  await expect(dialog).toHaveCount(0)
}

test.describe('focus', () => {
  test.describe.configure({ timeout: 120_000 })

  test('Task Modal traps Tab, closes on Esc and gives focus back to the row it came from', async ({
    page,
  }) => {
    await boot(page, `/projects/${seed.projectId}/list`)
    const trigger = page.getByRole('button', { name: /^Beta task/ }).first()
    await trigger.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')))
      .toBe(true)
    await tabStaysInside(page, '[role=dialog]', 40)
    await escapeCloses(page, dialog)
    await expect(trigger).toBeFocused()
  })

  for (const [name, open, role] of [
    ['? dialog', (p: Page) => p.keyboard.press('?'), 'dialog'],
    ['search', (p: Page) => p.getByRole('button', { name: /^Search/ }).click(), 'dialog'],
    ['new project', (p: Page) => p.getByRole('button', { name: 'New project' }).click(), 'dialog'],
  ] as const) {
    test(`${name} traps Tab, Esc closes it and focus returns`, async ({ page }) => {
      await boot(page, `/projects/${seed.projectId}/list`)
      await expect(page.getByText('Alpha task').first()).toBeVisible()
      if (name === '? dialog')
        await page
          .locator('#main')
          .focus()
          .catch(() => undefined)
      await open(page)
      const dialog = page.getByRole(role)
      await expect(dialog).toBeVisible()
      await expect
        .poll(() => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')))
        .toBe(true)
      await tabStaysInside(page, '[role=dialog]', 25)
      await escapeCloses(page, dialog)
      if (name !== '? dialog') {
        await expect(
          page.getByRole('button', { name: name === 'search' ? /^Search/ : 'New project' }),
        ).toBeFocused()
      } else {
        // Focus must not be lost to a detached node: it is on the page, not on a removed element.
        expect(await page.evaluate(() => document.activeElement?.isConnected)).toBe(true)
      }
    })
  }

  for (const route of [
    '/overview',
    '/my-tasks/all',
    '/projects',
    '/timeline',
    '/settings/data',
    '/projects/{P}/list',
    '/projects/{P}/board',
    '/projects/{P}/gantt',
  ])
    test(`every stop on ${route} shows a visible focus indicator`, async ({ page }) => {
      await boot(page, route.replace('{P}', seed.projectId))
      await expect(page.locator('#main')).toContainText(/\w/)
      const bad: string[] = []
      for (let i = 0; i < 70; i++) {
        await page.keyboard.press('Tab')
        const info = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null
          if (!el || el === document.body) return null
          const cs = getComputedStyle(el)
          const rect = el.getBoundingClientRect()
          const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0
          const shadow = cs.boxShadow !== 'none'
          // Stretched row buttons draw their ring on ::after (the element itself has outline-none).
          const after = getComputedStyle(el, '::after')
          const afterRing = after.outlineStyle !== 'none' && parseFloat(after.outlineWidth) > 0
          // A ring drawn by a focused-within wrapper counts (inputs inside bordered boxes).
          const parent = el.closest('[class*="focus-within"]') as HTMLElement | null
          const wrapped = parent ? getComputedStyle(parent).boxShadow !== 'none' : false
          const skip = rect.width === 0 || rect.height === 0
          return {
            label: (el.getAttribute('aria-label') || el.innerText || el.tagName).slice(0, 40),
            visible: outline || shadow || wrapped || afterRing,
            skip,
          }
        })
        if (info && !info.skip && !info.visible) bad.push(info.label)
      }
      expect(bad, 'focused controls without outline / ring').toEqual([])
    })
})

test.describe('widths, zoom and reduced motion', () => {
  test.describe.configure({ timeout: 180_000 })
  // Browser zoom 200% on a 1280 window is a 640 px wide viewport; 67% is about 1910 px.
  const sizes = [
    { width: 640, height: 400, label: '200% zoom' },
    { width: 1024, height: 700, label: '1024 wide' },
    { width: 1728, height: 1000, label: '1728 wide' },
    { width: 1910, height: 1200, label: '67% zoom' },
  ]
  const routes = [
    '/overview',
    '/my-tasks/today',
    '/projects',
    '/projects/{P}/list',
    '/projects/{P}/board',
    '/projects/{P}/gantt',
    '/timeline',
    '/settings/account',
    '/settings/data',
  ]
  for (const size of sizes) {
    test(`${size.label}: no page-level horizontal scroll, header and content reachable`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      await boot(page, '/overview')
      for (const route of routes) {
        await page.goto(route.replace('{P}', seed.projectId))
        await expect(page.locator('#main')).toContainText(/\w/)
        const m = await page.evaluate(() => {
          const root = document.scrollingElement as HTMLElement
          const main = document.getElementById('main')!.getBoundingClientRect()
          return {
            overflow: root.scrollWidth - root.clientWidth,
            mainRight: main.right,
            mainWidth: main.width,
            vw: window.innerWidth,
          }
        })
        expect(m.overflow, `${route} page scrolls sideways at ${size.label}`).toBeLessThanOrEqual(0)
        expect(m.mainRight, `${route} main pushed past the viewport`).toBeLessThanOrEqual(m.vw + 1)
        expect(m.mainWidth, `${route} main is squeezed to nothing`).toBeGreaterThan(280)
        // The way back to the other pages is always on screen or one control away.
        const nav = page.getByRole('link', { name: /^Overview/ })
        const toggle = page.getByRole('button', { name: /sidebar/i })
        expect((await nav.isVisible()) || (await toggle.first().isVisible())).toBe(true)
      }
      await page.screenshot({ path: `test-results/pw-nav-a11y/zoom-${size.width}.png` })
    })
  }

  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })
    test('dialogs and menus open without a running animation or transition', async ({ page }) => {
      await boot(page, `/projects/${seed.projectId}/list`)
      await page.keyboard.press('?')
      const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
      await expect(dialog).toBeVisible()
      const motion = await page.evaluate(() => {
        const longest = (el: Element) => {
          const cs = getComputedStyle(el)
          const secs = (v: string) => Math.max(...v.split(',').map((x) => parseFloat(x) || 0))
          return Math.max(secs(cs.animationDuration), secs(cs.transitionDuration))
        }
        return [...document.querySelectorAll('[role=dialog], [data-state]')].map(longest)
      })
      expect(
        Math.max(0, ...motion),
        'longest animation/transition (s) under reduced motion',
      ).toBeLessThanOrEqual(0.02)
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    })
  })
})

test('Settings > Appearance controls act, and survive a reload', async ({ page }) => {
  await boot(page, '/settings/appearance')
  const theme = page.getByRole('radiogroup', { name: 'Theme' })
  await theme.getByRole('radio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await theme.getByRole('radio', { name: 'Light' }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await theme.getByRole('radio', { name: 'Dark' }).click()
  const week = page.getByRole('radiogroup', { name: 'Week starts on' })
  await week.getByRole('radio', { name: 'Sunday' }).click()
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(week.getByRole('radio', { name: 'Sunday' })).toBeChecked()
})

test('rapid navigation while a write is still pending keeps the write and never crashes', async ({
  page,
}) => {
  await boot(page, `/projects/${seed.projectId}/list`)
  await expect(page.getByText('Beta task').first()).toBeVisible()
  await page.evaluate(() => {
    ;(
      window as Window & { __cairnTest?: { setLatency(ms: number): void } }
    ).__cairnTest?.setLatency(800)
  })
  await page
    .getByRole('button', { name: /^Status: To Do/ })
    .nth(1)
    .click()
  await page.getByRole('menuitemradio', { name: 'Done' }).click()
  // Hammer navigation before the slow write can settle.
  const side = page.getByRole('navigation').first()
  for (const [name, url] of [
    [/^Overview/, /\/overview$/],
    [/^Timeline/, /\/timeline$/],
    [/^Projects/, /\/projects$/],
    [/^My Tasks/, /\/my-tasks\/today$/],
  ] as const) {
    await side.getByRole('link', { name }).click()
    await expect(page).toHaveURL(url)
  }
  await page.goBack()
  await expect(page).toHaveURL(/\/projects$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/timeline$/)
  await page.goForward()
  await expect(page).toHaveURL(/\/projects$/)
  await page.getByRole('link', { name: 'Launch plan' }).first().click()
  await page.getByRole('link', { name: 'Board', exact: true }).click()
  await expect(page).toHaveURL(/\/board$/)
  await page.getByRole('link', { name: 'Gantt', exact: true }).click()
  await expect(page).toHaveURL(/\/gantt$/)
  // The slow write settles in the background; only then do we reload and look at the result.
  await expect
    .poll(
      () =>
        page.evaluate(
          (key) => (localStorage.getItem(key) ?? '').includes('"status":"done"'),
          LOCAL_WORKSPACE_KEY,
        ),
      { timeout: 10_000 },
    )
    .toBe(true)
  await page.evaluate(() => {
    ;(
      window as Window & { __cairnTest?: { setLatency(ms: number): void } }
    ).__cairnTest?.setLatency(0)
  })
  await page.reload()
  await expect(page.getByText(/something went wrong/i)).toHaveCount(0)
  // One of Alpha / Beta / Gamma is Done now, nothing was lost or duplicated.
  const stored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '{}'),
    LOCAL_WORKSPACE_KEY,
  )
  const tasks = JSON.stringify(stored).match(/"status":"done"/g) ?? []
  expect(tasks.length).toBe(1)
  expect(JSON.stringify(stored).match(/Alpha task/g)?.length).toBe(1)
})
