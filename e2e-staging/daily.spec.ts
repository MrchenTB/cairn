/// <reference lib="dom" />
/**
 * The first day of real use, through the app's own screens against the real database: the other
 * specs seed their projects through the import RPC, so without this file the app's own inserts,
 * deletes and preference writes would never have reached a real PostgREST.
 */
import type { Page } from '@playwright/test'
import {
  expect,
  expectShell,
  listScroll,
  rest,
  rowTitles,
  submitSignIn,
  test,
  testProjectName,
  toast,
  tokenFor,
  account,
} from './support.ts'

const rows = async <Row>(token: string, path: string): Promise<Row[]> => {
  const answer = await rest(token, path)
  expect(answer.status, `GET ${path.split('?')[0]}`).toBe(200)
  return answer.body as Row[]
}

const phaseGroup = (page: Page, name: string) =>
  page.getByRole('region', { name: new RegExp(`^${name}, \\d+ tasks?$`) })

async function createProject(page: Page, label: string): Promise<{ id: string; name: string }> {
  const name = testProjectName(label)
  await page.goto('/projects')
  await expectShell(page)
  await page.getByRole('button', { name: 'Create your first project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/list$/)
  return { id: /\/projects\/([0-9a-f-]+)\/list$/.exec(page.url())![1], name }
}

async function addTasks(page: Page, titles: string[]): Promise<void> {
  const [first, ...rest_] = titles
  const opening = page.getByRole('textbox', { name: 'Add your first task' })
  await opening.fill(first)
  await opening.press('Enter')
  const next = page.getByRole('textbox', { name: 'New task' })
  await expect(next).toBeFocused()
  for (const title of rest_) {
    await next.fill(title)
    await next.press('Enter')
  }
  await next.press('Escape')
  await expect.poll(() => rowTitles(listScroll(page))).toEqual(titles)
}

async function addPhase(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Add phase', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'New phase name' })
  await input.fill(name)
  await input.press('Enter')
  await input.press('Escape')
  await expect(phaseGroup(page, name)).toBeVisible()
}

test.describe('the first day of use, through the app (C)', () => {
  test('C1: project, tasks, phase and phase colour are stored and survive a reload', async ({
    device,
  }) => {
    const page = await device('A')
    const token = await tokenFor('A')
    const project = await createProject(page, 'C1 研究專案')
    await expect(page.getByRole('heading', { name: project.name })).toBeVisible()
    const [stored] = await rows<{ name: string; user_id: string }>(
      token,
      `projects?id=eq.${project.id}&select=name,user_id`,
    )
    expect(stored.name).toBe(project.name)

    await addTasks(page, ['Alpha 任務', 'Beta', 'Gamma'])
    await expect
      .poll(async () =>
        (await rows<{ title: string }>(token, `tasks?project_id=eq.${project.id}&select=title`))
          .map((task) => task.title)
          .sort(),
      )
      .toEqual(['Alpha 任務', 'Beta', 'Gamma'])

    await addPhase(page, 'Design')
    await expect
      .poll(async () =>
        rows<{ name: string; color: string | null }>(
          token,
          `phases?project_id=eq.${project.id}&select=name,color`,
        ),
      )
      .toEqual([{ name: 'Design', color: null }])

    // Pick a colour for the phase in the list.
    await page.reload()
    await expectShell(page)
    await page
      .getByRole('button', { name: /^Color of Design:/ })
      .first()
      .click()
    await page.getByRole('radio', { name: 'Teal' }).click()
    await expect
      .poll(async () =>
        rows<{ color: string | null }>(token, `phases?project_id=eq.${project.id}&select=color`),
      )
      .toEqual([{ color: 'teal' }])

    await page.reload()
    await expectShell(page)
    await expect(page.getByRole('button', { name: /^Color of Design: Teal/ })).toBeVisible()

    // Back to the project's own colour: NULL in the database.
    await page.getByRole('button', { name: /^Color of Design: Teal/ }).click()
    await page.getByRole('button', { name: 'Use project color' }).click()
    await expect
      .poll(async () =>
        rows<{ color: string | null }>(token, `phases?project_id=eq.${project.id}&select=color`),
      )
      .toEqual([{ color: null }])
  })

  test('C2: subtask, dependency and milestone are stored; the link can be removed again', async ({
    device,
  }) => {
    const page = await device('A')
    const token = await tokenFor('A')
    const project = await createProject(page, 'C2')
    await addTasks(page, ['First', 'Second'])
    // The screen updates at once; on a real network the rows arrive a moment later.
    const readTasks = () =>
      rows<{ id: string; title: string }>(
        token,
        `tasks?project_id=eq.${project.id}&select=id,title`,
      )
    await expect.poll(async () => (await readTasks()).length).toBe(2)
    const tasks = await readTasks()
    const second = tasks.find((task) => task.title === 'Second')!
    const first = tasks.find((task) => task.title === 'First')!

    await page.goto(`/projects/${project.id}/list?task=${second.id}`)
    const modal = page.getByRole('dialog', { name: /^Edit task:/ })
    const add = modal.getByRole('textbox', { name: 'Add subtask' })
    await add.fill('A subtask')
    await add.press('Enter')
    await expect
      .poll(async () =>
        rows<{ title: string; parent_task_id: string | null }>(
          token,
          `tasks?parent_task_id=eq.${second.id}&select=title,parent_task_id`,
        ),
      )
      .toEqual([{ title: 'A subtask', parent_task_id: second.id }])

    await modal.getByRole('button', { name: 'Add a task that blocks this one' }).click()
    await page
      .getByRole('dialog', { name: 'Add a task that blocks this one' })
      .getByRole('option', { name: /First/ })
      .click()
    const links = () =>
      rows<{ predecessor_id: string; successor_id: string }>(
        token,
        `task_dependencies?project_id=eq.${project.id}&select=predecessor_id,successor_id`,
      )
    await expect.poll(links).toEqual([{ predecessor_id: first.id, successor_id: second.id }])
    await modal.getByRole('button', { name: 'Remove “First” from Blocked by' }).click()
    await expect.poll(links).toEqual([])
    await modal.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(modal).toBeHidden()

    await page.getByRole('button', { name: 'Project actions' }).click()
    await page.getByRole('menuitem', { name: 'Add milestone…' }).click()
    const milestone = page.getByRole('dialog', { name: 'New milestone' })
    await milestone.getByRole('textbox', { name: 'Name' }).fill('Kick-off 啟動會議')
    await milestone.getByRole('button', { name: /^Date:/ }).click()
    const picker = page.getByRole('dialog', { name: 'Date', exact: true })
    await picker.getByRole('button', { name: /^Today,/ }).click()
    await milestone.getByRole('button', { name: 'Create milestone' }).click()
    await expect(milestone).toBeHidden()
    await expect
      .poll(async () =>
        (
          await rows<{ name: string }>(token, `milestones?project_id=eq.${project.id}&select=name`)
        ).map((row) => row.name),
      )
      .toEqual(['Kick-off 啟動會議'])
  })

  test('C3: deleting a task, a phase and a project goes all the way to the database', async ({
    device,
  }) => {
    const page = await device('A')
    const token = await tokenFor('A')
    const project = await createProject(page, 'C3')
    await addTasks(page, ['Keep me', 'Delete me'])
    await addPhase(page, 'Temporary')
    const titles = async () =>
      (await rows<{ title: string }>(token, `tasks?project_id=eq.${project.id}&select=title`))
        .map((task) => task.title)
        .sort()
    await expect.poll(titles).toEqual(['Delete me', 'Keep me'])

    // A task, through the Task Modal.
    const [doomed] = await rows<{ id: string }>(
      token,
      `tasks?project_id=eq.${project.id}&title=eq.${encodeURIComponent('Delete me')}&select=id`,
    )
    await page.goto(`/projects/${project.id}/list?task=${doomed.id}`)
    const modal = page.getByRole('dialog', { name: /^Edit task:/ })
    await modal.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: /Delete task/ }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(titles).toEqual(['Keep me'])

    // A phase.
    await page.getByRole('button', { name: 'Actions for phase Temporary' }).click()
    await page.getByRole('menuitem', { name: 'Delete phase…' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete phase' }).click()
    await expect
      .poll(async () => rows(token, `phases?project_id=eq.${project.id}&select=id`))
      .toEqual([])

    // The project, and its tasks with it.
    await page.getByRole('button', { name: 'Project actions' }).click()
    await page.getByRole('menuitem', { name: 'Delete project…' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete project' }).click()
    await expect.poll(async () => rows(token, `projects?id=eq.${project.id}&select=id`)).toEqual([])
    expect(await rows(token, `tasks?project_id=eq.${project.id}&select=id`)).toEqual([])
  })

  test('C4: a preference is stored for the account, and only the changed field is sent', async ({
    device,
  }) => {
    const page = await device('A')
    const token = await tokenFor('A')
    const read = async () =>
      (
        await rows<{ theme: string; timezone: string }>(
          token,
          'user_preferences?select=theme,timezone',
        )
      )[0]
    const before = await read()
    try {
      await page.goto('/settings/appearance')
      await expectShell(page)
      const theme = page.getByRole('radiogroup', { name: 'Theme' })
      const wanted = before.theme === 'dark' ? 'Light' : 'Dark'
      await theme.getByRole('radio', { name: wanted }).click()
      await expect.poll(async () => (await read()).theme).toBe(wanted.toLowerCase())
      expect((await read()).timezone).toBe(before.timezone)
    } finally {
      await rest(token, 'user_preferences?user_id=not.is.null', {
        method: 'PATCH',
        body: { theme: before.theme },
        prefer: 'return=minimal',
      })
    }
  })

  test('C5: signing in through the form and signing out; a signed-out browser sees no data', async ({
    device,
  }) => {
    const page = await device(null)
    await page.goto('/login')
    const { email, password } = account('B')
    await submitSignIn(page, email, password)
    await expect(page).not.toHaveURL(/\/login/)
    await expectShell(page)

    await page.goto('/settings/account')
    await expectShell(page)
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Sign out', exact: true })
      .click()
    await expect(page).toHaveURL(/\/login/)

    // No way back in without signing in again, and no session left in the browser.
    await page.goto('/projects')
    await expect(page).toHaveURL(/\/login/)
    const left = await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => /^sb-.+-auth-token$/.test(key)),
    )
    expect(left).toEqual([])
    await expect(toast(page, /Couldn.t/)).toHaveCount(0)
  })
})
