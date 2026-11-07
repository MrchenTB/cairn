/// <reference lib="dom" />
/**
 * D1-D4: one account on two "devices", i.e. two browser contexts started from the same saved
 * session. This is a proxy for two machines (D5-D7 in the plan are the real ones, done by hand).
 */
import { type Page } from '@playwright/test'
import {
  createTestProject,
  descriptionBox,
  expect,
  expectShell,
  getRow,
  listScroll,
  modal,
  openList,
  openTask,
  rest,
  rowTitles,
  syncIndicator,
  taskRow,
  test,
  titleBox,
  toast,
  tokenFor,
} from './support.ts'

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } })

const LONG = { timeout: 30_000 }

const titleOf = async (id: string) =>
  (await getRow<{ title: string }>(await tokenFor('A'), 'tasks', id, 'title'))?.title

const statusButton = (page: Page, id: string) =>
  page.locator(`[data-task-row="${id}"]`).getByRole('button', { name: /^Status:/ })

test.describe('two devices, one account (D)', () => {
  test('D1: a task created on device 1 shows on device 2 after a reload', async ({ device }) => {
    const { projectId } = await createTestProject('A', {
      label: 'D1',
      tasks: [{ key: 'a', title: 'Existing task' }],
    })
    const one = await device('A')
    const two = await device('A')
    await openList(one, projectId)
    await openList(two, projectId)
    await expect.poll(() => rowTitles(listScroll(two))).toEqual(['Existing task'])

    const input = one.getByRole('textbox', { name: 'New task' })
    if ((await input.count()) === 0) {
      await one
        .getByRole('button', { name: /Add task/ })
        .first()
        .click()
    }
    await input.fill('Created on device 1')
    await input.press('Enter')
    await input.press('Escape')
    await expect(syncIndicator(one, 'Saved')).toBeVisible(LONG)

    const token = await tokenFor('A')
    const stored = await rest(
      token,
      `tasks?project_id=eq.${projectId}&select=title&order=sort_order.asc`,
    )
    expect(stored.body).toEqual([{ title: 'Existing task' }, { title: 'Created on device 1' }])

    await two.reload()
    await expectShell(two)
    await expect
      .poll(() => rowTitles(listScroll(two)), LONG)
      .toEqual(['Existing task', 'Created on device 1'])
    await one.reload()
    await expectShell(one)
    expect(await rowTitles(listScroll(one))).toEqual(['Existing task', 'Created on device 1'])
  })

  test('D2: a change made on device 2 shows on device 1 after a reload', async ({ device }) => {
    const { projectId, ids } = await createTestProject('A', {
      label: 'D2',
      tasks: [
        { key: 'a', title: 'Alpha' },
        { key: 'b', title: 'Beta' },
      ],
    })
    const one = await device('A')
    const two = await device('A')
    await openList(one, projectId)
    await openList(two, projectId)
    await expect.poll(() => rowTitles(listScroll(one))).toEqual(['Alpha', 'Beta'])

    await statusButton(two, ids.a).click()
    await two.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect(syncIndicator(two, 'Saved')).toBeVisible(LONG)
    const stored = await rest(await tokenFor('A'), `tasks?id=eq.${ids.a}&select=status`)
    expect(stored.body).toEqual([{ status: 'done' }])

    await one.reload()
    await expectShell(one)
    await expect(statusButton(one, ids.a)).toHaveAccessibleName('Status: Done', LONG)
    await expect(statusButton(one, ids.b)).not.toHaveAccessibleName('Status: Done')
  })

  test('D3: both devices change the same field: the last writer wins, both end the same', async ({
    device,
  }) => {
    const { projectId, ids } = await createTestProject('A', {
      label: 'D3',
      tasks: [{ key: 't', title: 'Shared task' }],
    })
    const one = await device('A')
    const two = await device('A')
    await openTask(one, projectId, ids.t, 'Shared task')
    await openTask(two, projectId, ids.t, 'Shared task')

    await titleBox(one).fill('Title from device 1')
    await one.keyboard.press('Enter')
    await expect.poll(() => titleOf(ids.t), LONG).toBe('Title from device 1')

    // Device 2 never saw that: it still shows the old title, and writes its own on top.
    await expect(titleBox(two)).toHaveValue('Shared task')
    await titleBox(two).fill('Title from device 2')
    await two.keyboard.press('Enter')
    await expect.poll(() => titleOf(ids.t), LONG).toBe('Title from device 2')

    // Known limit, documented here: no merge and no conflict message, the later write stands.
    for (const page of [one, two]) {
      await page.reload()
      await expect(titleBox(page)).toHaveValue('Title from device 2', LONG)
    }
    expect(await titleOf(ids.t)).toBe('Title from device 2')
  })

  test('D4: a task deleted on device 2 is not brought back by an edit on device 1, and the text is kept', async ({
    device,
  }) => {
    const { projectId, ids } = await createTestProject('A', {
      label: 'D4',
      tasks: [
        { key: 'gone', title: 'Doomed task' },
        { key: 'stay', title: 'Other task' },
      ],
    })
    const one = await device('A')
    const two = await device('A')
    await openTask(one, projectId, ids.gone, 'Doomed task')
    await openList(two, projectId)
    await expect.poll(() => rowTitles(listScroll(two))).toEqual(['Doomed task', 'Other task'])

    // Device 2 deletes it through the app.
    await taskRow(two, 'Doomed task').click({ button: 'right' })
    await two.getByRole('menuitem', { name: 'Delete task…' }).click()
    await two
      .getByRole('alertdialog')
      .getByRole('button', { name: /^Delete/ })
      .click()
    await expect.poll(() => rowTitles(listScroll(two)), LONG).toEqual(['Other task'])
    const token = await tokenFor('A')
    await expect
      .poll(async () => (await rest(token, `tasks?id=eq.${ids.gone}&select=id`)).body, LONG)
      .toEqual([])

    // Device 1 still has the old page open and edits the deleted task.
    await descriptionBox(one).fill('Text for a task that is gone')
    await titleBox(one).click()
    await expect(toast(one, /Couldn.t save|no longer exists/)).toBeVisible(LONG)
    // Honest: the text is still on screen and marked as not saved.
    await expect(modal(one)).toContainText('Your text is kept here.')
    await expect(descriptionBox(one)).toHaveValue('Text for a task that is gone')

    // The task did not come back, on the server or anywhere else.
    expect((await rest(token, `tasks?id=eq.${ids.gone}&select=id`)).body).toEqual([])
    expect((await rest(token, `tasks?project_id=eq.${projectId}&select=title`)).body).toEqual([
      { title: 'Other task' },
    ])
    await one.waitForTimeout(2_000)
    expect((await rest(token, `tasks?id=eq.${ids.gone}&select=id`)).body).toEqual([])
  })
})
