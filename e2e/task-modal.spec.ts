/// <reference lib="dom" />
/**
 * Task Modal + Milestone dialog E2E — runs in LOCAL data mode against the dev server
 * (playwright.config.ts).
 *
 * PRD §4.9 and acceptance §9.1 #3 (a task needs only a name), #4 (subtasks and milestones),
 * #8/#9 (dependencies: cycles refused, Manual vs Auto dates through the planner), #14 (dark mode,
 * Esc, focus, keyboard) and #15 (a failed write is never reported as saved; Retry works).
 *
 * Regressions pinned here that only a real browser shows:
 * - two date pickers never stack (a click on the other date chip dismisses the open picker);
 * - after a failed create, the toast's Retry stores the task and the form closes instead of
 *   waiting to create it a second time (same for "Add subtask" and the milestone dialog);
 * - a confirmation over the Task Modal sits above it.
 */
import { expect, test as base, type Locator, type Page } from '@playwright/test'

const LOCAL_WORKSPACE_KEY = 'cairn:local:workspace:v1'
const NOW = '2026-11-03T08:00:00.000Z'
const TIME_ZONE = 'Asia/Taipei'

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

const ID = {
  research: 'p-research',
  launch: 'p-launch',
  discovery: 'ph-discovery',
  writing: 'ph-writing',
  review: 't-review',
  outline: 't-outline',
  draft: 't-draft',
  survey: 't-survey',
  plain: 't-plain',
  solo: 't-solo',
  announce: 't-announce',
  legal: 't-legal',
  publish: 't-publish',
  late: 't-late',
  deadline: 'm-deadline',
} as const

/** The calendar day `offset` days from today in the app's time zone (see the seeded preferences). */
function isoDay(offset = 0): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date())
  const [year, month, day] = today.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10)
}

interface SeedTask {
  id: string
  projectId: string
  title: string
  phaseId?: string | null
  parentTaskId?: string | null
  description?: string | null
  status?: 'todo' | 'in_progress' | 'done'
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent'
  startDate?: string | null
  dueDate?: string | null
}

function seedWorkspace() {
  let order = 0
  const tasks: Record<string, unknown> = {}
  const task = (input: SeedTask) => {
    const status = input.status ?? 'todo'
    tasks[input.id] = {
      phaseId: null,
      parentTaskId: null,
      description: null,
      priority: 'none',
      startDate: null,
      dueDate: null,
      ...input,
      status,
      sortOrder: `a${String(order++).padStart(2, '0')}`,
      completedAt: status === 'done' ? NOW : null,
      createdAt: NOW,
      updatedAt: NOW,
    }
  }
  const project = (
    id: string,
    name: string,
    color: string,
    scheduleMode: string,
    sort: string,
  ) => ({
    id,
    name,
    description: null,
    status: 'active',
    color,
    startDate: null,
    dueDate: null,
    scheduleMode,
    sortOrder: sort,
    createdAt: NOW,
    updatedAt: NOW,
  })
  const phase = (id: string, name: string, sortOrder: string) => ({
    id,
    projectId: ID.research,
    name,
    sortOrder,
    createdAt: NOW,
    updatedAt: NOW,
  })
  const dependency = (
    id: string,
    predecessorId: string,
    successorId: string,
    projectId: string,
  ) => ({
    id,
    projectId,
    predecessorId,
    successorId,
    type: 'FS',
    createdAt: NOW,
  })

  // Research (Manual): Write literature review (2 subtasks) → Design survey, plus loose tasks.
  task({
    id: ID.review,
    projectId: ID.research,
    phaseId: ID.writing,
    title: 'Write literature review',
    description: 'Cover the last five years.',
    status: 'in_progress',
    priority: 'high',
    startDate: isoDay(1),
    dueDate: isoDay(5),
  })
  task({
    id: ID.outline,
    projectId: ID.research,
    phaseId: ID.writing,
    parentTaskId: ID.review,
    title: 'Outline chapters',
    status: 'done',
    dueDate: isoDay(2),
  })
  task({
    id: ID.draft,
    projectId: ID.research,
    phaseId: ID.writing,
    parentTaskId: ID.review,
    title: 'Draft related work',
    dueDate: isoDay(4),
  })
  task({
    id: ID.survey,
    projectId: ID.research,
    phaseId: ID.discovery,
    title: 'Design survey',
    priority: 'medium',
    startDate: isoDay(6),
    dueDate: isoDay(9),
  })
  task({ id: ID.plain, projectId: ID.research, title: 'Plain task' })
  task({ id: ID.solo, projectId: ID.research, title: 'Solo task' })
  // Launch plan (Auto): Draft announcement → Review with legal → Publish.
  task({
    id: ID.announce,
    projectId: ID.launch,
    title: 'Draft announcement',
    startDate: isoDay(0),
    dueDate: isoDay(2),
  })
  task({
    id: ID.legal,
    projectId: ID.launch,
    title: 'Review with legal',
    startDate: isoDay(3),
    dueDate: isoDay(5),
  })
  task({
    id: ID.publish,
    projectId: ID.launch,
    title: 'Publish',
    startDate: isoDay(6),
    dueDate: isoDay(7),
  })
  // Not linked to anything yet: linking it before "Publish" breaks the schedule.
  task({
    id: ID.late,
    projectId: ID.launch,
    title: 'Late dependency',
    startDate: isoDay(0),
    dueDate: isoDay(8),
  })

  return {
    version: 1,
    projects: {
      [ID.research]: project(ID.research, 'Research', 'violet', 'manual', 'a0'),
      [ID.launch]: project(ID.launch, 'Launch plan', 'blue', 'auto', 'a1'),
      'p-empty': project('p-empty', '空專案 Empty', 'green', 'manual', 'a2'),
    },
    phases: {
      [ID.discovery]: phase(ID.discovery, 'Discovery', 'a0'),
      [ID.writing]: phase(ID.writing, 'Writing', 'a1'),
    },
    tasks,
    milestones: {
      [ID.deadline]: {
        id: ID.deadline,
        projectId: ID.research,
        phaseId: ID.discovery,
        name: 'Submission deadline',
        date: isoDay(8),
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    dependencies: {
      'd-1': dependency('d-1', ID.review, ID.survey, ID.research),
      'd-2': dependency('d-2', ID.announce, ID.legal, ID.launch),
      'd-3': dependency('d-3', ID.legal, ID.publish, ID.launch),
    },
    preferences: { theme: 'system', sidebarCollapsed: false, timezone: TIME_ZONE, weekStartsOn: 1 },
  }
}

/** Seeds the local workspace once per tab (reloads keep what the test changed), then opens `route`. */
async function openApp(page: Page, route: string): Promise<void> {
  await page.addInitScript(
    ({ key, db }) => {
      if (sessionStorage.getItem('cairn-e2e-task-modal-seeded')) return
      localStorage.setItem(key, JSON.stringify(db))
      sessionStorage.setItem('cairn-e2e-task-modal-seeded', '1')
    },
    { key: LOCAL_WORKSPACE_KEY, db: seedWorkspace() },
  )
  await page.goto(route)
}

// ---------------------------------------------------------------------------
// Stored data (the local "database") and test hooks
// ---------------------------------------------------------------------------

interface StoredTask {
  id: string
  projectId: string
  phaseId: string | null
  parentTaskId: string | null
  title: string
  description: string | null
  status: string
  priority: string
  startDate: string | null
  dueDate: string | null
}
interface StoredDb {
  tasks: Record<string, StoredTask>
  dependencies: Record<string, { predecessorId: string; successorId: string }>
  milestones: Record<string, { name: string; date: string; phaseId: string | null }>
}

function readDb(page: Page): Promise<StoredDb> {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? 'null'),
    LOCAL_WORKSPACE_KEY,
  )
}
async function storedTask(page: Page, id: string): Promise<StoredTask | undefined> {
  return (await readDb(page)).tasks[id]
}
async function tasksTitled(page: Page, title: string): Promise<StoredTask[]> {
  return Object.values((await readDb(page)).tasks).filter((task) => task.title === title)
}
async function milestonesNamed(page: Page, name: string) {
  return Object.values((await readDb(page)).milestones).filter((m) => m.name === name)
}

type TestHooks = { failNextWrites(count: number): void; setLatency(ms: number): void }
function failNextWrites(page: Page, count = 1): Promise<void> {
  return page.evaluate((n) => {
    ;(window as Window & { __cairnTest?: TestHooks }).__cairnTest?.failNextWrites(n)
  }, count)
}
function setLatency(page: Page, ms: number): Promise<void> {
  return page.evaluate((n) => {
    ;(window as Window & { __cairnTest?: TestHooks }).__cairnTest?.setLatency(n)
  }, ms)
}

// ---------------------------------------------------------------------------
// Locators and small helpers
// ---------------------------------------------------------------------------

const editModal = (page: Page, title: string) =>
  page.getByRole('dialog', { name: `Edit task: ${title}` })
const newTaskModal = (page: Page) => page.getByRole('dialog', { name: 'New task', exact: true })
const titleBox = (modal: Locator) => modal.getByRole('textbox', { name: 'Task title' })
/** The edit form whatever its title is now (the dialog's name follows the stored title live). */
const anyEditModal = (page: Page) => page.getByRole('dialog', { name: /^Edit task:/ })
const doneButton = (modal: Locator) => modal.getByRole('button', { name: 'Done', exact: true })
const footerState = (modal: Locator) => modal.locator('[data-save-state]')
const discardAlert = (page: Page) => page.getByRole('alertdialog', { name: 'Discard changes?' })
const toastWith = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })

/** Opens the search overlay with the app's own `mod+k` (⌘ on Apple platforms, else Ctrl). */
async function openSearch(page: Page): Promise<void> {
  const modifier = await page.evaluate(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
    const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent
    return /mac|iphone|ipad|ipod/i.test(platform) ? 'Meta' : 'Control'
  })
  await page.keyboard.press(`${modifier}+k`)
}

/** "November 20th, 2026": how the calendar names a day (the label also says the weekday). */
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
  for (let page_ = 0; page_ < 4 && (await day.count()) === 0; page_++) {
    await picker.getByRole('button', { name: 'Go to the Next Month' }).click()
  }
  await day.click()
  await expect(picker).toBeHidden()
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

test.describe('task modal · create', () => {
  test('a task needs only a title: global New task asks for the project, Enter creates, the toast opens it', async ({
    page,
  }) => {
    await openApp(page, '/my-tasks/all')
    await page.getByRole('button', { name: 'New task' }).first().click()
    const modal = newTaskModal(page)
    await expect(titleBox(modal)).toBeFocused()

    // Three projects and none used yet: the project is a required choice.
    await expect(modal.getByRole('button', { name: 'Project: none chosen' })).toBeVisible()
    await expect(modal.getByRole('button', { name: 'Create task' })).toBeDisabled()
    await titleBox(modal).fill('Quick capture 快速記錄')
    await titleBox(modal).press('Enter')
    await expect(modal.getByRole('alert').filter({ hasText: 'Choose a project' })).toBeVisible()
    await expect(modal).toBeVisible()

    await modal.getByRole('button', { name: /^Project:/ }).click()
    await page.getByRole('menuitemradio', { name: 'Research' }).click()
    await titleBox(modal).press('Enter')
    await expect(modal).toBeHidden()

    const toast = toastWith(page, 'Task created')
    await expect(toast).toContainText('Quick capture 快速記錄')
    await expect
      .poll(async () => (await tasksTitled(page, 'Quick capture 快速記錄')).length)
      .toBe(1)
    const [created] = await tasksTitled(page, 'Quick capture 快速記錄')
    expect(created).toMatchObject({
      projectId: ID.research,
      status: 'todo',
      priority: 'none',
      description: null,
      startDate: null,
      dueDate: null,
    })

    await toast.getByRole('button', { name: 'Open' }).click()
    await expect(editModal(page, 'Quick capture 快速記錄')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`task=${created.id}`))
  })

  test('every field can be set on create, and the task keeps them after a reload', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list`)
    await expect(page.getByRole('button', { name: 'Plain task', exact: true })).toBeVisible()
    await page.keyboard.press('c')
    const modal = newTaskModal(page)
    await expect(modal.getByRole('button', { name: 'Project: Research' })).toBeVisible()
    for (const name of [
      'Status: To Do',
      'Priority: No priority',
      'Start date: not set',
      'Due date: not set',
      'Phase: No phase',
    ]) {
      await expect(modal.getByRole('button', { name })).toBeVisible()
    }

    await titleBox(modal).fill('Pilot interviews')
    await modal
      .getByRole('textbox', { name: 'Description' })
      .fill('Five participants.\nRecord every session.')
    await modal.getByRole('button', { name: /^Status:/ }).click()
    await page.getByRole('menuitemradio', { name: /In Progress/ }).click()
    await modal.getByRole('button', { name: /^Priority:/ }).click()
    await page.getByRole('menuitemradio', { name: /High/ }).click()
    await modal.getByRole('button', { name: /^Phase:/ }).click()
    await page.getByRole('menuitemradio', { name: 'Writing' }).click()
    await pickDate(page, modal, 'Start date', isoDay(0))
    await pickDate(page, modal, 'Due date', isoDay(2))
    await modal.getByRole('button', { name: 'Create task' }).click()
    await expect(modal).toBeHidden()

    await expect.poll(async () => (await tasksTitled(page, 'Pilot interviews')).length).toBe(1)
    const [created] = await tasksTitled(page, 'Pilot interviews')
    expect(created).toMatchObject({
      projectId: ID.research,
      phaseId: ID.writing,
      status: 'in_progress',
      priority: 'high',
      description: 'Five participants.\nRecord every session.',
      startDate: isoDay(0),
      dueDate: isoDay(2),
    })

    await page.reload()
    await page.getByRole('button', { name: 'Pilot interviews', exact: true }).click()
    const edit = editModal(page, 'Pilot interviews')
    await expect(edit.getByRole('button', { name: 'Status: In Progress' })).toBeVisible()
    await expect(edit.getByRole('button', { name: 'Priority: High' })).toBeVisible()
    await expect(edit.getByRole('button', { name: 'Phase: Writing' })).toBeVisible()
    await expect(edit.getByRole('textbox', { name: 'Description' })).toHaveValue(
      'Five participants.\nRecord every session.',
    )
  })

  test('repeated Enter or a slow save never creates the task twice', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list`)
    await expect(page.getByRole('button', { name: 'Plain task', exact: true })).toBeVisible()
    // Long enough that the "saving" window cannot be missed on a loaded machine.
    await setLatency(page, 3000)
    await page.keyboard.press('c')
    const modal = newTaskModal(page)
    await titleBox(modal).fill('Only once')
    await titleBox(modal).press('Enter')
    await titleBox(modal).press('Enter')
    await titleBox(modal).press('ControlOrMeta+Enter')
    await expect(modal.getByRole('button', { name: 'Create task' })).toBeDisabled()
    await expect(page.getByText('Saving…')).toBeVisible()
    await expect(modal).toBeHidden({ timeout: 15_000 })
    await expect.poll(async () => (await tasksTitled(page, 'Only once')).length).toBe(1)
  })

  test('a failed create keeps the typed task; Retry stores it once and closes the form', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list`)
    await expect(page.getByRole('button', { name: 'Plain task', exact: true })).toBeVisible()
    await page.keyboard.press('c')
    const modal = newTaskModal(page)
    await titleBox(modal).fill('Needs a retry')
    await modal.getByRole('button', { name: /^Priority:/ }).click()
    await page.getByRole('menuitemradio', { name: /Urgent/ }).click()

    await failNextWrites(page)
    await modal.getByRole('button', { name: 'Create task' }).click()
    const failure = toastWith(page, /Couldn.t create task/)
    await expect(failure).toBeVisible()
    // Rolled back, nothing reported as created, and the form keeps what was typed.
    expect(await tasksTitled(page, 'Needs a retry')).toHaveLength(0)
    await expect(toastWith(page, 'Task created')).toHaveCount(0)
    await expect(modal).toBeVisible()
    await expect(titleBox(modal)).toHaveValue('Needs a retry')
    await expect(modal.getByRole('button', { name: 'Priority: Urgent' })).toBeVisible()

    // The toast's Retry stores the task; the form is done (a second Create would duplicate it).
    await failure.getByRole('button', { name: 'Retry' }).click()
    await expect(modal).toBeHidden()
    await expect(toastWith(page, 'Task created')).toContainText('Needs a retry')
    await expect.poll(async () => (await tasksTitled(page, 'Needs a retry')).length).toBe(1)
    expect((await tasksTitled(page, 'Needs a retry'))[0].priority).toBe('urgent')
  })
})

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

test.describe('task modal · edit', () => {
  test('the form has Done and a save state, no Save or Cancel; ⌘/Ctrl+Enter keeps the typed title and closes', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    const modal = editModal(page, 'Plain task')
    await expect(titleBox(modal)).toBeFocused()
    await expect(doneButton(modal)).toBeVisible()
    await expect(footerState(modal)).toBeAttached() // empty until something was saved
    await expect(modal.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
    await expect(modal.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)

    await titleBox(modal).press('End')
    await page.keyboard.type(' (reviewed)')
    await page.keyboard.press('ControlOrMeta+Enter')

    await expect(anyEditModal(page)).toBeHidden()
    await expect(page).not.toHaveURL(/task=/)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect
      .poll(async () => (await storedTask(page, ID.plain))?.title)
      .toBe('Plain task (reviewed)')
  })

  test('status, priority, phase and dates are saved as they are picked and survive a reload', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.solo}`)
    const modal = editModal(page, 'Solo task')
    await modal.getByRole('button', { name: /^Status:/ }).click()
    await page.getByRole('menuitemradio', { name: /In Progress/ }).click()
    // Saved the moment it is picked: the modal is still open.
    await expect.poll(async () => (await storedTask(page, ID.solo))?.status).toBe('in_progress')
    await expect(modal).toBeVisible()
    await modal.getByRole('button', { name: /^Priority:/ }).click()
    await page.getByRole('menuitemradio', { name: /Urgent/ }).click()
    await expect.poll(async () => (await storedTask(page, ID.solo))?.priority).toBe('urgent')
    await modal.getByRole('button', { name: /^Phase:/ }).click()
    await page.getByRole('menuitemradio', { name: 'Discovery' }).click()
    await expect.poll(async () => (await storedTask(page, ID.solo))?.phaseId).toBe(ID.discovery)
    await pickDate(page, modal, 'Start date', isoDay(3))
    await pickDate(page, modal, 'Due date', isoDay(4))
    await expect.poll(async () => (await storedTask(page, ID.solo))?.dueDate).toBe(isoDay(4))
    await modal.getByRole('textbox', { name: 'Description' }).fill('  \n') // whitespace only: nothing to store
    await doneButton(modal).click()
    await expect(anyEditModal(page)).toBeHidden()

    await page.reload()
    await expect
      .poll(async () => await storedTask(page, ID.solo))
      .toMatchObject({
        status: 'in_progress',
        priority: 'urgent',
        phaseId: ID.discovery,
        startDate: isoDay(3),
        dueDate: isoDay(4),
        description: null,
      })
  })

  test('the date pickers disable a start after the due date (and the reverse) with a hint; one date picker at a time', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.survey}`)
    const modal = editModal(page, 'Design survey')
    const startPicker = page.getByRole('dialog', { name: 'Start date', exact: true })
    const duePicker = page.getByRole('dialog', { name: 'Due date', exact: true })

    // Opening the other date chip replaces the open picker (two calendars never stack).
    await modal.getByRole('button', { name: /^Start date:/ }).click()
    await expect(startPicker).toBeVisible()
    await modal.getByRole('button', { name: /^Due date:/ }).click()
    await expect(duePicker).toBeVisible()
    await expect(startPicker).toBeHidden()
    // Esc closes the picker only, never the modal.
    await page.keyboard.press('Escape')
    await expect(duePicker).toBeHidden()
    await expect(modal).toBeVisible()

    // The start is +6 and the due +9: the due picker disables the days before the start, the start
    // picker the days after the due date, each with a hint; there is no inline error to produce.
    const dayButton = async (picker: Locator, date: string) => {
      const day = picker.getByRole('button', { name: dayPattern(date) })
      for (let step = 0; step < 4 && (await day.count()) === 0; step++) {
        await picker.getByRole('button', { name: 'Go to the Next Month' }).click()
      }
      return day
    }
    await modal.getByRole('button', { name: /^Due date:/ }).click()
    await expect(duePicker.getByText('Due date can’t be before the start date.')).toBeVisible()
    await expect(await dayButton(duePicker, isoDay(6))).toBeEnabled()
    await expect(await dayButton(duePicker, isoDay(5))).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(duePicker).toBeHidden()
    await modal.getByRole('button', { name: /^Start date:/ }).click()
    await expect(startPicker.getByText('The start can’t be after the due date.')).toBeVisible()
    await expect(await dayButton(startPicker, isoDay(9))).toBeEnabled()
    await expect(await dayButton(startPicker, isoDay(10))).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(startPicker).toBeHidden()
    await expect(modal.getByRole('alert')).toHaveCount(0)
    expect(await storedTask(page, ID.survey)).toMatchObject({
      startDate: isoDay(6),
      dueDate: isoDay(9),
    })

    // Moving both later: the due date first, then the start. Each pick is saved on its own.
    await pickDate(page, modal, 'Due date', isoDay(14))
    await expect.poll(async () => (await storedTask(page, ID.survey))?.dueDate).toBe(isoDay(14))
    await pickDate(page, modal, 'Start date', isoDay(12))
    await expect.poll(async () => (await storedTask(page, ID.survey))?.startDate).toBe(isoDay(12))
    await expect(modal.getByRole('alert')).toHaveCount(0)
    await expect(modal).toBeVisible()
  })

  test('every way out keeps the edit and closes without asking; focus returns to the row', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list`)
    const opener = page.getByRole('button', { name: 'Plain task', exact: true })
    await opener.click()
    const modal = editModal(page, 'Plain task')
    await expect(titleBox(modal)).toBeFocused()
    await page.keyboard.type('!')

    // Esc: kept, closed, no question, and focus is back on the row that opened it.
    await page.keyboard.press('Escape')
    await expect(anyEditModal(page)).toBeHidden()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect.poll(async () => (await storedTask(page, ID.plain))?.title).toBe('Plain task!')
    await expect(page.getByRole('button', { name: 'Plain task!', exact: true })).toBeFocused()

    // The X button.
    await page.getByRole('button', { name: 'Plain task!', exact: true }).click()
    await expect(titleBox(anyEditModal(page))).toBeFocused()
    await page.keyboard.type('?')
    await anyEditModal(page).getByRole('button', { name: 'Close' }).click()
    await expect(anyEditModal(page)).toBeHidden()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect.poll(async () => (await storedTask(page, ID.plain))?.title).toBe('Plain task!?')

    // A click on the overlay.
    await page.getByRole('button', { name: 'Plain task!?', exact: true }).click()
    await expect(titleBox(anyEditModal(page))).toBeFocused()
    await page.keyboard.type('.')
    const box = await anyEditModal(page).boundingBox()
    if (!box) throw new Error('the modal is not visible')
    await page.mouse.click(box.x + box.width + 80, box.y + 120)
    await expect(anyEditModal(page)).toBeHidden()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect.poll(async () => (await storedTask(page, ID.plain))?.title).toBe('Plain task!?.')

    // A clean form closes straight away too.
    await page.getByRole('button', { name: 'Plain task!?.', exact: true }).click()
    await expect(anyEditModal(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(anyEditModal(page)).toBeHidden()
  })

  test('the create form still asks "Discard changes?" first, and the question sits above the form', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list`)
    await expect(page.getByRole('button', { name: 'Plain task', exact: true })).toBeVisible()
    await page.keyboard.press('c')
    const modal = newTaskModal(page)
    await expect(titleBox(modal)).toBeFocused()
    await page.keyboard.type('Half written')

    // Esc, a click on the overlay, the X button: each asks, and "Keep editing" keeps everything.
    await page.keyboard.press('Escape')
    await expect(discardAlert(page)).toBeVisible()
    // The confirmation sits above the modal and dims it (its layers outrank the modal's).
    const layers = await page.evaluate(() => {
      const zIndex = (element: Element | null | undefined) =>
        element ? Number(getComputedStyle(element).zIndex) : Number.NaN
      const confirmation = document.querySelector('[role="alertdialog"]')
      return {
        overlay: zIndex(confirmation?.previousElementSibling),
        confirmation: zIndex(confirmation),
        modal: zIndex(document.querySelector('[data-slot="dialog-content"]')),
      }
    })
    expect(layers.overlay).toBeGreaterThan(layers.modal)
    expect(layers.confirmation).toBeGreaterThanOrEqual(layers.overlay)
    await discardAlert(page).getByRole('button', { name: 'Keep editing' }).click()
    await expect(discardAlert(page)).toBeHidden()
    await expect(titleBox(modal)).toBeFocused()
    await expect(titleBox(modal)).toHaveValue('Half written')

    const box = await modal.boundingBox()
    if (!box) throw new Error('the modal is not visible')
    await page.mouse.click(box.x + box.width + 80, box.y + 120)
    await expect(discardAlert(page)).toBeVisible()
    await discardAlert(page).getByRole('button', { name: 'Keep editing' }).click()

    await modal.getByRole('button', { name: 'Close' }).click()
    await expect(discardAlert(page)).toBeVisible()
    await discardAlert(page).getByRole('button', { name: 'Keep editing' }).click()
    await expect(modal).toBeVisible()

    // Cancel → Discard: closed and nothing created.
    await modal.getByRole('button', { name: 'Cancel' }).click()
    await discardAlert(page).getByRole('button', { name: 'Discard' }).click()
    await expect(modal).toBeHidden()
    expect(await tasksTitled(page, 'Half written')).toHaveLength(0)
  })

  test('⌘K → New task keeps what an edit form had typed, with no prompt, and opens Create', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    const modal = editModal(page, 'Plain task')
    await titleBox(modal).press('End')
    await page.keyboard.type(' (typed)')
    await modal.getByRole('textbox', { name: 'Add subtask' }).fill('Not added yet')

    await openSearch(page)
    await page.getByRole('option', { name: /^New task/ }).click()
    await expect(newTaskModal(page)).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect
      .poll(async () => (await storedTask(page, ID.plain))?.title)
      .toBe('Plain task (typed)')
  })

  test('a failed title write rolls back, keeps the text with a message naming the task; Retry stores it', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    const modal = anyEditModal(page) // its name follows the stored title
    await titleBox(modal).fill('Plain task, edited')
    await failNextWrites(page)
    await titleBox(modal).press('Enter')

    const failure = toastWith(page, /Couldn.t save the title of “Plain task”/)
    await expect(failure).toBeVisible()
    await expect(failure.getByRole('button', { name: 'Retry' })).toBeVisible()
    await expect(failure.getByRole('button', { name: 'Open' })).toBeVisible()
    expect((await storedTask(page, ID.plain))?.title).toBe('Plain task')
    await expect(toastWith(page, 'Task created')).toHaveCount(0)
    await expect(modal).toBeVisible()
    await expect(titleBox(modal)).toHaveValue('Plain task, edited')
    await expect(modal).toContainText('Your text is kept here.')
    await expect(footerState(modal)).toContainText('Couldn’t save title')

    await failure.getByRole('button', { name: 'Retry' }).click()
    await expect
      .poll(async () => (await storedTask(page, ID.plain))?.title)
      .toBe('Plain task, edited')
    // Nothing left to retry.
    await expect(modal).not.toContainText('Your text is kept here.')
    await expect(footerState(modal)).not.toContainText('Couldn’t save')
  })

  test('deep links keep the modal across a reload; an unknown task reports "Task not found"', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.review}`)
    await expect(editModal(page, 'Write literature review')).toBeVisible()
    await page.reload()
    await expect(editModal(page, 'Write literature review')).toBeVisible()

    await page.goto(`/projects/${ID.research}/list?task=does-not-exist`)
    await expect(toastWith(page, 'Task not found')).toBeVisible()
    await expect(page).not.toHaveURL(/task=/)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('keyboard only, dark theme: focus stays inside the modal and Esc closes it', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await openApp(page, `/projects/${ID.research}/list?task=${ID.review}`)
    await expect(page.locator('html')).toHaveClass(/dark/)
    const modal = editModal(page, 'Write literature review')
    await expect(titleBox(modal)).toBeFocused()

    for (let step = 0; step < 40; step++) {
      await page.keyboard.press('Tab')
      expect(
        await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))),
      ).toBe(true)
    }
    // Esc on a control whose tooltip is showing only dismisses the tooltip (as it should), so
    // go back to the title and let the tooltips finish closing before the Esc that closes the modal.
    await titleBox(modal).focus()
    await expect(page.locator('[role="tooltip"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
  })
})

// ---------------------------------------------------------------------------
// Subtasks
// ---------------------------------------------------------------------------

test.describe('task modal · subtasks', () => {
  test('add inline, change a status, open one; its phase follows the parent', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.review}`)
    const modal = editModal(page, 'Write literature review')
    const subtasks = modal.getByRole('region', { name: 'Subtasks' })
    await expect(subtasks.getByText('1/2')).toBeVisible()
    await expect(subtasks.getByText('One level of subtasks')).toBeVisible()

    const add = subtasks.getByRole('textbox', { name: 'Add subtask' })
    await add.fill('Check citations')
    await add.press('Enter')
    await expect(
      subtasks.getByRole('button', { name: 'Check citations', exact: true }),
    ).toBeVisible()
    await expect(add).toHaveValue('')
    await expect(add).toBeFocused()
    await expect.poll(async () => (await tasksTitled(page, 'Check citations')).length).toBe(1)
    expect((await tasksTitled(page, 'Check citations'))[0]).toMatchObject({
      parentTaskId: ID.review,
      phaseId: ID.writing,
    })
    // Subtask edits are immediate, not part of the form: nothing is left waiting to be saved.
    await expect(footerState(modal)).not.toHaveAttribute('data-save-state', 'pending')
    await expect(footerState(modal)).not.toHaveAttribute('data-save-state', 'failed')

    await subtasks.getByRole('button', { name: 'Status of “Draft related work”: To Do' }).click()
    await page.getByRole('menuitemradio', { name: /Done/ }).click()
    await expect(subtasks.getByText('2/3')).toBeVisible()
    await expect.poll(async () => (await storedTask(page, ID.draft))?.status).toBe('done')

    await subtasks.getByRole('button', { name: 'Draft related work', exact: true }).click()
    const subtask = editModal(page, 'Draft related work')
    await expect(subtask).toBeVisible()
    const crumb = subtask.getByRole('button', { name: /Subtask of Write literature review/ })
    await expect(crumb).toBeVisible()
    await expect(subtask.getByRole('button', { name: 'Phase: Writing' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    // One level only: a subtask has no Subtasks section of its own.
    await expect(subtask.getByRole('region', { name: 'Subtasks' })).toHaveCount(0)
    await crumb.click()
    await expect(editModal(page, 'Write literature review')).toBeVisible()
  })

  test('a failed "Add subtask" gives its text back; Retry stores it once and clears the line', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    const modal = editModal(page, 'Plain task')
    const add = modal.getByRole('textbox', { name: 'Add subtask' })
    await add.fill('Child one')
    await failNextWrites(page)
    await add.press('Enter')

    const failure = toastWith(page, /Couldn.t create task/)
    await expect(failure).toBeVisible()
    await expect(add).toHaveValue('Child one')
    expect(await tasksTitled(page, 'Child one')).toHaveLength(0)

    await failure.getByRole('button', { name: 'Retry' }).click()
    await expect(add).toHaveValue('')
    await expect(modal.getByRole('button', { name: 'Child one', exact: true })).toBeVisible()
    await expect.poll(async () => (await tasksTitled(page, 'Child one')).length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Dependencies and the planner
// ---------------------------------------------------------------------------

test.describe('task modal · dependencies', () => {
  test('add and remove links; a circular dependency is refused with the reason', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.survey}`)
    const modal = editModal(page, 'Design survey')
    const blockedBy = modal.getByRole('list', { name: 'Blocked by' })
    const blocking = modal.getByRole('list', { name: 'Blocking' })
    await expect(
      blockedBy.getByRole('button', { name: 'Write literature review', exact: true }),
    ).toBeVisible()

    await blocking.getByRole('button', { name: 'Add a task this one blocks' }).click()
    const picker = page.getByRole('dialog', { name: 'Add a task this one blocks' })
    const cycle = picker.getByRole('option', { name: /^Write literature review/ })
    await expect(cycle).toHaveAttribute('aria-disabled', 'true')
    await expect(cycle).toContainText('This would create a circular dependency.')

    await picker.getByPlaceholder('Search tasks in this project…').fill('Plain')
    await picker.getByRole('option', { name: 'Plain task' }).click()
    await expect(blocking.getByRole('button', { name: 'Plain task', exact: true })).toBeVisible()
    await expect
      .poll(async () =>
        Object.values((await readDb(page)).dependencies).some(
          (d) => d.predecessorId === ID.survey && d.successorId === ID.plain,
        ),
      )
      .toBe(true)

    await blocking.getByRole('button', { name: 'Remove “Plain task” from Blocking' }).click()
    await expect(blocking.getByRole('button', { name: 'Plain task' })).toHaveCount(0)
    await expect
      .poll(async () =>
        Object.values((await readDb(page)).dependencies).some((d) => d.successorId === ID.plain),
      )
      .toBe(false)
  })

  test('Manual mode: dates that break a dependency show the conflict live in the modal, saved at once, no toast', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.review}`)
    const modal = editModal(page, 'Write literature review')
    const banner = modal.getByRole('status').filter({ hasText: 'Dependency conflict' })
    await expect(banner).toHaveCount(0)

    // The survey starts on day +6: finishing this task on day +8 breaks the link.
    await pickDate(page, modal, 'Due date', isoDay(8))
    await expect.poll(async () => (await storedTask(page, ID.review))?.dueDate).toBe(isoDay(8))
    await expect(banner).toContainText('Dependency conflict')
    await expect(banner).not.toContainText('with these dates') // it is stored now
    await expect(banner).toContainText('Design survey')
    await expect(banner.getByRole('link', { name: 'Open Gantt' })).toHaveAttribute(
      'href',
      `/projects/${ID.research}/gantt?task=${ID.review}`,
    )
    // The modal's banner is the warning: no separate conflict toast, only the date Undo.
    await expect(toastWith(page, /^Updated/)).toBeVisible()
    await expect(toastWith(page, '1 dependency conflict')).toHaveCount(0)
    await expect(modal).toBeVisible()
    // Manual: the successor is never moved.
    expect((await storedTask(page, ID.survey))?.startDate).toBe(isoDay(6))

    await doneButton(modal).click()
    await expect(anyEditModal(page)).toBeHidden()
    await expect(toastWith(page, '1 dependency conflict')).toHaveCount(0)
  })

  test('Auto mode: a date change previews the dependents right away; Cancel leaves the dates, Apply writes it all', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.launch}/list?task=${ID.announce}`)
    const modal = editModal(page, 'Draft announcement')
    await pickDate(page, modal, 'Due date', isoDay(6)) // Review with legal starts on day +3

    const preview = page.getByRole('dialog', { name: 'Move dependent tasks?' })
    await expect(preview).toBeVisible()
    await preview.getByRole('button', { name: 'Cancel' }).click()
    await expect(preview).toBeHidden()
    // Cancelled: the modal stays open and the stored dates are untouched.
    await expect(modal).toBeVisible()
    await expect(modal).toContainText('Dates not changed.')
    expect(await storedTask(page, ID.announce)).toMatchObject({
      title: 'Draft announcement',
      dueDate: isoDay(2),
    })
    expect((await storedTask(page, ID.legal))?.startDate).toBe(isoDay(3))

    await pickDate(page, modal, 'Due date', isoDay(6))
    await expect(preview).toBeVisible()
    await preview.getByRole('button', { name: /^Apply/ }).click()
    await expect(preview).toBeHidden()
    await expect(anyEditModal(page)).toBeVisible()
    await expect.poll(async () => (await storedTask(page, ID.announce))?.dueDate).toBe(isoDay(6))
    const db = await readDb(page)
    expect(db.tasks[ID.legal].startDate! > isoDay(6)).toBe(true)
    expect(db.tasks[ID.publish].startDate! > db.tasks[ID.legal].dueDate!).toBe(true)
    await expect(anyEditModal(page)).not.toContainText('Dates not changed.')
  })

  test('Auto mode: linking a task that already breaks the schedule previews the shift', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.launch}/list?task=${ID.publish}`)
    const modal = editModal(page, 'Publish')
    const add = modal.getByRole('button', { name: 'Add a task that blocks this one' })
    await add.click()
    await page
      .getByRole('dialog', { name: 'Add a task that blocks this one' })
      .getByRole('option', { name: /Late dependency/ })
      .click()

    // The link is written; Auto mode offers to move "Publish" behind the late task.
    const preview = page.getByRole('dialog', { name: 'Reschedule for the new dependency?' })
    await expect(preview).toBeVisible()
    await expect
      .poll(async () =>
        Object.values((await readDb(page)).dependencies).some(
          (d) => d.predecessorId === ID.late && d.successorId === ID.publish,
        ),
      )
      .toBe(true)
    await preview.getByRole('button', { name: /^Apply/ }).click()
    await expect(preview).toBeHidden()
    await expect
      .poll(async () => ((await storedTask(page, ID.publish))?.startDate ?? '') > isoDay(8))
      .toBe(true)
    // Keyboard users stay in the row the preview was opened from.
    await expect(add).toBeFocused()
  })
})

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

test.describe('task modal · delete', () => {
  async function chooseDelete(page: Page, modal: Locator) {
    await modal.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: /Delete task/ }).click()
  }

  test('asks first, names the dependency that goes with the task, then deletes', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.survey}`)
    const modal = editModal(page, 'Design survey')
    await chooseDelete(page, modal)
    const confirmation = page.getByRole('alertdialog', { name: 'Delete task?' })
    await expect(confirmation).toContainText('1 dependency')
    await confirmation.getByRole('button', { name: 'Cancel' }).click()
    await expect(modal).toBeVisible()
    expect(await storedTask(page, ID.survey)).toBeDefined()

    await chooseDelete(page, modal)
    await confirmation.getByRole('button', { name: 'Delete' }).click()
    await expect(modal).toBeHidden()
    await expect(toastWith(page, 'Task deleted')).toBeVisible()
    await expect(toastWith(page, 'Task not found')).toHaveCount(0)
    await expect.poll(async () => await storedTask(page, ID.survey)).toBeUndefined()
    expect(Object.keys((await readDb(page)).dependencies)).not.toContain('d-1')
  })

  test('deleting a parent asks what happens to its subtasks: keep them on the top level', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.review}`)
    const modal = editModal(page, 'Write literature review')
    await chooseDelete(page, modal)
    const choice = page.getByRole('alertdialog', { name: /Delete “Write literature review”\?/ })
    await expect(choice).toContainText('2 subtasks')
    await choice.getByRole('button', { name: 'Keep subtasks (move to top level)' }).click()
    await expect(modal).toBeHidden()
    await expect(toastWith(page, 'Task deleted · subtasks kept')).toBeVisible()
    await expect.poll(async () => await storedTask(page, ID.review)).toBeUndefined()
    const db = await readDb(page)
    expect(db.tasks[ID.outline].parentTaskId).toBeNull()
    expect(db.tasks[ID.draft].parentTaskId).toBeNull()
  })

  test('deleting a parent can delete its subtasks too', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.review}`)
    const modal = editModal(page, 'Write literature review')
    await chooseDelete(page, modal)
    await page
      .getByRole('alertdialog', { name: /Delete “Write literature review”\?/ })
      .getByRole('button', { name: 'Delete subtasks too' })
      .click()
    await expect(modal).toBeHidden()
    await expect.poll(async () => await storedTask(page, ID.review)).toBeUndefined()
    const db = await readDb(page)
    expect(db.tasks[ID.outline]).toBeUndefined()
    expect(db.tasks[ID.draft]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

test.describe('milestone dialog', () => {
  test('create from the project menu, edit from the list, delete after confirming', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list`)
    await page.getByRole('button', { name: 'Project actions' }).click()
    await page.getByRole('menuitem', { name: 'Add milestone…' }).click()
    const dialog = page.getByRole('dialog', { name: 'New milestone' })
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeFocused()
    await expect(dialog.getByText(/never count toward project progress/)).toBeVisible()
    const create = dialog.getByRole('button', { name: 'Create milestone' })
    await expect(create).toBeDisabled()

    await dialog.getByRole('textbox', { name: 'Name' }).fill('Kick-off 啟動會議')
    await expect(create).toBeDisabled() // no date yet
    await pickDate(page, dialog, 'Date', isoDay(1))
    await dialog.getByRole('combobox', { name: 'Phase' }).click()
    await page.getByRole('option', { name: 'Writing' }).click()
    await create.click()
    await expect(dialog).toBeHidden()
    await expect(toastWith(page, 'Milestone created')).toBeVisible()
    await expect.poll(async () => (await milestonesNamed(page, 'Kick-off 啟動會議')).length).toBe(1)
    expect((await milestonesNamed(page, 'Kick-off 啟動會議'))[0]).toMatchObject({
      date: isoDay(1),
      phaseId: ID.writing,
    })

    // Edit: Save needs a change, and Esc with a change asks first.
    await page.getByRole('button', { name: /^Milestone Submission deadline/ }).click()
    const edit = page.getByRole('dialog', { name: 'Edit milestone' })
    const save = edit.getByRole('button', { name: 'Save', exact: true })
    await expect(save).toBeDisabled()
    await edit.getByRole('textbox', { name: 'Name' }).fill('Submission deadline (moved)')
    await expect(save).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(discardAlert(page)).toBeVisible()
    await discardAlert(page).getByRole('button', { name: 'Keep editing' }).click()
    await save.click()
    await expect(edit).toBeHidden()
    await expect
      .poll(async () => (await readDb(page)).milestones[ID.deadline]?.name)
      .toBe('Submission deadline (moved)')

    // Delete.
    await page.getByRole('button', { name: /^Milestone Submission deadline \(moved\)/ }).click()
    await edit.getByRole('button', { name: 'Delete' }).click()
    const confirmation = page.getByRole('alertdialog', { name: 'Delete milestone?' })
    await expect(confirmation).toContainText('Submission deadline (moved)')
    await confirmation.getByRole('button', { name: 'Delete' }).click()
    await expect(edit).toBeHidden()
    await expect.poll(async () => (await readDb(page)).milestones[ID.deadline]).toBeUndefined()
  })

  test('a failed create keeps the dialog; Retry stores the milestone once and closes it', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list`)
    await page.getByRole('button', { name: 'Project actions' }).click()
    await page.getByRole('menuitem', { name: 'Add milestone…' }).click()
    const dialog = page.getByRole('dialog', { name: 'New milestone' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Fails once')
    await pickDate(page, dialog, 'Date', isoDay(0))

    await failNextWrites(page)
    await dialog.getByRole('button', { name: 'Create milestone' }).click()
    const failure = toastWith(page, /Couldn.t create milestone/)
    await expect(failure).toBeVisible()
    expect(await milestonesNamed(page, 'Fails once')).toHaveLength(0)
    await expect(toastWith(page, 'Milestone created')).toHaveCount(0)
    await expect(dialog).toBeVisible()

    await failure.getByRole('button', { name: 'Retry' }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(async () => (await milestonesNamed(page, 'Fails once')).length).toBe(1)
  })
})

test('the browser Forward button reopens a closed task, and it can be closed again', async ({
  page,
}) => {
  await openApp(page, '/overview')
  await page.goto(`/projects/${ID.research}/list`)
  await page.getByText('Plain task', { exact: true }).first().click()
  await expect(page).toHaveURL(/task=/)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page).not.toHaveURL(/task=/)
  await expect(dialog).toBeHidden()
  await page.goForward()
  await expect(page).toHaveURL(/task=/)
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page).not.toHaveURL(/task=/)
  await expect(dialog).toBeHidden()
  await page.goBack()
  await expect(page).toHaveURL(/\/overview/)
})
