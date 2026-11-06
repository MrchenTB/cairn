/// <reference lib="dom" />
/**
 * Task Modal autosave in a real browser (LOCAL data mode; cloud mode is in
 * e2e-cloud/autosave.spec.ts). What only a real browser can show: real input-method composition
 * through CDP, real focus and blur, reloads with sessionStorage, and every view showing the result.
 */
import { expect, test as base, type Locator, type Page } from '@playwright/test'
import { Ime } from './ime.helpers.ts'

const LOCAL_WORKSPACE_KEY = 'cairn:local:workspace:v1'
const DRAFTS_KEY = 'cairn:task-drafts:v1'
const NOW = '2026-11-03T08:00:00.000Z'
const TIME_ZONE = 'Asia/Taipei'

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

const ID = {
  research: 'p-research',
  launch: 'p-launch',
  writing: 'ph-writing',
  review: 't-review',
  draft: 't-draft',
  plain: 't-plain',
  announce: 't-announce',
  legal: 't-legal',
} as const

function isoDay(offset = 0): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date())
  const [year, month, day] = today.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10)
}

function seedWorkspace() {
  let order = 0
  const task = (input: Record<string, unknown>) => ({
    phaseId: null,
    parentTaskId: null,
    description: null,
    priority: 'none',
    startDate: null,
    dueDate: null,
    status: 'todo',
    sortOrder: `a${String(order++).padStart(2, '0')}`,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  })
  const project = (id: string, name: string, scheduleMode: string, sortOrder: string) => ({
    id,
    name,
    description: null,
    status: 'active',
    color: 'violet',
    startDate: null,
    dueDate: null,
    scheduleMode,
    sortOrder,
    createdAt: NOW,
    updatedAt: NOW,
  })
  return {
    version: 1,
    projects: {
      [ID.research]: project(ID.research, 'Research', 'manual', 'a0'),
      [ID.launch]: project(ID.launch, 'Launch plan', 'auto', 'a1'),
    },
    phases: {
      [ID.writing]: {
        id: ID.writing,
        projectId: ID.research,
        name: 'Writing',
        sortOrder: 'a0',
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    tasks: {
      [ID.review]: task({
        id: ID.review,
        projectId: ID.research,
        phaseId: ID.writing,
        title: 'Write literature review',
        startDate: isoDay(1),
        dueDate: isoDay(5),
      }),
      [ID.draft]: task({
        id: ID.draft,
        projectId: ID.research,
        phaseId: ID.writing,
        parentTaskId: ID.review,
        title: 'Draft related work',
      }),
      [ID.plain]: task({ id: ID.plain, projectId: ID.research, title: 'Plain task' }),
      [ID.announce]: task({
        id: ID.announce,
        projectId: ID.launch,
        title: 'Draft announcement',
        startDate: isoDay(0),
        dueDate: isoDay(2),
      }),
      [ID.legal]: task({
        id: ID.legal,
        projectId: ID.launch,
        title: 'Review with legal',
        startDate: isoDay(3),
        dueDate: isoDay(5),
      }),
    },
    milestones: {},
    dependencies: {
      'd-1': {
        id: 'd-1',
        projectId: ID.launch,
        predecessorId: ID.announce,
        successorId: ID.legal,
        type: 'FS',
        createdAt: NOW,
      },
    },
    preferences: { theme: 'system', sidebarCollapsed: false, timezone: TIME_ZONE, weekStartsOn: 1 },
  }
}

async function openApp(page: Page, route: string): Promise<Ime> {
  await page.addInitScript(
    ({ key, db }) => {
      if (sessionStorage.getItem('cairn-e2e-autosave-seeded')) return
      localStorage.setItem(key, JSON.stringify(db))
      sessionStorage.setItem('cairn-e2e-autosave-seeded', '1')
    },
    { key: LOCAL_WORKSPACE_KEY, db: seedWorkspace() },
  )
  await page.goto(route)
  return Ime.attach(page)
}

interface StoredTask {
  title: string
  description: string | null
  status: string
  priority: string
  phaseId: string | null
  startDate: string | null
  dueDate: string | null
}

async function stored(page: Page, id: string): Promise<StoredTask> {
  const db = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? 'null'),
    LOCAL_WORKSPACE_KEY,
  )
  return db.tasks[id]
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

/** Counts writes of the local database from now on (how often it was really saved). */
async function countWrites(page: Page): Promise<() => Promise<number>> {
  await page.evaluate((key) => {
    const counter = window as Window & { __writes?: number }
    counter.__writes = 0
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (name: string, value: string) {
      if (this === localStorage && name === key) counter.__writes = (counter.__writes ?? 0) + 1
      original.call(this, name, value)
    }
  }, LOCAL_WORKSPACE_KEY)
  return () => page.evaluate(() => (window as Window & { __writes?: number }).__writes ?? 0)
}

const modal = (page: Page) => page.getByRole('dialog', { name: /^Edit task:/ })
const titleBox = (page: Page) => modal(page).getByRole('textbox', { name: 'Task title' })
const descriptionBox = (page: Page) => modal(page).getByRole('textbox', { name: 'Description' })
const doneButton = (page: Page) => modal(page).getByRole('button', { name: 'Done', exact: true })
const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })
const footerState = (page: Page) => modal(page).locator('[data-save-state]')

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

async function pickDate(page: Page, scope: Locator, field: string, date: string) {
  await scope.getByRole('button', { name: new RegExp(`^${field}:`) }).click()
  const picker = page.getByRole('dialog', { name: field, exact: true })
  const day = picker.getByRole('button', { name: dayPattern(date) })
  for (let step = 0; step < 4 && (await day.count()) === 0; step++) {
    await picker.getByRole('button', { name: 'Go to the Next Month' }).click()
  }
  await day.click()
  await expect(picker).toBeHidden()
}

/** Reloads, accepting the browser's "Leave site?" prompt. */
async function reloadAccepting(page: Page): Promise<void> {
  const accept = (dialog: { accept(): Promise<void> }) => void dialog.accept()
  page.on('dialog', accept)
  await page.reload()
  page.off('dialog', accept)
}

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } })

test.describe('text fields', () => {
  test('1. Enter saves the title and stays in the field', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await expect(titleBox(page)).toBeFocused()
    await titleBox(page).press('End')
    await page.keyboard.type(' (reviewed)')
    expect((await stored(page, ID.plain)).title).toBe('Plain task')

    await page.keyboard.press('Enter')
    await expect
      .poll(async () => (await stored(page, ID.plain)).title)
      .toBe('Plain task (reviewed)')
    await expect(titleBox(page)).toBeFocused()
    await expect(titleBox(page)).toHaveValue('Plain task (reviewed)')
  })

  test('2. a description typed and closed straight away is saved', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await descriptionBox(page).click()
    await page.keyboard.type('Ask the office about it')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect
      .poll(async () => (await stored(page, ID.plain)).description)
      .toBe('Ask the office about it')
    await page.reload()
    expect((await stored(page, ID.plain)).description).toBe('Ask the office about it')
  })

  test('a description is one write however long it was typed, after a pause', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await descriptionBox(page).click()
    const writes = await countWrites(page)
    await page.keyboard.type('twenty characters ok', { delay: 30 })
    expect(await writes()).toBe(0)
    await expect(footerState(page)).toHaveAttribute('data-save-state', 'pending', {
      timeout: 2500,
    })
    await expect
      .poll(async () => (await stored(page, ID.plain)).description, { timeout: 4000 })
      .toBe('twenty characters ok')
    expect(await writes()).toBe(1)
    await expect(footerState(page)).toHaveText('Saved')
    await expect(footerState(page)).toHaveAttribute('data-save-state', 'idle', { timeout: 3000 })
    await expect(descriptionBox(page)).toBeFocused()
  })

  test('an empty title goes back to the stored one on blur', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await titleBox(page).fill('')
    await expect(modal(page).getByRole('alert')).toHaveText('Task title is required.')
    await descriptionBox(page).click()
    await expect(titleBox(page)).toHaveValue('Plain task')
    await expect(modal(page)).toContainText('A task needs a title, so “Plain task” was kept.')
    expect((await stored(page, ID.plain)).title).toBe('Plain task')
  })
})

test.describe('IME', () => {
  test('3. Zhuyin in the title: nothing saved before the candidate; Enter then saves', async ({
    page,
  }) => {
    const ime = await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await titleBox(page).click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    const writes = await countWrites(page)

    await ime.compose('ㄓ')
    await ime.compose('ㄓㄨㄢ')
    await expect(titleBox(page)).toHaveValue('ㄓㄨㄢ')
    await ime.confirmWithEnter('專')
    await expect(titleBox(page)).toHaveValue('專')
    await ime.compose('ㄢˋ')
    await ime.confirmWithEnter('案')
    await expect(titleBox(page)).toHaveValue('專案')
    // The Enters belonged to the input method.
    expect(await writes()).toBe(0)

    await page.keyboard.press('Enter')
    await expect.poll(async () => (await stored(page, ID.plain)).title).toBe('專案')
    expect(await writes()).toBe(1)
    await expect(titleBox(page)).toHaveValue('專案')
  })

  test('Safari’s order: the Enter after compositionend still is not a save', async ({ page }) => {
    const ime = await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await titleBox(page).click()
    await page.keyboard.press('End')
    const writes = await countWrites(page)
    await ime.compose('ㄇㄚˇ')
    await ime.confirmWithEnterSafari('馬')
    await expect(titleBox(page)).toHaveValue('Plain task馬')
    expect(await writes()).toBe(0)
  })

  test('3. Zhuyin in the description: the wait never fires on pre-edit text', async ({ page }) => {
    const ime = await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await descriptionBox(page).click()
    const writes = await countWrites(page)
    await ime.compose('ㄓㄨ')
    await expect(descriptionBox(page)).toHaveValue('ㄓㄨ')
    // Well past the debounce: still composing, so still nothing.
    await page.waitForTimeout(2600)
    expect(await writes()).toBe(0)
    expect((await stored(page, ID.plain)).description).toBeNull()
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key) ?? '', DRAFTS_KEY),
    ).not.toContain('ㄓ')

    await ime.commit('專')
    await expect(descriptionBox(page)).toHaveValue('專')
    await expect
      .poll(async () => (await stored(page, ID.plain)).description, { timeout: 4000 })
      .toBe('專')
    expect(await writes()).toBe(1)
  })

  test('4. Japanese: a growing pre-edit, a conversion, then the saved text', async ({ page }) => {
    const ime = await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await descriptionBox(page).click()
    const writes = await countWrites(page)
    for (const step of ['か', 'かん', 'かんじ', '感じ', '漢字']) await ime.compose(step)
    await expect(descriptionBox(page)).toHaveValue('漢字')
    await ime.handle('ArrowDown')
    await ime.release('ArrowDown')
    await ime.confirmWithEnter('漢字')
    await ime.compose('に')
    await ime.commit('に')
    await expect(descriptionBox(page)).toHaveValue('漢字に')
    expect(await writes()).toBe(0)
    await titleBox(page).click()
    await expect.poll(async () => (await stored(page, ID.plain)).description).toBe('漢字に')
    expect(await writes()).toBe(1)
  })

  test('Esc cancelling a composition keeps the modal and the earlier text, and saves nothing', async ({
    page,
  }) => {
    const ime = await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await descriptionBox(page).click()
    await page.keyboard.type('note')
    await ime.compose('ㄇ')
    await ime.cancelWithEsc()
    await expect(modal(page)).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(descriptionBox(page)).toHaveValue('note')
    await ime.compose('ㄇ')
    await ime.cancelWithEscSafari()
    await expect(modal(page)).toBeVisible()
    await expect(descriptionBox(page)).toHaveValue('note')
  })

  test('leaving during a composition never stores the pre-edit string', async ({ page }) => {
    const ime = await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await titleBox(page).click()
    await page.keyboard.press('End')
    const writes = await countWrites(page)
    await ime.compose('ㄇㄚˇ')
    await descriptionBox(page).click()
    await expect(descriptionBox(page)).toBeFocused()

    // Chromium ends the composition and leaves the pre-edit string as text: not a confirmed choice.
    await expect(modal(page)).toContainText('interrupted before you confirmed it')
    await expect(titleBox(page)).toHaveValue('Plain taskㄇㄚˇ')
    expect(await writes()).toBe(0)
    expect((await stored(page, ID.plain)).title).toBe('Plain task')

    // Closing doesn't skip over it.
    await doneButton(page).click()
    await expect(modal(page)).toContainText('Save or discard the interrupted text first.')
    await modal(page).getByRole('button', { name: 'Discard: title' }).click()
    await expect(titleBox(page)).toHaveValue('Plain task')
    await doneButton(page).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect((await stored(page, ID.plain)).title).toBe('Plain task')
    expect(await writes()).toBe(0)
  })

  test('clicking Done during a composition: same rule, and Save keeps the text if wanted', async ({
    page,
  }) => {
    const ime = await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await descriptionBox(page).click()
    await ime.compose('かんじ')
    // The press ends the composition; the note it brings moves the footer, so this click may land
    // elsewhere. Either way the modal stays and says why.
    await doneButton(page).click()
    await expect(modal(page)).toContainText('interrupted before you confirmed it')
    await doneButton(page).click()
    await expect(modal(page)).toContainText('Save or discard the interrupted text first.')
    expect((await stored(page, ID.plain)).description).toBeNull()

    await modal(page).getByRole('button', { name: 'Save: description' }).click()
    await expect.poll(async () => (await stored(page, ID.plain)).description).toBe('かんじ')
    await doneButton(page).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('no caret jump or duplicated text while an answer arrives mid-typing', async ({ page }) => {
    const ime = await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await setLatency(page, 400)
    await descriptionBox(page).click()
    await page.keyboard.type('abc')
    await titleBox(page).click() // saved, slowly
    await descriptionBox(page).click()
    await page.keyboard.press('End')
    await ime.compose('ㄊ')
    // The answer to "abc" lands during the composition.
    await page.waitForTimeout(600)
    await expect(descriptionBox(page)).toHaveValue('abcㄊ')
    await ime.commit('台')
    await page.keyboard.type('!')
    await expect(descriptionBox(page)).toHaveValue('abc台!')
    await setLatency(page, 0)
    await page.keyboard.press('Escape')
    await expect
      .poll(async () => (await stored(page, ID.plain)).description, { timeout: 4000 })
      .toBe('abc台!')
  })
})

test.describe('several fields, slow network, failure', () => {
  test('5. fast changes of many fields all arrive', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.review}`)
    await titleBox(page).press('End')
    await page.keyboard.type(' v2')
    await modal(page)
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: /In Progress/ }).click()
    await modal(page)
      .getByRole('button', { name: /^Priority:/ })
      .click()
    await page.getByRole('menuitemradio', { name: /Urgent/ }).click()
    await pickDate(page, modal(page), 'Due date', isoDay(7))
    await descriptionBox(page).fill('Notes')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect
      .poll(async () => stored(page, ID.review))
      .toMatchObject({
        title: 'Write literature review v2',
        description: 'Notes',
        status: 'in_progress',
        priority: 'urgent',
        startDate: isoDay(1),
        dueDate: isoDay(7),
      })
  })

  test('6. slow network: Saving… shows, typing is not disturbed, the newest text wins', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await setLatency(page, 2500)
    const writes = await countWrites(page)
    await descriptionBox(page).click()
    await page.keyboard.type('first')
    await titleBox(page).click()
    await expect(footerState(page)).toHaveText('Saving…')
    // Three more commits while the first is in flight: one follow-up write, the newest text.
    for (const text of ['second', 'third', 'fourth']) {
      await descriptionBox(page).fill(text)
      await titleBox(page).click()
    }
    await expect(descriptionBox(page)).toHaveValue('fourth')
    await expect
      .poll(async () => (await stored(page, ID.plain)).description, { timeout: 10_000 })
      .toBe('fourth')
    await expect(footerState(page)).toHaveText('Saved', { timeout: 3000 })
    expect(await writes()).toBe(2)
    await expect(descriptionBox(page)).toHaveValue('fourth')
  })

  test('7. a failed write: the text stays, the message names task and field, Retry stores it', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await titleBox(page).fill('Plain task, edited')
    await failNextWrites(page)
    await page.keyboard.press('Enter')

    const failure = toast(page, /Couldn.t save the title of “Plain task”/)
    await expect(failure).toBeVisible()
    await expect(failure.getByRole('button', { name: 'Retry' })).toBeVisible()
    await expect(failure.getByRole('button', { name: 'Open' })).toBeVisible()
    await expect(titleBox(page)).toHaveValue('Plain task, edited')
    await expect(modal(page)).toContainText('Your text is kept here.')
    await expect(footerState(page)).toContainText('Couldn’t save title')
    expect((await stored(page, ID.plain)).title).toBe('Plain task')
    await expect(page.locator('[data-sync="failed"]')).toBeVisible()

    await footerState(page).getByRole('button', { name: 'Retry' }).click()
    await expect.poll(async () => (await stored(page, ID.plain)).title).toBe('Plain task, edited')
    await expect(modal(page)).not.toContainText('Your text is kept here.')
    await expect(footerState(page)).not.toContainText('Couldn’t save')
  })

  test('7. the toast’s Retry works too, and a newer edit withdraws it', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await descriptionBox(page).fill('old attempt')
    await failNextWrites(page)
    await titleBox(page).click()
    const failure = toast(page, /Couldn.t save the description/)
    await expect(failure).toBeVisible()

    // A newer edit: the old Retry goes away instead of putting the older text back.
    await descriptionBox(page).fill('newer text')
    await expect(failure).toHaveCount(0)
    await titleBox(page).click()
    await expect.poll(async () => (await stored(page, ID.plain)).description).toBe('newer text')

    await descriptionBox(page).fill('fails again')
    await failNextWrites(page)
    await titleBox(page).click()
    await toast(page, /Couldn.t save the description/)
      .getByRole('button', { name: 'Retry' })
      .click()
    await expect.poll(async () => (await stored(page, ID.plain)).description).toBe('fails again')
    await expect(modal(page)).not.toContainText('Your text is kept here.')
  })

  test('8. closing during a slow save does not wait; a late failure can be found again', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list`)
    await page.getByRole('button', { name: 'Plain task', exact: true }).click()
    await expect(titleBox(page)).toBeFocused()
    await setLatency(page, 1500)
    await failNextWrites(page)
    await titleBox(page).fill('Plain task v2')

    const before = Date.now()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(Date.now() - before).toBeLessThan(1200)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)

    const failure = toast(page, /Couldn.t save the title of “Plain task/)
    await expect(failure).toBeVisible({ timeout: 4000 })
    await setLatency(page, 0)
    expect((await stored(page, ID.plain)).title).toBe('Plain task')

    // The toast's Open brings the task back with the text.
    await failure.getByRole('button', { name: 'Open' }).click()
    await expect(titleBox(page)).toHaveValue('Plain task v2')
    await expect(modal(page)).toContainText('Your text is kept here.')
    await footerState(page).getByRole('button', { name: 'Retry' }).click()
    await expect.poll(async () => (await stored(page, ID.plain)).title).toBe('Plain task v2')
  })

  test('8. after the toast is gone the sidebar still lists the text', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await failNextWrites(page)
    await descriptionBox(page).fill('Do not lose this')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(toast(page, /Couldn.t save/)).toBeVisible()
    // Dismissing the toast leaves the sidebar's Retry and the draft list.
    await page.getByRole('button', { name: /^Sync status:/ }).click()
    const row = page.getByRole('listitem').filter({ hasText: 'Plain task · description' })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: /^Open/ }).click()
    await expect(descriptionBox(page)).toHaveValue('Do not lose this')
  })

  test('9. a reload recovers failed text; nothing is written until the user decides', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await failNextWrites(page)
    await descriptionBox(page).fill('Survives the reload')
    await titleBox(page).click()
    await expect(modal(page)).toContainText('Your text is kept here.')

    await reloadAccepting(page)
    await expect(descriptionBox(page)).toHaveValue('Survives the reload')
    await expect(modal(page)).toContainText('Recovered text that wasn’t saved.')
    await expect(toast(page, 'Unsaved text recovered')).toBeVisible()
    expect((await stored(page, ID.plain)).description).toBeNull()

    await modal(page).getByRole('button', { name: 'Save: description' }).click()
    await expect
      .poll(async () => (await stored(page, ID.plain)).description)
      .toBe('Survives the reload')
    await expect(modal(page)).not.toContainText('Recovered text')
    await expect
      .poll(() => page.evaluate((key) => sessionStorage.getItem(key), DRAFTS_KEY))
      .toBeNull()

    // Nothing left to recover: the next reload is silent.
    await page.reload()
    await expect(descriptionBox(page)).toHaveValue('Survives the reload')
    await expect(modal(page)).not.toContainText('Recovered text')
  })

  test('9. text still waiting for its pause is saved as the page goes away', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await descriptionBox(page).click()
    await page.keyboard.type('still typing')
    expect((await stored(page, ID.plain)).description).toBeNull()
    await reloadAccepting(page)
    await expect(descriptionBox(page)).toHaveValue('still typing')
    await expect(modal(page)).not.toContainText('Recovered text')
    expect((await stored(page, ID.plain)).description).toBe('still typing')
  })

  test('9. recovered text can be discarded for good', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await failNextWrites(page)
    await descriptionBox(page).fill('Changed my mind')
    await titleBox(page).click()
    await expect(modal(page)).toContainText('Your text is kept here.')
    await reloadAccepting(page)
    await modal(page).getByRole('button', { name: 'Discard: description' }).click()
    await expect(descriptionBox(page)).toHaveValue('')
    expect((await stored(page, ID.plain)).description).toBeNull()
    await page.reload()
    await expect(descriptionBox(page)).toHaveValue('')
    await expect(modal(page)).not.toContainText('Recovered text')
  })

  test('a reload with newer data never shows the old text over it', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await failNextWrites(page)
    await descriptionBox(page).fill('old text')
    await titleBox(page).click()
    await expect(modal(page)).toContainText('Your text is kept here.')
    // Another tab of this browser changes the same field in the stored data.
    await page.evaluate(
      ([key, id]) => {
        const db = JSON.parse(localStorage.getItem(key) ?? '{}')
        db.tasks[id].description = 'changed elsewhere'
        localStorage.setItem(key, JSON.stringify(db))
      },
      [LOCAL_WORKSPACE_KEY, ID.plain],
    )
    await reloadAccepting(page)
    await expect(descriptionBox(page)).toHaveValue('changed elsewhere')
    await expect(modal(page)).toContainText('unsaved text from earlier')
    await modal(page).getByRole('button', { name: 'Show my text: description' }).click()
    await expect(descriptionBox(page)).toHaveValue('old text')
    expect((await stored(page, ID.plain)).description).toBe('changed elsewhere')
  })
})

test.describe('dates and auto schedule', () => {
  test('11 + 12. a change that moves others previews; Cancel puts the stored date back', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.launch}/list?task=${ID.announce}`)
    const due = modal(page).getByRole('button', { name: /^Due date:/ })
    await pickDate(page, modal(page), 'Due date', isoDay(6)) // Review with legal starts on day +3

    const preview = page.getByRole('dialog', { name: 'Move dependent tasks?' })
    await expect(preview).toBeVisible()
    await preview.getByRole('button', { name: 'Cancel' }).click()
    await expect(preview).toBeHidden()

    await expect(modal(page)).toContainText('Dates not changed.')
    expect(await stored(page, ID.announce)).toMatchObject({ dueDate: isoDay(2) })
    await expect(due).toHaveAttribute('aria-label', /Due date:/)
    const shown = await due.getAttribute('title')
    await pickDate(page, modal(page), 'Due date', isoDay(6))
    await expect(preview).toBeVisible()
    await preview.getByRole('button', { name: /^Apply/ }).click()
    await expect(preview).toBeHidden()
    await expect.poll(async () => (await stored(page, ID.announce)).dueDate).toBe(isoDay(6))
    expect((await stored(page, ID.legal)).startDate! > isoDay(6)).toBe(true)
    await expect(modal(page)).not.toContainText('Dates not changed.')
    expect(await due.getAttribute('title')).not.toBe(shown)
    await expect(modal(page)).toBeVisible()
  })

  test('the date Undo restores a whole Apply, shifted tasks included', async ({ page }) => {
    await openApp(page, `/projects/${ID.launch}/list?task=${ID.announce}`)
    await pickDate(page, modal(page), 'Due date', isoDay(6))
    await page
      .getByRole('dialog', { name: 'Move dependent tasks?' })
      .getByRole('button', { name: /^Apply/ })
      .click()
    await expect.poll(async () => (await stored(page, ID.announce)).dueDate).toBe(isoDay(6))
    const movedTo = (await stored(page, ID.legal)).startDate
    expect(movedTo).not.toBe(isoDay(3))

    await toast(page, /^Updated/)
      .getByRole('button', { name: 'Undo' })
      .click()
    await expect.poll(async () => (await stored(page, ID.announce)).dueDate).toBe(isoDay(2))
    expect((await stored(page, ID.legal)).startDate).toBe(isoDay(3))
  })

  test('the start can’t pass the due date in the picker', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.review}`)
    await modal(page)
      .getByRole('button', { name: /^Start date:/ })
      .click()
    const picker = page.getByRole('dialog', { name: 'Start date', exact: true })
    await expect(picker.getByRole('button', { name: dayPattern(isoDay(5)) })).toBeEnabled()
    await expect(picker.getByText('The start can’t be after the due date.')).toBeVisible()
    if (isoDay(6).slice(0, 7) === isoDay(5).slice(0, 7)) {
      await expect(picker.getByRole('button', { name: dayPattern(isoDay(6)) })).toBeDisabled()
    }
  })
})

test.describe('closing', () => {
  test('13. back from a subtask lands on its parent; a second close leaves the page', async ({
    page,
  }) => {
    await openApp(page, `/projects/${ID.research}/list`)
    await page
      .locator(`[data-task-row="${ID.review}"]`)
      .getByRole('button', { name: /^Write literature review/ })
      .click()
    await expect(titleBox(page)).toHaveValue('Write literature review')
    await page
      .getByRole('region', { name: 'Subtasks' })
      .getByRole('button', { name: 'Draft related work', exact: true })
      .click()
    await expect(titleBox(page)).toHaveValue('Draft related work')
    await page.keyboard.type(' v2')

    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(new RegExp(`task=${ID.review}`))
    await expect(titleBox(page)).toHaveValue('Write literature review')
    await expect
      .poll(async () => (await stored(page, ID.draft)).title)
      .toBe('Draft related work v2')

    await doneButton(page).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page).not.toHaveURL(/task=/)
  })

  test('Done, X and a click outside all keep the edit, without asking', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list`)
    const opener = page.getByRole('button', { name: 'Plain task', exact: true })

    await opener.click()
    await titleBox(page).press('End')
    await page.keyboard.type('!')
    await doneButton(page).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(async () => (await stored(page, ID.plain)).title).toBe('Plain task!')

    await page.getByRole('button', { name: 'Plain task!', exact: true }).click()
    await titleBox(page).press('End')
    await page.keyboard.type('!')
    await modal(page).getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(async () => (await stored(page, ID.plain)).title).toBe('Plain task!!')

    await page.getByRole('button', { name: 'Plain task!!', exact: true }).click()
    await titleBox(page).press('End')
    await page.keyboard.type('!')
    const box = await modal(page).boundingBox()
    if (!box) throw new Error('the modal is not visible')
    await page.mouse.click(box.x + box.width + 80, box.y + 120)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect.poll(async () => (await stored(page, ID.plain)).title).toBe('Plain task!!!')
  })

  test('the browser Back button keeps the edit too', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list`)
    await page.getByRole('button', { name: 'Plain task', exact: true }).click()
    await titleBox(page).press('End')
    await page.keyboard.type('!')
    await page.goBack()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect.poll(async () => (await stored(page, ID.plain)).title).toBe('Plain task!')
  })

  test('text that can’t be saved stops the way out and asks', async ({ page }) => {
    await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
    await titleBox(page).fill('x'.repeat(501))
    await doneButton(page).click()
    const prompt = page.getByRole('alertdialog', { name: /Can’t save this title/ })
    await expect(prompt).toBeVisible()
    await prompt.getByRole('button', { name: 'Keep editing' }).click()
    await expect(titleBox(page)).toBeFocused()
    await expect(titleBox(page)).toHaveValue('x'.repeat(501))

    await page.keyboard.press('Escape')
    await prompt.getByRole('button', { name: 'Discard text' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect((await stored(page, ID.plain)).title).toBe('Plain task')
  })
})

test('14. List, Board and Gantt all show what the modal just saved', async ({ page }) => {
  await openApp(page, `/projects/${ID.research}/list?task=${ID.plain}`)
  await titleBox(page).fill('Renamed everywhere')
  await page.keyboard.press('Enter')
  await modal(page)
    .getByRole('button', { name: /^Status:/ })
    .click()
  await page.getByRole('menuitemradio', { name: /In Progress/ }).click()
  await pickDate(page, modal(page), 'Due date', isoDay(3))

  // The list behind the modal has already changed.
  await expect(
    page.locator('[data-task-row]').filter({ hasText: 'Renamed everywhere' }),
  ).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const listRow = page.locator('[data-task-row]').filter({ hasText: 'Renamed everywhere' })
  await expect(listRow.getByRole('button', { name: 'Status: In Progress' })).toBeVisible()

  await page.goto(`/projects/${ID.research}/board`)
  const column = page.getByRole('region', { name: /In Progress/ })
  await expect(column.getByText('Renamed everywhere')).toBeVisible()

  await page.goto(`/projects/${ID.research}/gantt`)
  await expect(page.getByText('Renamed everywhere').first()).toBeVisible()
})
