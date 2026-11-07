/// <reference lib="dom" />
/**
 * S1-S4, O1, O2: Task Modal autosave and recovery against the real database. The Task Modal is
 * driven through the UI; what reached the database is read back over REST with the user's own
 * token. Faults are made in the browser only: an aborted request, a delayed request, being offline.
 */
import {
  createTestProject,
  descriptionBox,
  expect,
  footerState,
  getRow,
  isoDay,
  modal,
  openTask,
  pickDate,
  sleep,
  STORAGE_STATE,
  syncIndicator,
  test,
  titleBox,
  toast,
  tokenFor,
} from './support.ts'

test.use({ storageState: STORAGE_STATE.A, locale: 'en-US', viewport: { width: 1280, height: 800 } })

interface TaskRow {
  title: string
  description: string | null
  status: string
  priority: string
  start_date: string | null
  due_date: string | null
  sort_order: string
  completed_at: string | null
  updated_at: string
}

const COLUMNS =
  'id,project_id,phase_id,parent_task_id,title,description,status,priority,start_date,due_date,sort_order,completed_at,created_at,updated_at'

async function dbTask(id: string): Promise<TaskRow | undefined> {
  return getRow<TaskRow>(await tokenFor('A'), 'tasks', id, COLUMNS)
}

const LONG = { timeout: 30_000 }

test.describe('autosave on the real database (S)', () => {
  test('S1: title, description, status and dates reach the database', async ({ page }) => {
    const { projectId, ids } = await createTestProject('A', {
      label: 'S1',
      tasks: [{ key: 't', title: 'Plain task' }],
    })
    await openTask(page, projectId, ids.t, 'Plain task')

    await titleBox(page).fill('Renamed on staging')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await dbTask(ids.t))?.title, LONG).toBe('Renamed on staging')

    // The description is saved by itself after a pause in typing.
    await descriptionBox(page).fill('Written on staging')
    await expect
      .poll(async () => (await dbTask(ids.t))?.description, LONG)
      .toBe('Written on staging')

    await modal(page)
      .getByRole('button', { name: /^Status:/ })
      .click()
    await page.getByRole('menuitemradio', { name: /In Progress/ }).click()
    await expect.poll(async () => (await dbTask(ids.t))?.status, LONG).toBe('in_progress')

    await pickDate(page, 'Start date', isoDay(2))
    await expect.poll(async () => (await dbTask(ids.t))?.start_date, LONG).toBe(isoDay(2))
    await pickDate(page, 'Due date', isoDay(9))
    await expect.poll(async () => (await dbTask(ids.t))?.due_date, LONG).toBe(isoDay(9))

    await expect(footerState(page)).toHaveText('Saved', LONG)
    // Everything is still there after a reload.
    await page.reload()
    await expect(titleBox(page)).toHaveValue('Renamed on staging')
    await expect(descriptionBox(page)).toHaveValue('Written on staging')
  })

  test('S2: only the changed field is sent, every other column stays as it was', async ({
    page,
  }) => {
    const { projectId, ids } = await createTestProject('A', {
      label: 'S2',
      phases: [{ name: 'Phase' }],
      tasks: [
        {
          key: 't',
          title: 'Full task',
          description: 'Keep me',
          status: 'in_progress',
          priority: 'high',
          start: '2026-11-03',
          due: '2026-11-12',
          phase: 'Phase',
        },
      ],
    })
    const before = await dbTask(ids.t)
    expect(before?.description).toBe('Keep me')

    const bodies: Record<string, unknown>[] = []
    page.on('request', (request) => {
      if (request.method() === 'PATCH' && request.url().includes('/rest/v1/tasks')) {
        bodies.push(JSON.parse(request.postData() ?? '{}') as Record<string, unknown>)
      }
    })
    await openTask(page, projectId, ids.t, 'Full task')
    await titleBox(page).fill('Full task, renamed')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await dbTask(ids.t))?.title, LONG).toBe('Full task, renamed')
    await expect(footerState(page)).toHaveText('Saved', LONG)

    const after = await dbTask(ids.t)
    const unchanged = (row: TaskRow | undefined) =>
      Object.fromEntries(
        Object.entries(row ?? {}).filter(([name]) => name !== 'title' && name !== 'updated_at'),
      )
    expect(unchanged(after)).toEqual(unchanged(before))
    expect(after?.updated_at).not.toBe(before?.updated_at)
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) expect(Object.keys(body)).toEqual(['title'])
  })

  test('S3: closing the Task Modal does not wait for the network, and the write still completes', async ({
    page,
  }) => {
    const { projectId, ids } = await createTestProject('A', {
      label: 'S3',
      tasks: [{ key: 't', title: 'Plain task' }],
    })
    await openTask(page, projectId, ids.t, 'Plain task')
    // A slow network, made in the browser: every write waits 2.5 s on its way out.
    await page.route('**/rest/v1/tasks?*', async (route) => {
      if (route.request().method() === 'PATCH') await sleep(2_500)
      await route.continue()
    })

    await descriptionBox(page).fill('Sent while closing')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // Closed, and the database does not have it yet: the write is still on its way.
    expect((await dbTask(ids.t))?.description).toBeNull()
    await expect(syncIndicator(page, 'Saving…')).toBeVisible()

    await expect
      .poll(async () => (await dbTask(ids.t))?.description, { timeout: 45_000 })
      .toBe('Sent while closing')
    await expect(syncIndicator(page, 'Saved')).toBeVisible(LONG)
  })

  test('S4: a reload after a failed save brings the text back; nothing is written until Save', async ({
    page,
  }) => {
    const { projectId, ids } = await createTestProject('A', {
      label: 'S4',
      tasks: [{ key: 't', title: 'Plain task' }],
    })
    await openTask(page, projectId, ids.t, 'Plain task')
    // The write never leaves the browser, however many times the page tries.
    await page.route('**/rest/v1/tasks?*', async (route) => {
      if (route.request().method() === 'PATCH') await route.abort()
      else await route.continue()
    })

    await descriptionBox(page).fill('Survives the reload')
    await titleBox(page).click()
    await expect(modal(page)).toContainText('Your text is kept here.', LONG)
    expect((await dbTask(ids.t))?.description).toBeNull()

    // Reload, accepting the browser's "Leave site?" question.
    const accept = (dialog: { accept(): Promise<void> }) => void dialog.accept()
    page.on('dialog', accept)
    await page.reload()
    page.off('dialog', accept)

    await expect(descriptionBox(page)).toHaveValue('Survives the reload')
    await expect(modal(page)).toContainText('Recovered text that wasn’t saved.')
    await expect(toast(page, 'Unsaved text recovered')).toBeVisible()
    expect((await dbTask(ids.t))?.description, 'nothing written by the recovery').toBeNull()

    // The network is back (the same page, no reload); Save writes it, once.
    await page.unroute('**/rest/v1/tasks?*')
    await modal(page).getByRole('button', { name: 'Save: description' }).click()
    await expect
      .poll(async () => (await dbTask(ids.t))?.description, LONG)
      .toBe('Survives the reload')
    await expect(modal(page)).not.toContainText('Recovered text')
  })
})

test.describe('offline and back (O)', () => {
  test('O1: text typed offline is sent by itself when the connection returns', async ({
    page,
    context,
  }) => {
    const { projectId, ids } = await createTestProject('A', {
      label: 'O1',
      tasks: [{ key: 't', title: 'Plain task' }],
    })
    await openTask(page, projectId, ids.t, 'Plain task')

    await context.setOffline(true)
    await expect(footerState(page)).toContainText('Offline')
    await descriptionBox(page).fill('Written on the train')
    await titleBox(page).click()
    await expect(descriptionBox(page)).toHaveValue('Written on the train')
    await expect(toast(page, /Couldn.t save/)).toHaveCount(0)
    expect((await dbTask(ids.t))?.description).toBeNull()

    await context.setOffline(false)
    await expect
      .poll(async () => (await dbTask(ids.t))?.description, { timeout: 45_000 })
      .toBe('Written on the train')
    await expect(footerState(page)).not.toContainText('Offline')
  })

  test('O2: text left behind by closing the Task Modal offline is sent when the connection returns', async ({
    page,
    context,
  }) => {
    const { projectId, ids } = await createTestProject('A', {
      label: 'O2',
      tasks: [{ key: 't', title: 'Plain task' }],
    })
    await openTask(page, projectId, ids.t, 'Plain task')

    await context.setOffline(true)
    await expect(footerState(page)).toContainText('Offline')
    await descriptionBox(page).fill('Closed while offline')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Sync status: 1 unsaved text/ })).toBeVisible()
    expect((await dbTask(ids.t))?.description).toBeNull()

    await context.setOffline(false)
    await expect
      .poll(async () => (await dbTask(ids.t))?.description, { timeout: 45_000 })
      .toBe('Closed while offline')
    await expect(page.getByRole('button', { name: /^Sync status: 1 unsaved text/ })).toHaveCount(0)
  })
})
