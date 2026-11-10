/// <reference lib="dom" />
/**
 * List keyboard navigation (UX-05), in the real page: ↑ / ↓ move focus between the visible phase
 * headers ("No phase" included), tasks, subtasks and milestones, in the order they are drawn.
 *
 * - Navigation: whole walk down and up, ends stop (no wrap), collapsed phases / hidden subtasks are
 *   skipped and not expanded, empty / tiny / flat lists work.
 * - Focus recovery: a deleted / moved focused task hands focus to the same task or its successor.
 * - Interaction safety: Enter keeps each button's own action, nothing is written by moving focus,
 *   text fields, IME composition, menus, the date picker and dnd-kit's keyboard drag keep their
 *   arrow keys, and the app's shortcuts still work from a list item.
 * - Layout: the focused row is never hidden under the sticky column header / phase header, the
 *   focus ring is visible, no tab stop is added; dark mode and a narrow window work.
 */
import { generateNKeysBetween } from 'fractional-indexing'
import { expect as baseExpect, test as base, type Locator, type Page } from '@playwright/test'
import { Ime } from './ime.helpers.ts'

const expect = baseExpect.configure({ timeout: 10_000 })

const LOCAL_WORKSPACE_KEY = 'cairn:local:workspace:v1'
const NOW = '2026-11-03T08:00:00.000Z'
const PROJECT_ID = 'p-nav'

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

test.use({
  viewport: { width: 1280, height: 800 },
  timezoneId: 'Asia/Taipei',
  locale: 'en-US',
  reducedMotion: 'reduce',
})

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

interface SeedTask {
  /** Short id; the title is shown, the key is for the tests. */
  key: string
  title?: string
  phase?: string
  parent?: string
}
interface SeedMilestone {
  key: string
  name: string
  date: string
  phase?: string
}
interface Spec {
  phases?: string[]
  tasks?: SeedTask[]
  milestones?: SeedMilestone[]
}

const taskId = (key: string) => `t-${key}`
const phaseId = (name: string) => `ph-${name}`

function buildWorkspace(spec: Spec): unknown {
  const { phases = [], tasks = [], milestones = [] } = spec
  const db = {
    version: 1,
    projects: {
      [PROJECT_ID]: {
        id: PROJECT_ID,
        name: 'Navigation',
        description: null,
        status: 'active',
        color: 'violet',
        startDate: null,
        dueDate: null,
        scheduleMode: 'manual',
        sortOrder: 'a0',
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    phases: {} as Record<string, unknown>,
    tasks: {} as Record<string, unknown>,
    milestones: {} as Record<string, unknown>,
    dependencies: {},
    preferences: null,
  }
  const phaseKeys = phases.length ? generateNKeysBetween(null, null, phases.length) : []
  phases.forEach((name, index) => {
    db.phases[phaseId(name)] = {
      id: phaseId(name),
      projectId: PROJECT_ID,
      name,
      sortOrder: phaseKeys[index],
      createdAt: NOW,
      updatedAt: NOW,
    }
  })
  const top = tasks.filter((task) => !task.parent)
  const topKeys = top.length ? generateNKeysBetween(null, null, top.length) : []
  const subCounts: Record<string, number> = {}
  for (const task of tasks)
    if (task.parent) subCounts[task.parent] = (subCounts[task.parent] ?? 0) + 1
  const subKeys: Record<string, string[]> = {}
  for (const [parent, count] of Object.entries(subCounts))
    subKeys[parent] = generateNKeysBetween(null, null, count)
  const subUsed: Record<string, number> = {}
  for (const task of tasks) {
    const sortOrder = task.parent
      ? subKeys[task.parent][(subUsed[task.parent] = (subUsed[task.parent] ?? -1) + 1)]
      : topKeys[top.indexOf(task)]
    db.tasks[taskId(task.key)] = {
      id: taskId(task.key),
      projectId: PROJECT_ID,
      phaseId: task.phase && !task.parent ? phaseId(task.phase) : null,
      parentTaskId: task.parent ? taskId(task.parent) : null,
      title: task.title ?? task.key,
      description: null,
      status: 'todo',
      priority: 'none',
      startDate: null,
      dueDate: null,
      sortOrder,
      completedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    }
  }
  milestones.forEach((milestone) => {
    db.milestones[`m-${milestone.key}`] = {
      id: `m-${milestone.key}`,
      projectId: PROJECT_ID,
      phaseId: milestone.phase ? phaseId(milestone.phase) : null,
      name: milestone.name,
      date: milestone.date,
      createdAt: NOW,
      updatedAt: NOW,
    }
  })
  return db
}

/** Boots the List with the seed (written once per tab: a reload keeps what the test changed). */
async function openList(page: Page, spec: Spec, path = `/projects/${PROJECT_ID}/list`) {
  await page.clock.setFixedTime('2026-11-03T10:00:00+08:00')
  await page.addInitScript(
    ({ key, db }) => {
      if (sessionStorage.getItem('cairn-e2e-listnav-seeded')) return
      localStorage.setItem(key, JSON.stringify(db))
      sessionStorage.setItem('cairn-e2e-listnav-seeded', '1')
    },
    { key: LOCAL_WORKSPACE_KEY, db: buildWorkspace(spec) },
  )
  await page.goto(path)
  await expect(scroller(page).or(page.getByText('No tasks yet'))).toBeVisible()
}

// ---------------------------------------------------------------------------
// Locators and readers
// ---------------------------------------------------------------------------

const scroller = (page: Page) => page.locator('[data-list-scroll]')

const taskStop = (page: Page, key: string): Locator =>
  page.locator(`[data-focus-key="list:task:${taskId(key)}"]`)
const milestoneStop = (page: Page, key: string): Locator =>
  page.locator(`[data-focus-key="list:milestone:m-${key}"]`)
/** A phase header's toggle button ("Design, 3 tasks"; the label of the group without a phase is "No phase"). */
const groupStop = (page: Page, name: string): Locator =>
  page.getByRole('button', { name: new RegExp(`^${name}, \\d+ tasks?$`) })
const group = (page: Page, name: string) =>
  page.getByRole('region', { name: new RegExp(`^${name}, \\d+ tasks?$`) })

/** What a focused element is, in words: stops are "Title" / "Phase, n tasks" / "Milestone …". */
const LABEL_OF = `(element) => {
  if (!element) return null
  const kind = element.getAttribute('data-list-nav')
  if (kind === 'task') return element.querySelector('span[title]')?.getAttribute('title') ?? null
  if (kind) return element.getAttribute('aria-label')
  return '(not a stop) ' + element.tagName.toLowerCase() + ' ' + (element.getAttribute('aria-label') ?? element.getAttribute('role') ?? '')
}`

/** Labels of every stop in drawing order. */
function stopLabels(page: Page): Promise<(string | null)[]> {
  return page.evaluate((source) => {
    const label = new Function(`return (${source})`)() as (element: Element | null) => string | null
    return Array.from(document.querySelectorAll('[data-list-nav]')).map(label)
  }, LABEL_OF)
}

function focused(page: Page): Promise<string | null> {
  return page.evaluate((source) => {
    const label = new Function(`return (${source})`)() as (element: Element | null) => string | null
    return label(document.activeElement)
  }, LABEL_OF)
}

const expectFocus = async (page: Page, label: string | RegExp) => {
  if (typeof label === 'string') await expect.poll(() => focused(page)).toBe(label)
  else await expect.poll(() => focused(page)).toMatch(label)
}

/** Key presses one at a time, reading where focus is after each. */
async function walk(
  page: Page,
  key: 'ArrowDown' | 'ArrowUp',
  times: number,
): Promise<(string | null)[]> {
  const seen: (string | null)[] = []
  for (let i = 0; i < times; i += 1) {
    await page.keyboard.press(key)
    seen.push(await focused(page))
  }
  return seen
}

const storage = (page: Page): Promise<string> =>
  page.evaluate((key) => localStorage.getItem(key) ?? '', LOCAL_WORKSPACE_KEY)

interface Stored {
  tasks: Record<string, { id: string; title: string; phaseId: string | null; sortOrder: string }>
}
async function storedTitles(page: Page, phase: string | null): Promise<string[]> {
  const data = JSON.parse(await storage(page)) as Stored
  return Object.values(data.tasks)
    .filter((task) => task.phaseId === (phase ? phaseId(phase) : null))
    .sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1))
    .map((task) => task.title)
}

/** Task rows' titles inside `scope`, subtasks marked "↳ ". */
function rowTitles(scope: Locator): Promise<string[]> {
  return scope.locator('[data-task-row]').evaluateAll((rows) =>
    rows.map((row) => {
      const title = row.querySelector('[data-list-nav="task"] span[title]')?.getAttribute('title')
      return row.getAttribute('data-depth') === '1' ? `↳ ${title}` : String(title)
    }),
  )
}

/** Places keyboard modality on `locator` (focus-visible rings) and checks it took focus. */
async function focusStop(page: Page, locator: Locator) {
  await locator.focus()
  await expect(locator).toBeFocused()
  await page.keyboard.press('Shift') // a key event: later focus changes count as keyboard focus
}

const rowActions = (page: Page, title: string) =>
  page.getByRole('button', { name: `Actions for ${title}`, exact: true })

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const PHASED: Spec = {
  phases: ['Design', 'Build'],
  tasks: [
    { key: 'a', title: 'Wireframes', phase: 'Design' },
    { key: 'a1', title: 'Mockups', parent: 'a' },
    { key: 'a2', title: 'Icons', parent: 'a' },
    { key: 'b', title: 'Review', phase: 'Design' },
    { key: 'c', title: 'Scaffold', phase: 'Build' },
    { key: 'd', title: 'Ship it' },
  ],
  milestones: [
    { key: 'k1', name: 'Kick-off', date: '2026-11-10', phase: 'Design' },
    { key: 'k2', name: 'Launch', date: '2026-12-01' },
  ],
}

test.describe('Navigation', () => {
  test('↓ walks every stop of a phased project to the last and stops; ↑ walks back to the first and stops', async ({
    page,
  }) => {
    await openList(page, PHASED)
    // Subtasks are hidden: they are not stops. "No phase" is drawn after the phases.
    const order = [
      'Design, 2 tasks',
      'Wireframes',
      'Review',
      expect.stringMatching(/^Milestone Kick-off/),
      'Build, 1 task',
      'Scaffold',
      'No phase, 1 task',
      'Ship it',
      expect.stringMatching(/^Milestone Launch/),
    ]
    expect(await stopLabels(page)).toEqual(order)

    await focusStop(page, groupStop(page, 'Design'))
    expect(await focused(page)).toBe('Design, 2 tasks')
    const down = await walk(page, 'ArrowDown', order.length + 2)
    expect(down).toEqual([...order.slice(1), order.at(-1), order.at(-1), order.at(-1)])
    // At the end ↓ is swallowed: the scroller must not scroll instead of moving focus.
    const up = await walk(page, 'ArrowUp', order.length + 2)
    expect(up).toEqual(
      [...order.slice(0, -1).reverse(), order[0], order[0], order[0]].slice(0, up.length),
    )
    await expectFocus(page, 'Design, 2 tasks')
  })

  test('crosses phases and goes Task ↔ Subtask only when the subtasks are shown, never expanding them itself', async ({
    page,
  }) => {
    await openList(page, PHASED)
    await focusStop(page, taskStop(page, 'a'))
    await page.keyboard.press('ArrowDown')
    await expectFocus(page, 'Review')
    expect(await rowTitles(scroller(page))).toEqual(['Wireframes', 'Review', 'Scaffold', 'Ship it'])

    await page.getByRole('button', { name: 'Show subtasks of Wireframes' }).click()
    await expect(page.getByRole('button', { name: 'Hide subtasks of Wireframes' })).toBeVisible()
    await focusStop(page, taskStop(page, 'a'))
    expect(await walk(page, 'ArrowDown', 4)).toEqual([
      'Mockups',
      'Icons',
      'Review',
      expect.stringMatching(/^Milestone Kick-off/),
    ])
    expect(await walk(page, 'ArrowUp', 3)).toEqual(['Review', 'Icons', 'Mockups'])
    await page.keyboard.press('ArrowUp')
    await expectFocus(page, 'Wireframes')

    // Hide again: the subtasks vanish from the walk.
    await page.getByRole('button', { name: 'Hide subtasks of Wireframes' }).click()
    await focusStop(page, taskStop(page, 'a'))
    await page.keyboard.press('ArrowDown')
    await expectFocus(page, 'Review')
  })

  test('a collapsed phase keeps its header as a stop and its rows are skipped, without expanding it', async ({
    page,
  }) => {
    await openList(page, PHASED)
    const design = groupStop(page, 'Design')
    await design.click()
    await expect(design).toHaveAttribute('aria-expanded', 'false')
    await expect(design).toBeFocused()
    // Wireframes, Review and the Kick-off milestone are not drawn.
    expect(await stopLabels(page)).toEqual([
      'Design, 2 tasks',
      'Build, 1 task',
      'Scaffold',
      'No phase, 1 task',
      'Ship it',
      expect.stringMatching(/^Milestone Launch/),
    ])
    await page.keyboard.press('ArrowDown')
    await expectFocus(page, 'Build, 1 task')
    await page.keyboard.press('ArrowUp')
    await expectFocus(page, 'Design, 2 tasks')
    await expect(design).toHaveAttribute('aria-expanded', 'false')

    // Enter on the header expands it again; the rows are stops again.
    await page.keyboard.press('Enter')
    await expect(design).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowDown')
    await expectFocus(page, 'Wireframes')
  })

  test('Milestones are stops: ↓ from the last task of a phase lands on its milestone, Enter opens the dialog, Esc returns', async ({
    page,
  }) => {
    await openList(page, PHASED)
    await focusStop(page, taskStop(page, 'b'))
    await page.keyboard.press('ArrowDown')
    await expectFocus(page, /^Milestone Kick-off/)
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(milestoneStop(page, 'k1')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expectFocus(page, 'Build, 1 task')
  })

  test('the "No phase" header is a stop in a project with phases (milestones only counts too)', async ({
    page,
  }) => {
    await openList(page, {
      phases: ['Design'],
      tasks: [{ key: 'a', title: 'Wireframes', phase: 'Design' }],
      milestones: [{ key: 'k', name: 'Loose end', date: '2026-11-20' }],
    })
    expect(await stopLabels(page)).toEqual([
      'Design, 1 task',
      'Wireframes',
      'No phase, 0 tasks',
      expect.stringMatching(/^Milestone Loose end/),
    ])
    await focusStop(page, taskStop(page, 'a'))
    await page.keyboard.press('ArrowDown')
    await expectFocus(page, 'No phase, 0 tasks')
    await page.keyboard.press('ArrowDown')
    await expectFocus(page, /^Milestone Loose end/)
  })

  test('an empty List shows the empty state and the arrow keys do nothing (no error)', async ({
    page,
  }) => {
    await openList(page, {})
    await expect(page.getByText('No tasks yet')).toBeVisible()
    expect(await stopLabels(page)).toEqual([])
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await page.getByRole('textbox', { name: 'Add your first task' }).focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await expect(page.getByRole('textbox', { name: 'Add your first task' })).toBeFocused()
  })

  test('a project with a single task: the task is the only stop and both arrows stay on it', async ({
    page,
  }) => {
    await openList(page, { tasks: [{ key: 'solo', title: 'Only one' }] })
    expect(await stopLabels(page)).toEqual(['Only one'])
    await focusStop(page, taskStop(page, 'solo'))
    expect(await walk(page, 'ArrowDown', 3)).toEqual(['Only one', 'Only one', 'Only one'])
    expect(await walk(page, 'ArrowUp', 3)).toEqual(['Only one', 'Only one', 'Only one'])
  })

  test('a project with phases and no tasks: the headers are the only stops', async ({ page }) => {
    await openList(page, { phases: ['Design', 'Build'] })
    expect(await stopLabels(page)).toEqual(['Design, 0 tasks', 'Build, 0 tasks'])
    await focusStop(page, groupStop(page, 'Design'))
    expect(await walk(page, 'ArrowDown', 3)).toEqual([
      'Build, 0 tasks',
      'Build, 0 tasks',
      'Build, 0 tasks',
    ])
    expect(await walk(page, 'ArrowUp', 2)).toEqual(['Design, 0 tasks', 'Design, 0 tasks'])
  })

  test('a flat project (no phases) has no header: tasks only, no group header stop', async ({
    page,
  }) => {
    await openList(page, {
      tasks: [
        { key: 'a', title: 'One' },
        { key: 'b', title: 'Two' },
        { key: 'c', title: 'Three' },
      ],
    })
    expect(await stopLabels(page)).toEqual(['One', 'Two', 'Three'])
    await expect(page.locator('[data-list-group-header]')).toHaveCount(0)
    await focusStop(page, taskStop(page, 'a'))
    expect(await walk(page, 'ArrowDown', 3)).toEqual(['Two', 'Three', 'Three'])
    expect(await walk(page, 'ArrowUp', 3)).toEqual(['Two', 'One', 'One'])
  })

  test('the add rows (Add task / Add phase) are not stops', async ({ page }) => {
    await openList(page, PHASED)
    const kinds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-list-nav]')).map(
        (e) => e.tagName + ':' + e.getAttribute('data-list-nav'),
      ),
    )
    expect(kinds.every((kind) => kind.startsWith('BUTTON:'))).toBe(true)
    await focusStop(page, taskStop(page, 'd'))
    // Walk to the end: the Add task / Add phase rows below are never entered.
    await walk(page, 'ArrowDown', 6)
    await expectFocus(page, /^Milestone Launch/)
  })
})

// ---------------------------------------------------------------------------
// Focus recovery
// ---------------------------------------------------------------------------

test.describe('Focus recovery', () => {
  const FLAT: Spec = {
    tasks: [
      { key: 'a', title: 'Alpha' },
      { key: 'b', title: 'Bravo' },
      { key: 'c', title: 'Charlie' },
    ],
  }

  test('deleting the focused task from its ⋯ menu puts focus on the task that took its place; then on the last one', async ({
    page,
  }) => {
    await openList(page, FLAT)
    await focusStop(page, taskStop(page, 'b'))
    await rowActions(page, 'Bravo').click()
    await page.getByRole('menuitem', { name: 'Delete task…' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete task' }).click()
    await expect(taskStop(page, 'b')).toHaveCount(0)
    await expectFocus(page, 'Charlie')

    // Charlie is the last one now: deleting it hands focus to the new last one.
    await rowActions(page, 'Charlie').click()
    await page.getByRole('menuitem', { name: 'Delete task…' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete task' }).click()
    await expect(taskStop(page, 'c')).toHaveCount(0)
    await expectFocus(page, 'Alpha')
    // And the walk still works from there.
    await page.keyboard.press('ArrowDown')
    await expectFocus(page, 'Alpha')
  })

  test('deleting from the Task Modal returns focus to the list item that took its place, not to <main>', async ({
    page,
  }) => {
    await openList(page, FLAT)
    await focusStop(page, taskStop(page, 'b'))
    await page.keyboard.press('Enter')
    const modal = page.getByRole('dialog', { name: 'Edit task: Bravo' })
    await expect(modal).toBeVisible()
    await modal.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'Delete task…' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(modal).toBeHidden()
    await expect(taskStop(page, 'b')).toHaveCount(0)
    await expectFocus(page, 'Charlie')
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('main')
  })

  test('Move down from the menu keeps focus with the same task', async ({ page }) => {
    await openList(page, FLAT)
    await focusStop(page, taskStop(page, 'a'))
    await rowActions(page, 'Alpha').click()
    await page.getByRole('menuitem', { name: 'Move down' }).click()
    await expect.poll(() => rowTitles(scroller(page))).toEqual(['Bravo', 'Alpha', 'Charlie'])
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.closest('[data-task-row]')?.getAttribute('data-task-row'),
        ),
      )
      .toBe(taskId('a'))
    // From there the walk continues relative to the moved task.
    await taskStop(page, 'a').focus()
    await page.keyboard.press('ArrowDown')
    await expectFocus(page, 'Charlie')
  })

  test('Move to phase from the menu keeps focus with the same task in its new group', async ({
    page,
  }) => {
    await openList(page, {
      phases: ['Design', 'Build'],
      tasks: [
        { key: 'a', title: 'Alpha', phase: 'Design' },
        { key: 'b', title: 'Bravo', phase: 'Design' },
        { key: 'c', title: 'Charlie', phase: 'Build' },
      ],
    })
    await focusStop(page, taskStop(page, 'a'))
    await rowActions(page, 'Alpha').click()
    await page.getByRole('menuitem', { name: 'Move to phase' }).click()
    await page.getByRole('menuitem', { name: 'Build', exact: true }).click()
    await expect.poll(() => rowTitles(group(page, 'Build'))).toEqual(['Charlie', 'Alpha'])
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.closest('[data-task-row]')?.getAttribute('data-task-row'),
        ),
      )
      .toBe(taskId('a'))
    await taskStop(page, 'a').focus()
    await page.keyboard.press('ArrowUp')
    await expectFocus(page, 'Charlie')
  })
})

// ---------------------------------------------------------------------------
// Interaction safety
// ---------------------------------------------------------------------------

test.describe('Interaction safety', () => {
  test('Enter opens the Task Modal on a title; Esc closes it and focus is back on that title', async ({
    page,
  }) => {
    await openList(page, PHASED)
    await focusStop(page, taskStop(page, 'b'))
    await page.keyboard.press('Enter')
    const modal = page.getByRole('dialog', { name: 'Edit task: Review' })
    await expect(modal).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
    await expect(taskStop(page, 'b')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expectFocus(page, /^Milestone Kick-off/)
  })

  test('Enter on a phase header collapses it (the header keeps focus)', async ({ page }) => {
    await openList(page, PHASED)
    const build = groupStop(page, 'Build')
    await focusStop(page, build)
    await page.keyboard.press('Enter')
    await expect(build).toHaveAttribute('aria-expanded', 'false')
    await expect(build).toBeFocused()
    await expect(taskStop(page, 'c')).toHaveCount(0)
  })

  test('moving focus with lots of arrow keys writes nothing', async ({ page }) => {
    await openList(page, PHASED)
    await page.getByRole('button', { name: 'Show subtasks of Wireframes' }).click()
    await expect(page.getByRole('button', { name: 'Hide subtasks of Wireframes' })).toBeVisible()
    await page.reload()
    await expect(scroller(page)).toBeVisible()
    const before = await storage(page)
    await focusStop(page, groupStop(page, 'Design'))
    for (let round = 0; round < 3; round += 1) {
      await walk(page, 'ArrowDown', 14)
      await walk(page, 'ArrowUp', 14)
    }
    // Held keys, too.
    await page.keyboard.down('ArrowDown')
    for (let i = 0; i < 8; i += 1) await page.keyboard.press('ArrowDown')
    await page.keyboard.up('ArrowDown')
    expect(await storage(page)).toBe(before)
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
  })

  test('arrows inside the inline "Add task" input and the phase rename input do not change the row', async ({
    page,
  }) => {
    await openList(page, {
      tasks: [
        { key: 'a', title: 'One' },
        { key: 'b', title: 'Two' },
      ],
    })
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const add = page.getByRole('textbox', { name: 'New task', exact: true })
    await expect(add).toBeFocused()
    await page.keyboard.type('draft')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await expect(add).toBeFocused()
    await expect(add).toHaveValue('draft')
    await page.keyboard.press('Escape')
  })

  test('arrows inside the phase rename input keep focus in the field', async ({ page }) => {
    await openList(page, PHASED)
    await page.getByRole('button', { name: 'Actions for phase Design' }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menuitem', { name: 'Rename phase' }).click()
    const rename = page.getByRole('textbox', { name: 'Phase name' })
    await expect(rename).toBeFocused()
    const before = await storage(page)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowDown')
    await expect(rename).toBeFocused()
    await expect(rename).toHaveValue('Design')
    await page.keyboard.press('Escape')
    await expect(rename).toBeHidden()
    expect(await storage(page)).toBe(before)
    await expect(groupStop(page, 'Design')).toBeFocused()
  })

  for (const naming of ['name', 'process'] as const) {
    test(`IME (${naming === 'name' ? 'macOS' : 'Windows "Process"'} naming): keys the input method takes in "Add task" do not move focus or break the composition`, async ({
      page,
    }) => {
      await openList(page, {
        tasks: [
          { key: 'a', title: 'One' },
          { key: 'b', title: 'Two' },
        ],
      })
      const ime = await Ime.attach(page)
      await page.getByRole('button', { name: 'Add task', exact: true }).click()
      const add = page.getByRole('textbox', { name: 'New task', exact: true })
      await expect(add).toBeFocused()
      const before = await storage(page)

      await ime.compose('ㄇ')
      await expect(add).toHaveValue('ㄇ')
      for (const key of ['ArrowDown', 'ArrowUp', 'Enter'] as const) {
        await ime.handle(key, naming)
        await ime.release(key)
        await expect(add).toBeFocused()
        await expect(add).toHaveValue('ㄇ')
      }
      await ime.commit('馬')
      await expect(add).toHaveValue('馬')
      await expect(add).toBeFocused()
      expect(await storage(page)).toBe(before)
      expect(await storedTitles(page, null)).toEqual(['One', 'Two'])
      await page.keyboard.press('Escape')
    })

    test(`IME (${naming === 'name' ? 'macOS' : 'Windows "Process"'} naming): an ArrowDown the input method takes (keyCode 229) on a list item does not move focus; a plain one still does`, async ({
      page,
    }) => {
      await openList(page, PHASED)
      const ime = await Ime.attach(page)
      await focusStop(page, taskStop(page, 'a'))
      await ime.handle('ArrowDown', naming)
      await ime.release('ArrowDown')
      await ime.handle('ArrowUp', naming)
      await ime.release('ArrowUp')
      await expect(taskStop(page, 'a')).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expectFocus(page, 'Review')
    })
  }

  test('a keydown with isComposing = true on a list item is left alone (not prevented, focus stays)', async ({
    page,
  }) => {
    await openList(page, PHASED)
    await focusStop(page, taskStop(page, 'a'))
    const result = await page.evaluate(() => {
      const target = document.activeElement as HTMLElement
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      })
      target.dispatchEvent(event)
      return { prevented: event.defaultPrevented, same: document.activeElement === target }
    })
    expect(result).toEqual({ prevented: false, same: true })
  })

  test('the Status menu keeps its own arrow keys; the list focus does not move; nothing is saved', async ({
    page,
  }) => {
    await openList(page, PHASED)
    const before = await storage(page)
    const trigger = page
      .locator('[data-task-row]')
      .first()
      .getByRole('button', { name: /^Status:/ })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    const inMenu = await page.evaluate(
      () => document.activeElement?.closest('[role="menu"]') !== null,
    )
    expect(inMenu).toBe(true)
    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-list-nav'))).toBe(
      false,
    )
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(trigger).toBeFocused()
    expect(await storage(page)).toBe(before)
  })

  test('the Priority menu keeps its own arrow keys too', async ({ page }) => {
    await openList(page, PHASED)
    const before = await storage(page)
    const trigger = page
      .locator('[data-task-row]')
      .first()
      .getByRole('button', { name: /^Priority:/ })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    expect(
      await page.evaluate(() => document.activeElement?.closest('[role="menu"]') !== null),
    ).toBe(true)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(trigger).toBeFocused()
    expect(await storage(page)).toBe(before)
  })

  test('with the date picker open the arrow keys move inside the calendar, not the list', async ({
    page,
  }) => {
    await openList(page, PHASED)
    const before = await storage(page)
    const row = page.locator('[data-task-row]').first()
    const trigger = row.getByRole('button', { name: /^Due date/ })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const picker = page.getByRole('dialog')
    await expect(picker).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowUp')
    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-list-nav'))).toBe(
      false,
    )
    expect(
      await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null),
    ).toBe(true)
    await page.keyboard.press('Escape')
    await expect(picker).toBeHidden()
    expect(await storage(page)).toBe(before)
  })

  test.describe('dnd-kit keyboard drag', () => {
    const SPEC: Spec = {
      phases: ['Design'],
      tasks: [
        { key: 'a', title: 'Alpha', phase: 'Design' },
        { key: 'b', title: 'Bravo', phase: 'Design' },
        { key: 'c', title: 'Charlie', phase: 'Design' },
      ],
    }
    const live = (page: Page) => page.locator('[id^="DndLiveRegion"]')
    /** dnd-kit's KeyboardSensor starts listening for arrows one task after the pickup. */
    const sensorListening = (page: Page) =>
      page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

    test('Space, ArrowDown, Space on the handle reorders inside the group and saves; focus never jumps to another row; the title arrows work afterwards', async ({
      page,
    }) => {
      await openList(page, SPEC)
      const handle = page.getByRole('button', { name: 'Move Alpha' })
      await handle.focus()
      await page.keyboard.press('Space')
      await expect(live(page)).toHaveText('Picked up Alpha.')
      await sensorListening(page)
      await page.keyboard.press('ArrowDown')
      await expect(live(page)).toHaveText('Alpha is over Bravo.')
      // Focus is still on the handle, not on a list item.
      expect(await focused(page)).toBe('(not a stop) button Move Alpha')
      await page.keyboard.press('Space')
      await expect(live(page)).toHaveText('Alpha was dropped.')
      await expect
        .poll(() => rowTitles(group(page, 'Design')))
        .toEqual(['Bravo', 'Alpha', 'Charlie'])
      await expect.poll(() => storedTitles(page, 'Design')).toEqual(['Bravo', 'Alpha', 'Charlie'])
      await page.reload()
      await expect
        .poll(() => rowTitles(group(page, 'Design')))
        .toEqual(['Bravo', 'Alpha', 'Charlie'])

      // Afterwards the arrows on a title are navigation again.
      await focusStop(page, taskStop(page, 'b'))
      await page.keyboard.press('ArrowDown')
      await expectFocus(page, 'Alpha')
    })

    test('Escape cancels the drag: the order is unchanged and the title arrows work', async ({
      page,
    }) => {
      await openList(page, SPEC)
      const before = await storage(page)
      const handle = page.getByRole('button', { name: 'Move Bravo' })
      await handle.focus()
      await page.keyboard.press('Space')
      await expect(live(page)).toHaveText('Picked up Bravo.')
      await sensorListening(page)
      await page.keyboard.press('ArrowDown')
      await expect(live(page)).toHaveText('Bravo is over Charlie.')
      expect(await focused(page)).toBe('(not a stop) button Move Bravo')
      await page.keyboard.press('Escape')
      await expect(live(page)).toHaveText('Moving Bravo was cancelled.')
      await expect
        .poll(() => rowTitles(group(page, 'Design')))
        .toEqual(['Alpha', 'Bravo', 'Charlie'])
      expect(await storage(page)).toBe(before)

      await focusStop(page, taskStop(page, 'a'))
      await page.keyboard.press('ArrowDown')
      await expectFocus(page, 'Bravo')
    })
  })

  test('app shortcuts still work with focus on a list item: C, ⌘/Ctrl+K, [ and G then P', async ({
    page,
  }) => {
    await openList(page, PHASED)
    const mod = await page.evaluate(() => {
      const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
      const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent
      return /mac|iphone|ipad|ipod/i.test(platform) ? 'Meta' : 'Control'
    })

    await focusStop(page, taskStop(page, 'a'))
    await page.keyboard.press('c')
    const newTask = page.getByRole('dialog', { name: 'New task' })
    await expect(newTask).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(newTask).toBeHidden()

    await focusStop(page, taskStop(page, 'a'))
    await page.keyboard.press(`${mod}+k`)
    const search = page.getByPlaceholder('Search projects, tasks and milestones…')
    await expect(search).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(search).toBeHidden()

    await focusStop(page, taskStop(page, 'a'))
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible()
    await page.keyboard.press('[')
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible()
    await page.keyboard.press('[')
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible()

    await focusStop(page, taskStop(page, 'a'))
    await page.keyboard.press('g')
    await page.keyboard.press('p')
    await expect(page).toHaveURL(/\/projects$/)
  })
})

// ---------------------------------------------------------------------------
// Layout and accessibility
// ---------------------------------------------------------------------------

const LONG: Spec = {
  phases: ['Design', 'Build'],
  tasks: [
    ...Array.from({ length: 32 }, (_, i) => ({
      key: `d${i}`,
      title: `Design task ${String(i + 1).padStart(2, '0')}`,
      phase: 'Design',
    })),
    ...Array.from({ length: 32 }, (_, i) => ({
      key: `b${i}`,
      title: `Build task ${String(i + 1).padStart(2, '0')}`,
      phase: 'Build',
    })),
  ],
  milestones: [{ key: 'm', name: 'Beta', date: '2026-12-01', phase: 'Build' }],
}

/** Where the focused row sits against the scroller and the sticky headers it must stay below. */
function rowGeometry(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement
    const list = document.querySelector('[data-list-scroll]') as HTMLElement
    const view = list.getBoundingClientRect()
    const columnHeader = list.querySelector('[data-list-column-header]') as HTMLElement
    const ownHeader = active.closest('[data-list-group-header]') as HTMLElement | null
    const row = ownHeader ?? (active.closest('[data-task-row]') as HTMLElement | null) ?? active
    const groupHeader = ownHeader
      ? null
      : (active.closest('section')?.querySelector('[data-list-group-header]') as HTMLElement | null)
    const box = row.getBoundingClientRect()
    const style = getComputedStyle(active)
    return {
      label: active.getAttribute('aria-label') ?? active.textContent,
      fromTop: box.top - view.top,
      fromBottom: view.bottom - box.bottom,
      minTop: columnHeader.offsetHeight + (groupHeader?.offsetHeight ?? 0),
      scrolls: list.scrollHeight > list.clientHeight,
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
      focusVisible: active.matches(':focus-visible'),
    }
  })
}

test.describe('Layout and accessibility', () => {
  test('a long list: every step ↓ then ↑ keeps the focused row inside the scroller and below the sticky headers', async ({
    page,
  }) => {
    await openList(page, LONG)
    const list = scroller(page)
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight + 200)).toBe(true)

    await focusStop(page, groupStop(page, 'Design'))
    const total = (await stopLabels(page)).length
    expect(total).toBe(2 + 64 + 1)
    const problems: string[] = []
    const check = async (step: string) => {
      const g = await rowGeometry(page)
      if (g.fromTop < g.minTop - 0.5 || g.fromBottom < -0.5)
        problems.push(
          `${step} ${g.label}: top ${g.fromTop} (min ${g.minTop}) bottom gap ${g.fromBottom}`,
        )
    }
    await check('start')
    for (let i = 1; i < total; i += 1) {
      await page.keyboard.press('ArrowDown')
      await check(`down ${i}`)
    }
    await expectFocus(page, /^Milestone Beta/)
    expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    for (let i = 1; i < total; i += 1) {
      await page.keyboard.press('ArrowUp')
      await check(`up ${i}`)
    }
    await expectFocus(page, 'Design, 32 tasks')
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0)
    expect(problems).toEqual([])
  })

  test('the focus ring is visible on every kind of stop; no tabindex is added to the stops', async ({
    page,
  }) => {
    await openList(page, PHASED)
    const tabindex = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-list-nav]')).map((e) =>
        e.getAttribute('tabindex'),
      ),
    )
    expect(tabindex.every((value) => value === null)).toBe(true)

    await focusStop(page, groupStop(page, 'Design'))
    const seen = new Set<string>()
    for (let i = 0; i < 9; i += 1) {
      await page.keyboard.press('ArrowDown')
      const g = await rowGeometry(page)
      expect(g.focusVisible, g.label ?? '').toBe(true)
      expect(g.outlineStyle, g.label ?? '').not.toBe('none')
      expect(g.outlineWidth, g.label ?? '').toBeGreaterThan(0)
      seen.add(
        await page.evaluate(() => document.activeElement?.getAttribute('data-list-nav') ?? ''),
      )
    }
    expect([...seen].sort()).toEqual(['group', 'milestone', 'task'])
  })

  test.describe('dark mode', () => {
    test.use({ colorScheme: 'dark' })
    test('navigation works and the focus ring is visible', async ({ page }) => {
      await openList(page, PHASED)
      await focusStop(page, groupStop(page, 'Design'))
      expect(await walk(page, 'ArrowDown', 3)).toEqual([
        'Wireframes',
        'Review',
        expect.stringMatching(/^Milestone Kick-off/),
      ])
      const g = await rowGeometry(page)
      expect(g.outlineStyle).not.toBe('none')
      expect(g.outlineWidth).toBeGreaterThan(0)
      await page.keyboard.press('ArrowUp')
      const ring = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement as Element)
        return {
          color: style.outlineColor,
          background: getComputedStyle(document.body).backgroundColor,
        }
      })
      expect(ring.color).not.toBe(ring.background)
    })
  })

  test.describe('narrow window', () => {
    test.use({ viewport: { width: 390, height: 800 } })
    test('navigation works at about 390px wide and the focused row stays in view', async ({
      page,
    }) => {
      await openList(page, LONG)
      await focusStop(page, groupStop(page, 'Design'))
      expect(await walk(page, 'ArrowDown', 3)).toEqual([
        'Design task 01',
        'Design task 02',
        'Design task 03',
      ])
      for (let i = 0; i < 40; i += 1) await page.keyboard.press('ArrowDown')
      const g = await rowGeometry(page)
      expect(g.fromTop).toBeGreaterThanOrEqual(g.minTop - 0.5)
      expect(g.fromBottom).toBeGreaterThanOrEqual(-0.5)
      expect(g.outlineStyle).not.toBe('none')
      expect(g.outlineWidth).toBeGreaterThan(0)
      await page.keyboard.press('ArrowUp')
      await expectFocus(page, /^Design task|^Build task/)
    })
  })
})
