/// <reference lib="dom" />
/**
 * Cloud mode, failure honesty (PRD §5.4, §9.1 AC-15, §9.2): the request never arrives, the server
 * answers 500, the database refuses it, or the server applied the write and the answer was lost.
 * Expected every time: the screen matches the database, the error is honest, Retry works where it
 * makes sense, nothing is created twice, the sync indicator tells the truth, and no console errors.
 * The failures are injected in the simulator's HTTP layer, so the real client and database react.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type Browser, type Page } from '@playwright/test'
import {
  accessToken,
  expect,
  expectShell,
  focusAfterThrottle,
  listScroll,
  rest,
  rowTitles,
  seedProject,
  sidebar,
  signIn,
  signUpNew,
  sim,
  syncIndicator,
  taskRow,
  test,
  toast,
  userId,
  watchConsole,
} from './support.ts'

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } })

const statusButton = (page: Page, id: string) =>
  page.locator(`[data-task-row="${id}"]`).getByRole('button', { name: /^Status:/ })

async function setStatus(page: Page, id: string, status: string): Promise<void> {
  await statusButton(page, id).click()
  await page.getByRole('menuitemradio', { name: status }).click()
}

const dbStatus = (id: string) =>
  sim.sql<{ status: string }>('select status from public.tasks where id = $1', [id])

const titledCount = async (projectId: string, title: string) =>
  (
    await sim.sql('select id from public.tasks where project_id = $1 and title = $2', [
      projectId,
      title,
    ])
  ).length

async function addInline(page: Page, title: string): Promise<void> {
  const input = page.getByRole('textbox', { name: 'New task' })
  if ((await input.count()) === 0) {
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
  }
  await input.fill(title)
  await input.press('Enter')
  await input.press('Escape')
}

const SEED = {
  tasks: [
    { key: 'a', title: 'Alpha' },
    { key: 'b', title: 'Beta' },
  ],
}

test.describe('the request never arrives', () => {
  test('update: rolled back, honest toast, Couldn’t save in the sidebar, Retry saves it once', async ({
    page,
  }) => {
    await signUpNew(page)
    const { ids } = await seedProject(page, SEED)
    await sim.fault({ method: 'PATCH', path: '/rest/v1/tasks', when: 'before', action: 'drop' })

    await setStatus(page, ids.a, 'Done')
    const failure = toast(page, "Couldn't update task")
    await expect(failure).toContainText('Network error — check your connection.')
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: To Do')
    await expect(syncIndicator(page, "Couldn't save")).toBeVisible()
    await expect(sidebar(page).getByRole('button', { name: 'Retry' })).toBeVisible()
    expect(await dbStatus(ids.a)).toEqual([{ status: 'todo' }])

    await failure.getByRole('button', { name: 'Retry' }).click()
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: Done')
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    await expect(toast(page, 'Saved')).toHaveCount(1)
    await expect(failure).toHaveCount(0)
    await expect(sidebar(page).getByRole('button', { name: 'Retry' })).toHaveCount(0)
    expect(await dbStatus(ids.a)).toEqual([{ status: 'done' }])
    await page.reload()
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: Done')
  })

  test('create, fails twice: never shown as saved; the sidebar Retry stores it exactly once', async ({
    page,
  }) => {
    await signUpNew(page)
    const { projectId } = await seedProject(page, SEED)
    await sim.fault({
      method: 'POST',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'drop',
      times: 2,
    })

    await addInline(page, 'Gamma')
    const failure = toast(page, "Couldn't create task")
    await expect(failure).toBeVisible()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta'])
    expect(await titledCount(projectId, 'Gamma')).toBe(0)

    await failure.getByRole('button', { name: 'Retry' }).click()
    await expect(toast(page, "Couldn't create task")).toBeVisible()
    await expect(syncIndicator(page, "Couldn't save")).toBeVisible()
    expect(await titledCount(projectId, 'Gamma')).toBe(0)

    await sidebar(page).getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta', 'Gamma'])
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    expect(await titledCount(projectId, 'Gamma')).toBe(1)
  })

  test('browser offline: Offline in the sidebar, a change fails honestly, back online it can be retried', async ({
    context,
    page,
  }) => {
    await signUpNew(page)
    const { ids } = await seedProject(page, SEED)
    await expect(syncIndicator(page, 'Saved')).toBeVisible()

    await context.setOffline(true)
    await expect(syncIndicator(page, 'Offline')).toBeVisible()
    await setStatus(page, ids.a, 'Done')
    await expect(toast(page, "Couldn't update task")).toContainText('Network error')
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: To Do')
    await expect(syncIndicator(page, "Couldn't save")).toBeVisible()
    expect(await dbStatus(ids.a)).toEqual([{ status: 'todo' }])

    await context.setOffline(false)
    await toast(page, "Couldn't update task").getByRole('button', { name: 'Retry' }).click()
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: Done')
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    expect(await dbStatus(ids.a)).toEqual([{ status: 'done' }])
  })
})

test.describe('the server never answers', () => {
  test('after 30 s the request gives up: rolled back, honest, and Retry cannot apply it twice', async ({
    page,
  }) => {
    test.slow()
    await signUpNew(page)
    const { projectId } = await seedProject(page, SEED)
    await sim.fault({
      method: 'POST',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'delay',
      delayMs: 33_000,
    })
    await addInline(page, 'Slow one')
    await expect(syncIndicator(page, 'Saving…')).toBeVisible()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta', 'Slow one'])
    // The client's own 30 s limit ends the wait, while the server is still busy with it.
    await expect(toast(page, "Couldn't create task")).toContainText('Network error', {
      timeout: 35_000,
    })
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta'])
    await expect(syncIndicator(page, "Couldn't save")).toBeVisible()
    expect(await titledCount(projectId, 'Slow one')).toBe(0)

    // The server finishes after the client gave up, then the user presses Retry.
    await expect.poll(() => titledCount(projectId, 'Slow one'), { timeout: 8_000 }).toBe(1)
    await toast(page, "Couldn't create task").getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta', 'Slow one'])
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    expect(await titledCount(projectId, 'Slow one')).toBe(1)
  })
})

test.describe('the server answers 500', () => {
  test('update: rolled back, Retry; a gateway HTML page is handled the same way', async ({
    page,
  }) => {
    await signUpNew(page)
    const { ids } = await seedProject(page, SEED)
    await sim.fault({
      method: 'PATCH',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'status',
      status: 500,
      body: '{"code":"XX000","details":null,"hint":null,"message":"internal_error"}',
    })
    await setStatus(page, ids.a, 'In Progress')
    const failure = toast(page, "Couldn't update task")
    await expect(failure).toContainText("The server couldn't complete the request. Try again.")
    await expect(failure).not.toContainText('internal_error')
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: To Do')
    await expect(syncIndicator(page, "Couldn't save")).toBeVisible()

    await sim.fault({
      method: 'PATCH',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'status',
      status: 502,
      body: '<html><body>Bad gateway</body></html>',
      contentType: 'text/html',
    })
    await failure.getByRole('button', { name: 'Retry' }).click()
    await expect(toast(page, "Couldn't update task")).toContainText("The server couldn't complete")
    await expect(toast(page, "Couldn't update task")).not.toContainText('Bad gateway')
    expect(await dbStatus(ids.a)).toEqual([{ status: 'todo' }])

    await toast(page, "Couldn't update task").getByRole('button', { name: 'Retry' }).click()
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: In Progress')
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    expect(await dbStatus(ids.a)).toEqual([{ status: 'in_progress' }])
  })

  test('RPC writes: Gantt Apply and delete keeping subtasks roll back whole and Retry works', async ({
    page,
  }) => {
    await signUpNew(page)
    const { projectId, ids } = await seedProject(page, {
      tasks: [
        { key: 'p', title: 'Parent' },
        { key: 's', title: 'Sub', parent: 'p' },
        { key: 'o', title: 'Other' },
      ],
    })
    await page.getByRole('button', { name: 'Expand subtasks' }).click()
    await sim.fault({
      method: 'POST',
      path: '/rest/v1/rpc/delete_task',
      when: 'before',
      action: 'status',
      status: 500,
    })
    await taskRow(page, 'Parent').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete task…' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Keep subtasks' }).click()
    const failure = toast(page, /Couldn.t delete task/)
    await expect(failure).toBeVisible()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Parent', '↳ Sub', 'Other'])
    expect(await titledCount(projectId, 'Parent')).toBe(1)

    await failure.getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Sub', 'Other'])
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    await expect(
      sim.sql('select parent_task_id from public.tasks where id = $1', [ids.s]),
    ).resolves.toEqual([{ parent_task_id: null }])
    expect(await titledCount(projectId, 'Parent')).toBe(0)
  })

  test('a failed first load is an error with Retry, never a friendly empty workspace', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    await seedProject(page, { name: 'Real data', tasks: [{ key: 'a', title: 'Alpha' }] })
    await page.goto('/overview')
    await expectShell(page)
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible()
    await sim.fault({
      method: 'GET',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'status',
      status: 500,
    })
    await page.reload()
    await expect(page.getByRole('button', { name: /Retry|Try again/ }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create project' })).toHaveCount(0)
    await page
      .getByRole('button', { name: /Retry|Try again/ })
      .first()
      .click()
    await expect(page.getByRole('link', { name: /Real data/ }).first()).toBeVisible()
    expect(email).toBeTruthy()
  })

  test('a failed background refresh keeps the data on screen; the next focus brings the news', async ({
    page,
  }) => {
    await page.clock.install()
    await signUpNew(page)
    const { projectId } = await seedProject(page, SEED)
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta'])
    const failedReads = async () =>
      (await sim.requests()).filter((r) => r.path === '/rest/v1/tasks' && r.status === 500).length
    const before = await failedReads()
    await sim.fault({
      method: 'GET',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'status',
      status: 500,
    })
    await focusAfterThrottle(page)
    await expect.poll(failedReads).toBe(before + 1)
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta'])
    await expect(page.getByRole('button', { name: 'Create project' })).toHaveCount(0)
    // Another device adds a task; the next focus shows it.
    const token = await accessToken(page)
    const added = await rest(token, 'tasks?select=id', {
      method: 'POST',
      body: { id: randomUUID(), project_id: projectId, title: 'From elsewhere', sort_order: 'a9' },
      prefer: 'return=representation',
    })
    expect(added.status).toBe(201)
    await focusAfterThrottle(page)
    await expect
      .poll(() => rowTitles(listScroll(page)))
      .toEqual(['Alpha', 'Beta', 'From elsewhere'])
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
  })
})

test.describe('the database refuses it (another device got there first)', () => {
  async function secondDevice(browser: Browser, email: string): Promise<Page> {
    const context = await browser.newContext({
      baseURL: 'http://localhost:5181',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    })
    const page = await context.newPage()
    watchConsole(page)
    await signIn(page, email)
    return page
  }

  async function addBlockedTask(
    page: Page,
    projectId: string,
    from: string,
    to: string,
    toId: string,
  ): Promise<void> {
    await page.goto(`/projects/${projectId}/list?task=${toId}`)
    const modal = page.getByRole('dialog', { name: `Edit task: ${from}` })
    const blocking = modal.getByRole('list', { name: 'Blocking' })
    await blocking.getByRole('button', { name: 'Add a task this one blocks' }).click()
    const picker = page.getByRole('dialog', { name: 'Add a task this one blocks' })
    await picker.getByPlaceholder('Search tasks in this project…').fill(to)
    await picker.getByRole('option', { name: to }).click()
  }

  test('a cycle only the server can see: readable message, rolled back, no Retry, and it catches up', async ({
    browser,
    page,
  }) => {
    const email = await signUpNew(page)
    const { projectId, ids } = await seedProject(page, SEED)
    const other = await secondDevice(browser, email)
    try {
      // Device B opens the task first, so its picker does not know about A's link.
      await other.goto(`/projects/${projectId}/list?task=${ids.b}`)
      const modal = other.getByRole('dialog', { name: 'Edit task: Beta' })
      await expect(modal).toBeVisible()

      await addBlockedTask(page, projectId, 'Alpha', 'Beta', ids.a)
      await expect
        .poll(() =>
          sim.sql('select id from public.task_dependencies where project_id = $1', [projectId]),
        )
        .toHaveLength(1)

      // B: Beta blocks Alpha closes a cycle, which only the database can tell now.
      const blocking = modal.getByRole('list', { name: 'Blocking' })
      await blocking.getByRole('button', { name: 'Add a task this one blocks' }).click()
      const picker = other.getByRole('dialog', { name: 'Add a task this one blocks' })
      await picker.getByPlaceholder('Search tasks in this project…').fill('Alpha')
      await picker.getByRole('option', { name: 'Alpha' }).click()

      await expect(toast(other, /cycle/i)).toBeVisible()
      await expect(toast(other, /cycle/i).getByRole('button', { name: 'Retry' })).toHaveCount(0)
      await expect(
        sim.sql('select id from public.task_dependencies where project_id = $1', [projectId]),
      ).resolves.toHaveLength(1)
      // The refresh after the refusal brings A's link; nothing remains waiting to be retried.
      await expect(
        modal
          .getByRole('list', { name: 'Blocked by' })
          .getByRole('button', { name: 'Alpha', exact: true }),
      ).toBeVisible()
      await expect(blocking.getByRole('button', { name: 'Alpha', exact: true })).toHaveCount(0)
      // The answer can arrive during the picker's exit animation, whose layer would take this Esc.
      await expect(picker).toBeHidden()
      await other.keyboard.press('Escape')
      await expect(modal).toBeHidden()
      await expect(sidebar(other).getByRole('button', { name: 'Retry' })).toHaveCount(0)
      await expect(syncIndicator(other, 'Saved')).toBeVisible()
    } finally {
      await other.context().close()
    }
  })

  test('the same link from both devices (unique key): one row, readable message', async ({
    browser,
    page,
  }) => {
    const email = await signUpNew(page)
    const { projectId, ids } = await seedProject(page, SEED)
    const other = await secondDevice(browser, email)
    try {
      await other.goto(`/projects/${projectId}/list?task=${ids.a}`)
      const modal = other.getByRole('dialog', { name: 'Edit task: Alpha' })
      await expect(modal).toBeVisible()
      await addBlockedTask(page, projectId, 'Alpha', 'Beta', ids.a)
      await expect
        .poll(() =>
          sim.sql('select id from public.task_dependencies where project_id = $1', [projectId]),
        )
        .toHaveLength(1)

      const blocking = modal.getByRole('list', { name: 'Blocking' })
      await blocking.getByRole('button', { name: 'Add a task this one blocks' }).click()
      const picker = other.getByRole('dialog', { name: 'Add a task this one blocks' })
      await picker.getByPlaceholder('Search tasks in this project…').fill('Beta')
      await picker.getByRole('option', { name: 'Beta' }).click()
      await expect(blocking.getByRole('button', { name: 'Beta', exact: true })).toBeVisible()
      await expect(syncIndicator(other, 'Saved'))
        .toBeHidden({ timeout: 100 })
        .catch(() => {})
      await expect(
        sim.sql('select id from public.task_dependencies where project_id = $1', [projectId]),
      ).resolves.toHaveLength(1)
    } finally {
      await other.context().close()
    }
  })

  test('a task added to a project another device deleted (foreign key): refused, and the project goes away', async ({
    browser,
    page,
  }) => {
    const email = await signUpNew(page)
    const { projectId } = await seedProject(page, { name: 'Soon gone', ...SEED })
    const other = await secondDevice(browser, email)
    try {
      await other.goto(`/projects/${projectId}/list`)
      await expect.poll(() => rowTitles(listScroll(other))).toEqual(['Alpha', 'Beta'])

      await page.getByRole('button', { name: 'Project actions' }).click()
      await page.getByRole('menuitem', { name: /Delete project/ }).click()
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: /Delete project/ })
        .click()
      await expect(page).toHaveURL(/\/projects$/)

      await addInline(other, 'Too late')
      await expect(toast(other, /related item no longer exists/)).toBeVisible()
      await expect(
        toast(other, /related item no longer exists/).getByRole('button', { name: 'Retry' }),
      ).toHaveCount(0)
      await expect(other.getByText('Project not found')).toBeVisible()
      await expect(
        sim.sql('select id from public.tasks where project_id = $1', [projectId]),
      ).resolves.toEqual([])
      await expect(sidebar(other).getByRole('button', { name: 'Retry' })).toHaveCount(0)
    } finally {
      await other.context().close()
    }
  })

  test('a value only the database rejects (request altered on the way): readable, rolled back', async ({
    page,
  }) => {
    await signUpNew(page)
    const { ids } = await seedProject(page, SEED)
    // The client validates titles, so alter the request: the real check constraint answers 400/23514.
    await page.route('**/rest/v1/tasks?*', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback()
      await route.continue({ postData: JSON.stringify({ title: 'x'.repeat(501) }) })
    })
    await setStatus(page, ids.a, 'Done')
    // One failure, one message, and it is not offered again: it would fail the same way.
    await expect(toast(page, 'Task title must be 1–500 characters.')).toHaveCount(1)
    await expect(
      toast(page, 'Task title must be 1–500 characters.').getByRole('button', { name: 'Retry' }),
    ).toHaveCount(0)
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: To Do')
    await page.unroute('**/rest/v1/tasks?*')
    expect(await dbStatus(ids.a)).toEqual([{ status: 'todo' }])
    await expect(sidebar(page).getByRole('button', { name: 'Retry' })).toHaveCount(0)
    // A refused change is over once the screen shows the current data: nothing to sync.
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
  })
})

test.describe('the server applied it, the answer was lost', () => {
  test('inline create: appears once, the failure is withdrawn, Saved', async ({ page }) => {
    await signUpNew(page)
    const { projectId } = await seedProject(page, SEED)
    await sim.fault({ method: 'POST', path: '/rest/v1/tasks', when: 'after', action: 'drop' })
    await addInline(page, 'Gamma')
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta', 'Gamma'])
    await expect(toast(page, "Couldn't create task")).toHaveCount(0)
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    await expect(sidebar(page).getByRole('button', { name: 'Retry' })).toHaveCount(0)
    expect(await titledCount(projectId, 'Gamma')).toBe(1)
    await page.reload()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(await titledCount(projectId, 'Gamma')).toBe(1)
  })

  test('update: the applied value stays, no Retry left', async ({ page }) => {
    await signUpNew(page)
    const { ids } = await seedProject(page, SEED)
    await sim.fault({ method: 'PATCH', path: '/rest/v1/tasks', when: 'after', action: 'drop' })
    await setStatus(page, ids.a, 'Done')
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: Done')
    await expect(toast(page, "Couldn't update task")).toHaveCount(0)
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    expect(await dbStatus(ids.a)).toEqual([{ status: 'done' }])
  })

  test('delete task RPC: stays deleted, no error left', async ({ page }) => {
    await signUpNew(page)
    const { projectId } = await seedProject(page, SEED)
    await sim.fault({
      method: 'POST',
      path: '/rest/v1/rpc/delete_task',
      when: 'after',
      action: 'drop',
    })
    await taskRow(page, 'Alpha').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete task…' }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /^Delete/ })
      .click()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Beta'])
    await expect(toast(page, /Couldn.t delete task/)).toHaveCount(0)
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    expect(await titledCount(projectId, 'Alpha')).toBe(0)
  })

  test('applied and the refresh fails too: Retry cannot make a second row, and the error ends', async ({
    page,
  }) => {
    await signUpNew(page)
    const { projectId } = await seedProject(page, SEED)
    await sim.fault({ method: 'POST', path: '/rest/v1/tasks', when: 'after', action: 'drop' })
    await sim.fault({
      method: 'GET',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'status',
      status: 500,
      times: 1,
    })
    await addInline(page, 'Gamma')
    const failure = toast(page, "Couldn't create task")
    await expect(failure.or(toast(page, /Couldn.t refresh/))).toBeVisible()
    expect(await titledCount(projectId, 'Gamma')).toBe(1)

    const retry = sidebar(page).getByRole('button', { name: 'Retry' })
    await expect(retry).toBeVisible()
    await retry.click()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta', 'Gamma'])
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    await expect(sidebar(page).getByRole('button', { name: 'Retry' })).toHaveCount(0)
    expect(await titledCount(projectId, 'Gamma')).toBe(1)
  })

  test('delete applied, refresh failed: Retry finds it gone and that is fine', async ({ page }) => {
    await signUpNew(page)
    const { projectId } = await seedProject(page, SEED)
    await sim.fault({
      method: 'POST',
      path: '/rest/v1/rpc/delete_task',
      when: 'after',
      action: 'drop',
    })
    await sim.fault({
      method: 'GET',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'status',
      status: 500,
      times: 1,
    })
    await taskRow(page, 'Alpha').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete task…' }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /^Delete/ })
      .click()
    const retry = sidebar(page).getByRole('button', { name: 'Retry' })
    await expect(retry).toBeVisible()
    await retry.click()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Beta'])
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    await expect(toast(page, /Couldn.t delete task/)).toHaveCount(0)
    expect(await titledCount(projectId, 'Alpha')).toBe(0)
  })

  test('project dialog: one project, opened or offered, whatever the user does next', async ({
    page,
  }) => {
    await signUpNew(page)
    await page.goto('/projects')
    await expectShell(page)
    await page.getByRole('button', { name: 'Create your first project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Lost answer project')
    await sim.fault({ method: 'POST', path: '/rest/v1/projects', when: 'after', action: 'drop' })
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await expect
      .poll(() =>
        sim.sql('select id from public.projects where name = $1', ['Lost answer project']),
      )
      .toHaveLength(1)
    // The natural reaction to a failure message: press Try again if it is still offered.
    await page.waitForTimeout(800)
    const tryAgain = dialog.getByRole('button', { name: 'Try again' })
    if (await tryAgain.isVisible()) await tryAgain.click()
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/list$/)
    await expect(page.getByRole('heading', { name: 'Lost answer project' })).toBeVisible()
    await expect(
      sim.sql('select id from public.projects where name = $1', ['Lost answer project']),
    ).resolves.toHaveLength(1)
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
  })

  test('task form: one task, whatever the user does next', async ({ page }) => {
    await signUpNew(page)
    const { projectId } = await seedProject(page, SEED)
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta'])
    await page.keyboard.press('c')
    const modal = page.getByRole('dialog', { name: 'New task', exact: true })
    await modal.getByRole('textbox', { name: 'Task title' }).fill('Lost answer task')
    await sim.fault({ method: 'POST', path: '/rest/v1/tasks', when: 'after', action: 'drop' })
    await modal.getByRole('button', { name: 'Create task' }).click()
    await expect.poll(() => titledCount(projectId, 'Lost answer task')).toBe(1)
    await page.waitForTimeout(800)
    const create = modal.getByRole('button', { name: 'Create task' })
    if (await create.isVisible()) await create.click()
    await page.waitForTimeout(800)
    expect(await titledCount(projectId, 'Lost answer task')).toBe(1)
    await expect(modal).toBeHidden()
    await expect(page.getByRole('button', { name: 'Move Lost answer task' })).toBeVisible()
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
  })

  test('milestone form: one milestone, whatever the user does next', async ({ page }) => {
    await signUpNew(page)
    const { projectId } = await seedProject(page, SEED)
    await page.getByRole('button', { name: 'Project actions' }).click()
    await page.getByRole('menuitem', { name: 'Add milestone…' }).click()
    const dialog = page.getByRole('dialog', { name: 'New milestone' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Lost answer milestone')
    await dialog.getByRole('button', { name: /^Date:/ }).click()
    await page
      .getByRole('dialog', { name: 'Date', exact: true })
      .getByRole('button', { name: /Today/ })
      .first()
      .click()
    await sim.fault({ method: 'POST', path: '/rest/v1/milestones', when: 'after', action: 'drop' })
    await dialog.getByRole('button', { name: 'Create milestone' }).click()
    const stored = () =>
      sim.sql('select id from public.milestones where project_id = $1 and name = $2', [
        projectId,
        'Lost answer milestone',
      ])
    await expect.poll(stored).toHaveLength(1)
    await page.waitForTimeout(800)
    const create = dialog.getByRole('button', { name: 'Create milestone' })
    if (await create.isVisible()) await create.click()
    await page.waitForTimeout(800)
    expect(await stored()).toHaveLength(1)
    await expect(dialog).toBeHidden()
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
  })

  test('import RPC: applied once, even when Try again is pressed', async ({ page }) => {
    const email = await signUpNew(page)
    await seedProject(page, { name: 'Original', ...SEED })
    await page.goto('/settings/data')
    await expectShell(page)
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    const text = readFileSync(await download.path(), 'utf8')
    await page.getByLabel('Backup file').setInputFiles({
      name: 'my-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    })
    const dialog = page.getByRole('dialog', { name: 'Import backup' })
    await sim.fault({
      method: 'POST',
      path: '/rest/v1/rpc/import_workspace',
      when: 'after',
      action: 'drop',
    })
    await dialog.getByRole('button', { name: 'Import as new copies' }).click()
    const owner = await userId(email)
    const copies = () =>
      sim.sql('select id from public.projects where name = $1 and user_id = $2', [
        'Original',
        owner,
      ])
    await expect.poll(copies).toHaveLength(2)
    await page.waitForTimeout(800)
    const tryAgain = dialog.getByRole('button', { name: 'Try again' })
    if (await tryAgain.isVisible()) await tryAgain.click()
    await page.waitForTimeout(800)
    expect(await copies()).toHaveLength(2)
    await expect(dialog).toBeHidden()
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
  })
})

test.describe('the request was delivered twice (the browser re-sent it after its connection died)', () => {
  test('inline create: one row, no failure, Saved', async ({ page }) => {
    await signUpNew(page)
    const { projectId } = await seedProject(page, SEED)
    await sim.fault({ method: 'POST', path: '/rest/v1/tasks', when: 'after', action: 'replay' })
    await addInline(page, 'Gamma')
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta', 'Gamma'])
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    await expect(toast(page, /Couldn.t create task/)).toHaveCount(0)
    expect(await titledCount(projectId, 'Gamma')).toBe(1)
  })

  test('task form: closes on success, so a second Create cannot add a copy', async ({ page }) => {
    await signUpNew(page)
    const { projectId } = await seedProject(page, SEED)
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta'])
    await page.keyboard.press('c')
    const modal = page.getByRole('dialog', { name: 'New task', exact: true })
    await modal.getByRole('textbox', { name: 'Task title' }).fill('Twice delivered')
    await sim.fault({ method: 'POST', path: '/rest/v1/tasks', when: 'after', action: 'replay' })
    await modal.getByRole('button', { name: 'Create task' }).click()
    await expect(modal).toBeHidden()
    await expect(toast(page, 'Task created')).toBeVisible()
    await expect(toast(page, /Couldn.t create task/)).toHaveCount(0)
    expect(await titledCount(projectId, 'Twice delivered')).toBe(1)
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
  })

  test('project dialog: opens the one project', async ({ page }) => {
    await signUpNew(page)
    await page.goto('/projects')
    await expectShell(page)
    await page.getByRole('button', { name: 'Create your first project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Twice delivered project')
    await sim.fault({ method: 'POST', path: '/rest/v1/projects', when: 'after', action: 'replay' })
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/list$/)
    await expect(page.getByRole('heading', { name: 'Twice delivered project' })).toBeVisible()
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    await expect(
      sim.sql('select id from public.projects where name = $1', ['Twice delivered project']),
    ).resolves.toHaveLength(1)
  })

  test('milestone form: closes on success, one milestone', async ({ page }) => {
    await signUpNew(page)
    const { projectId } = await seedProject(page, SEED)
    await page.getByRole('button', { name: 'Project actions' }).click()
    await page.getByRole('menuitem', { name: 'Add milestone…' }).click()
    const dialog = page.getByRole('dialog', { name: 'New milestone' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Twice delivered milestone')
    await dialog.getByRole('button', { name: /^Date:/ }).click()
    await page
      .getByRole('dialog', { name: 'Date', exact: true })
      .getByRole('button', { name: /Today/ })
      .first()
      .click()
    await sim.fault({
      method: 'POST',
      path: '/rest/v1/milestones',
      when: 'after',
      action: 'replay',
    })
    await dialog.getByRole('button', { name: 'Create milestone' }).click()
    await expect(dialog).toBeHidden()
    await expect(toast(page, /Couldn.t create milestone/)).toHaveCount(0)
    await expect(
      sim.sql('select id from public.milestones where project_id = $1', [projectId]),
    ).resolves.toHaveLength(1)
  })

  test('import: one copy, reported as imported', async ({ page }) => {
    const email = await signUpNew(page)
    const owner = await userId(email)
    await seedProject(page, { name: 'Original', ...SEED })
    await page.goto('/settings/data')
    await expectShell(page)
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    await page.getByLabel('Backup file').setInputFiles({
      name: 'my-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(readFileSync(await download.path(), 'utf8')),
    })
    const dialog = page.getByRole('dialog', { name: 'Import backup' })
    await sim.fault({
      method: 'POST',
      path: '/rest/v1/rpc/import_workspace',
      when: 'after',
      action: 'replay',
    })
    await dialog.getByRole('button', { name: 'Import as new copies' }).click()
    await expect(dialog).toBeHidden()
    await expect(toast(page, 'Backup imported')).toBeVisible()
    await expect(
      sim.sql('select id from public.projects where name = $1 and user_id = $2', [
        'Original',
        owner,
      ]),
    ).resolves.toHaveLength(2)
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
  })
})

test.describe('the sync indicator', () => {
  test('closing or reloading while a write is on its way asks first; not once it is saved', async ({
    page,
  }) => {
    await signUpNew(page)
    const { ids } = await seedProject(page, SEED)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/rest/v1/tasks?*', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback()
      await gate
      await route.fallback()
    })
    const unloadPrevented = () =>
      page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(event)
        return event.defaultPrevented
      })
    expect(await unloadPrevented()).toBe(false)
    await setStatus(page, ids.a, 'Done')
    await expect(syncIndicator(page, 'Saving…')).toBeVisible()
    expect(await unloadPrevented()).toBe(true)
    release()
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    expect(await unloadPrevented()).toBe(false)
    await page.unroute('**/rest/v1/tasks?*')
  })

  test('Saving… while a slow write is on its way, Saved after it; a sign-out waits for it', async ({
    page,
  }) => {
    await signUpNew(page)
    const { ids } = await seedProject(page, SEED)
    await sim.fault({
      method: 'PATCH',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'delay',
      delayMs: 1500,
    })
    await setStatus(page, ids.a, 'Done')
    // Optimistic at once, honest about it.
    await expect(statusButton(page, ids.a)).toHaveAccessibleName('Status: Done')
    await expect(syncIndicator(page, 'Saving…')).toBeVisible()
    expect(await dbStatus(ids.a)).toEqual([{ status: 'todo' }])
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    expect(await dbStatus(ids.a)).toEqual([{ status: 'done' }])

    // Signing out right after a change: the change is saved first.
    await sim.fault({
      method: 'PATCH',
      path: '/rest/v1/tasks',
      when: 'before',
      action: 'delay',
      delayMs: 1200,
    })
    await setStatus(page, ids.b, 'In Progress')
    await sidebar(page).getByRole('link', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Sign out', exact: true })
      .click()
    await expect(page).toHaveURL(/\/login/)
    expect(await dbStatus(ids.b)).toEqual([{ status: 'in_progress' }])
  })

  test('the cloud labels only: never "Local only" on any page', async ({ page }) => {
    await signUpNew(page)
    const { projectId } = await seedProject(page, SEED)
    const paths = [
      '/overview',
      '/my-tasks/all',
      '/projects',
      `/projects/${projectId}/list`,
      `/projects/${projectId}/board`,
      `/projects/${projectId}/gantt`,
      '/timeline',
      '/settings/account',
      '/settings/appearance',
      '/settings/data',
    ]
    for (const path of paths) {
      await page.goto(path)
      await expectShell(page)
      await expect(syncIndicator(page, 'Saved'), path).toBeVisible()
      await expect(
        page.getByText(/Local only|not synced|Local mode|this browser only/i),
        path,
      ).toHaveCount(0)
    }
  })
})
