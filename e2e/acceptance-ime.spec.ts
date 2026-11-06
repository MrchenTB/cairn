/// <reference lib="dom" />
/**
 * Acceptance E2E — Traditional Chinese input with a real input method (IME), plus CJK / emoji
 * handling. Local data mode, dev server from playwright.config.ts.
 *
 * The owner types Zhuyin / Pinyin every day. jsdom cannot compose, so these tests drive Chromium
 * through a CDP session (e2e/ime.helpers.ts): a pre-edit string that really sits in the field,
 * keys the input method consumes arriving as keydown 229, and the commit as compositionend.
 *
 * For EVERY text input the same contract is checked:
 *  - Enter that confirms a candidate never submits, saves or opens anything;
 *  - Esc that drops a composition never closes the surface, never clears or discards text;
 *  - after the commit, the next Enter submits exactly once, with exactly the committed text;
 *  - no character is lost or duplicated, no shortcut letter fires;
 *  - Safari's order (compositionend first, then keydown 229 with isComposing = false) behaves the
 *    same as Chrome's.
 */
import { expect as baseExpect, test as base, type Locator, type Page } from '@playwright/test'
import { Ime } from './ime.helpers.ts'

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

test.use({
  viewport: { width: 1280, height: 800 },
  timezoneId: 'Asia/Taipei',
  locale: 'zh-TW',
  reducedMotion: 'reduce',
})

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

interface SeedOptions {
  name?: string
  phases?: string[]
  /** Top-level task titles in order (a title may carry `phase`). */
  tasks?: { title: string; phase?: string; description?: string; start?: string; due?: string }[]
  milestones?: { name: string; date: string }[]
  extraProjects?: string[]
}

const PROJECT_ID = 'p-ime'
const PHASE_ID = (name: string) => `ph-${name}`

function buildWorkspace(options: SeedOptions = {}): unknown {
  const {
    name = 'Research',
    phases = [],
    tasks = [],
    milestones = [],
    extraProjects = [],
  } = options
  const project = (id: string, projectName: string, index: number) => ({
    id,
    name: projectName,
    description: null,
    status: 'active',
    color: 'violet',
    startDate: null,
    dueDate: null,
    scheduleMode: 'manual',
    sortOrder: `a${index}`,
    createdAt: NOW,
    updatedAt: NOW,
  })
  const db = {
    version: 1,
    projects: { [PROJECT_ID]: project(PROJECT_ID, name, 0) } as Record<string, unknown>,
    phases: {} as Record<string, unknown>,
    tasks: {} as Record<string, unknown>,
    milestones: {} as Record<string, unknown>,
    dependencies: {},
    preferences: null,
  }
  extraProjects.forEach((extra, index) => {
    db.projects[`p-extra-${index}`] = project(`p-extra-${index}`, extra, index + 1)
  })
  phases.forEach((phase, index) => {
    db.phases[PHASE_ID(phase)] = {
      id: PHASE_ID(phase),
      projectId: PROJECT_ID,
      name: phase,
      sortOrder: `a${index}`,
      createdAt: NOW,
      updatedAt: NOW,
    }
  })
  tasks.forEach((task, index) => {
    db.tasks[`t-${index}`] = {
      id: `t-${index}`,
      projectId: PROJECT_ID,
      phaseId: task.phase ? PHASE_ID(task.phase) : null,
      parentTaskId: null,
      title: task.title,
      description: task.description ?? null,
      status: 'todo',
      priority: 'none',
      startDate: task.start ?? null,
      dueDate: task.due ?? null,
      sortOrder: `a${index}`,
      completedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    }
  })
  milestones.forEach((milestone, index) => {
    db.milestones[`m-${index}`] = {
      id: `m-${index}`,
      projectId: PROJECT_ID,
      phaseId: null,
      name: milestone.name,
      date: milestone.date,
      createdAt: NOW,
      updatedAt: NOW,
    }
  })
  return db
}

/** Boots the app at `path`; the seed is written once per tab (a reload keeps what the test did). */
async function openApp(page: Page, path: string, seed: SeedOptions | null = {}): Promise<Ime> {
  if (seed) {
    await page.addInitScript(
      ({ key, db }) => {
        if (sessionStorage.getItem('cairn-e2e-ime-seeded')) return
        localStorage.setItem(key, JSON.stringify(db))
        sessionStorage.setItem('cairn-e2e-ime-seeded', '1')
      },
      { key: LOCAL_WORKSPACE_KEY, db: buildWorkspace(seed) },
    )
  }
  await page.goto(path)
  return Ime.attach(page)
}

// ---------------------------------------------------------------------------
// What the local "database" holds
// ---------------------------------------------------------------------------

interface Stored {
  projects: Record<string, { id: string; name: string; description: string | null }>
  phases: Record<string, { id: string; name: string }>
  tasks: Record<
    string,
    { id: string; title: string; description: string | null; parentTaskId: string | null }
  >
  milestones: Record<string, { id: string; name: string; date: string }>
}

function stored(page: Page): Promise<Stored> {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '{}') as Stored,
    LOCAL_WORKSPACE_KEY,
  )
}

/** Titles of the top-level tasks, in creation order (the seed's keys sort first). */
async function taskTitles(page: Page): Promise<string[]> {
  const data = await stored(page)
  return Object.values(data.tasks ?? {})
    .filter((task) => task.parentTaskId === null)
    .map((task) => task.title)
}

async function subtaskTitles(page: Page): Promise<string[]> {
  const data = await stored(page)
  return Object.values(data.tasks ?? {})
    .filter((task) => task.parentTaskId !== null)
    .map((task) => task.title)
}

async function phaseNames(page: Page): Promise<string[]> {
  return Object.values((await stored(page)).phases ?? {}).map((phase) => phase.name)
}

/** Everything a stray submit could have changed, to compare before / after. */
async function snapshot(page: Page): Promise<string> {
  return page.evaluate((key) => localStorage.getItem(key) ?? '', LOCAL_WORKSPACE_KEY)
}

// ---------------------------------------------------------------------------
// Strings: what the keyboard shows (pre-edit) and what the candidate list commits
// ---------------------------------------------------------------------------

/** 台北 typed with Zhuyin: ㄊㄞˊ ㄅㄟˇ. */
const TAIPEI = { preedit: ['ㄊ', 'ㄊㄞˊ', 'ㄊㄞˊㄅㄟˇ'], text: '台北' } as const
/** 專案規劃 (Pinyin zhuan an gui hua). */
const PLAN = { preedit: ['zhuan', 'zhuan an', 'zhuan an gui hua'], text: '專案規劃' } as const
/** 馬 (ㄇㄚˇ). */
const HORSE = { preedit: ['ㄇ', 'ㄇㄚˇ'], text: '馬' } as const

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('List: inline "Add task" / "Add phase" rows', () => {
  test('Enter and Esc that belong to the IME neither create nor close; Enter after it creates once', async ({
    page,
  }) => {
    const ime = await openApp(page, `/projects/${PROJECT_ID}/list`, {
      tasks: [{ title: 'Inbox idea' }],
    })
    await page.getByRole('button', { name: 'Add task' }).click()
    const input = page.getByRole('textbox', { name: 'New task', exact: true })
    await expect(input).toBeFocused()
    const before = await snapshot(page)

    // 1. Enter picks the candidate (Chrome order): nothing is created, the text arrives intact.
    await ime.type(TAIPEI.text, TAIPEI.preedit, 'enter')
    await expect(input).toHaveValue('台北')
    expect(await snapshot(page)).toBe(before)

    // 2. Esc drops a new composition: the row stays open and keeps the committed text.
    await ime.compose('ㄇ')
    await expect(input).toHaveValue('台北ㄇ')
    await ime.cancelWithEsc()
    await expect(input).toHaveValue('台北')
    await expect(input).toBeFocused()
    expect(await snapshot(page)).toBe(before)

    // 3. The next Enter is the user's: exactly one task, exactly the committed text.
    await page.keyboard.press('Enter')
    await expect.poll(() => taskTitles(page)).toEqual(['Inbox idea', '台北'])
    await expect(input).toHaveValue('')
    await expect(input).toBeFocused()

    // 4. Safari's order: compositionend, then Enter with keyCode 229 and isComposing = false.
    await ime.type(HORSE.text, HORSE.preedit, 'safari')
    await expect(input).toHaveValue('馬')
    await ime.compose('ㄅ')
    await ime.cancelWithEscSafari()
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('馬')
    expect(await taskTitles(page)).toEqual(['Inbox idea', '台北'])
    await page.keyboard.press('Enter')
    await expect.poll(() => taskTitles(page)).toEqual(['Inbox idea', '台北', '馬'])

    // 5. A plain Esc (no composition) still closes the row.
    await page.keyboard.press('Escape')
    await expect(input).toBeHidden()
    await expect(page.getByRole('button', { name: 'Add task' })).toBeFocused()
  })

  test('"Add phase" row: same contract; Windows-style "Process" keys too', async ({ page }) => {
    const ime = await openApp(page, `/projects/${PROJECT_ID}/list`, {
      phases: ['Discovery'],
      tasks: [{ title: 'Inbox idea', phase: 'Discovery' }],
    })
    await page.getByRole('button', { name: 'Add phase' }).click()
    const input = page.getByRole('textbox', { name: 'New phase name' })
    await expect(input).toBeFocused()

    await ime.type(PLAN.text, PLAN.preedit, 'commit')
    await ime.compose('ㄇ')
    await ime.confirmWithEnter('馬', 'process')
    await expect(input).toHaveValue('專案規劃馬')
    expect(await phaseNames(page)).toEqual(['Discovery'])

    await ime.compose('ㄅ')
    await ime.cancelWithEsc('process')
    await expect(input).toHaveValue('專案規劃馬')

    await page.keyboard.press('Enter')
    await expect.poll(() => phaseNames(page)).toEqual(['Discovery', '專案規劃馬'])
    await expect(
      page.getByRole('region', { name: /^專案規劃馬, No tasks$|^專案規劃馬, 0 tasks?$/ }),
    ).toBeVisible()
  })

  test('phase rename: IME Enter / Esc (both orders) neither save nor cancel; Enter saves the committed text', async ({
    page,
  }) => {
    const ime = await openApp(page, `/projects/${PROJECT_ID}/list`, {
      phases: ['Discovery'],
      tasks: [{ title: 'Inbox idea', phase: 'Discovery' }],
    })
    await page.getByRole('button', { name: 'Actions for phase Discovery' }).click()
    await page.getByRole('menuitem', { name: 'Rename phase' }).click()
    const input = page.getByRole('textbox', { name: 'Phase name' })
    await expect(input).toBeFocused()
    await input.press('ControlOrMeta+a')
    await ime.type(TAIPEI.text, TAIPEI.preedit, 'enter')
    await expect(input).toHaveValue('台北')
    expect(await phaseNames(page)).toEqual(['Discovery'])
    await ime.type(HORSE.text, HORSE.preedit, 'safari')
    await expect(input).toHaveValue('台北馬')
    expect(await phaseNames(page)).toEqual(['Discovery'])
    await ime.compose('ㄅ')
    await ime.cancelWithEsc()
    await expect(input).toHaveValue('台北馬')
    await ime.compose('ㄅ')
    await ime.cancelWithEscSafari()
    await expect(input).toHaveValue('台北馬')
    expect(await phaseNames(page)).toEqual(['Discovery'])
    await page.keyboard.press('Enter')
    await expect.poll(() => phaseNames(page)).toEqual(['台北馬'])
  })
})

test.describe('Board: "+ Add task" composer', () => {
  test('IME Enter / Esc are ignored; the next Enter adds one card with the committed text', async ({
    page,
  }) => {
    const ime = await openApp(page, `/projects/${PROJECT_ID}/board`, {
      tasks: [{ title: 'Inbox idea' }],
    })
    await page.getByRole('button', { name: 'Add task to To Do' }).click()
    const input = page.getByRole('textbox', { name: 'New task in To Do' })
    await expect(input).toBeFocused()
    const before = await snapshot(page)

    await ime.type(TAIPEI.text, TAIPEI.preedit, 'enter')
    await expect(input).toHaveValue('台北')
    expect(await snapshot(page)).toBe(before)

    await ime.compose('ㄇ')
    await ime.cancelWithEsc()
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('台北')
    expect(await snapshot(page)).toBe(before)

    await page.keyboard.press('Enter')
    await expect.poll(() => taskTitles(page)).toEqual(['Inbox idea', '台北'])
    await expect(input).toHaveValue('')
    await expect(input).toBeFocused()

    // Safari order, Windows naming ("Process").
    await ime.type(HORSE.text, HORSE.preedit, 'safari')
    await ime.compose('ㄅ')
    await ime.cancelWithEscSafari('process')
    await expect(input).toHaveValue('馬')
    expect(await taskTitles(page)).toEqual(['Inbox idea', '台北'])
    await page.keyboard.press('Enter')
    await expect.poll(() => taskTitles(page)).toEqual(['Inbox idea', '台北', '馬'])

    await page.keyboard.press('Escape')
    await expect(input).toBeHidden()
  })
})

test.describe('Projects page: filter box', () => {
  test('Esc that drops a composition keeps the filter; a plain Esc clears it', async ({ page }) => {
    const ime = await openApp(page, '/projects', { name: '專案規劃', extraProjects: ['Other'] })
    const filter = page.getByRole('searchbox', { name: /^Filter projects/ })
    await filter.click()

    await ime.type('專案', ['ㄓ', 'ㄓㄨㄢ', 'ㄓㄨㄢ ㄢˋ'], 'enter')
    await expect(filter).toHaveValue('專案')
    await expect(page.locator('#main').getByRole('link', { name: /Other/ })).toHaveCount(0)

    // Esc cancelling a new composition must not wipe the committed filter.
    await ime.compose('ㄍ')
    await expect(filter).toHaveValue('專案ㄍ')
    await ime.cancelWithEsc()
    await expect(filter).toHaveValue('專案')
    await expect(filter).toBeFocused()

    // Same in Safari's order.
    await ime.compose('ㄍ')
    await ime.cancelWithEscSafari()
    await expect(filter).toHaveValue('專案')
    await expect(filter).toBeFocused()

    // A plain Esc clears, the next one leaves the box.
    await page.keyboard.press('Escape')
    await expect(filter).toHaveValue('')
    await expect(filter).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(filter).not.toBeFocused()
  })
})

test.describe('Task Modal', () => {
  test('create: title and description keep IME Enter / Esc to themselves; Enter creates once', async ({
    page,
  }) => {
    const ime = await openApp(page, `/projects/${PROJECT_ID}/list`, {
      tasks: [{ title: 'Inbox idea' }],
    })
    await page.keyboard.press('c')
    const dialog = page.getByRole('dialog', { name: 'New task' })
    const title = dialog.getByRole('textbox', { name: 'Task title' })
    await expect(title).toBeFocused()
    const before = await snapshot(page)

    // Title: Enter picks the candidate, no task, no line break.
    await ime.type(TAIPEI.text, TAIPEI.preedit, 'enter')
    await expect(title).toHaveValue('台北')
    expect(await snapshot(page)).toBe(before)
    await expect(dialog).toBeVisible()

    // Esc drops a composition: no close, no "Discard changes?" prompt.
    await ime.compose('ㄇ')
    await ime.cancelWithEsc()
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(title).toHaveValue('台北')
    await ime.compose('ㄇ')
    await ime.cancelWithEscSafari()
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(title).toHaveValue('台北')

    // Description: Enter picks a candidate without adding a line break; a real Enter does.
    const description = dialog.getByRole('textbox', { name: 'Description' })
    await description.click()
    await ime.type(PLAN.text, PLAN.preedit, 'enter')
    await expect(description).toHaveValue('專案規劃')
    await ime.compose('ㄇ')
    await ime.cancelWithEsc()
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(description).toHaveValue('專案規劃')
    await ime.type(HORSE.text, HORSE.preedit, 'safari')
    await expect(description).toHaveValue('專案規劃馬')
    await page.keyboard.press('Enter')
    await expect(description).toHaveValue('專案規劃馬\n')
    expect(await snapshot(page)).toBe(before)

    // Back in the title, the next Enter creates exactly one task.
    await title.click()
    await page.keyboard.press('Enter')
    await expect.poll(() => taskTitles(page)).toEqual(['Inbox idea', '台北'])
    await expect(dialog).toBeHidden()
    const created = Object.values((await stored(page)).tasks).find((t) => t.title === '台北')
    expect(created?.description).toBe('專案規劃馬\n')
  })

  test('edit: title, description and the subtask line', async ({ page }) => {
    const ime = await openApp(page, `/projects/${PROJECT_ID}/list?task=t-0`, {
      tasks: [{ title: 'Inbox idea', description: 'note' }],
    })
    const dialog = page.getByRole('dialog')
    const title = dialog.getByRole('textbox', { name: 'Task title' })
    await expect(title).toHaveValue('Inbox idea')
    const before = await snapshot(page)

    // Replace the title through the IME.
    await title.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    await ime.type('專案', ['ㄓ', 'ㄓㄨㄢ'], 'enter')
    await expect(title).toHaveValue('專案')
    await ime.compose('ㄇ')
    await ime.cancelWithEsc()
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(title).toHaveValue('專案')
    // A real Enter in an edit-mode title only blocks the line break; nothing is saved by it.
    await page.keyboard.press('Enter')
    await expect(title).toHaveValue('專案')
    expect(await snapshot(page)).toBe(before)

    // Subtask line: IME Enter does not add; the next Enter adds one subtask with the exact text.
    const subtask = dialog.getByRole('textbox', { name: 'Add subtask' })
    await subtask.click()
    await ime.type(TAIPEI.text, TAIPEI.preedit, 'enter')
    await expect(subtask).toHaveValue('台北')
    expect(await subtaskTitles(page)).toEqual([])
    await ime.compose('ㄇ')
    await ime.cancelWithEsc()
    await expect(dialog).toBeVisible()
    await expect(subtask).toHaveValue('台北')
    await page.keyboard.press('Enter')
    await expect.poll(() => subtaskTitles(page)).toEqual(['台北'])
    await expect(subtask).toHaveValue('')
    await ime.type(HORSE.text, HORSE.preedit, 'safari')
    await expect(subtask).toHaveValue('馬')
    expect(await subtaskTitles(page)).toEqual(['台北'])
    await page.keyboard.press('Enter')
    await expect.poll(() => subtaskTitles(page)).toEqual(['台北', '馬'])

    // Save: ⌘/Ctrl+Enter, the title is exactly what was committed.
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(dialog).toBeHidden()
    expect((await stored(page)).tasks['t-0'].title).toBe('專案')
  })
})

// ---------------------------------------------------------------------------
// Dialogs built on a <form>: implicit submission, Esc handled by the dialog
// ---------------------------------------------------------------------------

/**
 * The contract of one text field inside a dialog, in Chrome's and Safari's order. `submitted()`
 * tells how often the dialog's form was saved so far; `closed()` that the dialog is gone.
 */
async function dialogFieldContract(
  page: Page,
  ime: Ime,
  field: Locator,
  dialog: Locator,
  stored: () => Promise<string[]>,
  expected: string,
): Promise<void> {
  await field.click()
  const before = await snapshot(page)

  // Enter that picks the candidate (Chrome order) neither submits nor closes.
  await ime.type(TAIPEI.text, TAIPEI.preedit, 'enter')
  await expect(field).toHaveValue('台北')
  await expect(dialog).toBeVisible()
  expect(await snapshot(page)).toBe(before)

  // Esc that drops a composition (Chrome order, then Windows' "Process") keeps the dialog + text.
  await ime.compose('ㄇ')
  await ime.cancelWithEsc()
  await expect(dialog).toBeVisible()
  await expect(field).toHaveValue('台北')
  await ime.compose('ㄇ')
  await ime.cancelWithEsc('process')
  await expect(dialog).toBeVisible()
  await expect(field).toHaveValue('台北')

  // Safari's order: compositionend first, then Enter / Esc as keyCode 229 with isComposing false.
  await ime.type(HORSE.text, HORSE.preedit, 'safari')
  await expect(field).toHaveValue('台北馬')
  await ime.compose('ㄅ')
  await ime.cancelWithEscSafari()
  await expect(dialog).toBeVisible()
  await expect(field).toHaveValue('台北馬')
  expect(await snapshot(page)).toBe(before)
  expect(await stored()).toEqual([])

  // The user's own Enter submits once with exactly the committed text.
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  expect(await stored()).toEqual([expected])
}

test.describe('Dialogs with a form', () => {
  test('Project dialog: name field', async ({ page }) => {
    const ime = await openApp(page, '/projects', { name: 'Existing' })
    await page.getByRole('button', { name: 'New project' }).first().click()
    const dialog = page.getByRole('dialog')
    const name = dialog.getByRole('textbox', { name: 'Name' })
    await expect(name).toBeFocused()
    await dialogFieldContract(
      page,
      ime,
      name,
      dialog,
      async () =>
        Object.values((await stored(page)).projects)
          .map((p) => p.name)
          .filter((n) => n !== 'Existing'),
      '台北馬',
    )
  })

  test('Phase dialog: name field', async ({ page }) => {
    const ime = await openApp(page, `/projects/${PROJECT_ID}/list`, { tasks: [{ title: 'x' }] })
    await page.getByRole('button', { name: 'Project actions' }).click()
    await page.getByRole('menuitem', { name: /Add phase/ }).click()
    const dialog = page.getByRole('dialog')
    const name = dialog.getByRole('textbox', { name: 'Name' })
    await expect(name).toBeFocused()
    await dialogFieldContract(page, ime, name, dialog, () => phaseNames(page), '台北馬')
  })

  test('Milestone dialog: name field', async ({ page }) => {
    const ime = await openApp(page, `/projects/${PROJECT_ID}/list`, { tasks: [{ title: 'x' }] })
    await page.getByRole('button', { name: 'Project actions' }).click()
    await page.getByRole('menuitem', { name: /Add milestone/ }).click()
    const dialog = page.getByRole('dialog')
    const name = dialog.getByRole('textbox', { name: 'Name' })
    await expect(name).toBeFocused()
    // A milestone needs a date to be saved: pick it after the IME steps, before the last Enter.
    await name.click()
    const before = await snapshot(page)
    await ime.type(TAIPEI.text, TAIPEI.preedit, 'enter')
    await expect(name).toHaveValue('台北')
    await expect(dialog).toBeVisible()
    await ime.compose('ㄇ')
    await ime.cancelWithEsc()
    await expect(dialog).toBeVisible()
    await ime.compose('ㄇ')
    await ime.cancelWithEscSafari()
    await expect(dialog).toBeVisible()
    await expect(name).toHaveValue('台北')
    expect(await snapshot(page)).toBe(before)
    expect(Object.keys((await stored(page)).milestones)).toEqual([])
  })
})

test.describe('Search overlay and time-zone picker', () => {
  test('Search overlay: Enter / Esc during composition; partial and full-width text finds the task', async ({
    page,
  }) => {
    const ime = await openApp(page, `/projects/${PROJECT_ID}/list`, {
      tasks: [{ title: '專案規劃 Roadmap' }, { title: 'Other thing' }],
    })
    await expect(page.getByText('專案規劃 Roadmap')).toBeVisible()
    // The app's own rule for `mod`: userAgentData.platform first, then navigator.platform.
    const mod = await page.evaluate(() => {
      const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
      const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent
      return /mac|iphone|ipad|ipod/i.test(platform) ? 'Meta' : 'Control'
    })
    await page.keyboard.press(`${mod}+k`)
    const input = page.getByPlaceholder('Search projects, tasks and milestones…')
    await expect(input).toBeFocused()
    await ime.type('專案', ['ㄓ', 'ㄓㄨㄢ', 'ㄓㄨㄢ ㄢˋ'], 'enter')
    await expect(input).toHaveValue('專案')
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page).toHaveURL(/\/list$/)
    await ime.compose('ㄍ')
    await ime.cancelWithEsc()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(input).toHaveValue('專案')
    await ime.compose('ㄍ')
    await ime.cancelWithEscSafari()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(input).toHaveValue('專案')
    await expect(page.getByRole('option', { name: /專案規劃 Roadmap/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /Other thing/ })).toHaveCount(0)

    // Full-width Latin and a partial CJK term find the same task (NFKC).
    await input.fill('ＲＯＡＤＭＡＰ')
    await expect(page.getByRole('option', { name: /專案規劃 Roadmap/ })).toBeVisible()
    await input.fill('規劃')
    await expect(page.getByRole('option', { name: /專案規劃 Roadmap/ })).toBeVisible()

    // Esc without a composition closes.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('Time-zone picker: Esc that drops a composition keeps the list open', async ({ page }) => {
    const ime = await openApp(page, '/settings', {})
    await page.getByRole('link', { name: 'Appearance' }).click()
    await page.getByRole('combobox', { name: /^Time zone:/ }).click()
    const input = page.getByPlaceholder('Search time zones…')
    await expect(input).toBeFocused()
    await ime.type('台北', ['ㄊ', 'ㄊㄞˊ', 'ㄊㄞˊㄅㄟˇ'], 'enter')
    await expect(input).toHaveValue('台北')
    await expect(input).toBeVisible()
    // A closing popover is still visible while it fades out: only its state tells them apart.
    const picker = page.locator('[data-slot="popover-content"]')
    await ime.compose('ㄇ')
    await ime.cancelWithEsc()
    await expect(picker).toHaveAttribute('data-state', 'open')
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('台北')
    await ime.compose('ㄇ')
    await ime.cancelWithEscSafari()
    await expect(picker).toHaveAttribute('data-state', 'open')
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('台北')
    await page.keyboard.press('Escape')
    await expect(input).toBeHidden()
  })
})

// ---------------------------------------------------------------------------
// CJK and emoji in titles: long unbroken text truncates, never overflows the page
// ---------------------------------------------------------------------------

const LONG_CJK = '專案規劃與研究計畫書'.repeat(20) // 200 characters, no break opportunity
const LONG_EMOJI = '😀'.repeat(200)

test.describe('Long unbroken CJK and emoji text', () => {
  const tasks = [
    { title: LONG_CJK, start: '2026-11-02', due: '2026-11-20' },
    { title: LONG_EMOJI, start: '2026-11-04', due: '2026-11-10' },
  ]

  async function expectNoOverflow(page: Page): Promise<void> {
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }))
    expect(overflow.page, 'page scrolls sideways').toBeLessThanOrEqual(0)
    expect(overflow.body, 'body scrolls sideways').toBeLessThanOrEqual(0)
  }

  /** The element that shows `needle` stays inside the viewport. */
  async function expectInside(page: Page, needle: string): Promise<void> {
    const locator = page.getByText(needle, { exact: false }).first()
    await expect(locator).toBeVisible()
    const box = await locator.boundingBox()
    const width = page.viewportSize()?.width ?? 1280
    expect(box, needle).not.toBeNull()
    expect(box!.x + box!.width, `${needle.slice(0, 4)}… right edge`).toBeLessThanOrEqual(width)
  }

  const routes = [
    `/projects/${PROJECT_ID}/list`,
    `/projects/${PROJECT_ID}/board`,
    `/projects/${PROJECT_ID}/gantt`,
    '/overview',
    '/my-tasks',
    '/timeline',
    '/projects',
  ]

  for (const route of routes) {
    test(`${route}: no sideways scroll, text stays inside`, async ({ page }) => {
      await openApp(page, route, { name: LONG_CJK, tasks })
      await page.waitForLoadState('networkidle')
      await expectNoOverflow(page)
      await expectInside(page, '專案規劃與研究')
    })
  }

  test('task modal and search overlay hold the long titles', async ({ page }) => {
    await openApp(page, `/projects/${PROJECT_ID}/list`, { tasks })
    await page.getByText('專案規劃與研究').first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expectNoOverflow(page)
    const box = await dialog.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    const mod = await page.evaluate(() => {
      const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
      return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || '')
        ? 'Meta'
        : 'Control'
    })
    await page.keyboard.press(`${mod}+k`)
    await page.getByPlaceholder('Search projects, tasks and milestones…').fill('研究計畫')
    await expect(page.getByRole('option').first()).toBeVisible()
    await expectNoOverflow(page)
    const option = await page.getByRole('option').first().boundingBox()
    expect(option!.x + option!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  })
})

test.describe('Emoji at the length limits', () => {
  test('200 emoji are a valid project name, 201 are refused (code points, not UTF-16 units)', async ({
    page,
  }) => {
    await openApp(page, '/projects', { name: 'Existing' })
    await page.getByRole('button', { name: 'New project' }).first().click()
    const dialog = page.getByRole('dialog')
    const name = dialog.getByRole('textbox', { name: 'Name' })
    await name.fill('😀'.repeat(201))
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/200/)).toBeVisible()
    await name.fill('😀'.repeat(200))
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    const names = Object.values((await stored(page)).projects).map((p) => p.name)
    expect(names).toContain('😀'.repeat(200))
  })
})
