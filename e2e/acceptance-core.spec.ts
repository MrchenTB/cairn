/// <reference lib="dom" />
/**
 * Core acceptance E2E (local data mode, dev server from playwright.config.ts).
 *
 * PRD §9.1 acceptance items AC-1 … AC-6 and the page specs §4.1 (shell), §4.4 (Projects list),
 * §4.5 (project List) and §4.6 (Board), walked the way a new user would: first-run empty states,
 * a "Research" project without a phase, a task with only a name, phases / subtasks / milestones
 * next to a flat project, List drag reorder that survives a reload (flat, across phases,
 * subtasks), and a Board drag To Do → In Progress that the List shows at once and after a reload.
 * Setup may be seeded straight into localStorage; every result is read from the UI and from the
 * stored workspace after a reload.
 */
import { expect as baseExpect, test as base, type Locator, type Page } from '@playwright/test'

/** A busy machine can need longer than Playwright's 5 s default for a page boot after a reload. */
const expect = baseExpect.configure({ timeout: 10_000 })

const LOCAL_WORKSPACE_KEY = 'cairn:local:workspace:v1'
const NOW = '2026-11-03T08:00:00.000Z'

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

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

type Status = 'todo' | 'in_progress' | 'done'
type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

interface SeedTask {
  id: string
  title: string
  phaseId?: string
  parentId?: string
  status?: Status
  priority?: Priority
  startDate?: string
  dueDate?: string
}

interface SeedProject {
  id: string
  name: string
  status?: 'active' | 'completed' | 'archived'
  phases?: { id: string; name: string }[]
  /** In project order; subtasks follow their parent in the order given. */
  tasks?: SeedTask[]
}

/** Fractional-index keys that sort by position: a0, a1, … (enough for the small seeds here). */
const key = (index: number) => `a${index}`

function buildWorkspace(projects: SeedProject[]): unknown {
  const db = {
    version: 1,
    projects: {} as Record<string, unknown>,
    phases: {} as Record<string, unknown>,
    tasks: {} as Record<string, unknown>,
    milestones: {},
    dependencies: {},
    preferences: null,
  }
  projects.forEach((project, projectIndex) => {
    db.projects[project.id] = {
      id: project.id,
      name: project.name,
      description: null,
      status: project.status ?? 'active',
      color: projectIndex % 2 === 0 ? 'violet' : 'green',
      startDate: null,
      dueDate: null,
      scheduleMode: 'manual',
      sortOrder: key(projectIndex),
      createdAt: NOW,
      updatedAt: NOW,
    }
    project.phases?.forEach((phase, index) => {
      db.phases[phase.id] = {
        id: phase.id,
        projectId: project.id,
        name: phase.name,
        sortOrder: key(index),
        createdAt: NOW,
        updatedAt: NOW,
      }
    })
    project.tasks?.forEach((task, index) => {
      db.tasks[task.id] = {
        id: task.id,
        projectId: project.id,
        phaseId: task.phaseId ?? null,
        parentTaskId: task.parentId ?? null,
        title: task.title,
        description: null,
        status: task.status ?? 'todo',
        priority: task.priority ?? 'none',
        startDate: task.startDate ?? null,
        dueDate: task.dueDate ?? null,
        sortOrder: key(index),
        completedAt: task.status === 'done' ? NOW : null,
        createdAt: NOW,
        updatedAt: NOW,
      }
    })
  })
  return db
}

/** A project with two phases, a task outside any phase and one parent with two subtasks. */
const researchSeed = (): SeedProject => ({
  id: 'p-research',
  name: 'Research',
  phases: [
    { id: 'ph-discovery', name: 'Discovery' },
    { id: 'ph-build', name: 'Build' },
  ],
  tasks: [
    { id: 't-inbox', title: 'Inbox idea' },
    { id: 't-interview', title: 'Interview users', phaseId: 'ph-discovery' },
    { id: 't-synth', title: 'Synthesize findings', phaseId: 'ph-discovery' },
    { id: 't-cluster', title: 'Cluster notes', phaseId: 'ph-discovery', parentId: 't-synth' },
    { id: 't-personas', title: 'Write personas', phaseId: 'ph-discovery', parentId: 't-synth' },
    { id: 't-prototype', title: 'Prototype flow', phaseId: 'ph-build' },
    { id: 't-survey', title: 'Draft survey', phaseId: 'ph-build' },
    { id: 't-retro', title: 'Plan retro', phaseId: 'ph-build' },
  ],
})

/** A flat project: no phases, no subtasks. */
const flatSeed = (): SeedProject => ({
  id: 'p-flat',
  name: 'Flat project',
  tasks: [
    { id: 'f-alpha', title: 'Alpha' },
    { id: 'f-beta', title: 'Beta' },
    { id: 'f-gamma', title: 'Gamma' },
    { id: 'f-delta', title: 'Delta' },
  ],
})

/** Boots the app at `path`; a seeded workspace is written once per tab (a reload keeps changes). */
async function openApp(page: Page, path: string, projects: SeedProject[] | null = null) {
  if (projects) {
    await page.addInitScript(
      ({ storageKey, db }) => {
        if (sessionStorage.getItem('cairn-e2e-acceptance-core-seeded')) return
        localStorage.setItem(storageKey, JSON.stringify(db))
        sessionStorage.setItem('cairn-e2e-acceptance-core-seeded', '1')
      },
      { storageKey: LOCAL_WORKSPACE_KEY, db: buildWorkspace(projects) },
    )
  }
  await page.goto(path)
}

// ---------------------------------------------------------------------------
// Stored workspace, test hooks and dates
// ---------------------------------------------------------------------------

interface StoredTask {
  id: string
  projectId: string
  title: string
  description: string | null
  phaseId: string | null
  parentTaskId: string | null
  status: Status
  priority: Priority
  startDate: string | null
  dueDate: string | null
  sortOrder: string
  completedAt: string | null
}

interface StoredWorkspace {
  projects: Record<
    string,
    { id: string; name: string; status: string; startDate: string | null; dueDate: string | null }
  >
  phases: Record<string, { id: string; projectId: string; name: string }>
  tasks: Record<string, StoredTask>
  milestones: Record<string, { id: string; projectId: string; name: string; date: string }>
}

/** What the local "database" holds right now (the source of truth after a reload). */
function stored(page: Page): Promise<StoredWorkspace> {
  return page.evaluate(
    (storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? '{}') as StoredWorkspace,
    LOCAL_WORKSPACE_KEY,
  )
}

async function storedTask(page: Page, title: string): Promise<StoredTask | undefined> {
  return Object.values((await stored(page)).tasks ?? {}).find((task) => task.title === title)
}

/** The calendar day `offset` days from today in the browser's zone (= the app's first-run zone). */
function isoDay(page: Page, offset = 0): Promise<string> {
  return page.evaluate((days) => {
    const date = new Date()
    date.setDate(date.getDate() + days)
    const two = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
  }, offset)
}

type TestHooks = { failNextWrites(count: number): void; setLatency(ms: number): void }

function failNextWrites(page: Page, count: number): Promise<void> {
  return page.evaluate((n) => {
    ;(window as Window & { __cairnTest?: TestHooks }).__cairnTest?.failNextWrites(n)
  }, count)
}

/** "November 20th, 2026": how the calendar names a day. */
function dayPattern(date: string): RegExp {
  const [year, month, day] = date.split('-').map(Number)
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
  return new RegExp(`${monthName} ${day}${suffix}, ${year}`)
}

/** Opens a date chip of `scope` and picks `date` in its calendar (paging forward when needed). */
async function pickDate(
  page: Page,
  scope: Locator,
  field: 'Start date' | 'Due date' | 'Date',
  date: string,
): Promise<void> {
  await scope.getByRole('button', { name: new RegExp(`^${field}:`) }).click()
  const picker = page.getByRole('dialog', { name: field, exact: true })
  const day = picker.getByRole('button', { name: dayPattern(date) })
  for (let step = 0; step < 4 && (await day.count()) === 0; step++) {
    await picker.getByRole('button', { name: 'Go to the Next Month' }).click()
  }
  await day.click()
  await expect(picker).toBeHidden()
}

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })

const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })

const listArea = (page: Page) => page.locator('[data-list-scroll]')

const taskRow = (page: Page, title: string) =>
  page
    .locator('[data-task-row]')
    .filter({ has: page.getByRole('button', { name: `Move ${title}`, exact: true }) })

/** Titles of the task rows inside `scope` in DOM order; subtasks are marked with "↳ ". */
function rowTitles(scope: Locator): Promise<string[]> {
  return scope.locator('[data-task-row]').evaluateAll((rows) =>
    rows.map((row) => {
      const handle = row.querySelector('button[aria-label^="Move "]')
      const title = handle?.getAttribute('aria-label')?.slice('Move '.length) ?? '?'
      return row.getAttribute('data-depth') === '1' ? `↳ ${title}` : title
    }),
  )
}

/** A phase group of the List (its accessible name is "<name>, <n> task(s)"). */
const group = (page: Page, name: string) =>
  page.getByRole('region', { name: new RegExp(`^${name}, \\d+ tasks?$`) })

const liveRegion = (page: Page) => page.locator('[id^="DndLiveRegion"]')

/** A board column (its region is named "<Status> <n> task(s)"). */
const column = (page: Page, name: string) =>
  page.getByRole('region', { name: new RegExp(`^${name} \\d+ tasks?$`) })

/** A card's activator (a button named by the task title). */
const card = (page: Page, title: string) => page.getByRole('button', { name: title, exact: true })

function cardTitles(region: Locator): Promise<string[]> {
  return region
    .locator('[data-card-activator]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label') ?? ''))
}

/** Card titles in on-screen order (a drag previews a reorder with transforms, not DOM order). */
function visualCardTitles(region: Locator): Promise<string[]> {
  return region.locator('[data-card-activator]').evaluateAll((elements) =>
    elements
      .map((element) => ({
        title: element.getAttribute('aria-label') ?? '',
        top: element.getBoundingClientRect().top,
      }))
      .sort((a, b) => a.top - b.top)
      .map((entry) => entry.title),
  )
}

// ---------------------------------------------------------------------------
// Pointer drags (real mouse events; released only once the preview shows the landing spot)
// ---------------------------------------------------------------------------

/**
 * Picks up the List handle of `source`, moves to `target` and waits for the announcement. A target
 * given as a function is measured again after every move: lifting a parent folds its subtasks
 * away and a preview that crosses into another group moves the rows, so the first aim can miss.
 */
async function dragHandleTo(
  page: Page,
  source: Locator,
  target: { x: number; y: number } | (() => Promise<{ x: number; y: number }>),
  announced: RegExp,
): Promise<void> {
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
  await source.hover()
  const handle = source.getByRole('button', { name: /^Move / })
  const box = await handle.boundingBox()
  if (!box) throw new Error('drag handle is not visible')
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  const down = typeof target === 'function' || target.y > start.y
  await page.mouse.move(start.x + 6, start.y + (down ? 6 : -6), { steps: 3 })
  if (typeof target === 'function') {
    await settle()
    for (let attempt = 0; attempt < 8; attempt++) {
      const aim = await target()
      await page.mouse.move(aim.x, aim.y, { steps: attempt === 0 ? 14 : 3 })
      await settle()
      if (announced.test((await liveRegion(page).textContent()) ?? '')) break
    }
  } else {
    await page.mouse.move(target.x, target.y, { steps: 14 })
  }
  await expect(liveRegion(page)).toHaveText(announced)
  await page.mouse.up()
}

/** A point `fraction` of the way down `locator`, a little right of the row's left edge. */
async function pointIn(locator: Locator, fraction: number): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('target is not visible')
  return { x: box.x + 300, y: box.y + box.height * fraction }
}

/** Presses a board card, moves to `to`, waits until `preview` holds, then releases. */
async function dragCard(
  page: Page,
  source: Locator,
  to: { x: number; y: number },
  preview: () => Promise<void>,
): Promise<void> {
  const box = await source.boundingBox()
  if (!box) throw new Error('drag source is not visible')
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 6, start.y + 6, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await preview()
  await page.mouse.up()
}

/** A point on the upper edge of `locator` (a drop there enters before that card). */
async function topOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('drop target is not visible')
  return { x: box.x + box.width / 2, y: box.y + 6 }
}

// ===========================================================================
// AC-1 — a new user's first open
// ===========================================================================

test.describe('AC-1: first run', () => {
  test('AC-1: every page of an empty workspace shows a friendly empty state, never a blank or broken page', async ({
    page,
  }) => {
    await openApp(page, '/')
    await expect(page).toHaveURL(/\/overview$/)

    // Overview: welcome + one clear next step, no zero-filled dashboard.
    await expect(page.getByRole('heading', { name: 'Plan clearly. Work simply.' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create project' })).toBeVisible()
    // Shell (§4.1): sidebar with the four destinations, an honest local-mode indicator, Settings.
    const side = sidebar(page)
    for (const name of ['Overview', 'My Tasks', 'Projects', 'Timeline']) {
      await expect(side.getByRole('link', { name })).toBeVisible()
    }
    await expect(side.getByText('No projects yet')).toBeVisible()
    await expect(side.getByText('Local only — not synced')).toBeVisible()
    await expect(side.getByRole('link', { name: 'Settings' })).toBeVisible()

    // My Tasks: each tab explains itself.
    await page.goto('/my-tasks')
    await expect(page).toHaveURL(/\/my-tasks\/today$/)
    await expect(page.getByRole('heading', { name: 'Nothing for today' })).toBeVisible()
    await page.getByRole('link', { name: /^Upcoming/ }).click()
    await expect(
      page.getByRole('heading', { name: 'Nothing due in the next 7 days' }),
    ).toBeVisible()
    await page.getByRole('link', { name: /^Overdue/ }).click()
    await expect(page.getByRole('heading', { name: 'No overdue tasks' })).toBeVisible()
    await page.getByRole('link', { name: /^All/ }).click()
    await expect(page.getByRole('heading', { name: 'No tasks yet' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New task' }).last()).toBeVisible()

    // Projects and Timeline.
    await page.goto('/projects')
    await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create your first project' })).toBeVisible()
    await page.goto('/timeline')
    await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New project' }).last()).toBeVisible()

    // Nothing leaks a placeholder (NaN, undefined, a raw date) into the empty pages.
    await expect(page.locator('main')).not.toContainText(/NaN|undefined|Invalid|\[object/)
  })

  test('AC-1: "New task" with no project explains why and leads to Create project', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/all')
    await page.getByRole('button', { name: 'New task' }).first().click()
    const modal = page.getByRole('dialog', { name: 'New task' })
    await expect(modal).toBeVisible()
    await expect(modal).toContainText(/create a project|no project/i)
    await modal.getByRole('button', { name: /Create project/ }).click()
    await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible()
  })
})

// ===========================================================================
// AC-2 — a Research project without a phase
// ===========================================================================

test.describe('AC-2: Research project', () => {
  test('AC-2: Research is created from the empty Overview with just a name; its List, Board and Gantt are friendly empty views', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    await page.getByRole('button', { name: 'Create project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Research')
    await dialog.getByRole('button', { name: 'Create project' }).click()

    // Straight into the project's List; no phase was required or created.
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/list$/)
    await expect(page.getByRole('heading', { name: 'Research', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'No tasks yet' })).toBeVisible()
    await expect(page.getByText(/Phases are\s+optional/)).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Add your first task' })).toBeVisible()
    await expect(sidebar(page).getByRole('link', { name: 'Research' })).toBeVisible()
    await expect
      .poll(async () => {
        const db = await stored(page)
        return [
          Object.values(db.projects).map((project) => `${project.name}:${project.status}`),
          Object.keys(db.phases).length,
          Object.keys(db.tasks).length,
        ]
      })
      .toEqual([['Research:active'], 0, 0])

    // Board: the three fixed columns, each empty and calm.
    await page.getByRole('link', { name: 'Board', exact: true }).click()
    await expect(page).toHaveURL(/\/board$/)
    for (const name of ['To Do', 'In Progress', 'Done']) {
      await expect(column(page, name)).toHaveAccessibleName(`${name} 0 tasks`)
    }
    // Gantt: an explanation and a way to start, not an empty chart.
    await page.getByRole('link', { name: 'Gantt', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'No tasks yet' })).toBeVisible()

    // Other pages now know the project, still without inventing progress.
    await page.goto('/projects')
    const row = page
      .getByRole('table', { name: 'Projects' })
      .getByRole('row')
      .filter({
        has: page.getByRole('link', { name: 'Research', exact: true }),
      })
    await expect(row).toContainText('No tasks')
    await expect(row.getByRole('progressbar')).toHaveCount(0)
    await page.goto('/overview')
    await expect(page.getByRole('link', { name: /^Research/ }).first()).toBeVisible()
    await expect(page.locator('main')).not.toContainText(/100%|NaN/)
  })
})

// ===========================================================================
// AC-3 — a task needs only a name
// ===========================================================================

test.describe('AC-3: tasks', () => {
  test('AC-3: a task with only a name is valid; status, priority, dates and description can be added and survive a reload', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/list', [{ id: 'p-research', name: 'Research' }])

    // Only a name (inline, Enter).
    await page.getByRole('textbox', { name: 'Add your first task' }).fill('Collect interviews')
    await page.getByRole('textbox', { name: 'Add your first task' }).press('Enter')
    const row = taskRow(page, 'Collect interviews')
    await expect(row).toBeVisible()
    await expect
      .poll(() => storedTask(page, 'Collect interviews'))
      .toMatchObject({
        status: 'todo',
        priority: 'none',
        description: null,
        startDate: null,
        dueDate: null,
        phaseId: null,
        parentTaskId: null,
      })

    // Only a name through the New task button (Task Modal).
    await page.getByRole('button', { name: 'New task' }).first().click()
    const modal = page.getByRole('dialog', { name: 'New task', exact: true })
    await expect(modal.getByRole('button', { name: 'Project: Research' })).toBeVisible()
    await modal.getByRole('textbox', { name: 'Task title' }).fill('Name only 僅名稱')
    await modal.getByRole('textbox', { name: 'Task title' }).press('Enter')
    await expect(modal).toBeHidden()
    await expect(toast(page, 'Task created')).toBeVisible()
    await expect
      .poll(() => storedTask(page, 'Name only 僅名稱'))
      .toMatchObject({
        status: 'todo',
        priority: 'none',
        description: null,
        startDate: null,
        dueDate: null,
      })

    // Everything else is optional and can be added later, in the Task Modal.
    await row.getByRole('button', { name: 'Collect interviews', exact: true }).click()
    const edit = page.getByRole('dialog', { name: 'Edit task: Collect interviews' })
    // Auto-save: nothing to press Save on; Done is the only way to say "finished".
    await expect(edit.getByRole('button', { name: 'Done', exact: true })).toBeVisible()
    await expect(edit.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
    await edit
      .getByRole('textbox', { name: 'Description' })
      .fill('Five participants.\nRecord each.')
    await edit.getByRole('button', { name: /^Status:/ }).click()
    await page.getByRole('menuitemradio', { name: /In Progress/ }).click()
    await edit.getByRole('button', { name: /^Priority:/ }).click()
    await page.getByRole('menuitemradio', { name: /High/ }).click()
    const start = await isoDay(page, 1)
    const due = await isoDay(page, 3)
    await pickDate(page, edit, 'Start date', start)
    await pickDate(page, edit, 'Due date', due)
    await edit.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(edit).toBeHidden()

    await expect
      .poll(() => storedTask(page, 'Collect interviews'))
      .toMatchObject({
        status: 'in_progress',
        priority: 'high',
        description: 'Five participants.\nRecord each.',
        startDate: start,
        dueDate: due,
      })
    await expect(row.getByRole('button', { name: 'Status: In Progress' })).toBeVisible()
    await expect(row.getByRole('button', { name: 'Priority: High' })).toBeVisible()

    await page.reload()
    const again = taskRow(page, 'Collect interviews')
    await expect(again.getByRole('button', { name: 'Status: In Progress' })).toBeVisible()
    await expect(again.getByRole('button', { name: 'Priority: High' })).toBeVisible()
    await again.getByRole('button', { name: 'Collect interviews', exact: true }).click()
    const reopened = page.getByRole('dialog', { name: 'Edit task: Collect interviews' })
    await expect(reopened.getByRole('textbox', { name: 'Description' })).toHaveValue(
      'Five participants.\nRecord each.',
    )
    await expect(reopened.getByRole('button', { name: /^Start date: (?!not set)/ })).toBeVisible()
    await expect(reopened.getByRole('button', { name: /^Due date: (?!not set)/ })).toBeVisible()
  })

  test('AC-3: a failed inline create is never reported as saved, and typing it again stores it once (the old Retry is withdrawn)', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-flat/list', [flatSeed()])
    await expect.poll(() => rowTitles(listArea(page))).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
    await failNextWrites(page, 1)
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'New task' })
    await input.fill('Typed twice')
    await input.press('Enter')
    const failure = toast(page, "Couldn't create task")
    await expect(failure).toBeVisible()
    await expect(failure.getByRole('button', { name: 'Retry' })).toBeVisible()
    // Rolled back: nothing claims the task exists.
    await expect.poll(() => rowTitles(listArea(page))).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
    expect(await storedTask(page, 'Typed twice')).toBeUndefined()

    // The user does it over. That replaces the failed attempt: its toast (and Retry) goes away.
    await input.fill('Typed twice')
    await input.press('Enter')
    await expect
      .poll(() => rowTitles(listArea(page)))
      .toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Typed twice'])
    await expect(failure).toHaveCount(0)
    await expect
      .poll(
        async () =>
          Object.values((await stored(page)).tasks).filter((task) => task.title === 'Typed twice')
            .length,
      )
      .toBe(1)
    await page.reload()
    await expect
      .poll(() => rowTitles(listArea(page)))
      .toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Typed twice'])
  })
})

// ===========================================================================
// AC-4 — phases, subtasks and milestones, next to a flat project
// ===========================================================================

test.describe('AC-4: structure is optional', () => {
  test('AC-4: phases, subtasks and a milestone can be added to Research while the flat project keeps working; progress counts leaf tasks only', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/list', [
      {
        id: 'p-research',
        name: 'Research',
        tasks: [
          { id: 't-a', title: 'Scope the study' },
          { id: 't-b', title: 'Recruit participants' },
          { id: 't-c', title: 'Draft the report' },
        ],
      },
      flatSeed(),
    ])
    const progressbar = page.getByRole('progressbar', { name: 'Project progress' })
    await expect
      .poll(() => rowTitles(listArea(page)))
      .toEqual(['Scope the study', 'Recruit participants', 'Draft the report'])
    await expect(page.locator('[data-list-scroll] section[aria-label]')).toHaveCount(0) // flat

    // Phases: added inline; tasks stay "No phase" until moved, and moving works from the menu.
    await page.getByRole('button', { name: 'Add phase', exact: true }).click()
    const phaseInput = page.getByRole('textbox', { name: 'New phase name' })
    await phaseInput.fill('Discovery')
    await phaseInput.press('Enter')
    await phaseInput.fill('Build')
    await phaseInput.press('Enter')
    await phaseInput.press('Escape')
    await expect(group(page, 'No phase')).toBeVisible()
    await expect(group(page, 'Discovery')).toBeVisible()
    await expect(group(page, 'Build')).toBeVisible()
    await taskRow(page, 'Recruit participants').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to phase' }).hover()
    await page.getByRole('menuitem', { name: 'Discovery', exact: true }).click()
    await group(page, 'Build').getByRole('button', { name: 'Add task', exact: true }).click()
    await page.getByRole('textbox', { name: 'New task' }).fill('Ship the prototype')
    await page.getByRole('textbox', { name: 'New task' }).press('Enter')
    await expect
      .poll(() => rowTitles(group(page, 'No phase')))
      .toEqual(['Scope the study', 'Draft the report'])
    await expect.poll(() => rowTitles(group(page, 'Discovery'))).toEqual(['Recruit participants'])
    await expect.poll(() => rowTitles(group(page, 'Build'))).toEqual(['Ship the prototype'])

    // Subtasks: from the row menu, one level, shown under the parent and counted as leaves.
    await taskRow(page, 'Scope the study').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Add subtask' }).click()
    const subInput = page.getByRole('textbox', { name: 'New subtask of Scope the study' })
    await expect(subInput).toBeFocused()
    await subInput.fill('Write the protocol')
    await subInput.press('Enter')
    await subInput.fill('Get ethics approval')
    await subInput.press('Enter')
    await subInput.press('Escape')
    await expect
      .poll(() => rowTitles(group(page, 'No phase')))
      .toEqual([
        'Scope the study',
        '↳ Write the protocol',
        '↳ Get ethics approval',
        'Draft the report',
      ])
    await expect
      .poll(async () => (await storedTask(page, 'Write the protocol'))?.parentTaskId)
      .toBe('t-a')

    // Leaves now: 2 subtasks + Recruit + Draft + Ship = 5 (the parent is not counted).
    await taskRow(page, 'Recruit participants')
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect(progressbar).toHaveAttribute('aria-valuenow', '20') // 1 of 5

    // A milestone, with a date; it appears in its place and never changes progress.
    await page.getByRole('button', { name: 'Project actions' }).click()
    await page.getByRole('menuitem', { name: 'Add milestone…' }).click()
    const milestoneDialog = page.getByRole('dialog', { name: 'New milestone' })
    await milestoneDialog.getByRole('textbox', { name: 'Name' }).fill('Kickoff')
    const milestoneDay = await isoDay(page, 2)
    await pickDate(page, milestoneDialog, 'Date', milestoneDay)
    await milestoneDialog.getByRole('button', { name: 'Create milestone' }).click()
    await expect(toast(page, 'Milestone created')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Milestone Kickoff/ })).toBeVisible()
    await expect(progressbar).toHaveAttribute('aria-valuenow', '20')
    await expect
      .poll(async () =>
        Object.values((await stored(page)).milestones).map((m) => `${m.name}@${m.date}`),
      )
      .toEqual([`Kickoff@${milestoneDay}`])

    // The one-level limit is explained where subtasks are managed, and a subtask has no "Add subtask".
    await taskRow(page, 'Write the protocol').click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Add subtask' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await taskRow(page, 'Scope the study')
      .getByRole('button', { name: /^Scope the study/ })
      .first()
      .click()
    const parentModal = page.getByRole('dialog', { name: 'Edit task: Scope the study' })
    await expect(parentModal.getByText('One level of subtasks')).toBeVisible()
    await page.keyboard.press('Escape')
    await taskRow(page, 'Write the protocol')
      .getByRole('button', { name: 'Write the protocol', exact: true })
      .click()
    const childModal = page.getByRole('dialog', { name: 'Edit task: Write the protocol' })
    await expect(childModal.getByText('Subtask of Scope the study')).toBeVisible()
    await expect(childModal.getByRole('heading', { name: 'Subtasks' })).toHaveCount(0)
    await expect(childModal).toContainText(/subtasks? can.?t have (their own )?subtasks/i)
    await page.keyboard.press('Escape')

    // Everything survives a reload.
    await page.reload()
    await expect
      .poll(() => rowTitles(group(page, 'No phase')))
      .toEqual([
        'Scope the study',
        '↳ Write the protocol',
        '↳ Get ethics approval',
        'Draft the report',
      ])
    await expect(progressbar).toHaveAttribute('aria-valuenow', '20')
    await expect(page.getByRole('button', { name: /^Milestone Kickoff/ })).toBeVisible()

    // The flat project still works as a plain list: no groups, add / edit / reload.
    await sidebar(page).getByRole('link', { name: 'Flat project' }).click()
    await expect(page).toHaveURL(/\/projects\/p-flat\/list$/)
    await expect.poll(() => rowTitles(listArea(page))).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
    await expect(page.locator('[data-list-scroll] section[aria-label]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    await page.getByRole('textbox', { name: 'New task' }).fill('Epsilon')
    await page.getByRole('textbox', { name: 'New task' }).press('Enter')
    await taskRow(page, 'Beta')
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'In Progress' }).click()
    await expect
      .poll(() => rowTitles(listArea(page)))
      .toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'])
    await expect.poll(async () => (await storedTask(page, 'Beta'))?.status).toBe('in_progress')
    await page.reload()
    await expect
      .poll(() => rowTitles(listArea(page)))
      .toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'])
    await expect(
      taskRow(page, 'Beta').getByRole('button', { name: 'Status: In Progress' }),
    ).toBeVisible()
  })
})

// ===========================================================================
// AC-5 — List drag reorder survives a reload
// ===========================================================================

test.describe('AC-5: List drag and drop', () => {
  test('AC-5: a drag in a flat List keeps its order after a reload', async ({ page }) => {
    await openApp(page, '/projects/p-flat/list', [flatSeed()])
    await expect.poll(() => rowTitles(listArea(page))).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])

    await dragHandleTo(
      page,
      taskRow(page, 'Delta'),
      await pointIn(taskRow(page, 'Alpha'), 0.2),
      /^Delta is over Alpha\.$/,
    )
    await expect.poll(() => rowTitles(listArea(page))).toEqual(['Delta', 'Alpha', 'Beta', 'Gamma'])
    await page.reload()
    await expect.poll(() => rowTitles(listArea(page))).toEqual(['Delta', 'Alpha', 'Beta', 'Gamma'])

    // And back down: the move is a real order change, not a lucky repaint.
    await dragHandleTo(
      page,
      taskRow(page, 'Delta'),
      await pointIn(taskRow(page, 'Beta'), 0.85),
      /^Delta is over Beta\.$/,
    )
    await expect.poll(() => rowTitles(listArea(page))).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma'])
    await page.reload()
    await expect.poll(() => rowTitles(listArea(page))).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma'])
    // Same statuses and no date was touched by ordering.
    for (const title of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
      expect(await storedTask(page, title)).toMatchObject({
        status: 'todo',
        startDate: null,
        dueDate: null,
      })
    }
  })

  test('AC-5: a drag across phase groups moves the task into that phase and the order survives a reload', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/list', [researchSeed()])
    await expect
      .poll(() => rowTitles(group(page, 'Build')))
      .toEqual(['Prototype flow', 'Draft survey', 'Plan retro'])

    // "Interview users" (Discovery) into Build, between "Prototype flow" and "Draft survey".
    await dragHandleTo(
      page,
      taskRow(page, 'Interview users'),
      await pointIn(taskRow(page, 'Prototype flow'), 0.85),
      /^Interview users is over Prototype flow\.$/,
    )
    await expect
      .poll(() => rowTitles(group(page, 'Build')))
      .toEqual(['Prototype flow', 'Interview users', 'Draft survey', 'Plan retro'])
    await expect
      .poll(async () => (await storedTask(page, 'Interview users'))?.phaseId)
      .toBe('ph-build')

    await page.reload()
    await expect
      .poll(() => rowTitles(group(page, 'Build')))
      .toEqual(['Prototype flow', 'Interview users', 'Draft survey', 'Plan retro'])
    await expect.poll(() => rowTitles(group(page, 'Discovery'))).toEqual(['Synthesize findings'])
    await expect.poll(() => rowTitles(group(page, 'No phase'))).toEqual(['Inbox idea'])
  })

  test('AC-5: subtasks reorder among their siblings and keep that order after a reload', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/list', [researchSeed()])
    await page.getByRole('button', { name: 'Expand subtasks' }).click()
    await expect
      .poll(() => rowTitles(group(page, 'Discovery')))
      .toEqual(['Interview users', 'Synthesize findings', '↳ Cluster notes', '↳ Write personas'])

    await dragHandleTo(
      page,
      taskRow(page, 'Write personas'),
      await pointIn(taskRow(page, 'Cluster notes'), 0.2),
      /^Write personas is over Cluster notes\.$/,
    )
    await expect
      .poll(() => rowTitles(group(page, 'Discovery')))
      .toEqual(['Interview users', 'Synthesize findings', '↳ Write personas', '↳ Cluster notes'])

    await page.reload()
    // Whether the subtasks are shown after a reload is the List's own (remembered) choice.
    await expect(page.getByRole('button', { name: /^(Expand|Collapse) subtasks$/ })).toBeVisible()
    const expandAll = page.getByRole('button', { name: 'Expand subtasks' })
    if (await expandAll.isVisible()) await expandAll.click()
    await expect
      .poll(() => rowTitles(group(page, 'Discovery')))
      .toEqual(['Interview users', 'Synthesize findings', '↳ Write personas', '↳ Cluster notes'])
    // Both are still subtasks of the same parent, in the parent's phase.
    for (const title of ['Write personas', 'Cluster notes']) {
      expect(await storedTask(page, title)).toMatchObject({
        parentTaskId: 't-synth',
        phaseId: 'ph-discovery',
      })
    }
  })

  test('AC-5: dragging a parent into another phase takes its subtasks along and the order survives a reload', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/list', [researchSeed()])
    await expect
      .poll(() => rowTitles(group(page, 'Build')))
      .toEqual(['Prototype flow', 'Draft survey', 'Plan retro'])

    // "Synthesize findings" (two subtasks, folded) from Discovery into Build, after "Prototype flow".
    await dragHandleTo(
      page,
      taskRow(page, 'Synthesize findings'),
      await pointIn(taskRow(page, 'Prototype flow'), 0.85),
      /^Synthesize findings is over Prototype flow\.$/,
    )
    await expect
      .poll(() => rowTitles(group(page, 'Build')))
      .toEqual(['Prototype flow', 'Synthesize findings', 'Draft survey', 'Plan retro'])
    await expect.poll(() => rowTitles(group(page, 'Discovery'))).toEqual(['Interview users'])

    await page.reload()
    await expect
      .poll(() => rowTitles(group(page, 'Build')))
      .toEqual(['Prototype flow', 'Synthesize findings', 'Draft survey', 'Plan retro'])
    // The subtasks went with it: still one level under the same parent, now in Build.
    await page.getByRole('button', { name: 'Expand subtasks' }).click()
    await expect
      .poll(() => rowTitles(group(page, 'Build')))
      .toEqual([
        'Prototype flow',
        'Synthesize findings',
        '↳ Cluster notes',
        '↳ Write personas',
        'Draft survey',
        'Plan retro',
      ])
    expect(await storedTask(page, 'Synthesize findings')).toMatchObject({
      parentTaskId: null,
      phaseId: 'ph-build',
    })
    for (const title of ['Cluster notes', 'Write personas']) {
      expect(await storedTask(page, title)).toMatchObject({
        parentTaskId: 't-synth',
        phaseId: 'ph-build',
      })
    }
  })

  test('AC-5: a parent dragged while its subtasks are shown keeps them directly under it, in its phase and into another', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/list', [researchSeed()])
    await page.getByRole('button', { name: 'Expand subtasks' }).click()
    await expect
      .poll(() => rowTitles(group(page, 'Discovery')))
      .toEqual(['Interview users', 'Synthesize findings', '↳ Cluster notes', '↳ Write personas'])

    // Up within its phase.
    await dragHandleTo(
      page,
      taskRow(page, 'Synthesize findings'),
      await pointIn(taskRow(page, 'Interview users'), 0.2),
      /^Synthesize findings is over Interview users\.$/,
    )
    await expect
      .poll(() => rowTitles(group(page, 'Discovery')))
      .toEqual(['Synthesize findings', '↳ Cluster notes', '↳ Write personas', 'Interview users'])

    // Into Build (lifting the parent folds its subtasks away, so the target is measured live).
    await dragHandleTo(
      page,
      taskRow(page, 'Synthesize findings'),
      () => pointIn(taskRow(page, 'Prototype flow'), 0.85),
      /^Synthesize findings is over Prototype flow\.$/,
    )
    await expect.poll(() => rowTitles(group(page, 'Discovery'))).toEqual(['Interview users'])
    // Wherever it landed among the others, the block is intact and the others kept their order.
    const intact = (titles: string[]) => {
      const at = titles.indexOf('Synthesize findings')
      expect(titles.slice(at, at + 3)).toEqual([
        'Synthesize findings',
        '↳ Cluster notes',
        '↳ Write personas',
      ])
      expect(
        titles.filter((title) => title !== 'Synthesize findings' && !title.startsWith('↳')),
      ).toEqual(['Prototype flow', 'Draft survey', 'Plan retro'])
    }
    const shown = await rowTitles(group(page, 'Build'))
    intact(shown)

    // What was shown is what was saved.
    await page.reload()
    const expandAll = page.getByRole('button', { name: 'Expand subtasks' })
    if (await expandAll.isVisible()) await expandAll.click()
    await expect.poll(() => rowTitles(group(page, 'Build'))).toEqual(shown)
    await expect.poll(() => rowTitles(group(page, 'Discovery'))).toEqual(['Interview users'])
    for (const title of ['Cluster notes', 'Write personas']) {
      expect(await storedTask(page, title)).toMatchObject({
        parentTaskId: 't-synth',
        phaseId: 'ph-build',
      })
    }
  })
})

// ===========================================================================
// AC-6 — Board drag changes the status everywhere
// ===========================================================================

test.describe('AC-6: Board drag and drop', () => {
  const boardSeed = (): SeedProject => ({
    id: 'p-board',
    name: 'Board project',
    tasks: [
      { id: 'b-alpha', title: 'Alpha' },
      { id: 'b-beta', title: 'Beta', status: 'in_progress' },
      { id: 'b-gamma', title: 'Gamma', status: 'done' },
      {
        id: 'b-delta',
        title: 'Delta',
        priority: 'high',
        startDate: '2026-11-10',
        dueDate: '2026-11-20',
      },
      { id: 'b-echo', title: 'Echo' },
    ],
  })

  test('AC-6: dragging To Do → In Progress shows in the List at once and after a reload', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-board/board', [boardSeed()])
    await expect(column(page, 'To Do')).toHaveAccessibleName('To Do 3 tasks')
    // Three fixed columns in the PRD's order.
    await expect(column(page, 'In Progress')).toHaveAccessibleName('In Progress 1 task')
    await expect(column(page, 'Done')).toHaveAccessibleName('Done 1 task')
    const lefts = await Promise.all(
      ['To Do', 'In Progress', 'Done'].map(
        async (name) => (await column(page, name).boundingBox())?.x ?? -1,
      ),
    )
    expect(lefts[0]).toBeLessThan(lefts[1])
    expect(lefts[1]).toBeLessThan(lefts[2])

    await dragCard(page, card(page, 'Alpha'), await topOf(card(page, 'Beta')), () =>
      expect.poll(() => visualCardTitles(column(page, 'In Progress'))).toEqual(['Alpha', 'Beta']),
    )
    await expect.poll(() => cardTitles(column(page, 'In Progress'))).toEqual(['Alpha', 'Beta'])
    expect(await cardTitles(column(page, 'To Do'))).toEqual(['Delta', 'Echo'])
    await expect.poll(async () => (await storedTask(page, 'Alpha'))?.status).toBe('in_progress')

    // At once: switch to the List without a reload.
    await page.getByRole('link', { name: 'List', exact: true }).click()
    await expect(page).toHaveURL(/\/list$/)
    const row = taskRow(page, 'Alpha')
    await expect(row.getByRole('button', { name: 'Status: In Progress' })).toBeVisible()

    // And after a reload, in the List and back on the Board.
    await page.reload()
    await expect(
      taskRow(page, 'Alpha').getByRole('button', { name: 'Status: In Progress' }),
    ).toBeVisible()
    await page.getByRole('link', { name: 'Board', exact: true }).click()
    await expect.poll(() => cardTitles(column(page, 'In Progress'))).toEqual(['Alpha', 'Beta'])
  })

  test('AC-6: reordering inside a column never changes status, priority or dates', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-board/board', [boardSeed()])
    const before = await storedTask(page, 'Delta')

    await dragCard(page, card(page, 'Delta'), await topOf(card(page, 'Echo')), () =>
      expect
        .poll(() => visualCardTitles(column(page, 'To Do')))
        .toEqual(['Alpha', 'Echo', 'Delta']),
    )
    await expect.poll(() => cardTitles(column(page, 'To Do'))).toEqual(['Alpha', 'Echo', 'Delta'])
    await expect
      .poll(async () => (await storedTask(page, 'Delta'))?.sortOrder)
      .not.toBe(before?.sortOrder)
    for (const title of ['Alpha', 'Echo', 'Delta']) {
      expect(await storedTask(page, title)).toMatchObject({ status: 'todo' })
    }
    expect(await storedTask(page, 'Delta')).toMatchObject({
      priority: 'high',
      startDate: '2026-11-10',
      dueDate: '2026-11-20',
      completedAt: null,
    })

    await page.reload()
    await expect.poll(() => cardTitles(column(page, 'To Do'))).toEqual(['Alpha', 'Echo', 'Delta'])
    // The List shows the same order (one task order for every view).
    await page.getByRole('link', { name: 'List', exact: true }).click()
    await expect
      .poll(() => rowTitles(listArea(page)))
      .toEqual(['Alpha', 'Beta', 'Gamma', 'Echo', 'Delta'])
  })

  test('AC-6: a drag to Done completes the task, and back out reopens it', async ({ page }) => {
    await openApp(page, '/projects/p-board/board', [boardSeed()])
    await dragCard(page, card(page, 'Echo'), await topOf(card(page, 'Gamma')), () =>
      expect.poll(() => visualCardTitles(column(page, 'Done'))).toEqual(['Echo', 'Gamma']),
    )
    await expect.poll(async () => (await storedTask(page, 'Echo'))?.status).toBe('done')
    expect((await storedTask(page, 'Echo'))?.completedAt).not.toBeNull()
    await expect.poll(() => cardTitles(column(page, 'Done'))).toEqual(['Echo', 'Gamma'])
    await expect(page.locator('[data-board-drag-overlay]')).toHaveCount(0)
    await dragCard(page, card(page, 'Echo'), await topOf(card(page, 'Delta')), () =>
      expect
        .poll(() => visualCardTitles(column(page, 'To Do')))
        .toEqual(['Alpha', 'Echo', 'Delta']),
    )
    await expect.poll(async () => (await storedTask(page, 'Echo'))?.status).toBe('todo')
    expect((await storedTask(page, 'Echo'))?.completedAt).toBeNull()
  })
})

// ===========================================================================
// The walk-through with nothing seeded: the order keys and columns are the app's own
// ===========================================================================

test.describe('journey', () => {
  test('AC-6: a project built only in the UI keeps one task order in List and Board, and a card dragged into the empty In Progress column shows in the List at once and after a reload', async ({
    page,
  }) => {
    await openApp(page, '/overview')
    await page.getByRole('button', { name: 'Create project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Research')
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/list$/)

    // Three tasks, name only, typed in a row.
    const first = page.getByRole('textbox', { name: 'Add your first task' })
    await first.fill('Collect sources')
    await first.press('Enter')
    await expect(taskRow(page, 'Collect sources')).toBeVisible()
    const input = page.getByRole('textbox', { name: 'New task' })
    if (!(await input.isVisible())) {
      await page.getByRole('button', { name: 'Add task', exact: true }).click()
    }
    await input.fill('Read the papers')
    await input.press('Enter')
    await input.fill('Write the summary')
    await input.press('Enter')
    await input.press('Escape')
    await expect
      .poll(() => rowTitles(listArea(page)))
      .toEqual(['Collect sources', 'Read the papers', 'Write the summary'])

    // AC-5 with keys the app generated itself: the last task goes to the top and stays there.
    await dragHandleTo(
      page,
      taskRow(page, 'Write the summary'),
      await pointIn(taskRow(page, 'Collect sources'), 0.2),
      /^Write the summary is over Collect sources\.$/,
    )
    const order = ['Write the summary', 'Collect sources', 'Read the papers']
    await expect.poll(() => rowTitles(listArea(page))).toEqual(order)
    await page.reload()
    await expect.poll(() => rowTitles(listArea(page))).toEqual(order)
    // Distinct keys that sort (plain comparison, as the app does) into the shown order.
    const keys = await Promise.all(
      order.map(async (title) => (await storedTask(page, title))?.sortOrder),
    )
    expect(new Set(keys).size).toBe(order.length)
    expect([...keys].sort((a, b) => (a! < b! ? -1 : a! > b! ? 1 : 0))).toEqual(keys)

    // The Board shows the same order; In Progress starts empty and takes the dragged card.
    await page.getByRole('link', { name: 'Board', exact: true }).click()
    await expect.poll(() => cardTitles(column(page, 'To Do'))).toEqual(order)
    const progress = column(page, 'In Progress')
    await expect(progress).toHaveAccessibleName('In Progress 0 tasks')
    const box = await progress.boundingBox()
    if (!box) throw new Error('In Progress column is not visible')
    await dragCard(
      page,
      card(page, 'Collect sources'),
      { x: box.x + box.width / 2, y: box.y + 120 },
      () => expect.poll(() => visualCardTitles(progress)).toEqual(['Collect sources']),
    )
    await expect.poll(() => cardTitles(progress)).toEqual(['Collect sources'])
    await expect(column(page, 'To Do')).toHaveAccessibleName('To Do 2 tasks')

    // The List agrees at once and after a reload; order and dates were not touched by the move.
    await page.getByRole('link', { name: 'List', exact: true }).click()
    const inList = () =>
      taskRow(page, 'Collect sources').getByRole('button', { name: 'Status: In Progress' })
    await expect(inList()).toBeVisible()
    await expect.poll(() => rowTitles(listArea(page))).toEqual(order)
    await page.reload()
    await expect(inList()).toBeVisible()
    await expect.poll(() => rowTitles(listArea(page))).toEqual(order)
    expect(await storedTask(page, 'Collect sources')).toMatchObject({
      status: 'in_progress',
      startDate: null,
      dueDate: null,
      completedAt: null,
    })
    for (const title of ['Write the summary', 'Read the papers']) {
      expect(await storedTask(page, title)).toMatchObject({ status: 'todo' })
    }
    const after = await Promise.all(
      order.map(async (title) => (await storedTask(page, title))?.sortOrder),
    )
    expect(after).toEqual(keys)
  })
})

// ===========================================================================
// §4.4 / §4.5 / §4.6 — page specs
// ===========================================================================

test.describe('page specs', () => {
  test('AC-1: §4.1 shell: sidebar with recent projects collapses to icons and remembers it; breadcrumb, theme and Search work', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/list', [researchSeed(), flatSeed()])
    const side = sidebar(page)
    await expect(page.getByRole('heading', { name: 'Research', exact: true })).toBeVisible()

    // Expanded: the four destinations, recent projects (the open one is current), Settings below.
    for (const name of ['Overview', 'My Tasks', 'Projects', 'Timeline']) {
      await expect(side.getByRole('link', { name })).toBeVisible()
    }
    await expect(side.getByRole('link', { name: 'Research' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(side.getByRole('link', { name: 'Flat project' })).toBeVisible()
    await expect(side.getByRole('link', { name: 'Settings' })).toBeVisible()
    const widthOpen = (await side.boundingBox())?.width ?? 0

    // Breadcrumb and the tab title follow the page.
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' })
    await expect(crumbs.getByRole('link', { name: 'Projects' })).toBeVisible()
    await expect(crumbs.getByText('Research')).toHaveAttribute('aria-current', 'page')
    await expect(page).toHaveTitle('Research · Cairn')

    // Collapse (button, then the "[" key), the choice survives a reload, links keep their names.
    await side.getByRole('button', { name: 'Collapse sidebar' }).click()
    await expect(side).toHaveAttribute('data-collapsed', 'true')
    await expect
      .poll(async () => (await side.boundingBox())?.width ?? 999)
      .toBeLessThan(widthOpen / 2)
    for (const name of ['Overview', 'My Tasks', 'Projects', 'Timeline', 'Settings']) {
      await expect(side.getByRole('link', { name })).toBeVisible()
    }
    await page.reload()
    await expect(side).toHaveAttribute('data-collapsed', 'true')
    await side.getByRole('button', { name: 'Expand sidebar' }).click()
    await expect(side).toHaveAttribute('data-collapsed', 'false')
    await page.keyboard.press('[')
    await expect(side).toHaveAttribute('data-collapsed', 'true')
    await page.keyboard.press('[')
    await expect(side).toHaveAttribute('data-collapsed', 'false')
    await page.reload()
    await expect(side).toHaveAttribute('data-collapsed', 'false')

    // Theme: Dark is applied at once and is still there after a reload; Light switches back.
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'))
    await page.getByRole('button', { name: /^Theme:/ }).click()
    await page.getByRole('menuitemradio', { name: 'Dark' }).click()
    await expect.poll(isDark).toBe(true)
    await page.reload()
    expect(await isDark()).toBe(true)
    await page.getByRole('button', { name: 'Theme: Dark' }).click()
    await page.getByRole('menuitemradio', { name: 'Light' }).click()
    await expect.poll(isDark).toBe(false)

    // Search opens from its button and closes with Esc; Settings is the last sidebar item.
    await page.getByRole('button', { name: /^Search/ }).click()
    await expect(page.getByRole('dialog', { name: /Search/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await side.getByRole('link', { name: 'Settings' }).click()
    await expect(page).toHaveURL(/\/settings\/account$/)
  })

  test('AC-1: §4.1 routes: a collapsed sidebar names its icons in tooltips (hover and keyboard); Back, Forward, a refresh and a direct link land on the right page', async ({
    page,
  }) => {
    await openApp(page, '/overview', [researchSeed(), flatSeed()])
    const side = sidebar(page)
    await expect(side.getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    )

    // Navigate: My Tasks → Projects → Research (List) → Board.
    await side.getByRole('link', { name: 'My Tasks' }).click()
    await expect(page).toHaveURL(/\/my-tasks\/[a-z-]+$/)
    await side.getByRole('link', { name: 'Projects' }).click()
    await expect(page).toHaveURL(/\/projects$/)
    await page
      .getByRole('table', { name: 'Projects' })
      .getByRole('link', { name: 'Research', exact: true })
      .click()
    await expect(page).toHaveURL(/\/projects\/p-research\/list$/)
    await page.getByRole('link', { name: 'Board', exact: true }).click()
    await expect(page).toHaveURL(/\/projects\/p-research\/board$/)
    await expect(column(page, 'To Do')).toBeVisible()

    // Back steps through the pages just visited (the remembered-view redirect is no trap), Forward returns.
    await page.goBack()
    await expect(page).toHaveURL(/\/projects\/p-research\/list$/)
    await page.goBack()
    await expect(page).toHaveURL(/\/projects$/)
    await page.goBack()
    await expect(page).toHaveURL(/\/my-tasks\/[a-z-]+$/)
    await page.goForward()
    await expect(page).toHaveURL(/\/projects$/)
    await expect(page.getByRole('table', { name: 'Projects' })).toBeVisible()

    // A refresh and a direct link keep the page (no redirect to the home page, shell intact).
    await page.goto('/projects/p-research/board')
    await expect(column(page, 'To Do')).toBeVisible()
    await page.reload()
    await expect(page).toHaveURL(/\/projects\/p-research\/board$/)
    await expect(column(page, 'To Do')).toBeVisible()
    await expect(side.getByRole('link', { name: 'Research' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await page.goto('/timeline')
    await expect(side.getByRole('link', { name: 'Timeline' })).toHaveAttribute(
      'aria-current',
      'page',
    )

    // Collapsed: icons only, and each one still says what it is (tooltip) on hover and on focus.
    await side.getByRole('button', { name: 'Collapse sidebar' }).click()
    await expect(side).toHaveAttribute('data-collapsed', 'true')
    await side.getByRole('link', { name: 'My Tasks' }).hover()
    await expect(page.getByRole('tooltip')).toContainText('My Tasks')
    await page.mouse.move(700, 400)
    await side.getByRole('link', { name: 'My Tasks' }).focus()
    await page.keyboard.press('Tab')
    await expect(side.getByRole('link', { name: 'Projects' })).toBeFocused()
    await expect(page.getByRole('tooltip').filter({ hasText: 'Projects' })).toBeVisible()
  })

  test('AC-2: §4.4 Projects page is a dense list with status, progress and dates, filters, and remembers the last used view', async ({
    page,
  }) => {
    await openApp(page, '/projects', [
      researchSeed(),
      flatSeed(),
      {
        id: 'p-done',
        name: 'Website redesign',
        status: 'completed',
        tasks: [{ id: 'w1', title: 'W', status: 'done' }],
      },
      { id: 'p-old', name: 'Legacy migration', status: 'archived' },
    ])
    const table = page.getByRole('table', { name: 'Projects' })
    await expect(table).toBeVisible()
    // A table (columns), not a wall of cards.
    for (const name of ['Project', 'Status', 'Progress']) {
      await expect(table.getByRole('columnheader', { name })).toBeVisible()
    }
    const links = table.getByRole('link')
    await expect.poll(() => links.allInnerTexts()).toEqual(['Research', 'Flat project'])
    const research = table.getByRole('row').filter({
      has: page.getByRole('link', { name: 'Research', exact: true }),
    })
    // 6 leaf tasks (subtasks count, their parent does not), none done → 0%.
    await expect(research.getByRole('progressbar', { name: 'Research progress' })).toHaveAttribute(
      'aria-valuenow',
      '0',
    )
    const rowBox = await research.boundingBox()
    expect(rowBox?.height ?? 999).toBeLessThan(64) // dense, not a card

    // Filters.
    const filters = page.getByRole('radiogroup', { name: 'Filter projects by status' })
    await filters.getByRole('radio', { name: /^Completed/ }).click()
    await expect.poll(() => links.allInnerTexts()).toEqual(['Website redesign'])
    await filters.getByRole('radio', { name: /^Archived/ }).click()
    await expect.poll(() => links.allInnerTexts()).toEqual(['Legacy migration'])
    await filters.getByRole('radio', { name: /^Active/ }).click()
    await page
      .getByRole('searchbox', { name: 'Filter projects by name or description' })
      .fill('flat')
    await expect.poll(() => links.allInnerTexts()).toEqual(['Flat project'])
    await page.getByRole('button', { name: 'Clear filter', exact: true }).first().click()

    // The last used view is remembered per project: Board for Research, Gantt for Flat.
    await table.getByRole('link', { name: 'Research', exact: true }).click()
    await expect(page).toHaveURL(/\/projects\/p-research\/list$/) // default
    await page.getByRole('link', { name: 'Board', exact: true }).click()
    await expect(page).toHaveURL(/\/p-research\/board$/)
    await sidebar(page).getByRole('link', { name: 'Flat project' }).click()
    await expect(page.getByRole('heading', { name: 'Flat project', exact: true })).toBeVisible()
    await page.getByRole('link', { name: 'Gantt', exact: true }).click()
    await expect(page).toHaveURL(/\/p-flat\/gantt$/)

    await page.goto('/projects')
    await page
      .getByRole('table', { name: 'Projects' })
      .getByRole('link', { name: 'Research', exact: true })
      .click()
    await expect(page).toHaveURL(/\/projects\/p-research\/board$/)
    await page.goto('/projects/p-flat') // a direct visit, even after a full page load
    await expect(page).toHaveURL(/\/projects\/p-flat\/gantt$/)
    await sidebar(page).getByRole('link', { name: 'Research' }).click()
    await expect(page).toHaveURL(/\/p-research\/board$/)
  })

  test('AC-4: §4.5 project List: header with progress, view tabs, rows edited in place, inline add, subtasks expand', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/list', [researchSeed()])
    await expect(page.getByRole('heading', { name: 'Research', exact: true })).toBeVisible()
    await expect(page.getByRole('progressbar', { name: 'Project progress' })).toBeVisible()
    const tabs = page.getByRole('navigation', { name: 'Project views' })
    await expect(tabs.getByRole('link')).toHaveText(['List', 'Board', 'Gantt'])
    await expect(page.locator('main').getByRole('button', { name: 'New task' })).toBeVisible() // a button, no shortcut needed

    // Rows: handle, status, title; subtasks stay folded until asked for.
    const row = taskRow(page, 'Prototype flow')
    await expect(row.getByRole('button', { name: 'Move Prototype flow' })).toBeVisible()
    await expect(row.getByRole('button', { name: /^Status:/ })).toBeVisible()
    await expect(taskRow(page, 'Synthesize findings')).toContainText(/subtasks? done/)
    await expect(page.getByRole('button', { name: 'Move Cluster notes' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Show subtasks of Synthesize findings' }).click()
    await expect(page.getByRole('button', { name: 'Move Cluster notes' })).toBeVisible()

    // Row editing: status, priority and due date without opening anything.
    await row.getByRole('button', { name: /^Status:/ }).click()
    await page.getByRole('menuitemradio', { name: 'In Progress' }).click()
    await row.getByRole('button', { name: /^Priority:/ }).click()
    await page.getByRole('menuitemradio', { name: 'Urgent' }).click()
    await row.getByRole('button', { name: /^Due date/ }).click()
    await page.getByRole('button', { name: /^Tomorrow/ }).click()
    const tomorrow = await isoDay(page, 1)
    await expect
      .poll(() => storedTask(page, 'Prototype flow'))
      .toMatchObject({ status: 'in_progress', priority: 'urgent', dueDate: tomorrow })
    // The title opens the Task Modal; Esc comes back to the row (once the date popover has left).
    await expect(page.getByRole('dialog', { name: 'Due date', exact: true })).toHaveCount(0)
    await row.getByRole('button', { name: 'Prototype flow', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Edit task: Prototype flow' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Inline add at the end of a phase, rapidly.
    await group(page, 'Build').getByRole('button', { name: 'Add task', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'New task' })
    await input.fill('Run pilot')
    await input.press('Enter')
    await input.fill('Review pilot')
    await input.press('Enter')
    await input.press('Escape')
    await expect
      .poll(() => rowTitles(group(page, 'Build')))
      .toEqual(['Prototype flow', 'Draft survey', 'Plan retro', 'Run pilot', 'Review pilot'])
    await page.reload()
    await expect
      .poll(() => rowTitles(group(page, 'Build')))
      .toEqual(['Prototype flow', 'Draft survey', 'Plan retro', 'Run pilot', 'Review pilot'])
    await expect(
      taskRow(page, 'Prototype flow').getByRole('button', { name: 'Priority: Urgent' }),
    ).toBeVisible()
  })

  test('AC-6: §4.6 Board cards show title, date, priority and subtask summary; the status menu moves a card too', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/board', [
      {
        ...researchSeed(),
        tasks: [
          ...(researchSeed().tasks ?? []),
          { id: 't-hot', title: 'Hot fix', priority: 'urgent', dueDate: '2026-12-24' },
        ],
      },
    ])
    await expect(column(page, 'To Do')).toBeVisible()
    const hot = page.locator('li', { has: card(page, 'Hot fix') })
    await expect(hot.getByText('Dec 24', { exact: true })).toBeVisible()
    // The priority glyph is described for assistive technology as "Priority: Urgent. Due Dec 24, 2026."
    const describedBy = (await card(page, 'Hot fix').getAttribute('aria-describedby'))?.split(
      ' ',
    )[0]
    await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(
      'Priority: Urgent. Due Dec 24, 2026.',
    )
    // The parent shows a subtask count, the subtasks themselves are not cards.
    await expect(page.locator('li', { has: card(page, 'Synthesize findings') })).toContainText(
      '0/2',
    )
    await expect(card(page, 'Cluster notes')).toHaveCount(0)

    // Status change without dragging: the glyph menu (the keyboard route).
    await hot.getByRole('button', { name: /^Status/ }).click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect.poll(() => cardTitles(column(page, 'Done'))).toEqual(['Hot fix'])
    await expect.poll(async () => (await storedTask(page, 'Hot fix'))?.status).toBe('done')
  })

  test('AC-6: §4.6 a Board card has no delete of its own: its Task Modal deletes it, and a parent asks what happens to its subtasks', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/board', [researchSeed()])
    await expect(column(page, 'To Do')).toBeVisible()

    const openDelete = async (title: string) => {
      await card(page, title).click()
      const modal = page.getByRole('dialog', { name: `Edit task: ${title}` })
      await modal.getByRole('button', { name: 'More actions' }).click()
      await page.getByRole('menuitem', { name: /Delete task/ }).click()
      return modal
    }

    // A plain card: asks first (Cancel keeps it), then it leaves the Board and the store.
    let modal = await openDelete('Inbox idea')
    const confirmation = page.getByRole('alertdialog', { name: 'Delete task?' })
    await confirmation.getByRole('button', { name: 'Cancel' }).click()
    await expect(modal).toBeVisible()
    expect(await storedTask(page, 'Inbox idea')).toBeDefined()
    await modal.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: /Delete task/ }).click()
    await confirmation.getByRole('button', { name: 'Delete' }).click()
    await expect(modal).toBeHidden()
    await expect(toast(page, 'Task deleted')).toBeVisible()
    await expect(toast(page, 'Task not found')).toHaveCount(0)
    await expect(card(page, 'Inbox idea')).toHaveCount(0)
    await expect(page).toHaveURL(/\/projects\/p-research\/board$/) // still on the Board, no ?task=
    await expect.poll(() => storedTask(page, 'Inbox idea')).toBeUndefined()

    // A parent: the choice names the subtasks; keeping them makes them top-level cards.
    modal = await openDelete('Synthesize findings')
    const choice = page.getByRole('alertdialog', { name: /Delete “Synthesize findings”\?/ })
    await expect(choice).toContainText('2 subtasks')
    await choice.getByRole('button', { name: 'Keep subtasks (move to top level)' }).click()
    await expect(modal).toBeHidden()
    await expect(toast(page, 'Task deleted · subtasks kept')).toBeVisible()
    await expect(card(page, 'Synthesize findings')).toHaveCount(0)
    await expect(card(page, 'Cluster notes')).toBeVisible()
    await expect(card(page, 'Write personas')).toBeVisible()

    await page.reload()
    await expect(card(page, 'Cluster notes')).toBeVisible()
    await expect(card(page, 'Inbox idea')).toHaveCount(0)
    expect((await storedTask(page, 'Cluster notes'))?.parentTaskId).toBeNull()
    expect((await storedTask(page, 'Write personas'))?.parentTaskId).toBeNull()
  })

  test('AC-4: §5.1 a subtask is added from a Board card’s Task Modal; the card counts it and the subtask is not a card', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/board', [researchSeed()])
    await card(page, 'Inbox idea').click()
    const modal = page.getByRole('dialog', { name: 'Edit task: Inbox idea' })
    await expect(modal.getByText('One level of subtasks')).toBeVisible()
    const add = modal.getByRole('textbox', { name: 'Add subtask' })
    await add.fill('Sketch the idea')
    await add.press('Enter')
    await expect(modal.getByRole('button', { name: 'Sketch the idea', exact: true })).toBeVisible()
    await expect
      .poll(async () => (await storedTask(page, 'Sketch the idea'))?.parentTaskId)
      .toBe('t-inbox')
    await modal.getByRole('button', { name: 'Close' }).click()
    await expect(modal).toBeHidden()
    const inbox = page.locator('li', { has: card(page, 'Inbox idea') })
    await expect(inbox).toContainText('0/1')
    await expect(card(page, 'Sketch the idea')).toHaveCount(0)

    await page.reload()
    await expect(page.locator('li', { has: card(page, 'Inbox idea') })).toContainText('0/1')
    await expect(card(page, 'Sketch the idea')).toHaveCount(0)
  })

  test('AC-4: §5.1 a line left in "Add subtask" becomes exactly one subtask, whichever way the modal closes', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/board', [researchSeed()])
    const modal = page.getByRole('dialog', { name: 'Edit task: Inbox idea' })
    const ways: [string, () => Promise<void>][] = [
      ['Esc', () => page.keyboard.press('Escape')],
      ['Done', () => modal.getByRole('button', { name: 'Done' }).click()],
      ['the X', () => modal.getByRole('button', { name: 'Close' }).click()],
      ['a click outside', () => page.mouse.click(4, 4)],
    ]
    for (const [way, close] of ways) {
      await card(page, 'Inbox idea').click()
      await modal.getByRole('textbox', { name: 'Add subtask' }).fill(`Left by ${way}`)
      await close()
      await expect(modal).toBeHidden()
    }
    await page.waitForTimeout(500) // anything a second commit would have sent is stored by now
    const titles = Object.values((await stored(page)).tasks ?? {})
      .filter((task) => task.parentTaskId === 't-inbox')
      .map((task) => task.title)
      .sort()
    expect(titles).toEqual(ways.map(([way]) => `Left by ${way}`).sort())
    await page.reload()
    await expect(page.locator('li', { has: card(page, 'Inbox idea') })).toContainText('0/4')
  })

  test('AC-2: §4.4 a project status change that failed and was retried from the toast is saved once, and the row follows it', async ({
    page,
  }) => {
    await openApp(page, '/projects', [researchSeed(), flatSeed()])
    const table = page.getByRole('table', { name: 'Projects' })
    await expect(table).toBeVisible()
    const row = table.getByRole('row').filter({
      has: page.getByRole('link', { name: 'Flat project', exact: true }),
    })

    await failNextWrites(page, 1)
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Mark completed' }).click()
    const failure = toast(page, /Couldn.t update project/)
    await expect(failure).toBeVisible()
    // Rolled back: still listed as Active, and nothing claims it was completed.
    await expect(row).toBeVisible()
    await expect(toast(page, 'Project marked completed')).toHaveCount(0)
    expect((await stored(page)).projects['p-flat'].status).toBe('active')

    await failure.getByRole('button', { name: 'Retry' }).click()
    // The row leaves the Active filter, the failure is gone, and the project is Completed.
    await expect(row).toHaveCount(0)
    await expect(failure).toHaveCount(0)
    await expect(toast(page, 'Saved')).toHaveCount(1)
    await expect.poll(async () => (await stored(page)).projects['p-flat'].status).toBe('completed')
    await page
      .getByRole('radiogroup', { name: 'Filter projects by status' })
      .getByRole('radio', { name: /^Completed/ })
      .click()
    await expect.poll(() => table.getByRole('link').allInnerTexts()).toEqual(['Flat project'])

    await page.reload()
    await page
      .getByRole('radiogroup', { name: 'Filter projects by status' })
      .getByRole('radio', { name: /^Completed/ })
      .click()
    await expect.poll(() => table.getByRole('link').allInnerTexts()).toEqual(['Flat project'])
    expect(
      Object.values((await stored(page)).projects)
        .map((p) => p.status)
        .sort(),
    ).toEqual(['active', 'completed'])
  })

  test('AC-2: §4.4 a project created with a start and a due date lists both dates; one without dates says so', async ({
    page,
  }) => {
    await openApp(page, '/projects', [researchSeed()])
    await page.locator('main').getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Community Event')
    const start = await isoDay(page, 3)
    const due = await isoDay(page, 20)
    await pickDate(page, dialog, 'Start date', start)
    await pickDate(page, dialog, 'Due date', due)
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/list$/)

    await page.goto('/projects')
    const row = (name: string) =>
      page
        .getByRole('table', { name: 'Projects' })
        .getByRole('row')
        .filter({ has: page.getByRole('link', { name, exact: true }) })
    // "Nov 7 – Nov 24" (a year is added only outside the current one).
    const monthDay = (iso: string) => {
      const [year, month, day] = iso.split('-').map(Number)
      const name = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
        month: 'short',
        timeZone: 'UTC',
      })
      return `${name} ${day}`
    }
    await expect(row('Community Event')).toContainText(
      new RegExp(`${monthDay(start)}.* – ${monthDay(due)}`),
    )
    await expect(row('Research')).toContainText('No dates')
    const project = Object.values((await stored(page)).projects).find(
      (candidate) => candidate.name === 'Community Event',
    )
    expect(project).toMatchObject({ startDate: start, dueDate: due })
  })

  test('AC-6: §4.6 a status change made on the Board is in the Gantt at once, in the row glyph and in the bar', async ({
    page,
  }) => {
    const inDays = (days: number) => {
      const date = new Date()
      date.setDate(date.getDate() + days)
      const two = (value: number) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
    }
    await openApp(page, '/projects/p-gantt/board', [
      {
        id: 'p-gantt',
        name: 'Gantt project',
        tasks: [
          { id: 'g-plan', title: 'Plan', startDate: inDays(1), dueDate: inDays(5) },
          { id: 'g-build', title: 'Build', startDate: inDays(6), dueDate: inDays(12) },
        ],
      },
    ])
    await expect(column(page, 'To Do')).toHaveAccessibleName('To Do 2 tasks')

    // A drag into the empty In Progress column, and the status menu for Done.
    const progress = column(page, 'In Progress')
    const box = await progress.boundingBox()
    if (!box) throw new Error('In Progress column is not visible')
    await dragCard(page, card(page, 'Plan'), { x: box.x + box.width / 2, y: box.y + 120 }, () =>
      expect.poll(() => visualCardTitles(progress)).toEqual(['Plan']),
    )
    await expect.poll(async () => (await storedTask(page, 'Plan'))?.status).toBe('in_progress')
    await page
      .locator('li', { has: card(page, 'Build') })
      .getByRole('button', { name: /^Status/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect.poll(async () => (await storedTask(page, 'Build'))?.status).toBe('done')

    // The Gantt, reached without a reload, already agrees.
    await page.getByRole('link', { name: 'Gantt', exact: true }).click()
    await expect(page).toHaveURL(/\/gantt$/)
    const outline = (id: string) => page.locator(`[data-row-key="task:${id}"]`)
    await expect(outline('g-plan').getByRole('img', { name: 'Status: In Progress' })).toBeVisible()
    await expect(outline('g-build').getByRole('img', { name: 'Status: Done' })).toBeVisible()
    await expect(page.locator('[data-task-id="g-plan"][data-link-target]')).toHaveAccessibleName(
      /^Plan, .*, In Progress$/,
    )
    await expect(page.locator('[data-task-id="g-build"][data-link-target]')).toHaveAccessibleName(
      /^Build, .*, Done$/,
    )
    // Moving cards never touched their dates.
    expect(await storedTask(page, 'Plan')).toMatchObject({
      startDate: inDays(1),
      dueDate: inDays(5),
    })
  })
})
