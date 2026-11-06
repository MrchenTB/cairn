/// <reference lib="dom" />
/** Shared by e2e/security.spec.ts and e2e-prod/production.spec.ts. */
import { expect, type Page } from '@playwright/test'

export const XSS = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>"'><svg onload=window.__xss=3>`
export const FORMULA = `=HYPERLINK("http://evil.example","x")`
export const WORKSPACE_KEY = 'cairn:local:workspace:v1'

const NOW = '2026-11-03T08:00:00.000Z'

/** Project p1 with the payload in every field a user can type. */
export function hostileWorkspace() {
  const task = (id: string, title: string, sortOrder: string, extra = {}) => ({
    id,
    projectId: 'p1',
    phaseId: null,
    parentTaskId: null,
    title,
    description: null,
    status: 'todo',
    priority: 'none',
    startDate: null,
    dueDate: null,
    sortOrder,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  })
  return {
    version: 1,
    projects: {
      p1: {
        id: 'p1',
        name: `Project ${XSS}`,
        description: `Desc ${XSS}`,
        status: 'active',
        color: 'violet',
        startDate: '2040-01-01',
        dueDate: '2040-03-01',
        scheduleMode: 'manual',
        sortOrder: 'a0',
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    phases: {
      ph1: {
        id: 'ph1',
        projectId: 'p1',
        name: `Phase ${XSS}`,
        sortOrder: 'a0',
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    tasks: {
      t1: task('t1', `Task ${XSS}`, 'a0', {
        description: `Task body ${XSS}\n[link](javascript:alert(1)) https://evil.example`,
        startDate: '2040-01-05',
        dueDate: '2040-01-10',
      }),
      t2: task('t2', FORMULA, 'a1', {
        phaseId: 'ph1',
        startDate: '2040-01-11',
        dueDate: '2040-01-12',
      }),
      t3: task('t3', 'Plain task', 'a2', { status: 'in_progress', dueDate: '2040-02-01' }),
      t4: task('t4', `Sub ${XSS}`, 'a0', { parentTaskId: 't1' }),
    },
    milestones: {
      m1: {
        id: 'm1',
        projectId: 'p1',
        phaseId: null,
        name: `Milestone ${XSS}`,
        date: '2040-01-20',
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    dependencies: {},
    preferences: null,
  }
}

/** Opens `path` in a browser that holds `hostileWorkspace()` (seeded once per tab). */
export async function openSeeded(page: Page, path: string) {
  await page.addInitScript(
    ({ key, workspace }) => {
      if (sessionStorage.getItem('e2e-seeded')) return
      localStorage.setItem(key, JSON.stringify(workspace))
      sessionStorage.setItem('e2e-seeded', '1')
    },
    { key: WORKSPACE_KEY, workspace: hostileWorkspace() },
  )
  await page.goto(path)
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
  await expect(page.getByRole('main').locator('[aria-busy="true"]')).toHaveCount(0)
}

/** Nothing from the payload became markup, and no handler ran. */
export async function expectNoInjection(page: Page, where: string) {
  const state = await page.evaluate(() => ({
    xss: (window as unknown as { __xss?: unknown }).__xss ?? null,
    images: document.querySelectorAll('img[src="x"], img[onerror]').length,
    handlers: document.querySelectorAll('[onerror], [onload], [onclick], [onmouseover]').length,
    scripts: [...document.scripts].filter((s) => s.textContent?.includes('__xss')).length,
    jsLinks: [...document.querySelectorAll('a')].filter((a) => /^\s*javascript:/i.test(a.href))
      .length,
  }))
  expect(state, where).toEqual({ xss: null, images: 0, handlers: 0, scripts: 0, jsLinks: 0 })
}
