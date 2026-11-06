/// <reference lib="dom" />
/**
 * Projects + List E2E — runs in LOCAL data mode against the dev server (playwright.config.ts).
 *
 * PRD acceptance §9.1: #2 a project without phases, #3 a task from just a name, #4 phases,
 * subtasks and milestones next to a flat project, #5 a List drag reorder that survives a reload,
 * #10 progress from leaf tasks only. Also covered: the dense Projects table (status filter in the
 * URL, quick filter, row menu actions, exact delete counts, manual order), the project header and
 * remembered view, and the failure paths (a failed write rolls back and Retry saves it; a failed
 * create keeps the form and never creates the project twice).
 */
import { expect, test as base, type Locator, type Page } from '@playwright/test'

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
// Seed: a local "database" written to localStorage before the app boots
// ---------------------------------------------------------------------------

interface SeedTask {
  id: string
  title: string
  phaseId?: string
  parentId?: string
  status?: 'todo' | 'in_progress' | 'done'
}

interface SeedProject {
  id: string
  name: string
  description?: string
  status?: 'active' | 'completed' | 'archived'
  color?: string
  startDate?: string
  dueDate?: string
  phases?: { id: string; name: string }[]
  /** In project order; subtasks follow their parent in the order given. */
  tasks?: SeedTask[]
  milestones?: { id: string; name: string; date: string; phaseId?: string }[]
}

/** Fractional-index keys that sort by position: a0, a1, … (enough for the small seeds here). */
const key = (index: number) => `a${index}`

function buildWorkspace(projects: SeedProject[]): unknown {
  const db = {
    version: 1,
    projects: {} as Record<string, unknown>,
    phases: {} as Record<string, unknown>,
    tasks: {} as Record<string, unknown>,
    milestones: {} as Record<string, unknown>,
    dependencies: {},
    preferences: null,
  }
  projects.forEach((project, projectIndex) => {
    db.projects[project.id] = {
      id: project.id,
      name: project.name,
      description: project.description ?? null,
      status: project.status ?? 'active',
      color: project.color ?? 'violet',
      startDate: project.startDate ?? null,
      dueDate: project.dueDate ?? null,
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
        priority: 'none',
        startDate: null,
        dueDate: null,
        sortOrder: key(index),
        completedAt: task.status === 'done' ? NOW : null,
        createdAt: NOW,
        updatedAt: NOW,
      }
    })
    project.milestones?.forEach((milestone) => {
      db.milestones[milestone.id] = {
        id: milestone.id,
        projectId: project.id,
        phaseId: milestone.phaseId ?? null,
        name: milestone.name,
        date: milestone.date,
        createdAt: NOW,
        updatedAt: NOW,
      }
    })
  })
  return db
}

/**
 * Research: phases Discovery + Build, one task without a phase, three subtasks and a milestone —
 * 8 leaf tasks of which 2 are done (25%), 9 tasks in all of which 7 are open.
 * Active order: Research, Flat project, Empty project, Roadmap 規劃.
 */
function seedWorkspace(): unknown {
  return buildWorkspace([
    {
      id: 'p-research',
      name: 'Research',
      description: 'User interviews and a prototype',
      color: 'violet',
      startDate: '2027-01-04',
      dueDate: '2027-03-26',
      phases: [
        { id: 'ph-discovery', name: 'Discovery' },
        { id: 'ph-build', name: 'Build' },
      ],
      tasks: [
        { id: 't-inbox', title: 'Inbox idea' },
        { id: 't-interview', title: 'Interview users', phaseId: 'ph-discovery', status: 'done' },
        {
          id: 't-synth',
          title: 'Synthesize findings',
          phaseId: 'ph-discovery',
          status: 'in_progress',
        },
        {
          id: 't-cluster',
          title: 'Cluster notes',
          phaseId: 'ph-discovery',
          parentId: 't-synth',
          status: 'done',
        },
        { id: 't-personas', title: 'Write personas', phaseId: 'ph-discovery', parentId: 't-synth' },
        { id: 't-review', title: 'Review with team', phaseId: 'ph-discovery', parentId: 't-synth' },
        { id: 't-prototype', title: 'Prototype flow', phaseId: 'ph-build' },
        { id: 't-survey', title: 'Draft survey', phaseId: 'ph-build' },
        { id: 't-retro', title: 'Plan retro', phaseId: 'ph-build' },
      ],
      milestones: [
        { id: 'm-kickoff', name: 'Kickoff', date: '2027-01-05', phaseId: 'ph-discovery' },
      ],
    },
    {
      id: 'p-flat',
      name: 'Flat project',
      color: 'green',
      tasks: [
        { id: 'f-alpha', title: 'Alpha' },
        { id: 'f-beta', title: 'Beta', status: 'in_progress' },
        { id: 'f-gamma', title: 'Gamma', status: 'done' },
        { id: 'f-delta', title: 'Delta' },
      ],
    },
    { id: 'p-empty', name: 'Empty project', color: 'orange' },
    {
      id: 'p-web',
      name: 'Website redesign',
      color: 'blue',
      status: 'completed',
      tasks: [
        { id: 'w-1', title: 'Wireframes', status: 'done' },
        { id: 'w-2', title: 'Visual design', status: 'done' },
      ],
    },
    {
      id: 'p-old',
      name: 'Legacy migration',
      color: 'gray',
      status: 'archived',
      tasks: [{ id: 'o-1', title: 'Inventory services' }],
    },
    {
      id: 'p-cjk',
      name: 'Roadmap 規劃',
      description: '市場調查與使用者訪談計畫',
      color: 'teal',
      tasks: [{ id: 'c-1', title: '問卷設計' }],
    },
  ])
}

/** Boots the app at `path`; the workspace is seeded once per tab (a reload keeps the changes). */
async function openApp(page: Page, path: string, workspace: unknown = seedWorkspace()) {
  if (workspace !== null) {
    await page.addInitScript(
      ({ storageKey, db }) => {
        if (sessionStorage.getItem('cairn-e2e-projects-list-seeded')) return
        localStorage.setItem(storageKey, JSON.stringify(db))
        sessionStorage.setItem('cairn-e2e-projects-list-seeded', '1')
      },
      { storageKey: LOCAL_WORKSPACE_KEY, db: workspace },
    )
  }
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
  projects: Record<string, { name: string; status: string; sortOrder: string }>
  phases: Record<string, { projectId: string; name: string; sortOrder: string }>
  tasks: Record<
    string,
    {
      projectId: string
      title: string
      phaseId: string | null
      parentTaskId: string | null
      status: string
      priority: string
      dueDate: string | null
      sortOrder: string
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

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

const projectsTable = (page: Page) => page.getByRole('table', { name: 'Projects' })
const projectRow = (page: Page, name: string) =>
  projectsTable(page)
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name, exact: true }) })

/** Names of the listed projects, in table order. */
function projectNames(page: Page): Promise<string[]> {
  return projectsTable(page).getByRole('link').allInnerTexts()
}

/** The sidebar's "Saving…" line (by text: a modal dialog hides the sidebar from the role tree). */
const saving = (page: Page) => page.getByText('Saving…', { exact: true })

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

const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })

/** dnd-kit's screen reader announcements (also how the specs wait for a drag preview). */
const liveRegion = (page: Page) => page.locator('[id^="DndLiveRegion"]')

/** Picks up the handle of `source`, moves over `target` (a point in the page) and waits for the preview. */
async function dragHandleTo(
  page: Page,
  source: Locator,
  target: { x: number; y: number },
  announced: RegExp,
): Promise<void> {
  await source.hover()
  const handle = source.getByRole('button', { name: /^Move / })
  const box = await handle.boundingBox()
  if (!box) throw new Error('drag handle is not visible')
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  // dnd-kit starts a drag after a few px of movement; the next moves are the drag itself.
  await page.mouse.move(start.x + 6, start.y + (target.y > start.y ? 6 : -6), { steps: 3 })
  await page.mouse.move(target.x, target.y, { steps: 14 })
  await expect(liveRegion(page)).toHaveText(announced)
  await page.mouse.up()
}

/** A point `fraction` of the way down `locator`, a little right of the row's left edge. */
async function pointIn(locator: Locator, fraction: number): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('target is not visible')
  return { x: box.x + 300, y: box.y + box.height * fraction }
}

// ===========================================================================
// Projects page
// ===========================================================================

test.describe('projects page (local mode)', () => {
  test('is a dense table: status, progress from leaf tasks only, dates and open / total tasks', async ({
    page,
  }) => {
    await openApp(page, '/projects')
    await expect(projectsTable(page)).toBeVisible()
    await expect
      .poll(() => projectNames(page))
      .toEqual(['Research', 'Flat project', 'Empty project', 'Roadmap 規劃'])

    // Acceptance #10: 8 leaf tasks (subtasks count, their parent does not), 2 done → 25%.
    const research = projectRow(page, 'Research')
    await expect(research.getByRole('progressbar', { name: 'Research progress' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    )
    await expect(research.getByText('Active', { exact: true })).toBeVisible()
    await expect(research).toContainText('User interviews and a prototype')
    await expect(research).toContainText(/Jan 4/)
    await expect(research.getByText('7 open of 9 tasks, subtasks included')).toBeAttached()

    // No tasks: "No tasks", never a made-up 100%.
    const empty = projectRow(page, 'Empty project')
    await expect(empty).toContainText('No tasks')
    await expect(empty.getByRole('progressbar')).toHaveCount(0)
    await expect(empty.getByText('No dates')).toBeAttached()
  })

  test('filters by status in the URL, keeps it on reload, and has a quick text filter', async ({
    page,
  }) => {
    await openApp(page, '/projects')
    const filters = page.getByRole('radiogroup', { name: 'Filter projects by status' })
    await expect(filters.getByRole('radio', { name: 'Active (4)' })).toBeChecked()

    await filters.getByRole('radio', { name: 'Completed (1)' }).click()
    await expect(page).toHaveURL(/\/projects\?status=completed$/)
    await expect.poll(() => projectNames(page)).toEqual(['Website redesign'])
    await page.reload()
    await expect(filters.getByRole('radio', { name: 'Completed (1)' })).toBeChecked()
    await expect.poll(() => projectNames(page)).toEqual(['Website redesign'])

    await filters.getByRole('radio', { name: 'Archived (1)' }).click()
    await expect.poll(() => projectNames(page)).toEqual(['Legacy migration'])
    await filters.getByRole('radio', { name: 'All (6)' }).click()
    await expect(page).toHaveURL(/status=all$/)
    await expect.poll(async () => (await projectNames(page)).length).toBe(6)
    await filters.getByRole('radio', { name: 'Active (4)' }).click()
    await expect(page).toHaveURL(/\/projects$/)

    // Quick filter: name or description, CJK included; Esc clears it.
    const quick = page.getByRole('searchbox', { name: 'Filter projects by name or description' })
    await quick.fill('flat')
    await expect.poll(() => projectNames(page)).toEqual(['Flat project'])
    await quick.press('Escape')
    await expect(quick).toHaveValue('')
    await quick.fill('訪談')
    await expect.poll(() => projectNames(page)).toEqual(['Roadmap 規劃'])
    await quick.fill('no such project')
    await expect(page.getByText('No projects match “no such project”')).toBeVisible()
    await page.getByRole('button', { name: 'Clear filter', exact: true }).first().click()
    await expect.poll(async () => (await projectNames(page)).length).toBe(4)
  })

  test('Mark completed leaves the Active list with an Undo; Archive does too', async ({ page }) => {
    await openApp(page, '/projects')
    await projectRow(page, 'Flat project').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Mark completed' }).click()
    await expect(toast(page, 'Project marked completed')).toBeVisible()
    await expect
      .poll(() => projectNames(page))
      .toEqual(['Research', 'Empty project', 'Roadmap 規劃'])
    await expect.poll(async () => (await stored(page)).projects['p-flat'].status).toBe('completed')

    await toast(page, 'Project marked completed').getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => projectNames(page)).toContain('Flat project')
    await expect.poll(async () => (await stored(page)).projects['p-flat'].status).toBe('active')

    await projectRow(page, 'Empty project')
      .getByRole('button', { name: 'Actions for Empty project' })
      .click()
    await page.getByRole('menuitem', { name: 'Archive' }).click()
    await expect(toast(page, 'Project archived')).toBeVisible()
    await expect.poll(async () => (await stored(page)).projects['p-empty'].status).toBe('archived')
    await page.reload()
    await expect.poll(() => projectNames(page)).not.toContain('Empty project')
  })

  test('delete asks with exactly what goes with the project', async ({ page }) => {
    await openApp(page, '/projects')
    await projectRow(page, 'Research').getByRole('button', { name: 'Actions for Research' }).click()
    await page.getByRole('menuitem', { name: 'Delete project…' }).click()
    const confirm = page.getByRole('alertdialog', { name: 'Delete “Research”?' })
    await expect(confirm).toContainText(
      'Deletes 6 tasks, 3 subtasks, 2 phases and 1 milestone along with the project.',
    )
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirm).toBeHidden()
    expect(await projectNames(page)).toContain('Research')

    await projectRow(page, 'Research').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete project…' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete project' }).click()
    await expect(toast(page, 'Project deleted')).toBeVisible()
    await expect.poll(() => projectNames(page)).not.toContain('Research')
    await expect
      .poll(async () => Object.keys((await stored(page)).tasks).includes('t-synth'))
      .toBe(false)
  })

  test('reorders the Active list by menu, keyboard and pointer; the order survives a reload', async ({
    page,
  }) => {
    await openApp(page, '/projects')
    await expect
      .poll(() => projectNames(page))
      .toEqual(['Research', 'Flat project', 'Empty project', 'Roadmap 規劃'])

    // Menu: Move down.
    await projectRow(page, 'Research').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move down' }).click()
    await expect
      .poll(() => projectNames(page))
      .toEqual(['Flat project', 'Research', 'Empty project', 'Roadmap 規劃'])

    // Keyboard: Space, ArrowUp, Space on the handle (one step at a time, as announced).
    const live = liveRegion(page)
    await projectRow(page, 'Empty project').hover()
    await page.getByRole('button', { name: 'Reorder Empty project' }).focus()
    await page.keyboard.press('Space')
    await expect(live).toContainText('Empty project') // picked up (and, at once, over itself)
    // dnd-kit attaches its keyboard listener one task after the pick-up; an earlier key is lost.
    await page.waitForTimeout(60)
    await page.keyboard.press('ArrowUp')
    await expect(live).toHaveText('Empty project moved to position 2 of 4.')
    await page.keyboard.press('Space')
    await expect(live).toHaveText('Empty project dropped at position 2 of 4.')
    await expect
      .poll(() => projectNames(page))
      .toEqual(['Flat project', 'Empty project', 'Research', 'Roadmap 規劃'])

    // Pointer: drag the last project to the top.
    const handle = page.getByRole('button', { name: 'Reorder Roadmap 規劃' })
    await projectRow(page, 'Roadmap 規劃').hover()
    const from = await handle.boundingBox()
    const to = await projectRow(page, 'Flat project').boundingBox()
    if (!from || !to) throw new Error('rows are not visible')
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + 4, from.y - 8, { steps: 3 })
    await page.mouse.move(from.x + 4, to.y + 4, { steps: 14 })
    await expect(live).toHaveText('Roadmap 規劃 moved to position 1 of 4.')
    await page.mouse.up()
    const expected = ['Roadmap 規劃', 'Flat project', 'Empty project', 'Research']
    await expect.poll(() => projectNames(page)).toEqual(expected)

    await page.reload()
    await expect.poll(() => projectNames(page)).toEqual(expected)

    // Reordering is only offered for the unfiltered Active list.
    await projectRow(page, 'Roadmap 規劃').click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Move down' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('radio', { name: /^All/ }).click()
    await projectRow(page, 'Roadmap 規劃').click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Mark completed' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Move down' })).toHaveCount(0)
  })

  test('a failed status change rolls back, toasts, and Retry saves it', async ({ page }) => {
    await openApp(page, '/projects')
    await expect(projectsTable(page)).toBeVisible()
    await failNextWrites(page, 1)
    await projectRow(page, 'Flat project').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Mark completed' }).click()

    const failure = toast(page, "Couldn't update project")
    await expect(failure).toBeVisible()
    await expect(toast(page, 'Project marked completed')).toHaveCount(0) // never reports a success
    await expect.poll(() => projectNames(page)).toContain('Flat project')
    expect((await stored(page)).projects['p-flat'].status).toBe('active')

    await failure.getByRole('button', { name: 'Retry' }).click()
    await expect.poll(async () => (await stored(page)).projects['p-flat'].status).toBe('completed')
    await expect.poll(() => projectNames(page)).not.toContain('Flat project')
  })
})

test.describe('projects page width (local mode)', () => {
  // A 1280px window with a classic 15px scrollbar (Windows / Linux, long lists) leaves the table
  // 1015px: every column must still fit there. (Headless Chromium hides scrollbars, so the same
  // width is set directly.)
  test.use({ viewport: { width: 1265, height: 720 } })

  test('the Tasks column is still there at 1280px next to a classic scrollbar', async ({
    page,
  }) => {
    await openApp(page, '/projects')
    const table = projectsTable(page)
    await expect(table).toBeVisible()
    await expect
      .poll(() => table.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
      .toBe(1015)
    for (const column of ['Project', 'Status', 'Progress', 'Dates', 'Open / total']) {
      await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible()
    }
    await expect(
      projectRow(page, 'Research').getByText('7 open of 9 tasks, subtasks included'),
    ).toBeVisible()
  })
})

// ===========================================================================
// Project dialog
// ===========================================================================

test.describe('project dialog (local mode)', () => {
  test('first run: create a project without phases, then add tasks by typing a name and Enter', async ({
    page,
  }) => {
    await openApp(page, '/projects', null)
    await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible()
    await page.getByRole('button', { name: 'Create your first project' }).click()

    const dialog = page.getByRole('dialog', { name: 'New project' })
    const name = dialog.getByRole('textbox', { name: 'Name' })
    await expect(name).toBeFocused()
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await expect(name).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog.getByText('Project name is required.')).toBeVisible()

    // A due date before the start can't be picked: those days are disabled.
    await dialog.getByRole('button', { name: /^Start date/ }).click()
    await page.getByRole('button', { name: /^Tomorrow/ }).click()
    await expect(dialog.getByRole('button', { name: /^Start date: (?!not set)/ })).toBeVisible()
    await dialog.getByRole('button', { name: /^Due date/ }).click()
    await expect(page.getByRole('button', { name: /^Today/ }).first()).toBeDisabled()
    await page.keyboard.press('Escape') // closes the calendar only
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: /^Due date/ }).click()
    await page.getByRole('button', { name: /^Next week/ }).click()
    await expect(dialog.getByRole('button', { name: /^Due date: (?!not set)/ })).toBeVisible()

    await name.fill('Research 研究專案')
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/list$/)
    await expect(page.getByRole('heading', { name: 'Research 研究專案' })).toBeVisible()
    await expect(page.getByText('No tasks yet')).toBeVisible()
    await expect(page.getByText(/Phases are\s+optional/)).toBeVisible()

    // Acceptance #2/#3: just a name is enough; Enter adds and keeps the field for the next one.
    const first = page.getByRole('textbox', { name: 'Add your first task' })
    await first.fill('First task')
    await first.press('Enter')
    const next = page.getByRole('textbox', { name: 'New task' })
    await expect(next).toBeFocused()
    await next.fill('Second task')
    await next.press('Enter')
    await next.fill('Third task')
    await next.press('Enter')
    await expect
      .poll(() => rowTitles(page.locator('[data-list-scroll]')))
      .toEqual(['First task', 'Second task', 'Third task'])
    await expect(page.locator('[data-list-scroll] section[aria-label]')).toHaveCount(0) // flat: no group headers
    await next.press('Escape')

    await page.reload()
    await expect
      .poll(() => rowTitles(page.locator('[data-list-scroll]')))
      .toEqual(['First task', 'Second task', 'Third task'])
  })

  test('edit changes name, colour and status; a failed save keeps the form and creates nothing twice', async ({
    page,
  }) => {
    await openApp(page, '/projects')
    await projectRow(page, 'Empty project').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit project…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit project' })
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('Empty project')
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Renamed project')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog).toBeHidden()
    await expect
      .poll(async () => (await stored(page)).projects['p-empty'].name)
      .toBe('Renamed project')
    await expect(projectRow(page, 'Renamed project')).toBeVisible()

    // Esc on a changed form asks before throwing the changes away.
    await projectRow(page, 'Renamed project').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit project…' }).click()
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Never saved')
    await page.keyboard.press('Escape')
    const discard = page.getByRole('alertdialog', { name: 'Discard changes?' })
    await expect(discard).toBeVisible()
    await discard.getByRole('button', { name: 'Keep editing' }).click()
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('Never saved')
    await page.keyboard.press('Escape')
    await discard.getByRole('button', { name: 'Discard' }).click()
    await expect(dialog).toBeHidden()
    expect((await stored(page)).projects['p-empty'].name).toBe('Renamed project')
  })

  test('a failed create keeps the form; Try again creates the project exactly once', async ({
    page,
  }) => {
    await openApp(page, '/projects')
    await expect(projectsTable(page)).toBeVisible()
    await page.locator('main').getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Will fail once')
    await failNextWrites(page, 1)
    await dialog.getByRole('button', { name: 'Create project' }).click()

    await expect(dialog.getByText('Couldn’t create the project')).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('Will fail once')
    // Rolled back, and the store's own toast (whose Retry would create it a second time) is gone.
    expect(Object.values((await stored(page)).projects).map((p) => p.name)).not.toContain(
      'Will fail once',
    )
    await expect(toast(page, "Couldn't create project")).toHaveCount(0)

    await dialog.getByRole('button', { name: 'Try again' }).click()
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/list$/)
    await expect(page.getByRole('heading', { name: 'Will fail once' })).toBeVisible()
    const created = Object.values((await stored(page)).projects).filter(
      (p) => p.name === 'Will fail once',
    )
    expect(created).toHaveLength(1)
  })

  test('creating shows "Saving…" while the server answers and cannot be submitted twice', async ({
    page,
  }) => {
    await openApp(page, '/projects')
    await expect(projectsTable(page)).toBeVisible()
    await setLatency(page, 2500)
    await page.locator('main').getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    const name = dialog.getByRole('textbox', { name: 'Name' })
    await name.fill('Slow project')
    await name.press('Control+Enter')
    await name.press('Control+Enter')
    await expect(dialog.getByRole('button', { name: 'Create project' })).toBeDisabled()
    await expect(saving(page)).toBeVisible()
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/list$/, { timeout: 15_000 })
    await setLatency(page, 0)
    const created = Object.values((await stored(page)).projects).filter(
      (p) => p.name === 'Slow project',
    )
    expect(created).toHaveLength(1)
  })
})

// ===========================================================================
// Project layout: header, view bar, remembered view
// ===========================================================================

test.describe('project layout (local mode)', () => {
  test('header shows leaf progress; List / Board / Gantt tabs, keys 1 2 3 and the remembered view', async ({
    page,
  }) => {
    await openApp(page, '/projects')
    await page
      .getByRole('table', { name: 'Projects' })
      .getByRole('link', { name: 'Flat project' })
      .click()
    await expect(page).toHaveURL(/\/projects\/p-flat\/list$/)
    await expect(page.getByRole('heading', { name: 'Flat project' })).toBeVisible()
    await expect(page.getByRole('progressbar', { name: 'Project progress' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    )
    const tabs = page.getByRole('navigation', { name: 'Project views' })
    await expect(tabs.getByRole('link', { name: 'List' })).toHaveAttribute('aria-current', 'page')

    // Keys 1/2/3 switch the view (the layout registers them once it is rendered).
    await expect(page.getByRole('list', { name: 'Tasks' })).toBeVisible()
    await page.keyboard.press('2')
    await expect(page).toHaveURL(/\/p-flat\/board$/)
    await page.keyboard.press('3')
    await expect(page).toHaveURL(/\/p-flat\/gantt$/)
    await expect(tabs.getByRole('link', { name: 'Gantt' })).toHaveAttribute('aria-current', 'page')

    // The last view is remembered: from the table and from a bare /projects/:id.
    await page.getByRole('link', { name: 'Projects', exact: true }).first().click()
    await page
      .getByRole('table', { name: 'Projects' })
      .getByRole('link', { name: 'Flat project' })
      .click()
    await expect(page).toHaveURL(/\/p-flat\/gantt$/)
    await page.goto('/projects/p-flat')
    await expect(page).toHaveURL(/\/p-flat\/gantt$/)
    await tabs.getByRole('link', { name: 'List' }).click()
    await expect(page).toHaveURL(/\/p-flat\/list$/)

    // Back from the project goes to the page before it, not through the redirect.
    await page.goto('/projects')
    await page
      .getByRole('table', { name: 'Projects' })
      .getByRole('link', { name: 'Research' })
      .click()
    await expect(page).toHaveURL(/\/p-research\/list$/)
    await page.goBack()
    await expect(page).toHaveURL(/\/projects$/)
  })

  test('an unknown project says so and links back; an archived one offers Unarchive', async ({
    page,
  }) => {
    await openApp(page, '/projects/does-not-exist/list')
    await expect(page.getByText('Project not found')).toBeVisible()
    await page.getByRole('link', { name: 'Back to Projects' }).click()
    await expect(page).toHaveURL(/\/projects$/)

    await page.goto('/projects/p-old/list')
    const banner = page.getByRole('status').filter({ hasText: 'This project is archived' })
    await expect(banner).toBeVisible()
    await banner.getByRole('button', { name: 'Unarchive' }).click()
    await expect(toast(page, 'Project unarchived')).toBeVisible()
    await expect(banner).toBeHidden()
    await expect.poll(async () => (await stored(page)).projects['p-old'].status).toBe('active')
  })

  test('header menu: delete from inside leaves the project; New task opens the modal for it', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-empty/list')
    await expect(page.getByRole('heading', { name: 'Empty project' })).toBeVisible()
    await page.getByRole('main').getByRole('button', { name: 'New task' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal).toContainText('Empty project')
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()

    await page.getByRole('button', { name: 'Project actions' }).click()
    await page.getByRole('menuitem', { name: 'Delete project…' }).click()
    const confirm = page.getByRole('alertdialog', { name: 'Delete “Empty project”?' })
    await expect(confirm).toContainText('The project has no tasks, phases or milestones.')
    await confirm.getByRole('button', { name: 'Delete project' }).click()
    await expect(page).toHaveURL(/\/projects$/)
    await expect.poll(() => projectNames(page)).not.toContain('Empty project')
    await expect
      .poll(async () => Object.keys((await stored(page)).projects).includes('p-empty'))
      .toBe(false)
  })
})

// ===========================================================================
// List view
// ===========================================================================

test.describe('list view (local mode)', () => {
  test('groups by phase with milestones, collapses a group; a flat project has no headers', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/list')
    // "No phase" first (it has a task), then the phases in order.
    await expect(group(page, 'No phase')).toBeVisible()
    await expect.poll(() => rowTitles(group(page, 'No phase'))).toEqual(['Inbox idea'])
    await expect
      .poll(() => rowTitles(group(page, 'Discovery')))
      .toEqual(['Interview users', 'Synthesize findings'])
    await expect
      .poll(() => rowTitles(group(page, 'Build')))
      .toEqual(['Prototype flow', 'Draft survey', 'Plan retro'])
    await expect(
      group(page, 'Discovery').getByRole('button', { name: /^Milestone Kickoff/ }),
    ).toBeVisible()
    // Done tasks are marked (and muted); the parent shows its subtask summary.
    await expect(taskRow(page, 'Interview users')).toContainText('done')
    await expect(taskRow(page, 'Synthesize findings')).toContainText('1 of 3 subtasks done')

    const toggle = page.getByRole('button', { name: 'Build, 3 tasks' })
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('button', { name: 'Move Draft survey' })).toHaveCount(0)
    await toggle.click()
    await expect(page.getByRole('button', { name: 'Move Draft survey' })).toBeVisible()

    await page.goto('/projects/p-flat/list')
    await expect
      .poll(() => rowTitles(page.locator('[data-list-scroll]')))
      .toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
    await expect(page.locator('[data-list-scroll] section[aria-label]')).toHaveCount(0)
  })

  test('adds tasks inline with Enter, rapidly, at the end of a phase; Esc cancels; empty is refused', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/list')
    await expect(group(page, 'Build')).toBeVisible()
    await group(page, 'Build').getByRole('button', { name: 'Add task', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'New task in Build' })
    await expect(input).toBeFocused()

    await input.press('Enter') // nothing typed: nothing created
    await input.fill('Rapid one')
    await input.press('Enter')
    await input.fill('Rapid two 中文')
    await input.press('Enter')
    await expect(input).toBeFocused()
    await expect
      .poll(() => rowTitles(group(page, 'Build')))
      .toEqual(['Prototype flow', 'Draft survey', 'Plan retro', 'Rapid one', 'Rapid two 中文'])
    await input.fill('x'.repeat(501))
    await input.press('Enter')
    await expect(page.getByRole('alert').filter({ hasText: /at most/ })).toBeVisible()
    await input.press('Escape')
    await expect(input).toBeHidden()

    await expect
      .poll(async () => {
        const db = await stored(page)
        return Object.values(db.tasks)
          .filter((task) => task.phaseId === 'ph-build')
          .map((task) => task.title)
          .sort()
      })
      .toEqual(['Draft survey', 'Plan retro', 'Prototype flow', 'Rapid one', 'Rapid two 中文'])
    await page.reload()
    await expect.poll(() => rowTitles(group(page, 'Build'))).toHaveLength(5)
  })

  test('subtasks: add from the menu, summary, expand all, and a parent delete asks what to do', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-flat/list')
    await taskRow(page, 'Alpha').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Add subtask' }).click()
    const input = page.getByRole('textbox', { name: 'New subtask of Alpha' })
    await expect(input).toBeFocused()
    await input.fill('Sub A')
    await input.press('Enter')
    await input.fill('Sub B')
    await input.press('Enter')
    await input.press('Escape')
    await expect
      .poll(() => rowTitles(page.locator('[data-list-scroll]')))
      .toEqual(['Alpha', '↳ Sub A', '↳ Sub B', 'Beta', 'Gamma', 'Delta'])
    await expect(taskRow(page, 'Alpha')).toContainText('0 of 2 subtasks done')

    // Completing a subtask updates the parent's summary; progress counts leaves (Sub A/B, not Alpha).
    await taskRow(page, 'Sub A')
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect(taskRow(page, 'Alpha')).toContainText('1 of 2 subtasks done')
    await expect(page.getByRole('progressbar', { name: 'Project progress' })).toHaveAttribute(
      'aria-valuenow',
      '40', // 2 of 5 leaves done (Sub A, Gamma); Alpha is a parent and does not count
    )

    // Collapse / expand every parent from the view bar.
    await page.getByRole('button', { name: 'Collapse subtasks' }).click()
    await expect
      .poll(() => rowTitles(page.locator('[data-list-scroll]')))
      .toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
    await page.getByRole('button', { name: 'Expand subtasks' }).click()
    await expect(page.getByRole('button', { name: 'Move Sub A' })).toBeVisible()

    // Deleting a parent: keep the subtasks as separate tasks, or delete them too.
    await taskRow(page, 'Alpha').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete task…' }).click()
    const choice = page.getByRole('alertdialog', { name: 'Delete “Alpha”?' })
    await expect(choice).toContainText('It has 2 subtasks.')
    await choice.getByRole('button', { name: 'Keep subtasks' }).click()
    await expect
      .poll(() => rowTitles(page.locator('[data-list-scroll]')))
      .toEqual(['Sub A', 'Sub B', 'Beta', 'Gamma', 'Delta'])
  })

  test('phases: add inline, move a task into one, rename, reorder and delete with the counts', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-flat/list')
    await expect(page.locator('[data-list-scroll] section[aria-label]')).toHaveCount(0)

    await page.getByRole('button', { name: 'Add phase', exact: true }).click()
    const phaseInput = page.getByRole('textbox', { name: 'New phase name' })
    await phaseInput.fill('Alpha phase')
    await phaseInput.press('Enter')
    await phaseInput.fill('Second 階段')
    await phaseInput.press('Enter')
    await phaseInput.press('Escape')
    await expect(group(page, 'No phase')).toBeVisible()
    await expect(group(page, 'Alpha phase')).toBeVisible()
    await expect(group(page, 'Second 階段')).toBeVisible()

    // Move a task into the first (empty) phase from its menu (the keyboard alternative to a drag).
    await taskRow(page, 'Beta').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to phase' }).hover()
    await page.getByRole('menuitem', { name: 'Alpha phase' }).click()
    await expect.poll(() => rowTitles(group(page, 'Alpha phase'))).toEqual(['Beta'])
    await expect.poll(() => rowTitles(group(page, 'No phase'))).toEqual(['Alpha', 'Gamma', 'Delta'])

    // Rename inline; Esc leaves the old name.
    await page.getByRole('button', { name: 'Actions for phase Alpha phase' }).click()
    await page.getByRole('menuitem', { name: 'Rename phase' }).click()
    const rename = page.getByRole('textbox', { name: 'Phase name' })
    await rename.fill('Renamed phase')
    await rename.press('Enter')
    await expect(group(page, 'Renamed phase')).toBeVisible()
    await page.getByRole('button', { name: 'Actions for phase Renamed phase' }).click()
    await page.getByRole('menuitem', { name: 'Rename phase' }).click()
    await rename.fill('Discarded name')
    await rename.press('Escape')
    await expect(group(page, 'Renamed phase')).toBeVisible()

    // Move the phase down: it changes places with the next one.
    await page.getByRole('button', { name: 'Actions for phase Renamed phase' }).click()
    await page.getByRole('menuitem', { name: 'Move phase down' }).click()
    await expect
      .poll(async () => {
        const db = await stored(page)
        return Object.values(db.phases)
          .filter((phase) => phase.projectId === 'p-flat')
          .sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1))
          .map((phase) => phase.name)
      })
      .toEqual(['Second 階段', 'Renamed phase'])

    // Delete: the confirmation says what becomes ungrouped; nothing but the phase is deleted.
    await page.getByRole('button', { name: 'Actions for phase Renamed phase' }).click()
    await page.getByRole('menuitem', { name: 'Delete phase…' }).click()
    const confirm = page.getByRole('alertdialog', { name: 'Delete phase “Renamed phase”?' })
    await expect(confirm).toContainText(
      'Its 1 task becomes ungrouped (No phase). Nothing else is deleted.',
    )
    await confirm.getByRole('button', { name: 'Delete phase' }).click()
    await expect(group(page, 'Renamed phase')).toHaveCount(0)
    await expect
      .poll(() => rowTitles(group(page, 'No phase')))
      .toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])

    // The last phase goes: back to a plain flat list.
    await page.getByRole('button', { name: 'Actions for phase Second 階段' }).click()
    await page.getByRole('menuitem', { name: 'Delete phase…' }).click()
    await expect(page.getByRole('alertdialog')).toContainText('The phase is empty.')
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete phase' }).click()
    await expect(page.locator('[data-list-scroll] section[aria-label]')).toHaveCount(0)
    await expect
      .poll(() => rowTitles(page.locator('[data-list-scroll]')))
      .toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
  })

  test('acceptance #5: a drag reorder in the List survives a reload; so does a move to another phase', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/list')
    await expect
      .poll(() => rowTitles(group(page, 'Build')))
      .toEqual(['Prototype flow', 'Draft survey', 'Plan retro'])

    // Within a group: "Plan retro" above "Prototype flow".
    await dragHandleTo(
      page,
      taskRow(page, 'Plan retro'),
      await pointIn(taskRow(page, 'Prototype flow'), 0.2),
      /^Plan retro is over Prototype flow\.$/,
    )
    await expect
      .poll(() => rowTitles(group(page, 'Build')))
      .toEqual(['Plan retro', 'Prototype flow', 'Draft survey'])
    await page.reload()
    await expect
      .poll(() => rowTitles(group(page, 'Build')))
      .toEqual(['Plan retro', 'Prototype flow', 'Draft survey'])

    // Across groups: "Inbox idea" (No phase) into Build, below "Plan retro".
    await dragHandleTo(
      page,
      taskRow(page, 'Inbox idea'),
      await pointIn(taskRow(page, 'Plan retro'), 0.85),
      /^Inbox idea is over Plan retro\.$/,
    )
    await expect.poll(async () => (await stored(page)).tasks['t-inbox'].phaseId).toBe('ph-build')
    await page.reload()
    await expect.poll(() => rowTitles(group(page, 'Build'))).toContain('Inbox idea')
    await expect(page.getByRole('region', { name: /^No phase/ })).toHaveCount(0) // empty: hidden
    expect(await rowTitles(group(page, 'Discovery'))).toEqual([
      'Interview users',
      'Synthesize findings',
    ])
  })

  test('subtasks reorder among their siblings; a whole parent moves with its subtasks', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-research/list')
    await page.getByRole('button', { name: 'Expand subtasks' }).click()
    await expect
      .poll(() => rowTitles(group(page, 'Discovery')))
      .toEqual([
        'Interview users',
        'Synthesize findings',
        '↳ Cluster notes',
        '↳ Write personas',
        '↳ Review with team',
      ])

    await dragHandleTo(
      page,
      taskRow(page, 'Review with team'),
      await pointIn(taskRow(page, 'Cluster notes'), 0.2),
      /^Review with team is over Cluster notes\.$/,
    )
    await expect
      .poll(() => rowTitles(group(page, 'Discovery')))
      .toEqual([
        'Interview users',
        'Synthesize findings',
        '↳ Review with team',
        '↳ Cluster notes',
        '↳ Write personas',
      ])

    // Moving the parent to another phase takes its subtasks along (menu: the drag alternative).
    await taskRow(page, 'Synthesize findings').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to phase' }).hover()
    await page.getByRole('menuitem', { name: 'Build', exact: true }).click()
    await expect
      .poll(() => rowTitles(group(page, 'Build')))
      .toEqual([
        'Prototype flow',
        'Draft survey',
        'Plan retro',
        'Synthesize findings',
        '↳ Review with team',
        '↳ Cluster notes',
        '↳ Write personas',
      ])
    await expect
      .poll(async () => {
        const db = await stored(page)
        return ['t-synth', 't-cluster', 't-personas', 't-review'].map((id) => db.tasks[id].phaseId)
      })
      .toEqual(['ph-build', 'ph-build', 'ph-build', 'ph-build'])
  })

  /** dnd-kit's KeyboardSensor starts listening for arrows one task after the pickup. */
  const sensorListening = (page: Page) =>
    page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

  test('the keyboard reorders too: Space, arrows, Space on the handle; Esc cancels', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-flat/list')
    const list = page.locator('[data-list-scroll]')
    const live = liveRegion(page)
    await expect.poll(() => rowTitles(list)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])

    const handle = page.getByRole('button', { name: 'Move Alpha' })
    await handle.focus()
    await page.keyboard.press('Space')
    await expect(live).toHaveText('Picked up Alpha.')
    await sensorListening(page)
    await page.keyboard.press('ArrowDown')
    await expect(live).toHaveText('Alpha is over Beta.')
    await page.keyboard.press('ArrowDown')
    await expect(live).toHaveText('Alpha is over Gamma.')
    await page.keyboard.press('Space')
    await expect(live).toHaveText('Alpha was dropped.')
    await expect.poll(() => rowTitles(list)).toEqual(['Beta', 'Gamma', 'Alpha', 'Delta'])
    await expect(page.getByRole('button', { name: 'Move Alpha' })).toBeFocused()
    await page.reload()
    await expect.poll(() => rowTitles(list)).toEqual(['Beta', 'Gamma', 'Alpha', 'Delta'])

    await page.getByRole('button', { name: 'Move Delta' }).focus()
    await page.keyboard.press('Space')
    await expect(live).toHaveText('Picked up Delta.')
    await sensorListening(page)
    await page.keyboard.press('ArrowUp')
    await expect(live).toHaveText('Delta is over Alpha.')
    await page.keyboard.press('Escape')
    await expect(live).toHaveText('Moving Delta was cancelled.')
    await expect.poll(() => rowTitles(list)).toEqual(['Beta', 'Gamma', 'Alpha', 'Delta'])

    // And without dragging at all: Move up / Move down in the row menu.
    await taskRow(page, 'Delta').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move up' }).click()
    await expect.poll(() => rowTitles(list)).toEqual(['Beta', 'Gamma', 'Delta', 'Alpha'])
  })

  test('edits in place: status, priority and due date are saved; the title opens the Task Modal', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-flat/list')
    const alpha = taskRow(page, 'Alpha')

    await alpha.getByRole('button', { name: /^Status:/ }).click()
    await page.getByRole('menuitemradio', { name: 'In Progress' }).click()
    await expect(alpha.getByRole('button', { name: 'Status: In Progress' })).toBeVisible()

    await alpha.getByRole('button', { name: /^Priority:/ }).click()
    await page.getByRole('menuitemradio', { name: 'High' }).click()
    await expect(alpha.getByRole('button', { name: 'Priority: High' })).toBeVisible()

    await alpha.getByRole('button', { name: /^Due date/ }).click()
    await page.getByRole('button', { name: /^Next week/ }).click()
    await expect(alpha.getByRole('button', { name: /^Due date: .*20\d\d/ })).toBeVisible()

    await expect
      .poll(async () => {
        const task = (await stored(page)).tasks['f-alpha']
        return [task.status, task.priority, task.dueDate !== null]
      })
      .toEqual(['in_progress', 'high', true])
    await page.reload()
    await expect(
      taskRow(page, 'Alpha').getByRole('button', { name: 'Status: In Progress' }),
    ).toBeVisible()

    await taskRow(page, 'Alpha').getByRole('button', { name: 'Alpha', exact: true }).click()
    await expect(page).toHaveURL(/\/p-flat\/list\?task=f-alpha$/)
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(/\/p-flat\/list$/)
    await expect(
      taskRow(page, 'Alpha').getByRole('button', { name: 'Alpha', exact: true }),
    ).toBeFocused()
  })

  test('a failed edit rolls back, shows a toast with Retry, and Retry saves it', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-flat/list')
    const delta = taskRow(page, 'Delta')
    await expect(delta).toBeVisible()
    await failNextWrites(page, 1)
    await delta.getByRole('button', { name: /^Status:/ }).click()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()

    const failure = toast(page, "Couldn't update task")
    await expect(failure).toBeVisible()
    await expect(delta.getByRole('button', { name: 'Status: To Do' })).toBeVisible()
    expect((await stored(page)).tasks['f-delta'].status).toBe('todo')

    await failure.getByRole('button', { name: 'Retry' }).click()
    await expect(delta.getByRole('button', { name: 'Status: Done' })).toBeVisible()
    await expect.poll(async () => (await stored(page)).tasks['f-delta'].status).toBe('done')
  })

  test('a failed inline create and a failed drop roll back; Retry brings them back', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-flat/list')
    const list = page.locator('[data-list-scroll]')
    await expect.poll(() => rowTitles(list)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])

    await failNextWrites(page, 1)
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'New task' })
    await input.fill('Lost then retried')
    await input.press('Enter')
    const createFailure = toast(page, "Couldn't create task")
    await expect(createFailure).toBeVisible()
    await expect.poll(() => rowTitles(list)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
    await createFailure.getByRole('button', { name: 'Retry' }).click()
    await expect
      .poll(() => rowTitles(list))
      .toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Lost then retried'])

    await failNextWrites(page, 1)
    await dragHandleTo(
      page,
      taskRow(page, 'Delta'),
      await pointIn(taskRow(page, 'Alpha'), 0.2),
      /^Delta is over Alpha\.$/,
    )
    const moveFailure = toast(page, "Couldn't move task")
    await expect(moveFailure).toBeVisible()
    await expect
      .poll(() => rowTitles(list))
      .toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Lost then retried'])
    await moveFailure.getByRole('button', { name: 'Retry' }).click()
    await expect
      .poll(() => rowTitles(list))
      .toEqual(['Delta', 'Alpha', 'Beta', 'Gamma', 'Lost then retried'])
    await page.reload()
    await expect
      .poll(() => rowTitles(list))
      .toEqual(['Delta', 'Alpha', 'Beta', 'Gamma', 'Lost then retried'])
  })

  test('with a slow server the new rows appear at once and the sidebar says "Saving…"', async ({
    page,
  }) => {
    await openApp(page, '/projects/p-flat/list')
    const list = page.locator('[data-list-scroll]')
    await expect.poll(() => rowTitles(list)).toHaveLength(4)
    await setLatency(page, 1500)
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'New task' })
    await input.fill('Slow one')
    await input.press('Enter')
    await input.fill('Slow two')
    await input.press('Enter')
    await expect
      .poll(() => rowTitles(list))
      .toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Slow one', 'Slow two'])
    await expect(saving(page)).toBeVisible()
    await expect(input).toBeFocused()
    await expect(saving(page)).toBeHidden({ timeout: 15_000 }) // the two writes go one after the other
    await setLatency(page, 0)
    const titles = Object.values((await stored(page)).tasks)
      .filter((task) => task.projectId === 'p-flat')
      .map((task) => task.title)
    expect(titles.filter((title) => title.startsWith('Slow'))).toHaveLength(2)
  })
})
