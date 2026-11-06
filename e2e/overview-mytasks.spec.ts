/// <reference lib="dom" />
/**
 * Overview + My Tasks E2E — LOCAL data mode against the dev server (playwright.config.ts).
 *
 * PRD acceptance §9.1: #1 a friendly empty first run, #10 project progress from completed leaf
 * tasks (milestones never count), #11 My Tasks shows today / upcoming / overdue. Also covered:
 * every number and list agreeing between the Overview, My Tasks and the sidebar badge (one set of
 * bucket rules), status changes in place with Undo, the keyboard path, New task from Today, the
 * time zone preference deciding "today" (PRD §5.3), a large workspace, a narrow window, text
 * contrast in light and dark, and the failure paths (a failed save rolls back, offers Retry and
 * never claims success; a slow save shows "Saving…").
 *
 * "Today" is pinned to Wednesday, November 4, 2026, so the dates in the seed are stable.
 */
import { expect, test as base, type Locator, type Page } from '@playwright/test'

const LOCAL_WORKSPACE_KEY = 'cairn:local:workspace:v1'
/** The app's "today" in every test (Taipei, mid-morning). */
const NOW = '2026-11-04T10:00:00+08:00'
const TODAY = '2026-11-04'
const TIME_ZONE = 'Asia/Taipei'
const STAMP = '2026-11-03T08:00:00.000Z'

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
test.use({ timezoneId: TIME_ZONE, locale: 'en-US', viewport: { width: 1280, height: 800 } })

// ---------------------------------------------------------------------------
// Seed: a local "database" written to localStorage before the app boots
// ---------------------------------------------------------------------------

type Status = 'todo' | 'in_progress' | 'done'
type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

interface SeedTask {
  id: string
  title: string
  /** Due date, in days from today. */
  due?: number
  status?: Status
  priority?: Priority
  /** Id of the parent task (a subtask). */
  parent?: string
  completedAt?: string
}

interface SeedProject {
  id: string
  name: string
  description?: string
  status?: 'active' | 'completed' | 'archived'
  color?: string
  /** Start / due date, in days from today. */
  start?: number
  due?: number
  /** In project order. */
  tasks?: SeedTask[]
  milestones?: { id: string; name: string; date: number }[]
}

interface SeedPreferences {
  theme: 'system' | 'light' | 'dark'
  sidebarCollapsed: boolean
  timezone: string
  weekStartsOn: 0 | 1
}
const PREFERENCES: SeedPreferences = {
  theme: 'system',
  sidebarCollapsed: false,
  timezone: TIME_ZONE,
  weekStartsOn: 1,
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

function buildWorkspace(
  projects: SeedProject[],
  preferences: SeedPreferences = PREFERENCES,
): unknown {
  const db = {
    version: 1,
    projects: {} as Record<string, unknown>,
    phases: {},
    tasks: {} as Record<string, unknown>,
    milestones: {} as Record<string, unknown>,
    dependencies: {},
    preferences,
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
        description: null,
        status: task.status ?? 'todo',
        priority: task.priority ?? 'none',
        startDate: null,
        dueDate: task.due === undefined ? null : day(task.due),
        sortOrder: key(index),
        completedAt: task.status === 'done' ? (task.completedAt ?? STAMP) : null,
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

const LONG_CJK = '市場調查與使用者訪談計畫的第一階段細節整理與報告撰寫（含訪談逐字稿與主題編碼）'
const LONG_EN =
  'Write a really long English task title that should truncate gracefully when the row runs out of horizontal space in the list view'

/**
 * Today is Wed Nov 4. Open tasks: 3 overdue (Finalize report, the long CJK one, Book venue),
 * 3 due today (Review prototype, Write personas, 問卷設計), 6 due in the next 7 days (the last one,
 * Catering quote, exactly on day 7), 2 later (day 8 and 20) and 1 without a date = 15. Three
 * tasks are done. Research has 9 leaf tasks (Synthesize findings is a parent) of which 2 are
 * done: 22%. The archived project has an overdue task and a milestone that must never show.
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
          due: -3,
          priority: 'high',
          status: 'in_progress',
        },
        { id: 't-proto', title: 'Review prototype', due: 0, priority: 'urgent' },
        {
          id: 't-interview',
          title: 'Interview users',
          due: -10,
          status: 'done',
          completedAt: '2026-11-02T08:00:00.000Z',
        },
        { id: 't-synth', title: 'Synthesize findings', due: 2, priority: 'medium' },
        { id: 't-cluster', title: 'Cluster notes', due: 1, parent: 't-synth' },
        { id: 't-personas', title: 'Write personas', due: 0, priority: 'low', parent: 't-synth' },
        {
          id: 't-review',
          title: 'Review with team',
          due: -1,
          status: 'done',
          parent: 't-synth',
          completedAt: '2026-11-03T08:00:00.000Z',
        },
        { id: 't-survey', title: 'Draft survey', due: 5 },
        { id: 't-retro', title: 'Plan retro', due: 20 },
        { id: 't-inbox', title: 'Inbox idea' },
      ],
      milestones: [
        { id: 'm-kickoff', name: 'Kickoff', date: -5 },
        { id: 'm-submit', name: 'Submission deadline', date: 8 },
        { id: 'm-launch', name: 'Launch', date: 30 },
        { id: 'm-freeze', name: 'Beta freeze', date: 31 },
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
          due: 3,
          priority: 'medium',
          status: 'in_progress',
        },
        { id: 'e-catering', title: 'Catering quote', due: 7 },
        { id: 'e-volunteer', title: 'Volunteer schedule', due: 8 },
      ],
    },
    {
      id: 'p-cjk',
      name: 'Roadmap 規劃',
      description: '市場調查與使用者訪談計畫',
      color: 'teal',
      tasks: [
        { id: 'c-1', title: '問卷設計', due: 0 },
        { id: 'c-2', title: LONG_CJK, due: -2 },
        { id: 'c-3', title: LONG_EN, due: 1 },
      ],
      milestones: [{ id: 'm-gate', name: 'Review gate', date: 0 }],
    },
    { id: 'p-biz', name: 'Business Development', color: 'blue', description: 'Partnerships' },
    {
      id: 'p-web',
      name: 'Website redesign',
      color: 'green',
      status: 'completed',
      tasks: [
        {
          id: 'w-1',
          title: 'Wireframes',
          due: -30,
          status: 'done',
          completedAt: '2026-10-01T08:00:00.000Z',
        },
      ],
    },
    {
      id: 'p-old',
      name: 'Legacy migration',
      color: 'gray',
      status: 'archived',
      tasks: [{ id: 'o-1', title: 'Inventory services', due: -20 }],
      milestones: [{ id: 'm-cutover', name: 'Legacy cutover', date: 3 }],
    },
  ]
}

/** Boots the app at `path`; the workspace is seeded once per tab (a reload keeps the changes). */
async function openApp(
  page: Page,
  path: string,
  projects: SeedProject[] = seedProjects(),
  preferences: SeedPreferences = PREFERENCES,
  /** A clock that keeps running from this moment (fast-forwardable); default: frozen at NOW. */
  startAt?: string,
): Promise<void> {
  if (startAt) await page.clock.install({ time: new Date(startAt) })
  else await page.clock.setFixedTime(NOW)
  await page.addInitScript(
    ({ storageKey, db }) => {
      if (sessionStorage.getItem('cairn-e2e-overview-mytasks-seeded')) return
      localStorage.setItem(storageKey, JSON.stringify(db))
      sessionStorage.setItem('cairn-e2e-overview-mytasks-seeded', '1')
    },
    { storageKey: LOCAL_WORKSPACE_KEY, db: buildWorkspace(projects, preferences) },
  )
  await page.goto(path)
}

type TestHooks = { failNextWrites(count: number): void; setLatency(ms: number): void }

function failNextWrites(page: Page, count: number): Promise<void> {
  return page.evaluate((n) => {
    ;(window as Window & { __cairnTest?: TestHooks }).__cairnTest?.failNextWrites(n)
  }, count)
}

function setLatency(page: Page, ms: number): Promise<void> {
  return page.evaluate((value) => {
    ;(window as Window & { __cairnTest?: TestHooks }).__cairnTest?.setLatency(value)
  }, ms)
}

interface StoredWorkspace {
  tasks: Record<
    string,
    {
      projectId: string
      title: string
      status: string
      priority: string
      dueDate: string | null
      completedAt: string | null
    }
  >
}

/** What the local "database" holds right now (the source of truth after a reload). */
function stored(page: Page): Promise<StoredWorkspace> {
  return page.evaluate(
    (storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? '{}') as StoredWorkspace,
    LOCAL_WORKSPACE_KEY,
  )
}

async function storedStatus(page: Page, id: string): Promise<string | undefined> {
  return (await stored(page)).tasks[id]?.status
}

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

const pageHeading = (page: Page, name: string) => page.getByRole('heading', { name, level: 1 })
const pageHeader = (page: Page) => page.locator('[data-slot="page-header"]')
const taskRow = (page: Page, id: string) => page.locator(`[data-task-row="${id}"]`)
const openButton = (page: Page, id: string) => taskRow(page, id).locator('[data-row-open]')
const statusButton = (page: Page, id: string, label?: string) =>
  taskRow(page, id).getByRole('button', { name: label ? `Status: ${label}` : /^Status:/ })
const metric = (page: Page, name: 'active' | 'open' | 'soon' | 'overdue') =>
  page.locator(`[data-metric="${name}"] dd`)
const sidebarMyTasks = (page: Page) => page.locator('a[href="/my-tasks"]')
const tabs = (page: Page) => page.getByRole('navigation', { name: 'My Tasks' })
const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })
const editModal = (page: Page, title: string) =>
  page.getByRole('dialog', { name: `Edit task: ${title}` })
const newTaskModal = (page: Page) => page.getByRole('dialog', { name: 'New task', exact: true })
const titleBox = (modal: Locator) => modal.getByRole('textbox', { name: 'Task title' })
/** The sidebar's "Saving…" line. */
const saving = (page: Page) => page.getByText('Saving…', { exact: true })

/**
 * How far the focused row is clear of the sticky view bar and section heading (top) and of the
 * bottom edge of the scrolling page (bottom); negative = partly hidden.
 */
function focusClearance(page: Page): Promise<{ top: number; bottom: number }> {
  return page.evaluate(() => {
    const row = document.activeElement?.closest('li')
    const scroller = document.querySelector('[data-slot="page"]')
    const viewBar = document.querySelector('[data-slot="view-bar"]')
    if (!row || !scroller || !viewBar) throw new Error('no focused row')
    const box = row.getBoundingClientRect()
    let stickyBottom = viewBar.getBoundingClientRect().bottom
    for (const heading of scroller.querySelectorAll('h2')) {
      const head = heading.getBoundingClientRect()
      // The heading that is stuck right below the view bar.
      if (Math.abs(head.top - stickyBottom) < 1.5)
        stickyBottom = Math.max(stickyBottom, head.bottom)
    }
    return {
      top: box.top - stickyBottom,
      bottom: scroller.getBoundingClientRect().bottom - box.bottom,
    }
  })
}

/** Task ids of the rows inside `scope`, in DOM order. */
function rowIds(scope: Locator): Promise<(string | null)[]> {
  return scope
    .locator('[data-task-row]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-task-row')))
}

/** The four My Tasks tabs read Today / Upcoming / Overdue / All Tasks with these counts. */
async function expectTabCounts(page: Page, counts: [number, number, number, number]) {
  const [today, upcoming, overdue, all] = counts
  await expect(tabs(page).getByRole('link')).toHaveText([
    new RegExp(`^Today\\s*${today}\\b`),
    new RegExp(`^Upcoming\\s*${upcoming}\\b`),
    new RegExp(`^Overdue\\s*${overdue}\\b`),
    new RegExp(`^All Tasks\\s*${all}\\b`),
  ])
}

/** The sidebar badge says how many tasks are due today or overdue (spoken text). */
async function expectBadge(page: Page, total: number, overdue: number) {
  await expect(sidebarMyTasks(page)).toHaveAccessibleName(
    new RegExp(`${total} due today or overdue \\(${overdue} overdue\\)`),
  )
}

/** Text in the page content (and the sidebar's My Tasks count) below WCAG AA contrast. */
function lowContrastText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Rgba = { r: number; g: number; b: number; a: number }
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return ['no canvas']
    // The canvas turns any CSS colour syntax (rgb, oklch, color-mix…) into plain RGBA.
    const parse = (css: string): Rgba => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = css
      context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      return { r, g, b, a: a / 255 }
    }
    const over = (top: Rgba, bottom: Rgba): Rgba => {
      const a = top.a + bottom.a * (1 - top.a)
      if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
      const mix = (k: 'r' | 'g' | 'b') => (top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / a
      return { r: mix('r'), g: mix('g'), b: mix('b'), a }
    }
    const luminance = ({ r, g, b }: Rgba) => {
      const channel = (c: number) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    const ratio = (a: Rgba, b: Rgba) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (light + 0.05) / (dark + 0.05)
    }
    const backgroundOf = (element: Element): Rgba => {
      const layers: Rgba[] = []
      for (let node: Element | null = element; node; node = node.parentElement) {
        const layer = parse(getComputedStyle(node).backgroundColor)
        if (layer.a > 0) layers.push(layer)
        if (layer.a >= 1) break
      }
      let color = over(parse(getComputedStyle(document.body).backgroundColor), {
        r: 255,
        g: 255,
        b: 255,
        a: 1,
      })
      for (const layer of layers.reverse()) color = over(layer, color)
      return color
    }
    const failures: string[] = []
    // The page itself and the sidebar's My Tasks link (its red count sits on the tinted active row).
    const roots = [
      document.querySelector('[data-slot="page"]'),
      document.querySelector('a[href="/my-tasks"]'),
    ].filter((root): root is Element => root !== null)
    const seen = new Set<Element>()
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent?.trim()
        const element = walker.currentNode.parentElement
        if (!text || !element || seen.has(element)) continue
        seen.add(element)
        const box = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue
        if (element.closest('.sr-only, [aria-hidden="true"] .sr-only, :disabled')) continue
        let faded = 1
        for (let node: Element | null = element; node; node = node.parentElement) {
          faded *= Number(getComputedStyle(node).opacity)
        }
        if (faded < 0.95) continue
        const background = backgroundOf(element)
        let foreground = parse(style.color)
        if (foreground.a < 1) foreground = over(foreground, background)
        const large = parseFloat(style.fontSize) >= 24
        const value = ratio(foreground, background)
        if (value < (large ? 3 : 4.5)) failures.push(`${text.slice(0, 40)} (${value.toFixed(2)}:1)`)
      }
    }
    return failures
  })
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

test.describe('overview', () => {
  test('shows the numbers, the active projects, what is coming up and a small timeline from real data', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    await expect(pageHeading(page, 'Overview')).toBeVisible()
    await expect(page.getByText('Wednesday, November 4, 2026')).toBeVisible()

    // Four calm numbers; overdue is the only one that takes the danger tone.
    await expect(metric(page, 'active')).toHaveText('4')
    await expect(metric(page, 'open')).toHaveText('15')
    await expect(metric(page, 'soon')).toHaveText('9')
    await expect(metric(page, 'overdue')).toHaveText('3')
    await expect(metric(page, 'overdue')).toHaveClass(/text-danger/)
    await expect(metric(page, 'open')).not.toHaveClass(/text-danger/)

    // Active projects only, in project order. Progress counts completed leaf tasks: 2 of the 9
    // leaves of Research (its parent task and its four milestones never count); no tasks → "No
    // tasks", never a made-up 100%.
    const projects = section(page, 'Active projects')
    await expect(
      projects.getByRole('list', { name: 'Active projects' }).getByRole('link'),
    ).toHaveText(['Research', 'Community Event', 'Roadmap 規劃', 'Business Development'])
    await expect(projects.getByRole('progressbar', { name: 'Research progress' })).toHaveAttribute(
      'aria-valuetext',
      '22% · 2 of 9 tasks done',
    )
    await expect(
      projects.getByRole('progressbar', { name: 'Community Event progress' }),
    ).toHaveAttribute('aria-valuenow', '0')
    const projectRow = (name: string) =>
      projects.getByRole('listitem').filter({ has: page.getByRole('link', { name, exact: true }) })
    await expect(projectRow('Research')).toContainText('Due Dec 14')
    await expect(projectRow('Community Event')).toContainText('Due Nov 18')
    await expect(projectRow('Business Development')).toContainText('No tasks')
    await expect(projectRow('Business Development').getByRole('progressbar')).toHaveCount(0)
    await expect(projects).not.toContainText('Website redesign')
    await expect(projects).not.toContainText('Legacy migration')

    // Upcoming tasks: overdue first, then today, then the next 7 days; at most 8 of the 12.
    const upcoming = section(page, 'Upcoming tasks')
    await expect
      .poll(() => rowIds(upcoming))
      .toEqual(['t-report', 'c-2', 'e-venue', 't-proto', 't-personas', 'c-1', 't-cluster', 'c-3'])
    await expect(upcoming.getByText('Showing 8 of 12')).toBeVisible()
    await expect(upcoming.getByRole('link', { name: 'View all in My Tasks' })).toBeVisible()
    // Overdue and due-today state is in the text, not only the colour.
    await expect(taskRow(page, 't-report').locator('[data-bucket="overdue"]')).toHaveText(
      /^Nov 1\s*\(overdue\)$/,
    )
    await expect(taskRow(page, 'e-venue').locator('[data-bucket="overdue"]')).toContainText(
      'Yesterday',
    )
    await expect(taskRow(page, 't-proto').locator('[data-bucket="today"]')).toHaveText('Today')
    await expect(taskRow(page, 'c-3').locator('[data-bucket="upcoming"]')).toHaveText('Tomorrow')
    // A subtask is shown with its parent; the project (dot + name) is on every row.
    await expect(openButton(page, 't-personas')).toHaveAccessibleName(
      /^Subtask of Synthesize findings\s*:\s*Write personas$/,
    )
    await expect(taskRow(page, 't-personas').getByRole('link', { name: 'Research' })).toBeVisible()
    // Long titles truncate inside the row instead of widening the page.
    await expect(openButton(page, 'c-2')).toHaveAccessibleName(LONG_CJK)

    // Milestones: today … day 30 of active projects, by date. Day 31, the past and an archived
    // project's milestone are left out.
    const milestones = section(page, 'Upcoming milestones')
    await expect(milestones.getByRole('list').getByRole('link')).toHaveText([
      'Review gate',
      'Submission deadline',
      'Launch',
    ])
    await expect(milestones.getByRole('listitem').first()).toContainText('Today')
    await expect(milestones.getByRole('listitem').nth(1)).toContainText('Nov 12')
    await expect(milestones.getByRole('listitem').nth(2)).toContainText('Dec 4')

    // "Next 6 weeks": one thin read-only row per project with something in the window.
    const timeline = section(page, 'Next 6 weeks')
    await expect(timeline.getByText('Nov 2 – Dec 13')).toBeVisible()
    const timelineRows = timeline.getByRole('list', { name: /^Projects,/ }).getByRole('listitem')
    await expect(timelineRows).toHaveCount(3)
    await expect(timeline.locator('[data-span]')).toHaveCount(3)
    await expect(timeline.locator('[data-milestone]')).toHaveCount(4)
    await expect(
      timeline.getByText('1 active project with nothing scheduled in these weeks'),
    ).toBeVisible()
    await expect(timeline.getByRole('link', { name: 'Open Timeline' })).toBeVisible()
    // Nothing on the dashboard is editable like a Gantt: no drag handles, no inputs.
    await expect(timeline.getByRole('slider')).toHaveCount(0)
    await expect(timeline.locator('input, [draggable="true"]')).toHaveCount(0)
  })

  test('the Overview, My Tasks and the sidebar badge all use the same definitions', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    await expect(metric(page, 'open')).toHaveText('15')
    await expectBadge(page, 6, 3)
    const number = async (name: 'open' | 'soon' | 'overdue') =>
      Number(await metric(page, name).innerText())
    const [open, soon, overdue] = [
      await number('open'),
      await number('soon'),
      await number('overdue'),
    ]

    // The tab counts are read from the page itself.
    await page.getByRole('link', { name: 'View all in My Tasks' }).click()
    await expect(page).toHaveURL(/\/my-tasks\/all$/)
    await expect(tabs(page).getByRole('link')).toHaveCount(4)
    const counts = await tabs(page)
      .getByRole('link')
      .evaluateAll((links) =>
        links.map((link) => Number(/^\D+(\d+)/.exec(link.textContent ?? '')?.[1] ?? Number.NaN)),
      )
    const [today, upcoming, overdueTab, all] = counts
    expect(all).toBe(open)
    expect(today + upcoming).toBe(soon)
    expect(overdueTab).toBe(overdue)
    // The sidebar badge is overdue + today.
    await expectBadge(page, overdueTab + today, overdueTab)

    // The Overview's "View all" lands on the All tab, whose Overdue / Today / Upcoming sections
    // start with the same tasks, in the same order, as the Overview list.
    await expectTabCounts(page, [3, 6, 3, 15])
    const all12 = [
      ...(await rowIds(section(page, 'Overdue , 3 tasks'))),
      ...(await rowIds(section(page, 'Today , 3 tasks'))),
      ...(await rowIds(section(page, 'Upcoming , 6 tasks'))),
    ]
    expect(all12).toHaveLength(12)
    expect(all12.slice(0, 8)).toEqual([
      't-report',
      'c-2',
      'e-venue',
      't-proto',
      't-personas',
      'c-1',
      't-cluster',
      'c-3',
    ])
  })

  test('links lead where they say; a row opens the Task Modal', async ({ page }) => {
    await openApp(page, '/overview')
    const projects = section(page, 'Active projects')
    await expect(pageHeading(page, 'Overview')).toBeVisible()

    await projects.getByRole('link', { name: 'Community Event' }).click()
    await expect(page).toHaveURL(/\/projects\/p-event\/list$/)

    await page.goto('/overview')
    // The whole project row is the click target, not only its name.
    await projects
      .getByRole('listitem')
      .filter({ hasText: 'Roadmap 規劃' })
      .click({ position: { x: 420, y: 12 } })
    await expect(page).toHaveURL(/\/projects\/p-cjk\/list$/)

    await page.goto('/overview')
    await projects.getByRole('link', { name: 'View all' }).click()
    await expect(page).toHaveURL(/\/projects$/)

    await page.goto('/overview')
    await taskRow(page, 't-report').getByRole('link', { name: 'Research' }).click()
    await expect(page).toHaveURL(/\/projects\/p-research\/list$/)

    await page.goto('/overview')
    await section(page, 'Upcoming milestones')
      .getByRole('link', { name: 'Submission deadline' })
      .click()
    await expect(page).toHaveURL(/\/projects\/p-research\/gantt$/)

    await page.goto('/overview')
    await section(page, 'Next 6 weeks')
      .getByRole('list', { name: /^Projects,/ })
      .getByRole('link', { name: 'Community Event' })
      .click()
    await expect(page).toHaveURL(/\/projects\/p-event\/gantt$/)

    await page.goto('/overview')
    await section(page, 'Next 6 weeks').getByRole('link', { name: 'Open Timeline' }).click()
    await expect(page).toHaveURL(/\/timeline$/)

    // A task row (its title, or anywhere on the row) opens the modal through ?task=.
    await page.goto('/overview')
    await openButton(page, 't-proto').click()
    await expect(page).toHaveURL(/[?&]task=t-proto\b/)
    await expect(editModal(page, 'Review prototype')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(editModal(page, 'Review prototype')).toBeHidden()
    await expect(page).toHaveURL(/\/overview$/)
    await taskRow(page, 'c-1').click({ position: { x: 150, y: 10 } })
    await expect(editModal(page, '問卷設計')).toBeVisible()
  })

  test('New project opens the project dialog', async ({ page }) => {
    await openApp(page, '/overview')
    await pageHeader(page).getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('textbox').first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  test('a status changed in place: the row leaves, every number follows, Undo brings it back', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    const upcoming = section(page, 'Upcoming tasks')
    await expect(taskRow(page, 't-proto')).toBeVisible()
    await expectBadge(page, 6, 3)

    await statusButton(page, 't-proto', 'To Do').click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()

    await expect(taskRow(page, 't-proto')).toHaveCount(0)
    await expect(metric(page, 'open')).toHaveText('14')
    await expect(metric(page, 'soon')).toHaveText('8')
    await expect(metric(page, 'overdue')).toHaveText('3')
    await expectBadge(page, 5, 3)
    // The next task slides into the eighth place: 8 shown of 11.
    await expect(upcoming.getByText('Showing 8 of 11')).toBeVisible()
    await expect(taskRow(page, 'c-3')).toBeVisible()
    await expect(toast(page, 'Marked as done')).toContainText('Review prototype')
    await expect.poll(() => storedStatus(page, 't-proto')).toBe('done')
    // Progress follows the leaf task that is now done: 3 of 9.
    await expect(
      section(page, 'Active projects').getByRole('progressbar', { name: 'Research progress' }),
    ).toHaveAttribute('aria-valuetext', '33% · 3 of 9 tasks done')

    await toast(page, 'Marked as done').getByRole('button', { name: 'Undo' }).click()
    await expect(taskRow(page, 't-proto')).toBeVisible()
    await expect(metric(page, 'open')).toHaveText('15')
    await expect(metric(page, 'soon')).toHaveText('9')
    await expect(upcoming.getByText('Showing 8 of 12')).toBeVisible()
    await expect.poll(() => storedStatus(page, 't-proto')).toBe('todo')
    await expectBadge(page, 6, 3)

    // Done again, then a reload: the task stays done and the numbers are the same.
    await statusButton(page, 't-proto', 'To Do').click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect(taskRow(page, 't-proto')).toHaveCount(0)
    await page.reload()
    await expect(metric(page, 'open')).toHaveText('14')
    await expect(taskRow(page, 't-proto')).toHaveCount(0)
    await expect(taskRow(page, 't-report')).toBeVisible()
  })

  test('a failed save rolls the status back, offers Retry, and Retry saves it', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    await expect(taskRow(page, 't-proto')).toBeVisible()

    await failNextWrites(page, 1)
    await statusButton(page, 't-proto', 'To Do').click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()

    const failure = toast(page, /Couldn.t update task/)
    await expect(failure).toBeVisible()
    // Rolled back everywhere: the row is back, the numbers are the old ones, nothing says "done".
    await expect(statusButton(page, 't-proto', 'To Do')).toBeVisible()
    await expect(metric(page, 'open')).toHaveText('15')
    await expect(toast(page, 'Marked as done')).toHaveCount(0)
    expect(await storedStatus(page, 't-proto')).toBe('todo')

    await failure.getByRole('button', { name: 'Retry' }).click()
    await expect(taskRow(page, 't-proto')).toHaveCount(0)
    await expect.poll(() => storedStatus(page, 't-proto')).toBe('done')
    await expect(metric(page, 'open')).toHaveText('14')
    await expect(failure).toHaveCount(0)
  })

  test('a new workspace gets a welcome; the first project shows up with "No tasks" and calm sections', async ({
    page,
  }) => {
    await openApp(page, '/overview', [])
    await expect(page.getByText('Plan clearly. Work simply.')).toBeVisible()
    await expect(metric(page, 'active')).toHaveCount(0)

    await page.getByRole('button', { name: 'Create project' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox').first().fill('我的第一個專案 First project')
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/\/projects\/[^/]+\/list$/)

    await page.getByRole('link', { name: 'Overview', exact: true }).click()
    await expect(pageHeading(page, 'Overview')).toBeVisible()
    await expect(metric(page, 'active')).toHaveText('1')
    await expect(metric(page, 'open')).toHaveText('0')
    await expect(metric(page, 'overdue')).not.toHaveClass(/text-danger/)
    const project = section(page, 'Active projects').getByRole('listitem')
    await expect(project).toContainText('我的第一個專案 First project')
    await expect(project).toContainText('No tasks')
    await expect(section(page, 'Upcoming tasks')).toContainText('No tasks yet')
    await expect(
      section(page, 'Upcoming tasks').getByRole('button', { name: 'New task' }),
    ).toBeVisible()
    await expect(section(page, 'Upcoming milestones')).toContainText(
      'No milestones in the next 30 days',
    )
    await expect(section(page, 'Next 6 weeks')).toContainText(
      'Nothing scheduled in the next 6 weeks',
    )

    // The empty Upcoming tasks section starts a task from here.
    await section(page, 'Upcoming tasks').getByRole('button', { name: 'New task' }).click()
    await expect(newTaskModal(page)).toBeVisible()
  })

  test('a workspace with only completed or archived projects says so', async ({ page }) => {
    await openApp(page, '/overview', [
      {
        id: 'p-done',
        name: 'Shipped',
        status: 'completed',
        tasks: [{ id: 'd-1', title: 'Ship', status: 'done' }],
      },
      {
        id: 'p-arch',
        name: 'Old',
        status: 'archived',
        tasks: [{ id: 'a-1', title: 'Old task', due: -5 }],
      },
    ])
    await expect(metric(page, 'active')).toHaveText('0')
    // The archived project's overdue task is nowhere: not in the numbers, not in a list.
    await expect(metric(page, 'open')).toHaveText('0')
    await expect(metric(page, 'overdue')).toHaveText('0')
    await expect(section(page, 'Active projects')).toContainText('No active projects')
    await expect(section(page, 'Active projects')).toContainText(
      'Completed and archived projects are on the Projects page.',
    )
    await expect(section(page, 'Upcoming tasks')).toContainText('Nothing due in the next 7 days')
    await expect(section(page, 'Next 6 weeks')).toHaveCount(0)
  })
})

test.describe('overview · timeline of a slipped project', () => {
  test('a project whose own dates are over but whose work is not still shows where that work is', async ({
    page,
  }) => {
    await openApp(page, '/overview', [
      {
        id: 'p-slip',
        name: 'Slipped launch',
        start: -60,
        due: -10,
        tasks: [
          { id: 's-qa', title: 'Final QA pass', due: 2 },
          { id: 's-ship', title: 'Ship it', due: 9 },
          { id: 's-old', title: 'Ancient open task', due: -300 },
          { id: 's-done', title: 'Finished long ago', due: 3, status: 'done' },
        ],
      },
      {
        id: 'p-quiet',
        name: 'Quiet',
        start: -60,
        due: -10,
        tasks: [{ id: 'q-1', title: 'Far away', due: 400 }],
      },
    ])
    const timeline = section(page, 'Next 6 weeks')
    const rows = timeline.getByRole('list', { name: /^Projects,/ }).getByRole('listitem')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('Slipped launch')
    // The bar follows the open work in the window (Nov 6 – Nov 13), not the far-off tasks.
    await expect(rows.first()).toContainText('Nov 6 – Nov 13')
    await expect(timeline.locator('[data-span]')).toHaveCount(1)
    await expect(
      timeline.getByText('1 active project with nothing scheduled in these weeks'),
    ).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// My Tasks
// ---------------------------------------------------------------------------

test.describe('my tasks', () => {
  test('four tabs with counts; /my-tasks and unknown tabs go to Today; each tab lists the right tasks in order', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks')
    await expect(page).toHaveURL(/\/my-tasks\/today$/)
    await expect(pageHeading(page, 'My Tasks')).toBeVisible()
    await expectTabCounts(page, [3, 6, 3, 15])
    await expectBadge(page, 6, 3)
    await expect(tabs(page).getByRole('link', { name: /^Today/ })).toHaveAttribute(
      'aria-current',
      'page',
    )

    // Today: due today and not done — by priority, then project order (not "in progress").
    const list = (name: string) => page.getByRole('list', { name })
    await expect.poll(() => rowIds(list('Today tasks'))).toEqual(['t-proto', 't-personas', 'c-1'])

    await tabs(page)
      .getByRole('link', { name: /^Upcoming/ })
      .click()
    await expect(page).toHaveURL(/\/my-tasks\/upcoming$/)
    // Tomorrow … today + 7 days, by date: Catering quote (day 7) is in, Volunteer schedule
    // (day 8) is not.
    await expect
      .poll(() => rowIds(list('Upcoming tasks')))
      .toEqual(['t-cluster', 'c-3', 't-synth', 'e-invite', 't-survey', 'e-catering'])
    await expect(taskRow(page, 'e-catering').locator('[data-bucket="upcoming"]')).toHaveText(
      'Nov 11',
    )
    await expect(taskRow(page, 'e-volunteer')).toHaveCount(0)

    await tabs(page)
      .getByRole('link', { name: /^Overdue/ })
      .click()
    await expect(page).toHaveURL(/\/my-tasks\/overdue$/)
    // Oldest first; done tasks and the archived project's task are never overdue here.
    await expect.poll(() => rowIds(list('Overdue tasks'))).toEqual(['t-report', 'c-2', 'e-venue'])
    await expect(taskRow(page, 'o-1')).toHaveCount(0)
    await expect(taskRow(page, 't-review')).toHaveCount(0)
    await expect(tabs(page).getByRole('link', { name: /^Overdue/ })).toHaveAttribute(
      'aria-current',
      'page',
    )

    await page.goto('/my-tasks/nonsense?ref=x')
    await expect(page).toHaveURL(/\/my-tasks\/today(\?ref=x)?$/)
    await expect(tabs(page).getByRole('link', { name: /^Today/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  test('a row shows the parent of a subtask, the project, the priority and the due state', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/all')
    await expect(pageHeading(page, 'My Tasks')).toBeVisible()
    await expect(openButton(page, 't-cluster')).toHaveAccessibleName(
      /^Subtask of Synthesize findings\s*:\s*Cluster notes$/,
    )
    await expect(taskRow(page, 't-cluster')).toContainText('Synthesize findings')
    await expect(
      taskRow(page, 't-report').getByRole('img', { name: 'Priority: High' }),
    ).toBeVisible()
    await expect(
      taskRow(page, 't-proto').getByRole('img', { name: 'Priority: Urgent' }),
    ).toBeVisible()
    await expect(
      taskRow(page, 't-synth').getByRole('img', { name: 'Priority: Medium' }),
    ).toBeVisible()
    await expect(
      taskRow(page, 't-personas').getByRole('img', { name: 'Priority: Low' }),
    ).toBeVisible()
    await expect(taskRow(page, 'c-1').getByRole('img', { name: /^Priority:/ })).toHaveCount(0)
    await expect(taskRow(page, 't-report').locator('[data-bucket="overdue"]')).toHaveText(
      /^Nov 1\s*\(overdue\)$/,
    )
    await expect(taskRow(page, 't-survey').locator('[data-bucket="upcoming"]')).toHaveText('Nov 9')
    await expect(taskRow(page, 't-inbox').locator('[data-bucket]')).toHaveCount(0)
    await expect(statusButton(page, 't-report', 'In Progress')).toBeVisible()
    await expect(openButton(page, 'c-3')).toHaveAccessibleName(LONG_EN)

    // The project is a link; the title (and the rest of the row) opens the task.
    await taskRow(page, 'c-1').getByRole('link', { name: 'Roadmap 規劃' }).click()
    await expect(page).toHaveURL(/\/projects\/p-cjk\/list$/)
  })

  test('All groups open tasks by due date; Show completed adds them and survives a reload', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/all')
    const all = page.getByRole('region', { name: 'All tasks', exact: true })
    await expect(all.getByRole('heading', { level: 2 })).toHaveText([
      /^Overdue\s*3\b/,
      /^Today\s*3\b/,
      /^Upcoming\s*6\b/,
      /^Later\s*2\b/,
      /^No due date\s*1\b/,
    ])
    await expect
      .poll(() => rowIds(section(page, 'Overdue , 3 tasks')))
      .toEqual(['t-report', 'c-2', 'e-venue'])
    await expect
      .poll(() => rowIds(section(page, 'Today , 3 tasks')))
      .toEqual(['t-proto', 't-personas', 'c-1'])
    await expect
      .poll(() => rowIds(section(page, 'Upcoming , 6 tasks')))
      .toEqual(['t-cluster', 'c-3', 't-synth', 'e-invite', 't-survey', 'e-catering'])
    await expect
      .poll(() => rowIds(section(page, 'Later , 2 tasks')))
      .toEqual(['e-volunteer', 't-retro'])
    await expect.poll(() => rowIds(section(page, 'No due date , 1 task'))).toEqual(['t-inbox'])
    // Completed tasks are hidden by default; the archived project's task is never listed.
    await expect(taskRow(page, 't-interview')).toHaveCount(0)
    await expect(taskRow(page, 'o-1')).toHaveCount(0)

    const toggle = page.getByRole('switch', { name: 'Show completed tasks' })
    await expect(toggle).not.toBeChecked()
    await expect(page.getByText('Show completed', { exact: true })).toBeVisible()
    await toggle.click()
    await expect(toggle).toBeChecked()
    await expect(page).toHaveURL(/\/my-tasks\/all\?completed=1$/)
    // Recently completed first, neutral (a done task is never "overdue").
    await expect
      .poll(() => rowIds(section(page, 'Completed , 3 tasks')))
      .toEqual(['t-review', 't-interview', 'w-1'])
    await expect(taskRow(page, 't-interview').locator('[data-bucket="done"]')).toBeVisible()
    await expect(taskRow(page, 't-interview').locator('[data-bucket="overdue"]')).toHaveCount(0)
    await expect(statusButton(page, 't-interview', 'Done')).toBeVisible()

    await page.reload()
    await expect(page.getByRole('switch', { name: 'Show completed tasks' })).toBeChecked()
    await expect(section(page, 'Completed , 3 tasks')).toBeVisible()

    // A task opened from here keeps the other URL parameters.
    await openButton(page, 't-report').click()
    await expect(page).toHaveURL(/completed=1/)
    await expect(page).toHaveURL(/task=t-report/)
    await expect(editModal(page, 'Finalize report')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(editModal(page, 'Finalize report')).toBeHidden()
    await expect(page).toHaveURL(/\/my-tasks\/all\?completed=1$/)

    // The tabs ignore the switch (it belongs to All), which is off again after coming back.
    await page.getByRole('switch', { name: 'Show completed tasks' }).click()
    await expect(page).toHaveURL(/\/my-tasks\/all$/)
    await expect(section(page, 'Completed , 3 tasks')).toHaveCount(0)
  })

  test('the definitions are one click away and match the numbers', async ({ page }) => {
    await openApp(page, '/my-tasks/today')
    const trigger = page.getByRole('button', { name: 'How tasks are grouped' })
    await trigger.click()
    const popover = page.getByRole('dialog', { name: 'How tasks are grouped' })
    await expect(popover).toContainText('Due today and not done')
    await expect(popover).toContainText('Due in the next 7 days, after today')
    await expect(popover).toContainText('Past their due date and not done')
    await expect(popover).toContainText('Today is Wednesday, November 4, 2026 (Asia/Taipei)')
    await page.keyboard.press('Escape')
    await expect(popover).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  test('a status changed in place leaves the list with Undo; the badge and tabs follow', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/today')
    await expectTabCounts(page, [3, 6, 3, 15])

    // Moving to In Progress keeps the task where it is (it is still due today), without a toast.
    await statusButton(page, 't-personas', 'To Do').click()
    await page.getByRole('menuitemradio', { name: 'In Progress' }).click()
    await expect(statusButton(page, 't-personas', 'In Progress')).toBeVisible()
    await expect(toast(page, 'Marked as done')).toHaveCount(0)
    await expectTabCounts(page, [3, 6, 3, 15])
    await expect.poll(() => storedStatus(page, 't-personas')).toBe('in_progress')

    // Done takes it out of Today, and every count moves with it.
    await statusButton(page, 't-personas').click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect(taskRow(page, 't-personas')).toHaveCount(0)
    await expectTabCounts(page, [2, 6, 3, 14])
    await expectBadge(page, 5, 3)
    await expect(toast(page, 'Marked as done')).toContainText('Write personas')
    await expect
      .poll(async () => (await stored(page)).tasks['t-personas']?.completedAt)
      .not.toBeNull()

    await toast(page, 'Marked as done').getByRole('button', { name: 'Undo' }).click()
    await expect(statusButton(page, 't-personas', 'In Progress')).toBeVisible()
    await expectTabCounts(page, [3, 6, 3, 15])
    await expectBadge(page, 6, 3)
    await expect.poll(() => storedStatus(page, 't-personas')).toBe('in_progress')
    await expect.poll(async () => (await stored(page)).tasks['t-personas']?.completedAt).toBeNull()
  })

  test('keyboard only: Done from the menu moves focus to the next row; Arrow keys move between rows; Enter opens a task and Esc returns', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/today')
    await expect(taskRow(page, 't-proto')).toBeVisible()

    await statusButton(page, 't-proto').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menuitemradio', { name: 'Done' })).toBeVisible()
    await page.keyboard.press('3')
    await expect(taskRow(page, 't-proto')).toHaveCount(0)
    // Focus does not fall to the page: it lands on the status menu of the row that moved up.
    await expect(statusButton(page, 't-personas')).toBeFocused()
    await expectTabCounts(page, [2, 6, 3, 14])

    await openButton(page, 't-personas').focus()
    await page.keyboard.press('ArrowDown')
    await expect(openButton(page, 'c-1')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(openButton(page, 't-personas')).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(editModal(page, 'Write personas')).toBeVisible()
    // The form focuses its title once mounted; Esc before that can beat the dialog's key handler.
    await expect(
      editModal(page, 'Write personas').getByRole('textbox', { name: 'Task title' }),
    ).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(editModal(page, 'Write personas')).toBeHidden()
    await expect(openButton(page, 't-personas')).toBeFocused()
    await expect(page).toHaveURL(/\/my-tasks\/today$/)
  })

  test('a change made in the Task Modal reaches the lists and the numbers', async ({ page }) => {
    await openApp(page, '/my-tasks/today')
    await openButton(page, 't-personas').click()
    const modal = editModal(page, 'Write personas')
    await expect(modal).toBeVisible()
    await modal.getByRole('button', { name: /^Status:/ }).click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await modal.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(modal).toBeHidden()
    await expect(taskRow(page, 't-personas')).toHaveCount(0)
    await expectTabCounts(page, [2, 6, 3, 14])
    await expectBadge(page, 5, 3)
    await expect.poll(() => storedStatus(page, 't-personas')).toBe('done')
  })

  test('New task from Today is due today and lands in the list; C does the same; elsewhere it has no date', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/today')
    await expectTabCounts(page, [3, 6, 3, 15])
    const title = '打包示範用品 Pack the demo kit'

    await pageHeader(page).getByRole('button', { name: 'New task' }).click()
    const modal = newTaskModal(page)
    await expect(
      modal.getByRole('button', { name: 'Due date: Wednesday, November 4, 2026' }),
    ).toBeVisible()
    await titleBox(modal).fill(title)
    await modal.getByRole('button', { name: /^Project:/ }).click()
    await page.getByRole('menuitemradio', { name: 'Community Event' }).click()
    await modal.getByRole('button', { name: 'Create task' }).click()
    await expect(modal).toBeHidden()

    const created = page.locator('[data-task-row]').filter({ hasText: title })
    await expect(created).toHaveCount(1)
    await expect(created.locator('[data-bucket="today"]')).toBeVisible()
    await expectTabCounts(page, [4, 6, 3, 16])
    await expectBadge(page, 7, 3)
    await expect
      .poll(async () =>
        Object.values((await stored(page)).tasks)
          .filter((task) => task.title === title)
          .map((task) => [task.projectId, task.dueDate]),
      )
      .toEqual([['p-event', TODAY]])

    await page.reload()
    await expect(created).toHaveCount(1)
    await expectTabCounts(page, [4, 6, 3, 16])

    // C on Today: the same (due today). On All: no date.
    await page.keyboard.press('c')
    await expect(
      newTaskModal(page).getByRole('button', { name: 'Due date: Wednesday, November 4, 2026' }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(newTaskModal(page)).toBeHidden()

    // (Opened by URL: a key pressed in the few milliseconds between a tab click and React
    // dropping the Today tab's shortcut would still reach it.)
    await page.goto('/my-tasks/all')
    await expect(pageHeading(page, 'My Tasks')).toBeVisible()
    await page.keyboard.press('c')
    await expect(
      newTaskModal(page).getByRole('button', { name: 'Due date: not set' }),
    ).toBeVisible()
  })

  test('a failed save rolls the status back, offers Retry and never says "Marked as done"', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/today')
    await expectTabCounts(page, [3, 6, 3, 15])

    await failNextWrites(page, 1)
    await statusButton(page, 't-proto', 'To Do').click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()

    const failure = toast(page, /Couldn.t update task/)
    await expect(failure).toBeVisible()
    await expect(statusButton(page, 't-proto', 'To Do')).toBeVisible()
    await expectTabCounts(page, [3, 6, 3, 15])
    await expectBadge(page, 6, 3)
    await expect(toast(page, 'Marked as done')).toHaveCount(0)
    expect(await storedStatus(page, 't-proto')).toBe('todo')

    await failure.getByRole('button', { name: 'Retry' }).click()
    await expect(taskRow(page, 't-proto')).toHaveCount(0)
    await expect.poll(() => storedStatus(page, 't-proto')).toBe('done')
    await expectTabCounts(page, [2, 6, 3, 14])
    await expect(failure).toHaveCount(0)
  })

  test('a slow save shows "Saving…" and the change is stored once it is done', async ({ page }) => {
    await openApp(page, '/my-tasks/today')
    await expect(taskRow(page, 't-proto')).toBeVisible()
    await setLatency(page, 1500)

    await statusButton(page, 't-proto', 'To Do').click()
    await page.getByRole('menuitemradio', { name: 'In Progress' }).click()
    // The screen answers at once; the sidebar tells that the save is still on its way.
    await expect(statusButton(page, 't-proto', 'In Progress')).toBeVisible()
    await expect(saving(page)).toBeVisible()
    await expect(saving(page)).toBeHidden()
    await expect.poll(() => storedStatus(page, 't-proto')).toBe('in_progress')
    await expect(toast(page, /Couldn.t/)).toHaveCount(0)
    await expect(statusButton(page, 't-proto', 'In Progress')).toBeVisible()
  })

  test('every tab has an empty state of its own; a workspace without tasks says so', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/today', [{ id: 'p-1', name: 'Research' }])
    const empty = page.locator('[data-slot="empty-state"]')
    await expectTabCounts(page, [0, 0, 0, 0])
    await expect(empty).toContainText('Nothing due today')
    await tabs(page)
      .getByRole('link', { name: /^Upcoming/ })
      .click()
    await expect(empty).toContainText('Nothing due in the next 7 days')
    await tabs(page)
      .getByRole('link', { name: /^Overdue/ })
      .click()
    await expect(empty).toContainText('No overdue tasks')
    await tabs(page).getByRole('link', { name: /^All/ }).click()
    await expect(empty).toContainText('No tasks yet')
    await empty.getByRole('button', { name: 'New task' }).click()
    await expect(newTaskModal(page)).toBeVisible()
  })

  test('when everything is done: "No open tasks", and one click shows the completed ones', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/all', [
      {
        id: 'p-1',
        name: 'Research',
        tasks: [
          { id: 'a', title: 'Done one', status: 'done', due: -3 },
          { id: 'b', title: 'Done two', status: 'done' },
        ],
      },
    ])
    const empty = page.locator('[data-slot="empty-state"]')
    await expect(empty).toContainText('No open tasks')
    await expectTabCounts(page, [0, 0, 0, 0])
    await empty.getByRole('button', { name: 'Show 2 completed tasks' }).click()
    await expect(page).toHaveURL(/\/my-tasks\/all\?completed=1$/)
    await expect.poll(() => rowIds(section(page, 'Completed , 2 tasks'))).toHaveLength(2)
    await expect(empty).toHaveCount(0)
    // Overdue stays calm: a done task is never overdue.
    await tabs(page)
      .getByRole('link', { name: /^Overdue/ })
      .click()
    await expect(page.locator('[data-slot="empty-state"]')).toContainText('No overdue tasks')
  })

  test('the time zone preference, not the browser, decides what today is', async ({ page }) => {
    // 10:00 in Taipei is still Tuesday evening in Los Angeles.
    await openApp(page, '/overview', seedProjects(), {
      ...PREFERENCES,
      timezone: 'America/Los_Angeles',
    })
    await expect(page.getByText('Tuesday, November 3, 2026')).toBeVisible()
    await expect(metric(page, 'overdue')).toHaveText('2')
    await expect(metric(page, 'soon')).toHaveText('9')
    await expectBadge(page, 3, 2)

    await page.getByRole('link', { name: 'View all in My Tasks' }).click()
    await expectTabCounts(page, [1, 8, 2, 15])
    await tabs(page)
      .getByRole('link', { name: /^Today/ })
      .click()
    await expect
      .poll(() => rowIds(page.getByRole('list', { name: 'Today tasks' })))
      .toEqual(['e-venue'])
    await expect(taskRow(page, 'e-venue').locator('[data-bucket="today"]')).toHaveText('Today')
  })

  test('the day rolls over at midnight without a reload, in every number and label', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/today', seedProjects(), PREFERENCES, '2026-11-04T23:59:40+08:00')
    await expectTabCounts(page, [3, 6, 3, 15])
    await expectBadge(page, 6, 3)
    await expect(taskRow(page, 'e-venue')).toHaveCount(0)

    // Twenty seconds past midnight the next 30 s tick moves "today" to Thursday, November 5.
    await page.clock.fastForward(60_000)
    // Tasks due Wednesday are overdue now; what was due tomorrow is due today; the 7-day window
    // moved with it (Volunteer schedule, day 8, is now inside).
    await expectTabCounts(page, [2, 5, 6, 15])
    await expectBadge(page, 8, 6)
    await expect
      .poll(() => rowIds(page.getByRole('list', { name: 'Today tasks' })))
      .toEqual(['t-cluster', 'c-3'])
    await expect(taskRow(page, 't-cluster').locator('[data-bucket="today"]')).toHaveText('Today')

    // The Overview (reached without a reload) agrees.
    await page.getByRole('link', { name: 'Overview', exact: true }).click()
    await expect(page.getByText('Thursday, November 5, 2026')).toBeVisible()
    await expect(metric(page, 'overdue')).toHaveText('6')
    await expect(metric(page, 'soon')).toHaveText('7')
    await expect(taskRow(page, 't-proto').locator('[data-bucket="overdue"]')).toContainText(
      'Yesterday',
    )
  })

  test('narrow window: the view bar controls never run over the tabs', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 })
    await openApp(page, '/my-tasks/all')
    await expect(pageHeading(page, 'My Tasks')).toBeVisible()
    const toggle = page.getByRole('switch', { name: 'Show completed tasks' })
    const gap = async () => {
      const [list, control] = await Promise.all([tabs(page).boundingBox(), toggle.boundingBox()])
      if (!list || !control) throw new Error('view bar controls are not visible')
      return control.x - (list.x + list.width)
    }
    expect(await gap()).toBeGreaterThanOrEqual(0)
    // The label gets shorter instead of colliding; it still toggles.
    await page.getByText('Completed', { exact: true }).click()
    await expect(toggle).toBeChecked()

    await page.setViewportSize({ width: 700, height: 900 })
    expect(await gap()).toBeGreaterThanOrEqual(0)
    await expect(page.getByRole('button', { name: 'How tasks are grouped' })).toBeHidden()
  })
})

// ---------------------------------------------------------------------------
// A large workspace
// ---------------------------------------------------------------------------

test.describe('a large workspace', () => {
  /** The seed plus 300 tasks in one project (60 per bucket) and six empty filler projects. */
  function bigSeed(): SeedProject[] {
    const tasks: SeedTask[] = Array.from({ length: 300 }, (_, index) => {
      const title = `Backlog item ${index}${index % 7 === 0 ? ' 長標題：需要被截斷的非常長的中文任務名稱' : ''}`
      switch (index % 5) {
        case 0:
          return { id: `big-${index}`, title, due: -1 - (index % 30) }
        case 1:
          return { id: `big-${index}`, title, due: 0 }
        case 2:
          return { id: `big-${index}`, title, due: 1 + (index % 7) }
        case 3:
          return { id: `big-${index}`, title, due: 8 + (index % 60) }
        default:
          return { id: `big-${index}`, title }
      }
    })
    const fillers = Array.from({ length: 6 }, (_, index) => ({
      id: `p-filler-${index}`,
      name: `Filler ${index + 1}`,
    }))
    return [
      ...seedProjects(),
      {
        id: 'p-big',
        name: 'Big backlog with a rather long project name that must truncate',
        tasks,
      },
      ...fillers,
    ]
  }

  test('the Overview stays at a glance: eight tasks, eight projects, the real totals', async ({
    page,
  }) => {
    test.slow()
    await openApp(page, '/overview', bigSeed())
    await expect(metric(page, 'active')).toHaveText('11')
    await expect(metric(page, 'open')).toHaveText('315')
    await expect(metric(page, 'overdue')).toHaveText('63')
    await expect(metric(page, 'soon')).toHaveText('129')
    const projects = section(page, 'Active projects')
    await expect(projects.getByRole('listitem')).toHaveCount(8)
    await expect(projects.getByRole('link', { name: '+3 more projects' })).toBeVisible()
    const upcoming = section(page, 'Upcoming tasks')
    await expect(upcoming.locator('[data-task-row]')).toHaveCount(8)
    await expect(upcoming.getByText('Showing 8 of 192')).toBeVisible()
    await expectBadge(page, 126, 63)
    await expect(
      section(page, 'Next 6 weeks').getByText(
        '7 active projects with nothing scheduled in these weeks',
      ),
    ).toBeVisible()
  })

  test('My Tasks keeps its section headings under the view bar while scrolling', async ({
    page,
  }) => {
    test.slow()
    await openApp(page, '/my-tasks/all', bigSeed())
    await expectTabCounts(page, [63, 66, 63, 315])
    await expect(page.locator('[data-task-row]')).toHaveCount(315)

    // Deep in the Today section, its heading is stuck right below the view bar.
    await taskRow(page, 'big-196').scrollIntoViewIfNeeded()
    const heading = page.getByRole('heading', { name: /^Today\s*,\s*63 tasks$/, level: 2 })
    const viewBar = page.locator('[data-slot="view-bar"]')
    await expect
      .poll(async () => {
        const [head, bar] = await Promise.all([heading.boundingBox(), viewBar.boundingBox()])
        return head && bar ? Math.abs(head.y - (bar.y + bar.height)) : Number.POSITIVE_INFINITY
      })
      .toBeLessThan(2)

    // One status change in the middle of 300 rows still behaves like any other.
    await statusButton(page, 'big-196', 'To Do').click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect(taskRow(page, 'big-196')).toHaveCount(0)
    await expectTabCounts(page, [62, 66, 63, 314])
  })

  test('a row reached with the arrow keys is never left behind the sticky bars or the page edge', async ({
    page,
  }) => {
    test.slow()
    await openApp(page, '/my-tasks/all', bigSeed())
    await expectTabCounts(page, [63, 66, 63, 315])
    await taskRow(page, 'big-196').scrollIntoViewIfNeeded()
    await openButton(page, 'big-196').focus()

    // Up through more than a screenful of rows, then down again.
    let top = Number.POSITIVE_INFINITY
    for (let step = 0; step < 30; step++) {
      await page.keyboard.press('ArrowUp')
      top = Math.min(top, (await focusClearance(page)).top)
    }
    expect(
      top,
      'the focused row stays below the sticky view bar and heading',
    ).toBeGreaterThanOrEqual(-0.5)

    let bottom = Number.POSITIVE_INFINITY
    for (let step = 0; step < 60; step++) {
      await page.keyboard.press('ArrowDown')
      bottom = Math.min(bottom, (await focusClearance(page)).bottom)
    }
    expect(bottom, 'the focused row stays above the bottom edge').toBeGreaterThanOrEqual(-0.5)
  })
})

// ---------------------------------------------------------------------------
// Light and dark
// ---------------------------------------------------------------------------

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme, reducedMotion: 'reduce' })

    test('Overview and My Tasks text keeps AA contrast', async ({ page }) => {
      await openApp(page, '/overview')
      await expect(page.locator('html')).toHaveClass(
        scheme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/,
      )
      await expect(taskRow(page, 't-report')).toBeVisible()
      expect(await lowContrastText(page), 'Overview').toEqual([])

      await page.getByRole('link', { name: 'View all in My Tasks' }).click()
      await expect(page).toHaveURL(/\/my-tasks\/all$/)
      await expect(taskRow(page, 't-report')).toBeVisible()
      expect(await lowContrastText(page), 'My Tasks · All').toEqual([])

      await page.getByRole('switch', { name: 'Show completed tasks' }).click()
      await expect(taskRow(page, 't-interview')).toBeVisible()
      expect(await lowContrastText(page), 'My Tasks · All with completed').toEqual([])

      await tabs(page)
        .getByRole('link', { name: /^Today/ })
        .click()
      await expect(taskRow(page, 't-proto')).toBeVisible()
      expect(await lowContrastText(page), 'My Tasks · Today').toEqual([])
    })
  })
}
