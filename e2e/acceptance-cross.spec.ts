/// <reference lib="dom" />
/**
 * Cross-feature acceptance E2E — LOCAL data mode against the dev server (playwright.config.ts).
 *
 * PRD §9.1:
 *  AC-10  progress = done LEAF tasks / LEAF tasks (parents and milestones never count, "No tasks"
 *         when empty), and the Overview, the Projects list, the project header and the Timeline
 *         show the very same number;
 *  AC-11  My Tasks Today / Upcoming / Overdue / All follow the definitions and agree with the
 *         Overview; the search (⌘K and the button) finds projects, tasks (CJK, partial words) and
 *         milestones across projects, opens the right place and has empty / no-result states;
 *  AC-12  the Timeline: projects as rows, expanding into tasks and milestones, overlaps on one
 *         shared axis, Day / Week / Month and Today.
 *
 * One hand-countable workspace is used by all of them (see `seedProjects`). "Today" is pinned to
 * Wednesday, November 4, 2026 (Taipei), so every date in the data is stable.
 */
import { expect, test as base, type Download, type Locator, type Page } from '@playwright/test'

const LOCAL_WORKSPACE_KEY = 'cairn:local:workspace:v1'
/** The app's "today" in every test (Taipei, mid-morning). */
const NOW = '2026-11-04T10:00:00+08:00'
const TODAY = '2026-11-04'
const TIME_ZONE = 'Asia/Taipei'
const STAMP = '2026-11-03T08:00:00.000Z'
/** Pixels per day on the Timeline's scales and the width of its project pane. */
const DAY_PX = { day: 36, week: 16, month: 5 }
const PANE_PX = 300

/** Every test fails if the page logs a console error or throws. */
const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
      await use(errors)
      expect(errors, 'console errors / uncaught exceptions').toEqual([])
    },
    { auto: true },
  ],
})
test.use({ timezoneId: TIME_ZONE, locale: 'en-US', viewport: { width: 1440, height: 900 } })

// ---------------------------------------------------------------------------
// Seed: a local "database" written to localStorage before the app boots
// ---------------------------------------------------------------------------

type Status = 'todo' | 'in_progress' | 'done'
type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

interface SeedTask {
  id: string
  title: string
  /** Start / due date, in days from today. */
  start?: number
  due?: number
  status?: Status
  priority?: Priority
  description?: string
  /** Id of the parent task (a subtask). */
  parent?: string
}

interface SeedProject {
  id: string
  name: string
  description?: string
  status?: 'active' | 'completed' | 'archived'
  color?: string
  start?: number
  due?: number
  tasks?: SeedTask[]
  milestones?: { id: string; name: string; date: number }[]
}

/** The calendar date `offset` days from today (yyyy-mm-dd). */
function day(offset: number): string {
  const [year, month, date] = TODAY.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date + offset)).toISOString().slice(0, 10)
}

/** Valid fractional-index keys that sort by position: a0…a9, b00…b89, c000… */
function key(index: number): string {
  if (index < 10) return `a${index}`
  if (index < 100) return `b${String(index - 10).padStart(2, '0')}`
  return `c${String(index - 100).padStart(3, '0')}`
}

function buildWorkspace(projects: SeedProject[]): unknown {
  const db = {
    version: 1,
    projects: {} as Record<string, unknown>,
    phases: {},
    tasks: {} as Record<string, unknown>,
    milestones: {} as Record<string, unknown>,
    dependencies: {},
    preferences: { theme: 'light', sidebarCollapsed: false, timezone: TIME_ZONE, weekStartsOn: 1 },
  }
  projects.forEach((project, projectIndex) => {
    db.projects[project.id] = {
      id: project.id,
      name: project.name,
      description: project.description ?? null,
      status: project.status ?? 'active',
      color: project.color ?? 'violet',
      startDate: project.start === undefined ? null : day(project.start),
      dueDate: project.due === undefined ? null : day(project.due),
      scheduleMode: 'manual',
      sortOrder: key(projectIndex),
      createdAt: STAMP,
      updatedAt: STAMP,
    }
    project.tasks?.forEach((task, index) => {
      db.tasks[task.id] = {
        id: task.id,
        projectId: project.id,
        phaseId: null,
        parentTaskId: task.parent ?? null,
        title: task.title,
        description: task.description ?? null,
        status: task.status ?? 'todo',
        priority: task.priority ?? 'none',
        startDate: task.start === undefined ? null : day(task.start),
        dueDate: task.due === undefined ? null : day(task.due),
        sortOrder: key(index),
        completedAt: task.status === 'done' ? '2026-11-02T08:00:00.000Z' : null,
        createdAt: STAMP,
        updatedAt: STAMP,
      }
    })
    project.milestones?.forEach((milestone) => {
      db.milestones[milestone.id] = {
        id: milestone.id,
        projectId: project.id,
        phaseId: null,
        name: milestone.name,
        date: day(milestone.date),
        createdAt: STAMP,
        updatedAt: STAMP,
      }
    })
  })
  return db
}

/**
 * The workspace every test counts by hand. Today is Wed Nov 4 (offsets in days).
 *
 *  Research (active, 11 leaves; "Synthesize findings" is a PARENT with 3 subtasks; 3 milestones)
 *    leaves done: Interview users, Review with team, Archive notes = 3 of 11 -> 27%
 *  Community Event (active, 5 leaves, 1 done) -> 20%
 *  Roadmap 規劃 (active, 3 leaves, 2 done) -> 66% (2/3 rounds DOWN, 99.6% never shows 100)
 *  Business Development (active, a milestone but no tasks) -> "No tasks"
 *  Launch prep (active, 2 of 2 done, undated) -> 100%
 *  Website redesign (completed, 1 of 1) · Legacy migration (archived, an overdue task + milestone)
 *
 * Open tasks of projects that are not archived (any level) = 14:
 *   overdue 2 (Finalize report -3, Book venue -1) · today 2 (Review prototype, Write personas)
 *   upcoming 6 (days +1 … +7: Cluster notes, Synthesize findings, Send invitations, Draft survey,
 *   期末報告簡報, Catering quote on exactly day +7) · later 2 (+8, +20) · no date 2.
 * Done tasks with past due dates (Interview users -10, Review with team -1, Confirm speakers -5,
 * 期末報告初稿 -2, 問卷設計 -4, Wireframes -30) are never overdue; "Ongoing admin" is In Progress
 * without a date and "Send invitations" is In Progress due in 3 days: neither is Today.
 */
function seedProjects(): SeedProject[] {
  return [
    {
      id: 'p-research',
      name: 'Research',
      description: 'User interviews and a prototype',
      color: 'violet',
      start: -20,
      due: 40,
      tasks: [
        {
          id: 't-report',
          title: 'Finalize report',
          start: -8,
          due: -3,
          priority: 'high',
          status: 'in_progress',
        },
        { id: 't-proto', title: 'Review prototype', start: -1, due: 0, priority: 'urgent' },
        { id: 't-interview', title: 'Interview users', start: -14, due: -10, status: 'done' },
        { id: 't-synth', title: 'Synthesize findings', start: 0, due: 2, priority: 'medium' },
        { id: 't-cluster', title: 'Cluster notes', start: 0, due: 1, parent: 't-synth' },
        { id: 't-personas', title: 'Write personas', start: 0, due: 0, parent: 't-synth' },
        { id: 't-review', title: 'Review with team', due: -1, status: 'done', parent: 't-synth' },
        { id: 't-survey', title: 'Draft survey', start: 1, due: 5 },
        { id: 't-retro', title: 'Plan retro', start: 15, due: 20 },
        { id: 't-inbox', title: 'Inbox idea' },
        { id: 't-archive', title: 'Archive notes', status: 'done' },
        { id: 't-admin', title: 'Ongoing admin', status: 'in_progress' },
      ],
      milestones: [
        { id: 'm-kickoff', name: 'Kickoff', date: -5 },
        { id: 'm-final', name: '期末報告繳交', date: 12 },
        { id: 'm-launch', name: 'Launch day', date: 30 },
      ],
    },
    {
      id: 'p-event',
      name: 'Community Event',
      color: 'orange',
      due: 14,
      tasks: [
        { id: 'e-venue', title: 'Book venue', due: -1, priority: 'urgent' },
        {
          id: 'e-invite',
          title: 'Send invitations',
          start: 0,
          due: 3,
          priority: 'medium',
          status: 'in_progress',
        },
        { id: 'e-speakers', title: 'Confirm speakers', due: -5, status: 'done' },
        {
          id: 'e-catering',
          title: 'Catering quote',
          due: 7,
          description: 'Call the vendor about the allergen list before the weekend',
        },
        { id: 'e-volunteer', title: 'Volunteer schedule', due: 8 },
      ],
    },
    {
      id: 'p-roadmap',
      name: 'Roadmap 規劃',
      description: '期末報告的規劃與里程碑',
      color: 'teal',
      tasks: [
        { id: 'c-draft', title: '期末報告初稿', due: -2, status: 'done' },
        { id: 'c-survey', title: '問卷設計', due: -4, status: 'done' },
        { id: 'c-slides', title: '期末報告簡報', start: 1, due: 6 },
      ],
      milestones: [{ id: 'm-gate', name: 'Review gate', date: 0 }],
    },
    {
      id: 'p-biz',
      name: 'Business Development',
      color: 'blue',
      description: 'Partnerships',
      milestones: [{ id: 'm-partner', name: 'Partner signing', date: 21 }],
    },
    {
      id: 'p-launch',
      name: 'Launch prep',
      color: 'green',
      tasks: [
        { id: 'l-press', title: 'Press kit', status: 'done' },
        { id: 'l-landing', title: 'Landing page', status: 'done' },
      ],
    },
    {
      id: 'p-web',
      name: 'Website redesign',
      color: 'pink',
      status: 'completed',
      start: -40,
      due: -20,
      tasks: [{ id: 'w-wire', title: 'Wireframes', due: -30, status: 'done' }],
    },
    {
      id: 'p-old',
      name: 'Legacy migration',
      color: 'gray',
      status: 'archived',
      tasks: [{ id: 'o-inventory', title: 'Inventory services', due: -20 }],
      milestones: [{ id: 'm-cutover', name: 'Legacy cutover', date: 3 }],
    },
  ]
}

/** Expected progress per project (done leaves, leaves, percent rounded down); null = No tasks. */
const PROGRESS: Record<string, { done: number; total: number; percent: number } | null> = {
  'p-research': { done: 3, total: 11, percent: 27 },
  'p-event': { done: 1, total: 5, percent: 20 },
  'p-roadmap': { done: 2, total: 3, percent: 66 },
  'p-biz': null,
  'p-launch': { done: 2, total: 2, percent: 100 },
  'p-web': { done: 1, total: 1, percent: 100 },
  'p-old': { done: 0, total: 1, percent: 0 },
}
const NAMES: Record<string, string> = {
  'p-research': 'Research',
  'p-event': 'Community Event',
  'p-roadmap': 'Roadmap 規劃',
  'p-biz': 'Business Development',
  'p-launch': 'Launch prep',
  'p-web': 'Website redesign',
  'p-old': 'Legacy migration',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Boots the app at `path`; the workspace is seeded once per tab (a reload keeps the changes).
 * "Now" is frozen at NOW, or, with `startAt`, a clock that runs on from that moment and can be
 * fast-forwarded (to cross midnight).
 */
async function openApp(
  page: Page,
  path: string,
  projects: SeedProject[] = seedProjects(),
  startAt?: string,
): Promise<void> {
  if (startAt) await page.clock.install({ time: new Date(startAt) })
  else await page.clock.setFixedTime(NOW)
  await page.addInitScript(
    ({ storageKey, db }) => {
      if (sessionStorage.getItem('cairn-e2e-acceptance-cross-seeded')) return
      localStorage.setItem(storageKey, JSON.stringify(db))
      sessionStorage.setItem('cairn-e2e-acceptance-cross-seeded', '1')
    },
    { storageKey: LOCAL_WORKSPACE_KEY, db: buildWorkspace(projects) },
  )
  await page.goto(path)
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
  await expect(page.getByRole('main').locator('[aria-busy="true"]')).toHaveCount(0)
}

/** Client-side navigation through the sidebar (keeps the in-memory store, like a user would). */
async function goVia(page: Page, link: 'Overview' | 'My Tasks' | 'Projects' | 'Timeline') {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: link }).click()
}

interface StoredWorkspace {
  tasks: Record<
    string,
    {
      title: string
      status: string
      dueDate: string | null
      completedAt: string | null
      parentTaskId: string | null
    }
  >
  projects: Record<string, { name: string }>
}
/** What the local "database" holds right now (the source of truth after a reload). */
function stored(page: Page): Promise<StoredWorkspace> {
  return page.evaluate(
    (storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? '{}') as StoredWorkspace,
    LOCAL_WORKSPACE_KEY,
  )
}

const pageHeading = (page: Page, name: string) => page.getByRole('heading', { name, level: 1 })
const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
const taskRow = (page: Page, id: string) => page.locator(`[data-task-row="${id}"]`)
const metric = (page: Page, name: 'active' | 'open' | 'soon' | 'overdue') =>
  page.locator(`[data-metric="${name}"] dd`)
const myTaskTabs = (page: Page) => page.getByRole('navigation', { name: 'My Tasks' })
const sidebarMyTasks = (page: Page) => page.locator('a[href="/my-tasks"]')
const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })

/** Task ids of the rows inside `scope`, in DOM order. */
function rowIds(scope: Locator): Promise<(string | null)[]> {
  return scope
    .locator('[data-task-row]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-task-row')))
}

/** The `aria-valuetext` of a progress bar ("27% · 3 of 11 tasks done"), or "No tasks". */
async function progressText(scope: Locator, name: string): Promise<string> {
  const bar = scope.getByRole('progressbar', { name })
  if ((await bar.count()) === 0) return 'No tasks'
  return (await bar.getAttribute('aria-valuetext')) ?? '?'
}

function expectedText(projectId: string): string {
  const progress = PROGRESS[projectId]
  return progress
    ? `${progress.percent}% · ${progress.done} of ${progress.total} tasks done`
    : 'No tasks'
}

// ===========================================================================
// AC-10  Progress = done leaf tasks / leaf tasks, the same everywhere
// ===========================================================================

/** The progress every page shows for each project, read from the page itself. */
async function progressEverywhere(page: Page): Promise<Record<string, Record<string, string>>> {
  const result: Record<string, Record<string, string>> = {
    overview: {},
    projects: {},
    header: {},
    timeline: {},
  }
  await goVia(page, 'Overview')
  await expect(pageHeading(page, 'Overview')).toBeVisible()
  const active = section(page, 'Active projects')
  for (const id of Object.keys(PROGRESS)) {
    // Only active projects are listed on the Overview.
    if (await active.getByRole('link', { name: NAMES[id], exact: true }).count()) {
      result.overview[id] = await progressText(active, `${NAMES[id]} progress`)
    }
  }

  await page.goto('/projects?status=all')
  const table = page.getByRole('table', { name: 'Projects' })
  await expect(table.getByRole('row')).toHaveCount(Object.keys(PROGRESS).length + 1)
  for (const id of Object.keys(PROGRESS)) {
    const row = table.getByRole('row').filter({
      has: page.getByRole('link', { name: NAMES[id], exact: true }),
    })
    result.projects[id] = await progressText(row, `${NAMES[id]} progress`)
  }

  for (const id of Object.keys(PROGRESS)) {
    await page.goto(`/projects/${id}/list`)
    await expect(pageHeading(page, NAMES[id])).toBeVisible()
    result.header[id] = await progressText(
      page.locator('[data-slot="page-header"]'),
      'Project progress',
    )
  }

  await page.goto('/timeline')
  await page.getByRole('switch', { name: /Include completed/ }).click()
  const chart = page.getByRole('region', { name: 'Timeline of all projects' })
  await expect(chart).toBeVisible()
  for (const id of Object.keys(PROGRESS)) {
    if (PROGRESS[id] && id === 'p-old') continue // archived projects are never on the Timeline
    const link = chart.getByRole('link', { name: NAMES[id], exact: true })
    await expect(link).toHaveCount(1)
    // The row's own description spells the progress out: "3 of 11 tasks done · 27%".
    const description = (await link.evaluate((element) => {
      const ids = element.getAttribute('aria-describedby')?.split(' ') ?? []
      return ids.map((value) => document.getElementById(value)?.textContent ?? '').join(' ')
    })) as string
    const match = /(\d+) of (\d+) tasks? done · (\d+)%/.exec(description)
    result.timeline[id] = match
      ? `${match[3]}% · ${match[1]} of ${match[2]} tasks done`
      : /No tasks/.test(description)
        ? 'No tasks'
        : `? ${description}`
  }
  return result
}

test.describe('AC-10: progress', () => {
  test('AC-10: progress is done leaf tasks / leaf tasks; Overview, Projects, project header and Timeline agree', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    const seen = await progressEverywhere(page)

    // Hand count (see seedProjects): parents (Synthesize findings) and milestones never count,
    // 2 of 3 is 66 not 67, an empty project says "No tasks", never a made-up 100%.
    const everywhere = Object.keys(PROGRESS)
    for (const id of everywhere) {
      expect(seen.projects[id], `Projects list · ${NAMES[id]}`).toBe(expectedText(id))
      expect(seen.header[id], `project header · ${NAMES[id]}`).toBe(expectedText(id))
    }
    // The Overview lists active projects only; the Timeline lists active + completed (toggle on).
    expect(Object.keys(seen.overview)).toEqual([
      'p-research',
      'p-event',
      'p-roadmap',
      'p-biz',
      'p-launch',
    ])
    for (const id of Object.keys(seen.overview)) {
      expect(seen.overview[id], `Overview · ${NAMES[id]}`).toBe(expectedText(id))
    }
    expect(Object.keys(seen.timeline).sort()).toEqual(
      ['p-research', 'p-event', 'p-roadmap', 'p-biz', 'p-launch', 'p-web'].sort(),
    )
    for (const id of Object.keys(seen.timeline)) {
      expect(seen.timeline[id], `Timeline · ${NAMES[id]}`).toBe(expectedText(id))
    }
  })

  test('AC-10: the number moves with a leaf task, never with a parent or a milestone, and the first task ends "No tasks"', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/list')
    const header = page.locator('[data-slot="page-header"]')
    const bar = header.getByRole('progressbar', { name: 'Project progress' })
    await expect(bar).toHaveAttribute('aria-valuetext', '27% · 3 of 11 tasks done')

    // A subtask is a leaf: 4 of 11 = 36%.
    await page.getByRole('button', { name: 'Expand subtasks' }).click()
    await taskRow(page, 't-cluster')
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect(bar).toHaveAttribute('aria-valuetext', '36% · 4 of 11 tasks done')

    // Finishing the PARENT changes nothing: it is not a leaf (no double counting).
    await taskRow(page, 't-synth')
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect(
      taskRow(page, 't-synth').getByRole('button', { name: 'Status: Done' }),
    ).toBeVisible()
    await expect(bar).toHaveAttribute('aria-valuetext', '36% · 4 of 11 tasks done')

    // The other pages follow in the same session (one store, no reload).
    await goVia(page, 'Overview')
    await expect(
      section(page, 'Active projects').getByRole('progressbar', { name: 'Research progress' }),
    ).toHaveAttribute('aria-valuetext', '36% · 4 of 11 tasks done')
    await goVia(page, 'Projects')
    await expect(
      page.getByRole('table', { name: 'Projects' }).getByRole('progressbar', {
        name: 'Research progress',
      }),
    ).toHaveAttribute('aria-valuetext', '36% · 4 of 11 tasks done')
    await goVia(page, 'Timeline')
    const chart = page.getByRole('region', { name: 'Timeline of all projects' })
    await expect(
      chart.getByRole('link', { name: 'Research', exact: true }),
    ).toHaveAccessibleDescription(/4 of 11 tasks done · 36%/)
    await expect(chart.locator('[data-row-key="project:p-research"]')).toContainText('36%')

    // An empty project: "No tasks" everywhere; a milestone does not change that.
    await page.goto('/projects/p-biz/list')
    await expect(header.getByText('No tasks')).toBeVisible()
    await expect(header.getByRole('progressbar')).toHaveCount(0)

    // Its first task makes it 0% (a real zero, not "No tasks"); done makes it 100%.
    await page.getByRole('button', { name: 'New task' }).first().click()
    const modal = page.getByRole('dialog', { name: 'New task', exact: true })
    await modal.getByRole('textbox', { name: 'Task title' }).fill('First deal')
    await modal.getByRole('button', { name: /^Create/ }).click()
    await expect(modal).toBeHidden()
    await expect(header.getByRole('progressbar', { name: 'Project progress' })).toHaveAttribute(
      'aria-valuetext',
      '0% · 0 of 1 tasks done',
    )
    await page
      .locator('[data-task-row]')
      .first()
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect(header.getByRole('progressbar', { name: 'Project progress' })).toHaveAttribute(
      'aria-valuetext',
      '100% · 1 of 1 tasks done',
    )
    await goVia(page, 'Overview')
    await expect(
      section(page, 'Active projects').getByRole('progressbar', {
        name: 'Business Development progress',
      }),
    ).toHaveAttribute('aria-valuetext', '100% · 1 of 1 tasks done')

    // Stored really: reload shows the same numbers.
    await page.reload()
    await expect(
      section(page, 'Active projects').getByRole('progressbar', { name: 'Research progress' }),
    ).toHaveAttribute('aria-valuetext', '36% · 4 of 11 tasks done')
  })
})

// ===========================================================================
// AC-11  My Tasks (Today / Upcoming / Overdue / All) and the global search
// ===========================================================================

/** "November 20th, 2026": how the calendar names a day (the label also says the weekday). */
function dayPattern(date: string): RegExp {
  const [year, month, dayOfMonth] = date.split('-').map(Number)
  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  })
  const suffix =
    dayOfMonth % 10 === 1 && dayOfMonth !== 11
      ? 'st'
      : dayOfMonth % 10 === 2 && dayOfMonth !== 12
        ? 'nd'
        : dayOfMonth % 10 === 3 && dayOfMonth !== 13
          ? 'rd'
          : 'th'
  return new RegExp(`${monthName} ${dayOfMonth}${suffix}, ${year}`)
}

/** Opens a date chip of `scope` and picks `date` in its calendar (paging forward when needed). */
async function pickDate(
  page: Page,
  scope: Locator,
  field: 'Start date' | 'Due date',
  date: string,
): Promise<void> {
  await scope.getByRole('button', { name: new RegExp(`^${field}:`) }).click()
  const picker = page.getByRole('dialog', { name: field, exact: true })
  const target = picker.getByRole('button', { name: dayPattern(date) })
  for (let step = 0; step < 4 && (await target.count()) === 0; step++) {
    await picker.getByRole('button', { name: 'Go to the Next Month' }).click()
  }
  await target.click()
  await expect(picker).toBeHidden()
}

/** The four My Tasks tabs read Today / Upcoming / Overdue / All Tasks with these counts. */
async function expectTabCounts(page: Page, counts: [number, number, number, number]) {
  const [today, upcoming, overdue, all] = counts
  await expect(myTaskTabs(page).getByRole('link')).toHaveText([
    new RegExp(`^Today\\s*${today}\\b`),
    new RegExp(`^Upcoming\\s*${upcoming}\\b`),
    new RegExp(`^Overdue\\s*${overdue}\\b`),
    new RegExp(`^All Tasks\\s*${all}\\b`),
  ])
}

/**
 * Switches the My Tasks tab and waits until that tab is the current one: until then the page still
 * shows the old list, and a click on one of its rows opens the task over the OLD tab's address.
 */
async function openTab(page: Page, tab: 'Today' | 'Upcoming' | 'Overdue' | 'All'): Promise<void> {
  const link = myTaskTabs(page).getByRole('link', { name: new RegExp(`^${tab}`) })
  await link.click()
  await expect(link).toHaveAttribute('aria-current', 'page')
}

/** The sidebar badge says how many tasks are due today or overdue (spoken text). */
async function expectBadge(page: Page, total: number, overdue: number) {
  await expect(sidebarMyTasks(page)).toHaveAccessibleName(
    new RegExp(`${total} due today or overdue \\(${overdue} overdue\\)`),
  )
}

/** The Overview's four numbers. */
async function expectMetrics(
  page: Page,
  active: number,
  open: number,
  soon: number,
  overdue: number,
) {
  await expect(metric(page, 'active')).toHaveText(String(active))
  await expect(metric(page, 'open')).toHaveText(String(open))
  await expect(metric(page, 'soon')).toHaveText(String(soon))
  await expect(metric(page, 'overdue')).toHaveText(String(overdue))
}

const searchButton = (page: Page) =>
  page
    .getByRole('banner', { includeHidden: true })
    .getByRole('button', { name: /^Search/, includeHidden: true })
const searchDialog = (page: Page) => page.getByRole('dialog', { name: 'Search' })

/** The modifier the app's keyboard engine treats as `mod` (⌘ on Apple platforms, else Ctrl). */
function modifierKey(page: Page): Promise<'Meta' | 'Control'> {
  return page.evaluate(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
    const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent
    return /mac|iphone|ipad|ipod/i.test(platform) ? 'Meta' : 'Control'
  })
}

/** ⌘/Ctrl+K: resolves with the open overlay once its input has focus. */
async function openSearchWithShortcut(page: Page): Promise<Locator> {
  await page.keyboard.press(`${await modifierKey(page)}+k`)
  const dialog = searchDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox')).toBeFocused()
  return dialog
}

/** The top-bar Search button: resolves with the open overlay once its input has focus. */
async function openSearchWithButton(page: Page): Promise<Locator> {
  await searchButton(page).click()
  const dialog = searchDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox')).toBeFocused()
  return dialog
}

/** Types a query and waits for the list to show it. */
async function search(dialog: Locator, query: string): Promise<void> {
  await dialog.getByRole('combobox').fill(query)
  await expect(dialog.getByRole('combobox')).toHaveValue(query)
}

test.describe('AC-11: My Tasks', () => {
  test('AC-11: Today, Upcoming, Overdue and All follow the definitions; the counts match the Overview', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    // Overview: 5 active projects; 14 open tasks of any level in projects that are not archived;
    // due soon = today (2) + the next 7 days (6); overdue 2. The archived project's overdue task
    // and every done task with a past date count for nothing.
    await expectMetrics(page, 5, 14, 8, 2)
    await expectBadge(page, 4, 2)
    await expect(section(page, 'Upcoming tasks').getByText('Showing 8 of 10')).toBeVisible()

    // /my-tasks opens on Today.
    await page.getByRole('link', { name: 'View all in My Tasks' }).click()
    await expect(page).toHaveURL(/\/my-tasks\/all$/)
    await expectTabCounts(page, [2, 6, 2, 14])

    // Today = open AND due today. Not "In Progress": Ongoing admin (In Progress, no date) and
    // Send invitations (In Progress, in 3 days) are elsewhere. A subtask counts like any task.
    await openTab(page, 'Today')
    await expect(page).toHaveURL(/\/my-tasks\/today$/)
    await expect.poll(() => rowIds(page.getByRole('main'))).toEqual(['t-proto', 't-personas'])

    // Upcoming = open AND due after today up to and including today + 7 (Catering quote sits on
    // day 7); Volunteer schedule (day 8) is "later". Today is not repeated here.
    await openTab(page, 'Upcoming')
    await expect
      .poll(() => rowIds(page.getByRole('main')))
      .toEqual(['t-cluster', 't-synth', 'e-invite', 't-survey', 'c-slides', 'e-catering'])

    // Overdue = open AND due before today. Done tasks with past dates are never overdue, nor is
    // anything of the archived project.
    await openTab(page, 'Overdue')
    await expect.poll(() => rowIds(page.getByRole('main'))).toEqual(['t-report', 'e-venue'])

    // All = every open task, grouped by due date (later and undated ones included) …
    await openTab(page, 'All')
    await expect(page).toHaveURL(/\/my-tasks\/all$/)
    await expect
      .poll(async () => (await rowIds(page.getByRole('main'))).sort())
      .toEqual(
        [
          't-report',
          'e-venue',
          't-proto',
          't-personas',
          't-cluster',
          't-synth',
          'e-invite',
          't-survey',
          'c-slides',
          'e-catering',
          'e-volunteer',
          't-retro',
          't-inbox',
          't-admin',
        ].sort(),
      )
    // … and the completed ones only on request (9 of them), still never as overdue.
    await page.getByRole('switch', { name: /Show completed/ }).click()
    await expectTabCounts(page, [2, 6, 2, 14])
    await expect(page.locator('[data-task-row]')).toHaveCount(23)
    await expect(taskRow(page, 'o-inventory')).toHaveCount(0)
    await expect(page.locator('[data-bucket="overdue"]')).toHaveCount(2)
  })

  test('AC-11: editing a task moves it between the tabs and every number follows (done is never overdue)', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/overdue')
    await expectTabCounts(page, [2, 6, 2, 14])
    await expectBadge(page, 4, 2)

    // Finishing an overdue task takes it off Overdue and out of every count; Undo restores it.
    await taskRow(page, 'e-venue')
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect(taskRow(page, 'e-venue')).toHaveCount(0)
    await expectTabCounts(page, [2, 6, 1, 13])
    await expectBadge(page, 3, 1)
    await toast(page, /Marked as done/)
      .getByRole('button', { name: 'Undo' })
      .click()
    await expect(taskRow(page, 'e-venue')).toBeVisible()
    await expectTabCounts(page, [2, 6, 2, 14])

    // An In Progress task without a date is not "Today": giving it today's date puts it there.
    await openTab(page, 'Today')
    await expect(taskRow(page, 't-admin')).toHaveCount(0)
    await openTab(page, 'All')
    await taskRow(page, 't-admin').locator('[data-row-open]').click()
    const modal = page.getByRole('dialog', { name: 'Edit task: Ongoing admin' })
    await pickDate(page, modal, 'Due date', TODAY)
    await modal.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(modal).toBeHidden()
    await expectTabCounts(page, [3, 6, 2, 14])
    await expectBadge(page, 5, 2)
    await openTab(page, 'Today')
    // Same day: by priority, then by position in the project (a subtask sits with its parent).
    await expect
      .poll(() => rowIds(page.getByRole('main')))
      .toEqual(['t-proto', 't-personas', 't-admin'])

    // Yesterday's date makes it overdue (it is still In Progress, not done) …
    await openTab(page, 'All')
    await taskRow(page, 't-admin').locator('[data-row-open]').click()
    await pickDate(page, modal, 'Due date', day(-1))
    await modal.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(modal).toBeHidden()
    await expectTabCounts(page, [2, 6, 3, 14])

    // … and finishing it leaves Overdue again: done is never overdue, the date stays.
    await taskRow(page, 't-admin')
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expectTabCounts(page, [2, 6, 2, 13])
    expect((await stored(page)).tasks['t-admin']).toMatchObject({
      status: 'done',
      dueDate: day(-1),
    })

    // The Overview says the same.
    await goVia(page, 'Overview')
    await expectMetrics(page, 5, 13, 8, 2)
    await expectBadge(page, 4, 2)
  })
})

test.describe('AC-11: search', () => {
  test('AC-11: ⌘K and the button find projects, tasks (CJK, partial words) and milestones across projects', async ({
    page,
  }) => {
    await openApp(page, '/overview')

    // CJK, opened with the button: the project (its description), two tasks of that project
    // (open before done) and a milestone of ANOTHER project.
    let dialog = await openSearchWithButton(page)
    await search(dialog, '期末報告')
    const options = dialog.getByRole('option')
    await expect(options).toHaveText([
      /^Roadmap 規劃/,
      /^期末報告簡報.*Roadmap 規劃/,
      /^期末報告初稿.*Roadmap 規劃/,
      /^期末報告繳交.*Research/,
    ])
    await expect(dialog.getByText('Projects', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Tasks', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Milestones', { exact: true })).toBeVisible()
    // The project matched through its description only: the excerpt says why.
    await expect(options.first().locator('[data-snippet]')).toContainText('期末報告的規劃與里程碑')
    await expect(options.first().locator('[data-snippet] [data-match]')).toHaveText('期末報告')
    // A shorter CJK part of a longer word matches too.
    await search(dialog, '報告')
    await expect(options).toHaveCount(4)
    await search(dialog, '問卷')
    await expect(options).toHaveText([/^問卷設計.*Roadmap 規劃/])
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // Partial words, opened with the shortcut: a prefix, a middle of a word, any case, several
    // words in any order; tasks of different projects in one list.
    dialog = await openSearchWithShortcut(page)
    await search(dialog, 'repo')
    await expect(options).toHaveText([/^Finalize report.*Research/])
    await search(dialog, 'ALIZE')
    await expect(options).toHaveText([/^Finalize report.*Research/])
    await search(dialog, 'report finalize')
    await expect(options).toHaveText([/^Finalize report.*Research/])
    await search(dialog, 'review')
    await expect(options).toHaveText([
      /^Review prototype.*Research/,
      /^Review with team.*Research/, // a done subtask: after the open tasks
      /^Review gate.*Roadmap 規劃/, // milestones come in their own group
    ])
    // A hit that exists only in a description quotes it.
    await search(dialog, 'allergen')
    await expect(options).toHaveText([/^Catering quote.*Community Event/])
    await expect(options.first().locator('[data-snippet] [data-match]')).toHaveText('allergen')
    // Milestones are found by name, across projects, with their date.
    await search(dialog, 'partner')
    await expect(options).toHaveText([
      /^Business Development.*Partnerships/, // the project, through its description
      /^Partner signing.*Business Development.*Nov 25/,
    ])
    await search(dialog, 'legacy')
    await expect(options).toHaveText([
      /^Legacy migration.*Archived/,
      /^Legacy cutover.*Legacy migration.*Archived/,
    ])
  })

  test('AC-11: a result opens the right place: project, task, subtask, milestone; the page title follows', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    await expect(page).toHaveTitle('Overview · Cairn')

    // A project → its page (List until another view is picked); the title follows at once.
    let dialog = await openSearchWithShortcut(page)
    await search(dialog, 'community')
    await dialog.getByRole('option', { name: /^Community Event/ }).click()
    await expect(page).toHaveURL(/\/projects\/p-event\/list$/)
    await expect(pageHeading(page, 'Community Event')).toBeVisible()
    await expect(page).toHaveTitle('Community Event · Cairn')

    // A task → over ITS project, in the Task Modal (deep link); Esc closes it and keeps the page.
    dialog = await openSearchWithShortcut(page)
    await search(dialog, 'prototype')
    await dialog.getByRole('option', { name: /^Review prototype/ }).click()
    await expect(page).toHaveURL(/\/projects\/p-research\/list\?task=t-proto$/)
    const modal = page.getByRole('dialog', { name: 'Edit task: Review prototype' })
    await expect(modal).toBeVisible()
    await expect(page).toHaveTitle('Research · Cairn')
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
    await expect(page).toHaveURL(/\/projects\/p-research\/list$/)
    await expect(pageHeading(page, 'Research')).toBeVisible()

    // A subtask → its own modal, which names the parent.
    dialog = await openSearchWithShortcut(page)
    await search(dialog, 'personas')
    await expect(dialog.getByRole('option')).toHaveText([/^Write personas.*in Synthesize findings/])
    await dialog.getByRole('option').first().click()
    await expect(page).toHaveURL(/\?task=t-personas$/)
    const sub = page.getByRole('dialog', { name: 'Edit task: Write personas' })
    await expect(sub).toBeVisible()
    await expect(sub).toContainText('Synthesize findings')
    await page.keyboard.press('Escape')
    await expect(sub).toBeHidden()

    // A milestone of another project → that project's Gantt with its dialog open on the milestone.
    dialog = await openSearchWithShortcut(page)
    await search(dialog, 'partner')
    await dialog.getByRole('option', { name: /^Partner signing/ }).click()
    await expect(page).toHaveURL(/\/projects\/p-biz\/gantt$/)
    const milestone = page.getByRole('dialog', { name: /Edit milestone/ })
    await expect(milestone).toBeVisible()
    await expect(milestone.getByRole('textbox', { name: 'Name' })).toHaveValue('Partner signing')
    await page.keyboard.press('Escape')
    await expect(milestone).toBeHidden()
    await expect(page).toHaveTitle('Business Development · Cairn')

    // Leaving the project: the title is the new page's, not the old project's.
    await goVia(page, 'Timeline')
    await expect(page).toHaveTitle('Timeline · Cairn')
    await goVia(page, 'My Tasks')
    await expect(page).toHaveTitle('My Tasks · Cairn')
    await page.goBack()
    await expect(page).toHaveTitle('Timeline · Cairn')
    await page.goBack()
    await expect(page).toHaveTitle('Business Development · Cairn')
  })

  test('AC-11: empty, no-result and odd queries are handled', async ({ page }) => {
    await openApp(page, '/overview')
    const dialog = await openSearchWithShortcut(page)
    const options = dialog.getByRole('option')

    // Nothing typed (or only blanks): the quick actions, not an error.
    await expect(options.first()).toContainText('New task')
    await search(dialog, '   ')
    await expect(options.first()).toContainText('New task')
    await expect(dialog.getByText(/No results/)).toHaveCount(0)

    // Nothing found: a clear message that quotes the query, no stale rows.
    await search(dialog, 'zzzzqx')
    await expect(dialog.getByRole('listbox').getByText('No results for "zzzzqx"')).toBeVisible()
    await expect(options).toHaveCount(0)
    await expect(dialog.getByRole('status')).toHaveText('No results for "zzzzqx"')

    // Characters that mean something in regular expressions, paths or markup are just text.
    for (const odd of ['(', '[a-', '\\', '*', '.*', '?', '<b>', '"quote"', '%', '期末報告 zzz']) {
      await search(dialog, odd)
      await expect(
        dialog.getByRole('listbox').getByText(`No results for "${odd.trim()}"`),
      ).toBeVisible()
    }
    // A very long query does not break the layout.
    await search(dialog, 'x'.repeat(400))
    await expect(dialog.getByRole('listbox').getByText(/^No results for "x+"$/)).toBeVisible()
    const box = await dialog.boundingBox()
    expect(box?.width ?? 0).toBeLessThan(1000)

    // Clearing the query brings the quick actions back; Esc closes.
    await search(dialog, '')
    await expect(options.first()).toContainText('New task')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
})

// ===========================================================================
// AC-12  Cross-project Timeline
// ===========================================================================

const chartOf = (page: Page) => page.getByRole('region', { name: 'Timeline of all projects' })
const barOf = (page: Page, projectId: string) =>
  chartOf(page).locator(`[data-project-bar="${projectId}"]`)
const rowKeys = (page: Page) =>
  chartOf(page)
    .locator('[data-row-key]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-row-key')))

/** The element's box on screen; waits while it is not laid out yet (or is being re-created). */
async function rect(locator: Locator) {
  let box: Awaited<ReturnType<Locator['boundingBox']>> = null
  await expect
    .poll(async () => {
      box = await locator.boundingBox()
      return box !== null
    })
    .toBe(true)
  return box as unknown as { x: number; y: number; width: number; height: number }
}

/** Two animation frames: scroll handlers and the React updates they cause have run. */
function settle(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

/** Waits until the chart stops scrolling (a smooth scroll to Today has arrived). */
async function scrollIdle(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const first = await chartOf(page).evaluate((el) => el.scrollLeft)
      await settle(page)
      return first === (await chartOf(page).evaluate((el) => el.scrollLeft))
    })
    .toBe(true)
}

async function openTimeline(page: Page): Promise<void> {
  await openApp(page, '/timeline')
  await expect(chartOf(page)).toBeVisible()
  await expect(barOf(page, 'p-research')).toBeVisible()
}

const scaleRadio = (page: Page, scale: 'day' | 'week' | 'month') =>
  page.getByRole('radio', { name: new RegExp(`^${scale}$`, 'i') })

/** The milestone diamond of `name` on the Timeline (centre x on screen). */
const diamond = (page: Page, name: string) =>
  chartOf(page).getByRole('button', { name: new RegExp(`^Milestone ${name},`) })

test.describe('AC-12: cross-project Timeline', () => {
  test('AC-12: projects are rows on one shared axis; overlapping projects overlap on screen, to the day', async ({
    page,
  }) => {
    await openTimeline(page)

    // One row per ACTIVE project in project order; the undated one under "Unscheduled".
    // Completed (Website redesign) and archived (Legacy migration) projects are not drawn.
    expect(await rowKeys(page)).toEqual([
      'project:p-research',
      'project:p-event',
      'project:p-roadmap',
      'project:p-biz',
      'section:unscheduled',
      'project:p-launch',
    ])
    await expect(chartOf(page).getByText('Website redesign')).toHaveCount(0)
    await expect(chartOf(page).getByText('Legacy migration')).toHaveCount(0)
    await expect(scaleRadio(page, 'week')).toBeChecked()
    const px = DAY_PX.week

    // Bars (inclusive days): Research -20…+40 (its own dates), Community Event -5…+14 (a due date
    // of its own, a start from its work), Roadmap -4…+6 (all from its tasks and milestone) and
    // Business Development +21 (one milestone, one day).
    const research = await rect(barOf(page, 'p-research'))
    const event = await rect(barOf(page, 'p-event'))
    const roadmap = await rect(barOf(page, 'p-roadmap'))
    const biz = await rect(barOf(page, 'p-biz'))
    expect(research.width).toBeCloseTo(61 * px, 0)
    expect(event.x - research.x).toBeCloseTo(15 * px, 0)
    expect(event.width).toBeCloseTo(20 * px, 0)
    expect(roadmap.x - research.x).toBeCloseTo(16 * px, 0)
    expect(roadmap.width).toBeCloseTo(11 * px, 0)
    expect(biz.x - research.x).toBeCloseTo(41 * px, 0)
    expect(biz.width).toBeCloseTo(px, 0)

    // Overlap reads at a glance: the ranges that share days share pixels, the others do not.
    const overlaps = (a: { x: number; width: number }, b: { x: number; width: number }) =>
      a.x < b.x + b.width && b.x < a.x + a.width
    expect(overlaps(research, event)).toBe(true)
    expect(overlaps(event, roadmap)).toBe(true)
    expect(overlaps(research, biz)).toBe(true) // Business Development's day is inside Research
    expect(overlaps(event, biz)).toBe(false) // …but after Community Event ended
    expect(overlaps(roadmap, biz)).toBe(false)
    // Rows are stacked, one under the other (not side by side).
    expect(event.y).toBeGreaterThan(research.y)
    expect(roadmap.y).toBeGreaterThan(event.y)

    // Milestones are on their project's row at their date: Kickoff (-5) and 期末報告繳交 (+12)
    // on Research, Review gate (today) on Roadmap, Partner signing (+21) on Business Development.
    const centreOf = async (locator: Locator) => {
      const box = await rect(locator)
      return box.x + box.width / 2
    }
    expect((await centreOf(diamond(page, 'Kickoff'))) - research.x).toBeCloseTo(15.5 * px, 0)
    expect((await centreOf(diamond(page, '期末報告繳交'))) - research.x).toBeCloseTo(32.5 * px, 0)
    expect((await centreOf(diamond(page, 'Partner signing'))) - research.x).toBeCloseTo(
      41.5 * px,
      0,
    )
    // Today (Nov 4) is day 20 of Research: the milestone due today and the today line agree.
    const todayColumn = chartOf(page).locator('[data-today-column]')
    await expect(todayColumn).toHaveCount(1)
    expect((await centreOf(todayColumn)) - research.x).toBeCloseTo(20.5 * px, 0)
    expect((await centreOf(diamond(page, 'Review gate'))) - research.x).toBeCloseTo(20.5 * px, 0)
    // A diamond sits on its own project's row.
    const rowTop = async (id: string) =>
      (await rect(chartOf(page).locator(`[data-row-key="project:${id}"]`))).y
    for (const [name, projectId] of [
      ['Kickoff', 'p-research'],
      ['Review gate', 'p-roadmap'],
      ['Partner signing', 'p-biz'],
    ] as const) {
      const box = await rect(diamond(page, name))
      const top = await rowTop(projectId)
      expect(box.y).toBeGreaterThanOrEqual(top - 1)
      expect(box.y + box.height).toBeLessThanOrEqual(top + 37)
    }

    // The progress fill is the project's progress (the leaf-task ratio of AC-10), on the bar.
    for (const [id, ratio] of [
      ['p-research', 3 / 11],
      ['p-event', 1 / 5],
      ['p-roadmap', 2 / 3],
    ] as const) {
      const bar = barOf(page, id)
      const fill = (await rect(bar.locator('[data-progress-fill]'))).width
      // (the bar's 1px border is outside the fill's own 100%)
      expect(fill / ((await rect(bar)).width - 2)).toBeCloseTo(ratio, 2)
    }
    await expect(barOf(page, 'p-biz').locator('[data-progress-fill]')).toHaveCount(0)
    await expect(chartOf(page).locator('[data-row-key="project:p-research"]')).toContainText('27%')
    await expect(chartOf(page).locator('[data-row-key="project:p-biz"]')).toContainText('No tasks')
    await expect(chartOf(page).locator('[data-row-key="project:p-launch"]')).toContainText('100%')
    // The project without any date is listed, not lost, under its own header.
    await expect(chartOf(page).locator('[data-row-key="section:unscheduled"]')).toContainText(
      'Unscheduled',
    )
    await expect(barOf(page, 'p-launch')).toHaveCount(0)

    // Completed projects only on request; archived ones never.
    await page.getByRole('switch', { name: /Include completed/ }).click()
    await expect(barOf(page, 'p-web')).toBeVisible()
    await expect(chartOf(page).getByText('Legacy migration')).toHaveCount(0)
    const web = await rect(barOf(page, 'p-web'))
    const researchAgain = await rect(barOf(page, 'p-research'))
    // -40…-20 starts 20 days before Research does and shares exactly one day with it (day -20):
    // dates are inclusive, so the two bars overlap by one day's width, not more, not less.
    expect(researchAgain.x - web.x).toBeCloseTo(20 * px, 0)
    expect(web.width).toBeCloseTo(21 * px, 0)
    expect(web.x + web.width - researchAgain.x).toBeCloseTo(px, 0)
  })

  test('AC-12: expanding a project lists its scheduled tasks and milestones on the same axis, like its Gantt', async ({
    page,
  }) => {
    await openTimeline(page)
    const px = DAY_PX.week
    // Collapsed by default: no task rows, nothing exploded.
    expect((await rowKeys(page)).filter((key) => /^(task|milestone):/.test(key ?? ''))).toEqual([])

    await page.getByRole('button', { name: /^Expand Research/ }).click()
    // Scheduled top-level tasks in project order (undated ones and subtasks are not rows), then
    // the milestones by date.
    expect(await rowKeys(page)).toEqual([
      'project:p-research',
      'task:t-report',
      'task:t-proto',
      'task:t-interview',
      'task:t-synth',
      'task:t-survey',
      'task:t-retro',
      'milestone:m-kickoff',
      'milestone:m-final',
      'milestone:m-launch',
      'project:p-event',
      'project:p-roadmap',
      'project:p-biz',
      'section:unscheduled',
      'project:p-launch',
    ])
    const bar = (id: string) => chartOf(page).locator(`[data-task-id="${id}"]`)
    const research = await rect(barOf(page, 'p-research'))
    // Task bars sit at their dates on the SAME axis as the project bar (Research starts day -20):
    // Finalize report -8…-3, Review prototype -1…0, Interview users -14…-10, Draft survey +1…+5,
    // Plan retro +15…+20.
    for (const [id, from, days] of [
      ['t-report', -8, 6],
      ['t-proto', -1, 2],
      ['t-interview', -14, 5],
      ['t-survey', 1, 5],
      ['t-retro', 15, 6],
    ] as const) {
      const box = await rect(bar(id))
      expect(box.x - research.x, `${id} start`).toBeCloseTo((from + 20) * px, 0)
      expect(box.width, `${id} width`).toBeCloseTo(days * px, 0)
    }
    // Milestone rows: the diamond on a row of its own is the same date as on the project row.
    const milestoneRow = chartOf(page).locator('[data-row-key="milestone:m-final"]')
    const rowDiamond = await rect(milestoneRow.locator('[data-milestone-id]'))
    expect(rowDiamond.x + rowDiamond.width / 2 - research.x).toBeCloseTo(32.5 * px, 0)

    // The project's own Gantt draws the same tasks the same distance apart (one shared data).
    const timelineGap = (await rect(bar('t-survey'))).x - (await rect(bar('t-report'))).x
    await chartOf(page).getByRole('link', { name: 'Research', exact: true }).click()
    await expect(page).toHaveURL(/\/projects\/p-research\/gantt$/)
    const ganttBar = (id: string) => page.locator(`[data-task-id="${id}"][data-link-target]`)
    await expect(ganttBar('t-report')).toBeVisible()
    await expect(ganttBar('t-survey')).toBeVisible()
    await expect(ganttBar('t-retro')).toBeVisible()
    const ganttGap = (await rect(ganttBar('t-survey'))).x - (await rect(ganttBar('t-report'))).x
    expect(ganttGap).toBeCloseTo(timelineGap, 0)
    expect((await rect(ganttBar('t-retro'))).width).toBeCloseTo(6 * px, 0)

    // Back: the expansion is remembered, the rows are the same.
    await goVia(page, 'Timeline')
    await expect(chartOf(page).locator('[data-row-key="task:t-report"]')).toBeVisible()
    await page.getByRole('button', { name: /^Collapse Research/ }).click()
    await expect(chartOf(page).locator('[data-row-key="task:t-report"]')).toHaveCount(0)
  })

  test('AC-12: Day, Week and Month rescale every row together and Today brings the present into view', async ({
    page,
  }) => {
    await openTimeline(page)
    await page.getByRole('button', { name: /^Expand Research/ }).click()
    const todayColumn = chartOf(page).locator('[data-today-column]')
    const todayLine = chartOf(page).getByTestId('gantt-today-line')

    for (const scale of ['day', 'month', 'week'] as const) {
      await scaleRadio(page, scale).click()
      await expect(scaleRadio(page, scale)).toBeChecked()
      const px = DAY_PX[scale]
      await expect(barOf(page, 'p-research')).toHaveCSS('width', `${61 * px}px`)
      await expect(barOf(page, 'p-event')).toHaveCSS('width', `${20 * px}px`)
      await expect(barOf(page, 'p-roadmap')).toHaveCSS('width', `${11 * px}px`)
      await expect(chartOf(page).locator('[data-task-id="t-report"]')).toHaveCSS(
        'width',
        `${6 * px}px`,
      )
      // A column for today where a day is wide enough, always a line through the middle of it.
      if (px >= 16) await expect(todayColumn).toHaveCSS('width', `${px}px`)
      else await expect(todayColumn).toHaveCount(0)
      // The offsets between projects are the same days at every scale.
      await settle(page)
      const research = await rect(barOf(page, 'p-research'))
      expect((await rect(barOf(page, 'p-event'))).x - research.x).toBeCloseTo(15 * px, 0)
      expect((await rect(barOf(page, 'p-roadmap'))).x - research.x).toBeCloseTo(16 * px, 0)
      const line = await rect(todayLine)
      expect(line.x + line.width / 2 - research.x).toBeCloseTo(20.5 * px, 0)
    }

    // Today: where today's column sits in the visible time axis (pane = 300px).
    const todayAt = async () => {
      const area = await rect(chartOf(page))
      const today = await rect(todayLine)
      return (today.x + today.width / 2 - area.x - PANE_PX) / (area.width - PANE_PX)
    }
    await scaleRadio(page, 'day').click()
    await scrollIdle(page)
    await chartOf(page).evaluate((el) => el.scrollBy({ left: 1500, behavior: 'instant' }))
    await expect.poll(todayAt).toBeLessThan(0)
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await expect.poll(todayAt).toBeCloseTo(1 / 3, 1)
    // …and the T key does the same from anywhere.
    await scaleRadio(page, 'month').click()
    await chartOf(page).evaluate((el) => el.scrollBy({ left: 400, behavior: 'instant' }))
    await page.locator('body').click({ position: { x: 700, y: 90 } })
    await page.keyboard.press('t')
    await expect.poll(todayAt).toBeCloseTo(1 / 3, 1)

    // The headers name the right periods: a day scale shows days, month scale shows months.
    await scaleRadio(page, 'day').click()
    await expect(chartOf(page).getByText('Nov 2026').first()).toBeVisible()
    await scaleRadio(page, 'month').click()
    await expect(chartOf(page).getByText('Dec', { exact: true }).first()).toBeVisible()
    await expect(chartOf(page).getByText('2027', { exact: true }).first()).toBeVisible()
  })

  test('AC-12: a date changed elsewhere moves the bar, and a project without own dates follows its tasks', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-roadmap/list')
    await taskRow(page, 'c-slides').getByText('期末報告簡報', { exact: true }).click()
    const modal = page.getByRole('dialog', { name: 'Edit task: 期末報告簡報' })
    await expect(modal).toBeVisible()
    // Due day +6 becomes +30: Roadmap's bar (no dates of its own) must now end on day +30.
    await pickDate(page, modal, 'Due date', day(30))
    await modal.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(modal).toBeHidden()

    await goVia(page, 'Timeline')
    await expect(chartOf(page)).toBeVisible()
    const research = await rect(barOf(page, 'p-research'))
    const roadmap = await rect(barOf(page, 'p-roadmap'))
    expect(roadmap.x - research.x).toBeCloseTo(16 * DAY_PX.week, 0)
    expect(roadmap.width).toBeCloseTo(35 * DAY_PX.week, 0) // -4 … +30
    await expect(
      chartOf(page).getByRole('link', { name: 'Roadmap 規劃', exact: true }),
    ).toHaveAccessibleDescription(/from its tasks and milestones/)
  })
})

// ===========================================================================
// Cross-page behaviour: settings, archiving, live search
// ===========================================================================

test.describe('AC-11 / AC-12: one source of truth across pages', () => {
  test('AC-11: the time zone setting moves Today in My Tasks, the Overview, the badge and the Timeline', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/today')
    await expectTabCounts(page, [2, 6, 2, 14])

    // Los Angeles is still on Nov 3 (18:00) while Taipei is on Nov 4 (10:00): Today is a day
    // earlier, for every page at once. Finalize report (-3) stays overdue, Book venue (due Nov 3)
    // is now due TODAY, Catering quote (day +7) falls out of the 7-day window.
    await page.goto('/settings/appearance')
    await page.getByRole('combobox', { name: /^Time zone:/ }).click()
    await page.getByRole('combobox', { name: 'Time zones' }).fill('los angeles')
    await page.getByRole('option', { name: /America\/Los Angeles/ }).click()
    await expect(page.getByText(/in America\/Los_Angeles\.$/)).toBeVisible()

    await goVia(page, 'Overview')
    await expect(page.getByText('Tuesday, November 3, 2026')).toBeVisible()
    await expectMetrics(page, 5, 14, 8, 1)
    await expectBadge(page, 2, 1)
    await goVia(page, 'My Tasks')
    await expectTabCounts(page, [1, 7, 1, 14])
    await expect.poll(() => rowIds(page.getByRole('main'))).toEqual(['e-venue'])
    await openTab(page, 'Overdue')
    await expect.poll(() => rowIds(page.getByRole('main'))).toEqual(['t-report'])

    // The Timeline's today line follows: one day to the left of where Taipei had it.
    await goVia(page, 'Timeline')
    await expect(chartOf(page)).toBeVisible()
    const research = await rect(barOf(page, 'p-research'))
    const line = await rect(chartOf(page).getByTestId('gantt-today-line'))
    expect(line.x + line.width / 2 - research.x).toBeCloseTo(19.5 * DAY_PX.week, 0)
  })

  test('AC-12: the week scale and the Overview mini timeline follow "Week starts on"', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    const mini = section(page, 'Next 6 weeks')
    await expect(mini.getByText('Nov 2 – Dec 13')).toBeVisible() // Monday to Sunday

    await page.goto('/settings/appearance')
    await page
      .getByRole('radiogroup', { name: 'Week starts on' })
      .getByRole('radio', { name: 'Sunday' })
      .click()
    await expect
      .poll(async () => {
        const db = await page.evaluate(
          (key) =>
            JSON.parse(localStorage.getItem(key) ?? '{}') as {
              preferences?: { weekStartsOn?: number }
            },
          LOCAL_WORKSPACE_KEY,
        )
        return db.preferences?.weekStartsOn
      })
      .toBe(0)

    await goVia(page, 'Overview')
    await expect(mini.getByText('Nov 1 – Dec 12')).toBeVisible() // Sunday to Saturday
    await goVia(page, 'Timeline')
    await expect(chartOf(page)).toBeVisible()
    // The week tier labels the Sundays now (Oct 25, Nov 8, Nov 15 …), not the Mondays.
    await expect(chartOf(page).getByText('Nov 8', { exact: true }).first()).toBeVisible()
    await expect(chartOf(page).getByText('Nov 15', { exact: true }).first()).toBeVisible()
    await expect(chartOf(page).getByText('Nov 9', { exact: true })).toHaveCount(0)
    await expect(chartOf(page).getByText('Nov 16', { exact: true })).toHaveCount(0)
  })

  test('AC-11: archiving a project takes it out of My Tasks, the Overview and the Timeline; search still finds it, marked Archived', async ({
    page,
  }) => {
    await openApp(page, '/projects')
    const table = page.getByRole('table', { name: 'Projects' })
    const row = (name: string) =>
      table.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) })
    await row('Community Event')
      .getByRole('button', { name: 'Actions for Community Event' })
      .click()
    await page.getByRole('menuitem', { name: 'Archive' }).click()
    await expect(toast(page, 'Project archived')).toBeVisible()

    // Its 4 open tasks (1 overdue, 2 upcoming, 1 later) leave every number.
    await goVia(page, 'Overview')
    await expectMetrics(page, 4, 10, 6, 1)
    await expectBadge(page, 3, 1)
    await goVia(page, 'My Tasks')
    await expectTabCounts(page, [2, 4, 1, 10])
    await goVia(page, 'Timeline')
    await expect(chartOf(page)).toBeVisible()
    await expect(barOf(page, 'p-event')).toHaveCount(0)
    const dialog = await openSearchWithShortcut(page)
    await search(dialog, 'invitations')
    await expect(dialog.getByRole('option')).toHaveText([
      /^Send invitations.*Community Event.*Archived/,
    ])
    await page.keyboard.press('Escape')

    // Reopening brings everything back.
    await page.goto('/projects?status=archived')
    await row('Community Event')
      .getByRole('button', { name: 'Actions for Community Event' })
      .click()
    await page.getByRole('menuitem', { name: 'Unarchive' }).click()
    await goVia(page, 'Overview')
    await expectMetrics(page, 5, 14, 8, 2)
    await goVia(page, 'My Tasks')
    await expectTabCounts(page, [2, 6, 2, 14])
  })

  test('AC-11: search reflects what you create, rename and delete, at once', async ({ page }) => {
    await openApp(page, '/my-tasks/all')
    // Create (global New task asks for the project).
    await page.getByRole('button', { name: 'New task' }).first().click()
    const created = page.getByRole('dialog', { name: 'New task', exact: true })
    await created.getByRole('textbox', { name: 'Task title' }).fill('Zebra crossing 斑馬線 audit')
    await created.getByRole('button', { name: /^Project:/ }).click()
    await page.getByRole('menuitemradio', { name: 'Community Event' }).click()
    await created.getByRole('textbox', { name: 'Task title' }).press('Enter')
    await expect(created).toBeHidden()

    let dialog = await openSearchWithShortcut(page)
    await search(dialog, 'zebra')
    await expect(dialog.getByRole('option')).toHaveText([
      /^Zebra crossing 斑馬線 audit.*Community Event/,
    ])
    await search(dialog, '斑馬')
    await expect(dialog.getByRole('option')).toHaveCount(1)

    // Rename through the Task Modal opened by the result.
    await search(dialog, 'zebra')
    await dialog.getByRole('option').first().click()
    const edit = page.getByRole('dialog', { name: 'Edit task: Zebra crossing 斑馬線 audit' })
    await expect(edit).toBeVisible()
    await edit.getByRole('textbox', { name: 'Task title' }).fill('Pelican crossing 行人穿越道')
    await edit.getByRole('button', { name: 'Done', exact: true }).click()
    // The dialog's name follows the stored title, so look for any edit dialog.
    await expect(page.getByRole('dialog', { name: /^Edit task:/ })).toBeHidden()
    dialog = await openSearchWithShortcut(page)
    await search(dialog, 'zebra')
    await expect(dialog.getByRole('listbox').getByText('No results for "zebra"')).toBeVisible()
    await search(dialog, '穿越')
    await expect(dialog.getByRole('option')).toHaveText([
      /^Pelican crossing 行人穿越道.*Community Event/,
    ])

    // Delete: gone from the results.
    await dialog.getByRole('option').first().click()
    const again = page.getByRole('dialog', { name: 'Edit task: Pelican crossing 行人穿越道' })
    await again.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: /Delete task/ }).click()
    await page
      .getByRole('alertdialog', { name: 'Delete task?' })
      .getByRole('button', { name: 'Delete' })
      .click()
    await expect(again).toBeHidden()
    dialog = await openSearchWithShortcut(page)
    await search(dialog, 'pelican')
    await expect(dialog.getByRole('listbox').getByText('No results for "pelican"')).toBeVisible()
    await page.keyboard.press('Escape')
    // The count of open tasks is back to the original 14 (one created, one deleted).
    await goVia(page, 'My Tasks')
    await expectTabCounts(page, [2, 6, 2, 14])
  })
})

test.describe('AC-10: progress from another page', () => {
  test('AC-10: finishing tasks in My Tasks moves their project everywhere, and nothing else', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/today')
    await expect.poll(() => rowIds(page.getByRole('main'))).toEqual(['t-proto', 't-personas'])
    // Review prototype and Write personas are both Research leaves: 3 → 5 of 11 = 45%.
    for (const id of ['t-proto', 't-personas']) {
      await taskRow(page, id)
        .getByRole('button', { name: /^Status:/ })
        .click()
      await page.getByRole('menuitemradio', { name: 'Done' }).click()
      await expect(taskRow(page, id)).toHaveCount(0)
    }
    const after = await progressEverywhere(page)
    const expectedAfter = '45% · 5 of 11 tasks done'
    for (const where of ['overview', 'projects', 'header', 'timeline']) {
      expect(after[where]['p-research'], `${where} · Research`).toBe(expectedAfter)
      // Nothing else moved.
      expect(after[where]['p-event'], `${where} · Community Event`).toBe(expectedText('p-event'))
      expect(after[where]['p-roadmap'], `${where} · Roadmap`).toBe(expectedText('p-roadmap'))
    }
    // The Overview counts follow too: two open tasks fewer, two due-today fewer.
    await goVia(page, 'Overview')
    await expectMetrics(page, 5, 12, 6, 2)
    await expectBadge(page, 2, 2)
  })

  test('AC-10: an empty or all-done project is never a made-up 100% or a missing number', async ({
    page,
  }) => {
    // No tasks at all (only a milestone): "No tasks" everywhere. All tasks done: 100%.
    await openApp(page, '/overview')
    const seen = await progressEverywhere(page)
    for (const where of ['overview', 'projects', 'header', 'timeline']) {
      expect(seen[where]['p-biz'], `${where} · Business Development`).toBe('No tasks')
      expect(seen[where]['p-launch'], `${where} · Launch prep`).toBe('100% · 2 of 2 tasks done')
    }
    // The Overview shows no progress bar for the empty project, only the words.
    await goVia(page, 'Overview')
    const row = section(page, 'Active projects')
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: 'Business Development', exact: true }) })
    await expect(row).toContainText('No tasks')
    await expect(row.getByRole('progressbar')).toHaveCount(0)
    // The Projects list's Tasks column counts open / all tasks, subtasks included, and agrees
    // with the Overview's "Open tasks" once archived projects are left out (9 + 4 + 1 + 0 + 0).
    await page.goto('/projects?status=all')
    const table = page.getByRole('table', { name: 'Projects' })
    const openOf = async (name: string) => {
      const text =
        (await table
          .getByRole('row')
          .filter({ has: page.getByRole('link', { name, exact: true }) })
          .getByText(/open of|No tasks/)
          .first()
          .textContent()) ?? ''
      return /(\d+) open of/.exec(text)?.[1] ? Number(/(\d+) open of/.exec(text)?.[1]) : 0
    }
    const counts = {
      Research: await openOf('Research'),
      'Community Event': await openOf('Community Event'),
      'Roadmap 規劃': await openOf('Roadmap 規劃'),
      'Business Development': await openOf('Business Development'),
      'Launch prep': await openOf('Launch prep'),
      'Website redesign': await openOf('Website redesign'),
    }
    expect(counts).toEqual({
      Research: 9,
      'Community Event': 4,
      'Roadmap 規劃': 1,
      'Business Development': 0,
      'Launch prep': 0,
      'Website redesign': 0,
    })
    expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(14)
  })
})

test.describe('AC-12: the Overview mini timeline', () => {
  test('AC-12: the Overview "Next 6 weeks" draws the same dates as the Timeline', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    const mini = section(page, 'Next 6 weeks')
    await expect(mini.getByText('Nov 2 – Dec 13')).toBeVisible()
    // Window = Monday Nov 2 … Sunday Dec 13 = 42 days. Percentages -> days.
    const spans = await mini.getByRole('listitem').evaluateAll((items) =>
      items.map((item) => {
        const span = item.querySelector<HTMLElement>('[data-span]')
        const marks = [...item.querySelectorAll<HTMLElement>('[data-milestone]')].map(
          (mark) => (parseFloat(mark.style.left) * 42) / 100,
        )
        return {
          name: item.textContent?.trim().slice(0, 24) ?? '',
          left: span ? (parseFloat(span.style.left) * 42) / 100 : null,
          // "max(40.5%, 6px)": the percentage inside is the span's width.
          width: span
            ? (parseFloat(/([\d.]+)%/.exec(span.style.width)?.[1] ?? 'NaN') * 42) / 100
            : null,
          marks,
        }
      }),
    )
    const [research, event, roadmap, biz] = spans
    expect(spans).toHaveLength(4)
    // Research (Oct 15 – Dec 14) fills the window from edge to edge.
    expect(research.left).toBeCloseTo(0, 1)
    expect(research.width).toBeCloseTo(42, 1)
    // Community Event ends Nov 18: 17 days into the window; Roadmap ends Nov 10: 9 days.
    expect(event.left).toBeCloseTo(0, 1)
    expect(event.width).toBeCloseTo(17, 1)
    expect(roadmap.left).toBeCloseTo(0, 1)
    expect(roadmap.width).toBeCloseTo(9, 1)
    // Business Development is one day, Nov 25 (the 24th day of the window).
    expect(biz.left).toBeCloseTo(23, 1)
    // Diamonds at the centre of their day: 期末報告繳交 Nov 16, Launch day Dec 4, Review gate
    // today (Nov 4), Partner signing Nov 25. (Kickoff, Oct 30, is before the window.)
    expect(research.marks.map((mark) => Number(mark.toFixed(1)))).toEqual([14.5, 32.5])
    expect(roadmap.marks.map((mark) => Number(mark.toFixed(1)))).toEqual([2.5])
    expect(biz.marks.map((mark) => Number(mark.toFixed(1)))).toEqual([23.5])
    // The Timeline draws the very same end dates: Event ends 35 days after Research starts
    // (Oct 15 → Nov 18), Roadmap 30 days after (Oct 31 → Nov 10 starts 16 days in).
    await mini.getByRole('link', { name: 'Open Timeline' }).click()
    await expect(page).toHaveURL(/\/timeline$/)
    const researchBar = await rect(barOf(page, 'p-research'))
    const eventBar = await rect(barOf(page, 'p-event'))
    const roadmapBar = await rect(barOf(page, 'p-roadmap'))
    expect((eventBar.x + eventBar.width - researchBar.x) / DAY_PX.week).toBeCloseTo(35, 0)
    expect((roadmapBar.x + roadmapBar.width - researchBar.x) / DAY_PX.week).toBeCloseTo(27, 0)
    // …and what is not scheduled is named, not dropped.
    await goVia(page, 'Overview')
    await expect(
      mini.getByText('1 active project with nothing scheduled in these weeks'),
    ).toBeVisible()
  })
})

test.describe('AC-11 / §4.2, §4.3, §4.8, §4.10: a brand-new workspace', () => {
  test('AC-11: Overview, My Tasks, Timeline and Search all say something friendly with no data', async ({
    page,
  }) => {
    await openApp(page, '/overview', [])
    // §4.2: welcome, zero numbers, no fake rows.
    await expect(pageHeading(page, 'Overview')).toBeVisible()
    await expect(page.getByRole('main')).toContainText('Start with a project')
    await expect(page.getByRole('button', { name: 'Create project' })).toBeVisible()
    await expect(page.locator('[data-metric]')).toHaveCount(0) // no numbers made up from nothing
    // §4.3: every tab explains itself instead of showing an empty list.
    await goVia(page, 'My Tasks')
    await expectTabCounts(page, [0, 0, 0, 0])
    for (const [tab, text] of [
      ['Today', 'Nothing due today'],
      ['Upcoming', 'Nothing due in the next 7 days'],
      ['Overdue', 'No overdue tasks'],
      ['All', 'No tasks yet'],
    ] as const) {
      await myTaskTabs(page)
        .getByRole('link', { name: new RegExp(`^${tab}`) })
        .click()
      await expect(page.getByRole('main')).toContainText(text)
    }
    await expect(sidebarMyTasks(page)).toHaveAccessibleName(/^My Tasks$/)
    // §4.8: the Timeline offers to create the first project.
    await goVia(page, 'Timeline')
    await expect(page.getByRole('main')).toContainText(/No projects/i)
    await expect(
      page.getByRole('button', { name: /New project|Create your first project/ }).first(),
    ).toBeVisible()
    // §4.10: search with nothing to find.
    const dialog = await openSearchWithButton(page)
    await search(dialog, 'anything')
    await expect(dialog.getByRole('listbox').getByText('No results for "anything"')).toBeVisible()
  })
})

// ===========================================================================
// §4.2 / §4.3 / §4.8 / §4.10 part by part
// ===========================================================================

/** The text of a download (the backup file). */
async function readDownload(download: Download): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** `count` dated projects with 12 tasks and a milestone each: a workspace too big to show at once. */
function manyProjects(count: number): SeedProject[] {
  const colors = ['violet', 'orange', 'teal', 'blue', 'green', 'pink'] as const
  return Array.from({ length: count }, (_, index) => ({
    id: `p-${index}`,
    name: `Project ${String(index + 1).padStart(2, '0')}`,
    color: colors[index % colors.length],
    start: -30 + index * 3,
    due: 20 + index * 3,
    tasks: Array.from({ length: 12 }, (_unused, task) => ({
      id: `p-${index}-t-${task}`,
      title: `P${index + 1} task ${task + 1}`,
      start: -25 + index * 3 + task * 2,
      due: -22 + index * 3 + task * 2,
      status: task % 3 === 0 ? ('done' as const) : ('todo' as const),
    })),
    milestones: [{ id: `p-${index}-m-0`, name: `P${index + 1} gate`, date: 10 + index * 3 }],
  }))
}

test.describe('§4.2 / §4.3 / §4.8 / §4.10: the pages, part by part', () => {
  test('AC-10: §4.2 the Overview has the wireframe parts, real numbers, only active projects, and every link goes somewhere', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    const main = page.getByRole('main')
    await expect(pageHeading(page, 'Overview')).toBeVisible()
    await expect(main.getByText('Wednesday, November 4, 2026')).toBeVisible()

    // [+ New project] is on the page and opens the project dialog (Esc leaves it).
    await main.getByRole('button', { name: 'New project' }).click()
    const newProject = page.getByRole('dialog', { name: /New project/ })
    await expect(newProject).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(newProject).toBeHidden()

    // The four numbers come from the hand-counted data and say what they count.
    await expectMetrics(page, 5, 14, 8, 2)
    await expect(page.locator('[data-metric="soon"] dt')).toHaveText('Due soon · next 7 days')

    // Active projects: active only (not completed, not archived), in project order, each with
    // its own progress (AC-10); the section's link shows them all.
    const active = section(page, 'Active projects')
    await expect(active.getByRole('listitem')).toHaveText([
      /^Research/,
      /^Community Event/,
      /^Roadmap 規劃/,
      /^Business Development/,
      /^Launch prep/,
    ])
    for (const id of ['p-research', 'p-event', 'p-roadmap', 'p-biz', 'p-launch']) {
      expect(await progressText(active, `${NAMES[id]} progress`)).toBe(expectedText(id))
    }
    await expect(main.getByText('Website redesign')).toHaveCount(0)
    await expect(main.getByText('Legacy migration')).toHaveCount(0)

    // Upcoming tasks (overdue, today and the next 7 days, most urgent first) and Upcoming
    // milestones (today … 30 days, by date); an archived project's items are never in them.
    expect(await rowIds(section(page, 'Upcoming tasks'))).toEqual([
      't-report',
      'e-venue',
      't-proto',
      't-personas',
      't-cluster',
      't-synth',
      'e-invite',
      't-survey',
    ])
    const milestones = section(page, 'Upcoming milestones')
    await expect(milestones.getByRole('listitem')).toHaveText([
      /^Review gate.*Roadmap 規劃.*Today/,
      /^期末報告繳交.*Research.*Nov 16/,
      /^Partner signing.*Business Development.*Nov 25/,
      /^Launch day.*Research.*Dec 4/,
    ])
    await expect(main.getByText('Legacy cutover')).toHaveCount(0)
    await expect(main.getByText('Inventory services')).toHaveCount(0)

    // Every link leads to the right page. A task row opens the Task Modal over the Overview.
    await taskRow(page, 't-proto').getByRole('button', { name: 'Review prototype' }).click()
    const modal = page.getByRole('dialog', { name: 'Edit task: Review prototype' })
    await expect(modal).toBeVisible()
    await expect(page).toHaveURL(/\/overview\?task=t-proto$/)
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()

    await active.getByRole('link', { name: 'View all' }).click()
    await expect(page).toHaveURL(/\/projects$/)
    await expect(pageHeading(page, 'Projects')).toBeVisible()
    await goVia(page, 'Overview')
    await section(page, 'Active projects').getByRole('link', { name: 'Community Event' }).click()
    await expect(page).toHaveURL(/\/projects\/p-event\/(list|board|gantt)$/)
    await expect(pageHeading(page, 'Community Event')).toBeVisible()
    await goVia(page, 'Overview')
    await section(page, 'Upcoming milestones')
      .getByRole('link', { name: /Partner signing/ })
      .click()
    await expect(page).toHaveURL(/\/projects\/p-biz\/gantt/)
    await goVia(page, 'Overview')
    await section(page, 'Next 6 weeks').getByRole('link', { name: 'Open Timeline' }).click()
    await expect(page).toHaveURL(/\/timeline$/)
    await expect(pageHeading(page, 'Timeline')).toBeVisible()
  })

  test('AC-11: §4.3 a My Tasks row shows name, project, status, priority and date; the modal is central; an edit shows in every other view', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/overdue')
    const row = taskRow(page, 't-report')
    await expect(row.getByRole('button', { name: 'Finalize report' })).toBeVisible()
    await expect(row.getByRole('link', { name: 'Research' })).toHaveAttribute(
      'href',
      '/projects/p-research',
    )
    await expect(row.getByRole('button', { name: /^Status: In Progress/ })).toBeVisible()
    await expect(row.getByRole('img', { name: 'Priority: High' })).toBeVisible()
    await expect(row.locator('[data-bucket="overdue"]')).toContainText('Nov 1')

    // A click opens the Task Modal in the middle of the window (not a side drawer, not a page).
    await row.getByRole('button', { name: 'Finalize report' }).click()
    const modal = page.getByRole('dialog', { name: 'Edit task: Finalize report' })
    await expect(modal).toBeVisible()
    await expect(page).toHaveURL(/\/my-tasks\/overdue\?task=t-report$/)
    const box = await rect(modal)
    const viewport = page.viewportSize() as { width: number; height: number }
    expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2)
    expect(box.x).toBeGreaterThan(100)
    expect(viewport.width - (box.x + box.width)).toBeGreaterThan(100)

    // Edit name and priority: the priority is saved when picked, the name when the modal closes (Done).
    await modal.getByRole('textbox', { name: 'Task title' }).fill('Finalize the research report')
    await modal.getByRole('button', { name: /^Priority:/ }).click()
    await page.getByRole('menuitemradio', { name: 'Urgent' }).click()
    // The title is stored when the field loses focus, and the dialog's name follows it.
    const open = page.getByRole('dialog', { name: /^Edit task:/ })
    await open.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(open).toBeHidden()

    // The other views follow without a reload: My Tasks, Overview, the project's List, Board and
    // Gantt, the Timeline and the search.
    const renamed = 'Finalize the research report'
    await expect(row.getByRole('button', { name: renamed })).toBeVisible()
    await expect(row.getByRole('img', { name: 'Priority: Urgent' })).toBeVisible()
    await goVia(page, 'Overview')
    await expect(taskRow(page, 't-report').getByRole('button', { name: renamed })).toBeVisible()
    await section(page, 'Upcoming tasks').getByRole('link', { name: 'Research' }).first().click()
    await expect(pageHeading(page, 'Research')).toBeVisible()
    const views = page.getByRole('navigation', { name: 'Project views' })
    await views.getByRole('link', { name: 'List', exact: true }).click()
    await expect(page).toHaveURL(/\/projects\/p-research\/list$/)
    await expect(
      taskRow(page, 't-report').getByRole('button', { name: renamed, exact: true }),
    ).toBeVisible()
    await expect(taskRow(page, 't-report').locator('[aria-label="Priority: Urgent"]')).toBeVisible()
    await views.getByRole('link', { name: 'Board', exact: true }).click()
    await expect(page.locator('[data-task-id="t-report"]')).toContainText(renamed)
    await views.getByRole('link', { name: 'Gantt', exact: true }).click()
    await expect(page.getByRole('main').getByText(renamed).first()).toBeVisible()
    await goVia(page, 'Timeline')
    await page.getByRole('button', { name: /^Expand Research/ }).click()
    await expect(chartOf(page).locator('[data-row-key="task:t-report"]')).toContainText(renamed)
    const dialog = await openSearchWithShortcut(page)
    await search(dialog, 'the research')
    await expect(dialog.getByRole('option')).toHaveText([new RegExp(`^${renamed}.*Research`)])
    await page.keyboard.press('Escape')

    // The edit is stored, not just drawn.
    await page.reload()
    await expect.poll(async () => (await stored(page)).tasks['t-report'].title).toBe(renamed)
  })

  test('AC-11: §4.3 "New task" on My Tasks asks which project the task belongs to', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/all')
    await expectTabCounts(page, [2, 6, 2, 14])
    await page.getByRole('button', { name: 'New task' }).first().click()
    const modal = page.getByRole('dialog', { name: 'New task', exact: true })
    await expect(modal).toBeVisible()
    // The project is a choice the form offers: every project that is still in use (the
    // completed one too), never an archived one.
    await modal.getByRole('button', { name: /^Project:/ }).click()
    await expect(page.getByRole('menuitemradio')).toHaveText([
      /Research/,
      /Community Event/,
      /Roadmap 規劃/,
      /Business Development/,
      /Launch prep/,
      /Website redesign/,
    ])
    await page.getByRole('menuitemradio', { name: 'Business Development' }).click()
    await modal.getByRole('textbox', { name: 'Task title' }).fill('Send the term sheet')
    await pickDate(page, modal, 'Due date', TODAY)
    await modal.getByRole('button', { name: /^Create/ }).click()
    await expect(modal).toBeHidden()
    // It is due today, so it is in Today now and every number moved by one.
    await expectTabCounts(page, [3, 6, 2, 15])
    await expectBadge(page, 5, 2)
    await expect(
      page.locator('[data-task-row]').filter({ hasText: 'Send the term sheet' }),
    ).toContainText('Business Development')
    await goVia(page, 'Overview')
    await expectMetrics(page, 5, 15, 9, 2)
    // …and Business Development has its first task: 0%, a real zero.
    expect(
      await progressText(section(page, 'Active projects'), 'Business Development progress'),
    ).toBe('0% · 0 of 1 tasks done')
  })

  test('AC-12: §4.8 with many projects the Timeline stays one readable row per project until you open one', async ({
    page,
  }) => {
    await openApp(page, '/timeline', manyProjects(40))
    await expect(chartOf(page)).toBeVisible()
    await expect(barOf(page, 'p-0')).toBeVisible()
    // One row per project, from the first on: nothing is expanded, so no task or milestone row
    // exists (the chart only draws the rows near the window, so not all 40 are in the page yet).
    let keys = (await rowKeys(page)).map(String)
    expect(keys.length).toBeGreaterThanOrEqual(15)
    expect(keys.slice(0, 5)).toEqual([
      'project:p-0',
      'project:p-1',
      'project:p-2',
      'project:p-3',
      'project:p-4',
    ])
    expect(keys.every((value) => value.startsWith('project:'))).toBe(true)
    // The page itself never scrolls; the chart scrolls inside its own frame.
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
          document.documentElement.scrollHeight <= document.documentElement.clientHeight,
      ),
    ).toBe(true)
    expect(await chartOf(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    // Rows are one under the other at the same height: none overlaps another.
    const tops = await chartOf(page)
      .locator('[data-row-key^="project:"]')
      .evaluateAll((rows) => rows.map((row) => Math.round(row.getBoundingClientRect().top)))
    const steps = new Set(tops.slice(1).map((top, index) => top - tops[index]))
    expect(steps.size).toBe(1)
    expect([...steps][0]).toBeGreaterThanOrEqual(32)

    // Opening one project adds only its own tasks and its milestone; the other 39 stay closed.
    await page.getByRole('button', { name: /^Expand Project 07/ }).click()
    await expect(chartOf(page).locator('[data-row-key="task:p-6-t-0"]')).toBeVisible()
    keys = (await rowKeys(page)).map(String)
    const opened = keys.filter((value) => /^(task|milestone):/.test(value))
    expect(opened.length).toBeGreaterThanOrEqual(10)
    expect(
      opened.every((value) => value.startsWith('task:p-6-t-') || value === 'milestone:p-6-m-0'),
    ).toBe(true)
    // …right under its own row, before the next project's.
    expect(keys.indexOf('task:p-6-t-0')).toBe(keys.indexOf('project:p-6') + 1)
    expect(keys.indexOf('project:p-7')).toBeGreaterThan(keys.indexOf('task:p-6-t-11'))
    // The last project is reachable by scrolling the chart down.
    await chartOf(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await expect(chartOf(page).locator('[data-row-key="project:p-39"]')).toBeVisible()
    await expect(barOf(page, 'p-39')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Collapse Project 07/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  test('AC-10: §4.10 a backup exported from this workspace brings back every number, date and link', async ({
    page,
  }) => {
    await openApp(page, '/settings/data')
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    const backup = await readDownload(download)

    // A brand-new browser profile (nothing stored): import the file.
    await page.evaluate((storageKey) => localStorage.removeItem(storageKey), LOCAL_WORKSPACE_KEY)
    await page.goto('/settings/data')
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
    await page.getByLabel('Backup file').setInputFiles({
      name: 'backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(backup),
    })
    const dialog = page.getByRole('dialog', { name: 'Import backup' })
    await expect(dialog).toContainText('7') // projects
    await expect(dialog).toContainText('24') // tasks
    await dialog.getByRole('button', { name: 'Import as new copies' }).click()
    await expect(dialog).toBeHidden()

    // Subtasks still point at their parent, so the leaf counts (AC-10) are the same as before…
    await goVia(page, 'Overview')
    await expectMetrics(page, 5, 14, 8, 2)
    const active = section(page, 'Active projects')
    for (const id of ['p-research', 'p-event', 'p-roadmap', 'p-biz', 'p-launch']) {
      expect(await progressText(active, `${NAMES[id]} progress`)).toBe(expectedText(id))
    }
    // …the dates did not move (AC-11)…
    await goVia(page, 'My Tasks')
    await expectTabCounts(page, [2, 6, 2, 14])
    await openTab(page, 'Today')
    await expect(page.locator('[data-task-row]')).toHaveText([
      /Review prototype/,
      /Synthesize findings.*Write personas/,
    ])
    // …and the Timeline (AC-12) and the search find the same things as before.
    await goVia(page, 'Timeline')
    await expect(chartOf(page)).toBeVisible()
    const rows = chartOf(page).locator('[data-row-key^="project:"]')
    await expect(rows).toHaveCount(5)
    await expect(rows.nth(0)).toContainText('27%')
    await expect(rows.nth(0)).toContainText('3 milestones')
    await expect(rows.nth(2)).toContainText('66%')
    await expect(rows.nth(3)).toContainText('No tasks')
    const search1 = await openSearchWithShortcut(page)
    await search(search1, '期末報告')
    await expect(search1.getByRole('option')).toHaveCount(4) // project, 2 tasks, milestone
  })

  test('AC-11: §4.10 Settings: account, appearance, sync status, backups; local mode says so and has nothing to sign out of', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    // The sidebar says where the data lives, on every page.
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toContainText(
      'Local only — not synced',
    )
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/account$/)
    const main = page.getByRole('main')
    await expect(main).toContainText('Local mode — data stays in this browser')
    await expect(main).toContainText('there is nothing to sign out of')
    await expect(main.getByRole('button', { name: /Sign out/ })).toHaveCount(0)

    await main.getByRole('link', { name: 'Appearance', exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/appearance$/)
    await main.getByRole('radio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(main.getByRole('radio', { name: 'Monday' })).toBeChecked()
    await expect(main).toContainText('Today is Wednesday, November 4, 2026 in Asia/Taipei')
    await page.reload()
    await expect(page.locator('html')).toHaveClass(/dark/) // the choice is kept

    await page.getByRole('main').getByRole('link', { name: 'Data', exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/data$/)
    await expect(main).toContainText('Sync status')
    await expect(main).toContainText('Stored in this browser only')
    await expect(main.getByRole('button', { name: 'Export JSON backup' })).toBeEnabled()
    await expect(main.getByRole('button', { name: 'Export tasks CSV' })).toBeEnabled()
    await expect(main.getByRole('button', { name: 'Import backup…' })).toBeEnabled()
  })
})

// ===========================================================================
// AC-10 / AC-11 / AC-12  The structure of the data changes under the numbers
// ===========================================================================

/** What every progress bar says for `done` of `total` leaf tasks (rounded down). */
function progressLabel(done: number, total: number): string {
  return `${Math.floor((done * 100) / total)}% · ${done} of ${total} tasks done`
}

const projectHeader = (page: Page) => page.locator('[data-slot="page-header"]')

/**
 * Research's progress on the project header (the page must be Research's List), the Overview, the
 * Projects list and the Timeline, all read from the pages themselves. Ends on the Timeline.
 */
async function expectResearchProgress(page: Page, done: number, total: number): Promise<void> {
  const text = progressLabel(done, total)
  await expect(
    projectHeader(page).getByRole('progressbar', { name: 'Project progress' }),
  ).toHaveAttribute('aria-valuetext', text)
  await goVia(page, 'Overview')
  await expect(
    section(page, 'Active projects').getByRole('progressbar', { name: 'Research progress' }),
  ).toHaveAttribute('aria-valuetext', text)
  await goVia(page, 'Projects')
  await expect(
    page.getByRole('table', { name: 'Projects' }).getByRole('progressbar', {
      name: 'Research progress',
    }),
  ).toHaveAttribute('aria-valuetext', text)
  await goVia(page, 'Timeline')
  await expect(
    chartOf(page).getByRole('link', { name: 'Research', exact: true }),
  ).toHaveAccessibleDescription(
    new RegExp(`${done} of ${total} tasks done · ${Math.floor((done * 100) / total)}%`),
  )
}

/** Ids of the stored tasks with this title (new tasks get generated ids). */
async function taskIdsTitled(page: Page, title: string): Promise<string[]> {
  const { tasks } = await stored(page)
  return Object.entries(tasks)
    .filter(([, task]) => task.title === title)
    .map(([id]) => id)
}

/**
 * The Task Modal is really gone: its address lost `?task=` and no dialog is left. (A role query
 * alone is not enough: while a menu or a confirmation is open on top, the modal beneath it is
 * aria-hidden and would "disappear" for `getByRole` too early.)
 */
async function expectTaskModalClosed(page: Page): Promise<void> {
  await expect(page).not.toHaveURL(/[?&]task=/)
  await expect(page.locator('[role="dialog"], [role="alertdialog"], [role="menu"]')).toHaveCount(0)
}

/** Deletes the task whose modal is open (a leaf: one confirmation, no subtask question). */
async function deleteOpenTask(page: Page, title: string): Promise<void> {
  const modal = page.getByRole('dialog', { name: `Edit task: ${title}` })
  await expect(modal).toBeVisible()
  await modal.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: /Delete task/ }).click()
  await page
    .getByRole('alertdialog', { name: 'Delete task?' })
    .getByRole('button', { name: 'Delete' })
    .click()
  await expectTaskModalClosed(page)
}

test.describe('AC-10: the hierarchy changes under the progress', () => {
  test('AC-10: a task that gets subtasks hands its share to them and takes it back when the last one is deleted', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    // "Inbox idea" is an open leaf of Research: 3 of 11. (A modal makes the rest of the page
    // inert, so boot on the list first and open the task by its address afterwards.)
    await openApp(page, '/projects/p-research/list')
    await page.goto('/projects/p-research/list?task=t-inbox')
    const modal = page.getByRole('dialog', { name: 'Edit task: Inbox idea' })
    const subtasks = modal.getByRole('region', { name: 'Subtasks' })
    const add = subtasks.getByRole('textbox', { name: 'Add subtask' })
    // The header behind the modal follows each change (it is aria-hidden while the modal is open).
    const headerBar = projectHeader(page).getByRole('progressbar', {
      name: 'Project progress',
      includeHidden: true,
    })
    await expect(headerBar).toHaveAttribute('aria-valuetext', progressLabel(3, 11))

    // Its first subtask takes over its place: still 11 leaves, "Inbox idea" no longer counts.
    await add.fill('Sort the inbox')
    await add.press('Enter')
    await expect(
      subtasks.getByRole('button', { name: 'Sort the inbox', exact: true }),
    ).toBeVisible()
    await expect(add).toHaveValue('')
    await expect(headerBar).toHaveAttribute('aria-valuetext', progressLabel(3, 11))
    // The second one is one more leaf: 3 of 12.
    await add.fill('Archive the inbox')
    await add.press('Enter')
    await expect(
      subtasks.getByRole('button', { name: 'Archive the inbox', exact: true }),
    ).toBeVisible()
    await expect(headerBar).toHaveAttribute('aria-valuetext', progressLabel(3, 12))
    // Finishing one subtask: 4 of 12. The parent itself stays open and never counts.
    await subtasks.getByRole('button', { name: /^Status of “Sort the inbox”/ }).click()
    await page.getByRole('menuitemradio', { name: /Done/ }).click()
    await expect(headerBar).toHaveAttribute('aria-valuetext', progressLabel(4, 12))
    // The first Escape belongs to the status menu while it is still closing: wait for it.
    await expect(page.locator('[role="menu"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expectTaskModalClosed(page)
    await expectResearchProgress(page, 4, 12)

    // Deleting an open subtask: 4 of 11.
    const [archiveId] = await taskIdsTitled(page, 'Archive the inbox')
    const [sortId] = await taskIdsTitled(page, 'Sort the inbox')
    expect(archiveId).toBeTruthy()
    expect(sortId).toBeTruthy()
    await page.goto(`/projects/p-research/list?task=${archiveId}`)
    await deleteOpenTask(page, 'Archive the inbox')
    await expectResearchProgress(page, 4, 11)

    // Deleting the LAST subtask makes the parent a leaf again: open, so the finished subtask's
    // credit goes with it: 3 of 11, exactly where it started.
    await page.goto(`/projects/p-research/list?task=${sortId}`)
    await deleteOpenTask(page, 'Sort the inbox')
    await expectResearchProgress(page, 3, 11)
    await page.goto('/projects/p-research/list')
    await expect(taskRow(page, 't-inbox')).toBeVisible()
    await expect(
      taskRow(page, 't-inbox').getByRole('button', { name: 'Expand subtasks' }),
    ).toHaveCount(0)
    expect((await stored(page)).tasks['t-inbox']).toMatchObject({ status: 'todo' })
  })

  test('AC-10: deleting a parent but keeping its subtasks changes no progress; the parent leaves My Tasks, the Overview and the search', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await openApp(page, '/projects/p-research/list')
    await page.goto('/projects/p-research/list?task=t-synth')
    const modal = page.getByRole('dialog', { name: 'Edit task: Synthesize findings' })
    await modal.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: /Delete task/ }).click()
    const choice = page.getByRole('alertdialog', { name: /Delete “Synthesize findings”\?/ })
    await expect(choice).toContainText('3 subtasks')
    await choice.getByRole('button', { name: 'Keep subtasks (move to top level)' }).click()
    await expectTaskModalClosed(page)

    // The three subtasks were leaves before and are leaves now: 3 of 11 either way.
    await expectResearchProgress(page, 3, 11)
    // Only the parent (open, due in 2 days) is gone from the counts.
    await goVia(page, 'My Tasks')
    await expectTabCounts(page, [2, 5, 2, 13])
    await expectBadge(page, 4, 2)
    await goVia(page, 'Overview')
    await expectMetrics(page, 5, 13, 7, 2)

    const dialog = await openSearchWithShortcut(page)
    await search(dialog, 'synthesize')
    await expect(dialog.getByRole('listbox').getByText('No results for "synthesize"')).toBeVisible()
    // A kept subtask is a top-level task now: no "in <parent>" any more.
    await search(dialog, 'personas')
    await expect(dialog.getByRole('option')).toHaveCount(1)
    await expect(dialog.getByRole('option').first()).toContainText('Write personas')
    await expect(dialog.getByRole('option').first()).not.toContainText('Synthesize')
    expect((await stored(page)).tasks['t-personas']).toMatchObject({ parentTaskId: null })
  })

  test('AC-10: deleting a parent together with its subtasks takes their share and their dates out of every number', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await openApp(page, '/projects/p-research/list')
    await page.goto('/projects/p-research/list?task=t-synth')
    const modal = page.getByRole('dialog', { name: 'Edit task: Synthesize findings' })
    await modal.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: /Delete task/ }).click()
    await page
      .getByRole('alertdialog', { name: /Delete “Synthesize findings”\?/ })
      .getByRole('button', { name: 'Delete subtasks too' })
      .click()
    await expectTaskModalClosed(page)

    // Gone: Cluster notes, Write personas (open) and Review with team (done): 2 of 8.
    await expectResearchProgress(page, 2, 8)
    // My Tasks: Today loses Write personas, Upcoming loses Cluster notes and the parent, All loses
    // those three open tasks.
    await goVia(page, 'My Tasks')
    await expectTabCounts(page, [1, 4, 2, 11])
    await expectBadge(page, 3, 2)
    await goVia(page, 'Overview')
    await expectMetrics(page, 5, 11, 5, 2)

    const dialog = await openSearchWithShortcut(page)
    for (const gone of ['personas', 'cluster', 'review with team']) {
      await search(dialog, gone)
      await expect(dialog.getByRole('listbox').getByText(`No results for "${gone}"`)).toBeVisible()
    }
    expect(Object.keys((await stored(page)).tasks)).not.toContain('t-cluster')
  })
})

test.describe('AC-11 / AC-12: a project that is deleted', () => {
  test('AC-11: deleting a project takes its tasks out of My Tasks, the Overview, the Timeline and the search', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await openApp(page, '/projects')
    const table = page.getByRole('table', { name: 'Projects' })
    const row = table.getByRole('row').filter({
      has: page.getByRole('link', { name: 'Community Event', exact: true }),
    })
    await row.getByRole('button', { name: 'Actions for Community Event' }).click()
    await page.getByRole('menuitem', { name: 'Delete project…' }).click()
    const confirm = page.getByRole('alertdialog', { name: 'Delete “Community Event”?' })
    // The confirmation says what goes with the project (PRD §5.4).
    await expect(confirm).toContainText('Deletes 5 tasks along with the project.')
    await confirm.getByRole('button', { name: 'Delete project' }).click()
    await expect(toast(page, 'Project deleted')).toBeVisible()
    await expect(row).toHaveCount(0)

    // Open tasks of Community Event: Book venue (overdue), Send invitations and Catering quote
    // (upcoming), Volunteer schedule (later). Confirm speakers was done.
    await goVia(page, 'My Tasks')
    await expectTabCounts(page, [2, 4, 1, 10])
    await expectBadge(page, 3, 1)
    await goVia(page, 'Overview')
    await expectMetrics(page, 4, 10, 6, 1)
    await expect(
      section(page, 'Active projects').getByRole('link', { name: 'Community Event' }),
    ).toHaveCount(0)
    await expect(section(page, 'Upcoming tasks')).not.toContainText('Send invitations')

    await goVia(page, 'Timeline')
    await expect(barOf(page, 'p-research')).toBeVisible()
    await expect(barOf(page, 'p-event')).toHaveCount(0)
    expect(await rowKeys(page)).not.toContain('project:p-event')

    const dialog = await openSearchWithShortcut(page)
    for (const gone of ['catering', 'community event', 'invitations']) {
      await search(dialog, gone)
      await expect(dialog.getByRole('listbox').getByText(`No results for "${gone}"`)).toBeVisible()
    }
    await page.keyboard.press('Escape')

    // Its address and the stored data: a friendly not-found, nothing left behind.
    await page.goto('/projects/p-event/list')
    await expect(page.getByText('Project not found')).toBeVisible()
    const db = await stored(page)
    expect(Object.keys(db.projects)).not.toContain('p-event')
    expect(Object.keys(db.tasks).filter((id) => id.startsWith('e-'))).toEqual([])
  })
})

test.describe('AC-11 / AC-12: the day rolls over while the app stays open', () => {
  test('AC-12: at midnight the Timeline moves its Today marker by one day, without a reload', async ({
    page,
  }) => {
    await openApp(page, '/timeline', seedProjects(), '2026-11-04T23:59:40+08:00')
    await expect(chartOf(page)).toBeVisible()
    await expect(barOf(page, 'p-research')).toBeVisible()
    // Research starts on day -20, so Today is 20 days (16 px each) into its bar; a day later 21.
    const todayFromResearchStart = async () => {
      const research = await rect(barOf(page, 'p-research'))
      const today = await rect(chartOf(page).locator('[data-today-column]'))
      return (today.x - research.x) / DAY_PX.week
    }
    expect(await todayFromResearchStart()).toBeCloseTo(20, 0)

    await page.clock.fastForward(60_000)
    await expect.poll(todayFromResearchStart).toBeCloseTo(21, 0)
    // The numbers beside it moved with the same clock: Thursday's list is Cluster notes; Review
    // prototype and Write personas (due Wednesday) are overdue now, next to the two from before.
    await goVia(page, 'My Tasks')
    await expectTabCounts(page, [1, 6, 4, 14])
  })

  test('AC-12: on Sunday night the Overview slides its six weeks to the new week', async ({
    page,
  }) => {
    // Sunday, November 8: the window is Monday Nov 2 - Sunday Dec 13 until midnight.
    await openApp(page, '/overview', seedProjects(), '2026-11-08T23:59:40+08:00')
    const mini = section(page, 'Next 6 weeks')
    await expect(mini.getByText('Nov 2 – Dec 13')).toBeVisible()
    await page.clock.fastForward(60_000)
    await expect(mini.getByText('Nov 9 – Dec 20')).toBeVisible()
    await expect(page.getByText('Monday, November 9, 2026')).toBeVisible()
  })
})
