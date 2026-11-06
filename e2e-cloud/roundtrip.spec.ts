/// <reference lib="dom" />
/**
 * Cloud mode, the full data round trip through real Postgres (PRD §5.4, §9.1 AC-2…AC-10, §9.2): each
 * action goes through the real UI and SupabaseRepository to the migrated schema, is checked in the
 * database, and must look the same after a reload, which reads it back from the server.
 */
import { readFileSync } from 'node:fs'
import { type Download, type Locator, type Page } from '@playwright/test'
import {
  accessToken,
  expect,
  expectShell,
  listScroll,
  phaseGroup,
  rest,
  rowTitles,
  seedProject,
  signUpNew,
  sim,
  syncIndicator,
  taskRow,
  test,
  toast,
  userId,
} from './support.ts'

const NOW = '2026-11-04T10:00:00+08:00'
const DAY_PX = 36

test.use({ timezoneId: 'Asia/Taipei', locale: 'en-US', viewport: { width: 1280, height: 800 } })

const editModal = (page: Page, title: string) =>
  page.getByRole('dialog', { name: `Edit task: ${title}` })

function modifier(page: Page): Promise<'Meta' | 'Control'> {
  return page.evaluate(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
    const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent
    return /mac|iphone|ipad|ipod/i.test(platform) ? 'Meta' : 'Control'
  })
}

async function expectSaved(page: Page): Promise<void> {
  await expect(syncIndicator(page, 'Saved')).toBeVisible()
}

interface TaskDbRow {
  id: string
  title: string
  status: string
  priority: string
  phase_id: string | null
  parent_task_id: string | null
  start_date: string | null
  due_date: string | null
  sort_order: string
  completed_at: string | null
  description: string | null
  user_id: string
}

const dbTasks = (projectId: string) =>
  sim.sql<TaskDbRow>('select * from public.tasks where project_id = $1 order by sort_order', [
    projectId,
  ])

test.describe('create and edit (AC-2, AC-3, AC-4)', () => {
  test('project, tasks, phase, subtask, milestone, dependency: stored in Postgres, the same after each reload', async ({
    page,
  }) => {
    await page.clock.setFixedTime(NOW)
    const email = await signUpNew(page)
    const owner = await userId(email)

    // A project without phases.
    await page.goto('/projects')
    await page.getByRole('button', { name: 'Create your first project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Research 研究專案')
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/list$/)
    const projectId = /\/projects\/([0-9a-f-]+)\/list$/.exec(page.url())![1]
    await expect(page.getByRole('heading', { name: 'Research 研究專案' })).toBeVisible()
    const [project] = await sim.sql<{ name: string; user_id: string }>(
      'select name, user_id from public.projects where id = $1',
      [projectId],
    )
    expect(project).toEqual({ name: 'Research 研究專案', user_id: owner })

    // Tasks from just a name.
    const first = page.getByRole('textbox', { name: 'Add your first task' })
    await first.fill('Alpha')
    await first.press('Enter')
    const next = page.getByRole('textbox', { name: 'New task' })
    await expect(next).toBeFocused()
    await next.fill('Beta')
    await next.press('Enter')
    await next.fill('Gamma')
    await next.press('Enter')
    await next.press('Escape')
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta', 'Gamma'])
    await expect
      .poll(async () => (await dbTasks(projectId)).map((t) => t.title))
      .toEqual(['Alpha', 'Beta', 'Gamma'])
    expect((await dbTasks(projectId))[0].user_id).toBe(owner)
    await page.reload()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Alpha', 'Beta', 'Gamma'])

    // A phase, and a task moved into it.
    await page.getByRole('button', { name: 'Add phase', exact: true }).click()
    const phaseInput = page.getByRole('textbox', { name: 'New phase name' })
    await phaseInput.fill('Build')
    await phaseInput.press('Enter')
    await phaseInput.press('Escape')
    await expect(phaseGroup(page, 'Build')).toBeVisible()
    await taskRow(page, 'Beta').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to phase' }).hover()
    await page.getByRole('menuitem', { name: 'Build' }).click()
    await expect.poll(() => rowTitles(phaseGroup(page, 'Build'))).toEqual(['Beta'])
    await expectSaved(page)
    await page.reload()
    await expect.poll(() => rowTitles(phaseGroup(page, 'Build'))).toEqual(['Beta'])
    await expect.poll(() => rowTitles(phaseGroup(page, 'No phase'))).toEqual(['Alpha', 'Gamma'])
    const [phase] = await sim.sql<{ id: string; name: string }>(
      'select id, name from public.phases where project_id = $1',
      [projectId],
    )
    expect(phase.name).toBe('Build')
    const beta = (await dbTasks(projectId)).find((t) => t.title === 'Beta')!
    expect(beta.phase_id).toBe(phase.id)

    // Rename the phase.
    await page.getByRole('button', { name: 'Actions for phase Build' }).click()
    await page.getByRole('menuitem', { name: 'Rename phase' }).click()
    const rename = page.getByRole('textbox', { name: 'Phase name' })
    await rename.fill('Ship')
    await rename.press('Enter')
    await expect(phaseGroup(page, 'Ship')).toBeVisible()
    await expectSaved(page)
    await page.reload()
    await expect(phaseGroup(page, 'Ship')).toBeVisible()

    // Subtasks, one level down, carry their parent's phase on the server.
    await taskRow(page, 'Beta').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Add subtask' }).click()
    const subInput = page.getByRole('textbox', { name: 'New subtask of Beta' })
    await subInput.fill('Sub one')
    await subInput.press('Enter')
    await subInput.fill('Sub two')
    await subInput.press('Enter')
    await subInput.press('Escape')
    await expect
      .poll(() => rowTitles(phaseGroup(page, 'Ship')))
      .toEqual(['Beta', '↳ Sub one', '↳ Sub two'])
    await expectSaved(page)
    await page.reload()
    await expect
      .poll(() => rowTitles(phaseGroup(page, 'Ship')))
      .toEqual(['Beta', '↳ Sub one', '↳ Sub two'])
    const subs = (await dbTasks(projectId)).filter((t) => t.parent_task_id === beta.id)
    expect(subs.map((t) => t.title).sort()).toEqual(['Sub one', 'Sub two'])
    expect(subs.every((t) => t.phase_id === phase.id)).toBe(true)

    // A milestone from the project menu.
    await page.getByRole('button', { name: 'Project actions' }).click()
    await page.getByRole('menuitem', { name: 'Add milestone…' }).click()
    const milestone = page.getByRole('dialog', { name: 'New milestone' })
    await milestone.getByRole('textbox', { name: 'Name' }).fill('Kick-off 啟動會議')
    await milestone.getByRole('button', { name: /^Date:/ }).click()
    const picker = page.getByRole('dialog', { name: 'Date', exact: true })
    await picker.getByRole('button', { name: /November 20th, 2026/ }).click()
    await milestone.getByRole('button', { name: 'Create milestone' }).click()
    await expect(milestone).toBeHidden()
    await expect(toast(page, 'Milestone created')).toBeVisible()
    await expect(
      sim.sql('select date::text, name from public.milestones where project_id = $1', [projectId]),
    ).resolves.toEqual([{ date: '2026-11-20', name: 'Kick-off 啟動會議' }])
    await page.reload()
    await expect(page.getByRole('button', { name: /^Milestone Kick-off 啟動會議/ })).toBeVisible()

    // Edit that milestone.
    await page.getByRole('button', { name: /^Milestone Kick-off 啟動會議/ }).click()
    const edit = page.getByRole('dialog', { name: 'Edit milestone' })
    await edit.getByRole('textbox', { name: 'Name' }).fill('Kick-off moved')
    await edit.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(edit).toBeHidden()
    await expect
      .poll(() => sim.sql('select name from public.milestones where project_id = $1', [projectId]))
      .toEqual([{ name: 'Kick-off moved' }])

    // A dependency from the task modal: Alpha blocks Gamma.
    const alphaId = (await dbTasks(projectId)).find((t) => t.title === 'Alpha')!.id
    await page.goto(`/projects/${projectId}/list?task=${alphaId}`)
    const modal = editModal(page, 'Alpha')
    const blocking = modal.getByRole('list', { name: 'Blocking' })
    await blocking.getByRole('button', { name: 'Add a task this one blocks' }).click()
    const linkPicker = page.getByRole('dialog', { name: 'Add a task this one blocks' })
    await linkPicker.getByPlaceholder('Search tasks in this project…').fill('Gamma')
    await linkPicker.getByRole('option', { name: 'Gamma' }).click()
    await expect(blocking.getByRole('button', { name: 'Gamma', exact: true })).toBeVisible()
    await expect
      .poll(() =>
        sim.sql(
          `select p.title as from, s.title as to, d.type from public.task_dependencies d
           join public.tasks p on p.id = d.predecessor_id join public.tasks s on s.id = d.successor_id
           where d.project_id = $1`,
          [projectId],
        ),
      )
      .toEqual([{ from: 'Alpha', to: 'Gamma', type: 'FS' }])

    // Every field of a task, saved as it is left; a deep link keeps the modal across a reload.
    await page.reload()
    await expect(
      editModal(page, 'Alpha')
        .getByRole('list', { name: 'Blocking' })
        .getByRole('button', { name: 'Gamma', exact: true }),
    ).toBeVisible()
    const open = page.getByRole('dialog')
    await open.getByRole('textbox', { name: 'Task title' }).fill('Alpha 2')
    await open.getByRole('textbox', { name: /Description/ }).fill('Details with "quotes" and 中文')
    await open.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(open).toBeHidden() // Done closes the modal; the text was handed over on the way
    await expect
      .poll(() =>
        sim.sql(
          'select title, description from public.tasks where project_id = $1 and title like $2',
          [projectId, 'Alpha%'],
        ),
      )
      .toEqual([{ title: 'Alpha 2', description: 'Details with "quotes" and 中文' }])

    // Removing the dependency.
    await page.goto(`/projects/${projectId}/list?task=${alphaId}`)
    await editModal(page, 'Alpha 2')
      .getByRole('list', { name: 'Blocking' })
      .getByRole('button', { name: 'Remove “Gamma” from Blocking' })
      .click()
    await expect
      .poll(() =>
        sim.sql('select id from public.task_dependencies where project_id = $1', [projectId]),
      )
      .toEqual([])
  })
})

test.describe('edits and order', () => {
  test('project fields and order, phase order, task dates and priority: stored, the same after a reload', async ({
    page,
  }) => {
    await page.clock.setFixedTime(NOW)
    const email = await signUpNew(page)
    const owner = await userId(email)
    const { projectId, ids } = await seedProject(page, {
      name: 'First',
      phases: ['One', 'Two'],
      tasks: [{ key: 'a', title: 'Alpha', phase: 'One' }],
    })
    const second = await seedProject(page, { name: 'Second' })

    // Project fields through the dialog.
    await page.goto('/projects')
    const table = page.getByRole('table', { name: 'Projects' })
    const row = (name: string) =>
      table.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) })
    await row('First').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit project…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit project' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('First renamed')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog).toBeHidden()
    await expect
      .poll(() => sim.sql('select name from public.projects where id = $1', [projectId]))
      .toEqual([{ name: 'First renamed' }])

    // Status: completed leaves the Active list, on the server too.
    await row('Second').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Mark completed' }).click()
    await expect
      .poll(() => sim.sql('select status from public.projects where id = $1', [second.projectId]))
      .toEqual([{ status: 'completed' }])
    await expect(row('Second')).toHaveCount(0)
    await page.reload()
    await expect(row('First renamed')).toBeVisible()
    await expect(row('Second')).toHaveCount(0)

    // Back to active, then the order: Move down is stored as sort keys.
    await page.goto('/projects?status=completed')
    await row('Second').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Mark active|Reopen/ }).click()
    await expect
      .poll(() => sim.sql('select status from public.projects where id = $1', [second.projectId]))
      .toEqual([{ status: 'active' }])
    await page.goto('/projects')
    const names = () => table.getByRole('link').allInnerTexts()
    await expect.poll(names).toHaveLength(2)
    const [top, bottom] = await names()
    await row(top).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move down' }).click()
    await expect.poll(names).toEqual([bottom, top])
    await expect(syncIndicator(page, 'Saved')).toBeVisible()
    await expect
      .poll(async () =>
        (
          await sim.sql<{ name: string }>(
            'select name from public.projects where user_id = $1 order by sort_order',
            [owner],
          )
        ).map((project) => project.name),
      )
      .toEqual([bottom, top])
    await page.reload()
    await expect.poll(names).toEqual([bottom, top])

    // Phase order.
    await page.goto(`/projects/${projectId}/list`)
    await page.getByRole('button', { name: 'Actions for phase One' }).click()
    await page.getByRole('menuitem', { name: 'Move phase down' }).click()
    await expect
      .poll(async () =>
        (
          await sim.sql<{ name: string }>(
            'select name from public.phases where project_id = $1 order by sort_order',
            [projectId],
          )
        ).map((phase) => phase.name),
      )
      .toEqual(['Two', 'One'])

    // Task fields in the modal: the calendar dates arrive exactly as picked.
    await page.goto(`/projects/${projectId}/list?task=${ids.a}`)
    const modal = editModal(page, 'Alpha')
    await modal.getByRole('button', { name: /^Start date:/ }).click()
    await page
      .getByRole('dialog', { name: 'Start date', exact: true })
      .getByRole('button', { name: /November 20th, 2026/ })
      .click()
    await modal.getByRole('button', { name: /^Due date:/ }).click()
    await page
      .getByRole('dialog', { name: 'Due date', exact: true })
      .getByRole('button', { name: /November 25th, 2026/ })
      .click()
    await modal.getByRole('button', { name: /^Priority:/ }).click()
    await page.getByRole('menuitemradio', { name: /Urgent/ }).click()
    await modal.getByRole('button', { name: 'Done', exact: true }).click()
    await expect
      .poll(() =>
        sim.sql(
          'select start_date::text, due_date::text, priority from public.tasks where id = $1',
          [ids.a],
        ),
      )
      .toEqual([{ start_date: '2026-11-20', due_date: '2026-11-25', priority: 'urgent' }])
    await expect(modal).toBeHidden() // Done closes the modal
    await page.goto(`/projects/${projectId}/list?task=${ids.a}`)
    const reopened = editModal(page, 'Alpha')
    await expect(reopened.getByRole('button', { name: 'Priority: Urgent' })).toBeVisible()
    await expect(
      reopened.getByRole('button', { name: 'Start date: Friday, November 20, 2026' }),
    ).toBeVisible()
    await expect(
      reopened.getByRole('button', { name: 'Due date: Wednesday, November 25, 2026' }),
    ).toBeVisible()
  })
})

test.describe('every page reads the same server data (§5.4)', () => {
  test('Overview, My Tasks, Timeline, Search, Board and Gantt agree after a load from Postgres', async ({
    page,
  }) => {
    await page.clock.setFixedTime(NOW)
    await signUpNew(page)
    const { projectId } = await seedProject(page, {
      name: 'Research',
      tasks: [
        { key: 'over', title: 'Late one', due: '2026-11-02' },
        { key: 'today', title: 'Today one', start: '2026-11-03', due: '2026-11-04' },
        { key: 'next', title: 'Next one', due: '2026-11-06', status: 'in_progress' },
        { key: 'done', title: 'Done one', due: '2026-11-03', status: 'done' },
        { key: 'parent', title: 'Parent one' },
        { key: 'sub', title: 'Sub one', parent: 'parent', due: '2026-11-20' },
      ],
      milestones: [{ key: 'm', name: 'Launch', date: '2026-11-30' }],
    })
    // Leaf tasks only: 1 of 5 done, the parent and the milestone do not count.
    await expect(page.getByRole('progressbar', { name: 'Project progress' })).toHaveAttribute(
      'aria-valuenow',
      '20',
    )

    await page.goto('/overview')
    await expectShell(page)
    await expect(page.locator('[data-metric="active"] dd')).toHaveText('1')
    await expect(page.locator('[data-metric="overdue"] dd')).toHaveText('1')
    await expect(page.getByRole('progressbar', { name: 'Research progress' })).toHaveAttribute(
      'aria-valuenow',
      '20',
    )

    await page.goto('/my-tasks/overdue')
    await expectShell(page)
    await expect(page.getByRole('main').getByText('Late one')).toBeVisible()
    await page.goto('/my-tasks/today')
    await expect(page.getByRole('main').getByText('Today one')).toBeVisible()
    await page.goto('/my-tasks/upcoming')
    await expect(page.getByRole('main').getByText('Next one')).toBeVisible()

    await page.goto('/timeline')
    const chart = page.getByRole('region', { name: 'Timeline of all projects' })
    await expect(chart.locator(`[data-project-bar="${projectId}"]`)).toBeVisible()

    await page.keyboard.press(`${await modifier(page)}+k`)
    const search = page.getByRole('dialog').filter({ has: page.getByRole('combobox') })
    await search.getByRole('combobox').fill('Late')
    await expect(search.getByRole('option', { name: /Late one/ })).toBeVisible()
    await page.keyboard.press('Escape')

    await page.goto(`/projects/${projectId}/board`)
    await expect(page.getByRole('region', { name: /^Done 1 task$/ })).toBeVisible()
    await page.goto(`/projects/${projectId}/gantt`)
    await expect(page.getByRole('region', { name: 'Gantt chart' })).toBeVisible()
    await expect(
      page.getByRole('region', { name: 'Gantt chart' }).getByText('Late one').first(),
    ).toBeVisible()
  })
})

test.describe('moves (AC-5, AC-6, AC-7, AC-8)', () => {
  test('List drag reorder is stored and survives a reload; a whole group move too', async ({
    page,
  }) => {
    await signUpNew(page)
    const { projectId, ids } = await seedProject(page, {
      phases: ['Build'],
      tasks: [
        { key: 'a', title: 'Alpha' },
        { key: 'b', title: 'Beta' },
        { key: 'c', title: 'Gamma' },
        { key: 'd', title: 'Delta', phase: 'Build' },
      ],
    })
    await expect
      .poll(() => rowTitles(phaseGroup(page, 'No phase')))
      .toEqual(['Alpha', 'Beta', 'Gamma'])

    const source = taskRow(page, 'Gamma')
    await source.hover()
    const handle = await source.getByRole('button', { name: /^Move / }).boundingBox()
    const target = await taskRow(page, 'Alpha').boundingBox()
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle!.x + handle!.width / 2 + 6, handle!.y - 6, { steps: 3 })
    await page.mouse.move(target!.x + 300, target!.y + target!.height * 0.2, { steps: 14 })
    await expect(page.locator('[id^="DndLiveRegion"]')).toHaveText(/^Gamma is over Alpha\.$/)
    await page.mouse.up()

    await expect
      .poll(() => rowTitles(phaseGroup(page, 'No phase')))
      .toEqual(['Gamma', 'Alpha', 'Beta'])
    await expect
      .poll(async () => {
        const rows = (await dbTasks(projectId)).filter((t) => t.phase_id === null)
        return rows.map((t) => t.title)
      })
      .toEqual(['Gamma', 'Alpha', 'Beta'])
    await expectSaved(page)
    await page.reload()
    await expect
      .poll(() => rowTitles(phaseGroup(page, 'No phase')))
      .toEqual(['Gamma', 'Alpha', 'Beta'])

    // Across groups through the row menu: the phase on the server changes with it.
    await taskRow(page, 'Beta').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to phase' }).hover()
    await page.getByRole('menuitem', { name: 'Build' }).click()
    await expect.poll(() => rowTitles(phaseGroup(page, 'Build'))).toContain('Beta')
    await expect
      .poll(async () => (await dbTasks(projectId)).find((t) => t.id === ids.b)?.phase_id)
      .toBe(ids.Build)
    await page.reload()
    await expect.poll(() => rowTitles(phaseGroup(page, 'Build'))).toContain('Beta')
  })

  test('Board drag To Do → In Progress → Done: status and completed_at on the server, List agrees', async ({
    page,
  }) => {
    await signUpNew(page)
    const { projectId, ids } = await seedProject(
      page,
      {
        tasks: [
          { key: 'a', title: 'Alpha' },
          { key: 'b', title: 'Beta' },
          { key: 'c', title: 'Gamma', status: 'in_progress' },
        ],
      },
      undefined,
    )
    await page.getByRole('link', { name: 'Board', exact: true }).click()
    const column = (name: string) =>
      page.getByRole('region', { name: new RegExp(`^${name} \\d+ tasks?$`) })
    const card = (title: string) => page.getByRole('button', { name: title, exact: true })
    const titles = (region: Locator) =>
      region
        .locator('[data-card-activator]')
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('aria-label') ?? ''),
        )
    async function drag(source: Locator, to: { x: number; y: number }) {
      const box = await source.boundingBox()
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await page.mouse.down()
      await page.mouse.move(box!.x + box!.width / 2 + 6, box!.y + box!.height / 2 + 6, { steps: 3 })
      await page.mouse.move(to.x, to.y, { steps: 12 })
      await page.waitForTimeout(150)
      await page.mouse.up()
    }
    await expect(column('To Do')).toBeVisible()
    const gamma = await card('Gamma').boundingBox()
    await drag(card('Alpha'), { x: gamma!.x + gamma!.width / 2, y: gamma!.y + 6 })
    await expect.poll(() => titles(column('In Progress'))).toEqual(['Alpha', 'Gamma'])
    await expect
      .poll(async () => (await dbTasks(projectId)).find((t) => t.id === ids.a)?.status)
      .toBe('in_progress')
    await expectSaved(page)

    // Into the empty Done column: the database stamps the completion time.
    const done = await column('Done').boundingBox()
    await drag(card('Gamma'), { x: done!.x + done!.width / 2, y: done!.y + 120 })
    await expect.poll(() => titles(column('Done'))).toEqual(['Gamma'])
    await expect
      .poll(async () => {
        const row = (await dbTasks(projectId)).find((t) => t.id === ids.c)
        return [row?.status, row?.completed_at !== null]
      })
      .toEqual(['done', true])
    await expectSaved(page)

    await page.reload()
    await expect.poll(() => titles(column('In Progress'))).toEqual(['Alpha'])
    await expect.poll(() => titles(column('Done'))).toEqual(['Gamma'])
    await page.getByRole('link', { name: 'List', exact: true }).click()
    await expect(
      page.locator(`[data-task-row="${ids.a}"]`).getByRole('button', { name: /^Status:/ }),
    ).toHaveAccessibleName('Status: In Progress')
  })

  async function openGantt(page: Page, projectId: string): Promise<void> {
    await page.goto(`/projects/${projectId}/gantt`)
    await expect(page.getByRole('region', { name: 'Gantt chart' })).toBeVisible()
    await expectShell(page)
  }

  const bar = (page: Page, id: string) => page.locator(`[data-task-id="${id}"][data-link-target]`)

  async function moveBar(page: Page, id: string, days: number): Promise<void> {
    const box = await bar(page, id).boundingBox()
    const from = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + Math.sign(days) * 4, from.y, { steps: 2 })
    await page.mouse.move(from.x + days * DAY_PX, from.y, { steps: 10 })
    await page.mouse.up()
  }

  const dates = async (ids: string[]) =>
    sim.sql<{ id: string; start_date: string; due_date: string }>(
      `select id, start_date::text, due_date::text from public.tasks where id = any($1::uuid[])`,
      [ids],
    )

  async function daySized(page: Page, projectId: string): Promise<void> {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key: 'cairn:gantt-scales',
      value: { [projectId]: 'day' },
    })
  }

  test('Gantt drag moves the dates on the server (no day shift across time zones) and survives a reload', async ({
    page,
  }) => {
    await page.clock.setFixedTime(NOW)
    await signUpNew(page)
    const { projectId, ids } = await seedProject(page, {
      tasks: [{ key: 'a', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' }],
    })
    await daySized(page, projectId)
    await openGantt(page, projectId)
    await expect(bar(page, ids.a)).toHaveAccessibleName('Alpha, Nov 5 – Nov 7, 3 days, To Do')

    await moveBar(page, ids.a, 2)
    await expect(bar(page, ids.a)).toHaveAccessibleName('Alpha, Nov 7 – Nov 9, 3 days, To Do')
    await expect
      .poll(() => dates([ids.a]))
      .toEqual([{ id: ids.a, start_date: '2026-11-07', due_date: '2026-11-09' }])
    await expectSaved(page)
    await page.reload()
    await expect(bar(page, ids.a)).toHaveAccessibleName('Alpha, Nov 7 – Nov 9, 3 days, To Do')
  })

  test('Auto-schedule Apply: one RPC moves the task and its dependents, all in one write', async ({
    page,
  }) => {
    await page.clock.setFixedTime(NOW)
    await signUpNew(page)
    const { projectId, ids } = await seedProject(page, {
      mode: 'auto',
      tasks: [
        { key: 'a', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
        { key: 'b', title: 'Bravo', start: '2026-11-08', due: '2026-11-10' },
        { key: 'c', title: 'Charlie', start: '2026-11-11', due: '2026-11-12' },
      ],
      deps: [
        ['a', 'b'],
        ['b', 'c'],
      ],
    })
    await daySized(page, projectId)
    await openGantt(page, projectId)
    await expect(page.getByRole('button', { name: 'Dependencies: Auto' })).toBeVisible()
    const rpcCalls = async () =>
      (await sim.requests()).filter((r) => r.path === '/rest/v1/rpc/apply_task_schedule').length
    const before = await rpcCalls()

    await moveBar(page, ids.a, 2)
    const dialog = page.getByRole('dialog', { name: 'Move dependent tasks?' })
    await expect(dialog).toBeVisible()
    // Nothing is written while it asks.
    expect(await rpcCalls()).toBe(before)
    await dialog.getByRole('button', { name: 'Apply 3 changes' }).click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(async () => {
        const rows = await dates([ids.a, ids.b, ids.c])
        return Object.fromEntries(rows.map((row) => [row.id, [row.start_date, row.due_date]]))
      })
      .toEqual({
        [ids.a]: ['2026-11-07', '2026-11-09'],
        [ids.b]: ['2026-11-10', '2026-11-12'],
        [ids.c]: ['2026-11-13', '2026-11-14'],
      })
    expect(await rpcCalls()).toBe(before + 1)
    await expectSaved(page)
    await page.reload()
    await expect(bar(page, ids.b)).toHaveAccessibleName('Bravo, Nov 10 – Nov 12, 3 days, To Do')
    await expect(bar(page, ids.c)).toHaveAccessibleName('Charlie, Nov 13 – Nov 14, 2 days, To Do')
    await expect(page.getByRole('button', { name: /conflict/ })).toHaveCount(0)
  })

  test('Manual mode: delaying A warns about B, nothing else changes on the server (AC-8)', async ({
    page,
  }) => {
    await page.clock.setFixedTime(NOW)
    await signUpNew(page)
    const { projectId, ids } = await seedProject(page, {
      tasks: [
        { key: 'a', title: 'Alpha', start: '2026-11-05', due: '2026-11-07' },
        { key: 'b', title: 'Bravo', start: '2026-11-08', due: '2026-11-10' },
      ],
      deps: [['a', 'b']],
    })
    await daySized(page, projectId)
    await openGantt(page, projectId)
    await moveBar(page, ids.a, 3)
    await expect(page.getByRole('button', { name: '1 conflict', exact: true })).toBeVisible()
    await expect.poll(async () => (await dates([ids.a]))[0].start_date).toBe('2026-11-08')
    expect((await dates([ids.b]))[0]).toMatchObject({
      start_date: '2026-11-08',
      due_date: '2026-11-10',
    })
    await page.reload()
    await expect(page.getByRole('button', { name: '1 conflict', exact: true })).toBeVisible()
  })
})

test.describe('deletes (§5.4)', () => {
  test('delete a task keeping its subtasks (RPC): promoted on the server, the same after a reload', async ({
    page,
  }) => {
    await signUpNew(page)
    const { projectId, ids } = await seedProject(page, {
      tasks: [
        { key: 'p', title: 'Parent' },
        { key: 's1', title: 'Sub one', parent: 'p' },
        { key: 's2', title: 'Sub two', parent: 'p' },
        { key: 'o', title: 'Other' },
      ],
    })
    await page.getByRole('button', { name: 'Expand subtasks' }).click()
    await expect
      .poll(() => rowTitles(listScroll(page)))
      .toEqual(['Parent', '↳ Sub one', '↳ Sub two', 'Other'])
    // The simulator's request log spans the whole run: count this test's call only.
    const deleteCalls = async () =>
      (await sim.requests()).filter(
        (r) => r.path === '/rest/v1/rpc/delete_task' && r.status === 204,
      ).length
    const callsBefore = await deleteCalls()
    await taskRow(page, 'Parent').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete task…' }).click()
    await page
      .getByRole('alertdialog', { name: 'Delete “Parent”?' })
      .getByRole('button', { name: 'Keep subtasks' })
      .click()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Sub one', 'Sub two', 'Other'])
    await expect
      .poll(async () => (await dbTasks(projectId)).map((t) => [t.title, t.parent_task_id]))
      .toEqual([
        ['Sub one', null],
        ['Sub two', null],
        ['Other', null],
      ])
    expect(await deleteCalls()).toBe(callsBefore + 1)
    await expectSaved(page)
    await page.reload()
    await expect.poll(() => rowTitles(listScroll(page))).toEqual(['Sub one', 'Sub two', 'Other'])
    expect(ids.p).toBeTruthy()
  })

  test('delete a parent with its subtasks, a phase (ungroups) and a project (cascades)', async ({
    page,
  }) => {
    await signUpNew(page)
    const { projectId } = await seedProject(page, {
      name: 'Doomed project',
      phases: ['Build', 'Empty'],
      tasks: [
        { key: 'p', title: 'Parent', phase: 'Build' },
        { key: 's1', title: 'Sub one', parent: 'p', phase: 'Build' },
        { key: 'o', title: 'Other', phase: 'Build' },
        { key: 'f', title: 'Free' },
      ],
      milestones: [{ key: 'm', name: 'Beta release', date: '2026-12-01', phase: 'Build' }],
      deps: [['o', 'f']],
    })
    await taskRow(page, 'Parent').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete task…' }).click()
    await page
      .getByRole('alertdialog', { name: 'Delete “Parent”?' })
      .getByRole('button', { name: /Delete/ })
      .last()
      .click()
    await expect.poll(() => rowTitles(phaseGroup(page, 'Build'))).toEqual(['Other'])
    await expect
      .poll(async () => (await dbTasks(projectId)).map((t) => t.title).sort())
      .toEqual(['Free', 'Other'])
    await expectSaved(page)
    await page.reload()
    await expect.poll(() => rowTitles(phaseGroup(page, 'Build'))).toEqual(['Other'])

    // Delete a phase: its task and milestone stay, ungrouped.
    await page.getByRole('button', { name: 'Actions for phase Build' }).click()
    await page.getByRole('menuitem', { name: 'Delete phase…' }).click()
    const phaseConfirm = page.getByRole('alertdialog', { name: 'Delete phase “Build”?' })
    await expect(phaseConfirm).toContainText('Its 1 task and 1 milestone become ungrouped')
    await phaseConfirm.getByRole('button', { name: 'Delete phase' }).click()
    await expect(phaseGroup(page, 'Build')).toHaveCount(0)
    await expect
      .poll(async () => (await dbTasks(projectId)).map((t) => t.phase_id))
      .toEqual([null, null])
    await expect(
      sim.sql('select phase_id from public.milestones where project_id = $1', [projectId]),
    ).resolves.toEqual([{ phase_id: null }])
    await expectSaved(page)
    await page.reload()
    await expect(phaseGroup(page, 'Build')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Move Other' })).toBeVisible()

    // Delete the project: the dialog names the impact, the database cascades.
    await page.getByRole('button', { name: 'Project actions' }).click()
    await page.getByRole('menuitem', { name: /Delete project/ }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText('Doomed project')
    await expect(confirm).toContainText(/2 tasks/)
    await confirm.getByRole('button', { name: /Delete project/ }).click()
    await expect(page).toHaveURL(/\/projects$/)
    await expect
      .poll(() =>
        sim.sql(
          `select (select count(*) from public.projects where id = $1)::int as projects,
                  (select count(*) from public.phases where project_id = $1)::int as phases,
                  (select count(*) from public.tasks where project_id = $1)::int as tasks,
                  (select count(*) from public.milestones where project_id = $1)::int as milestones,
                  (select count(*) from public.task_dependencies where project_id = $1)::int as deps`,
          [projectId],
        ),
      )
      .toEqual([{ projects: 0, phases: 0, tasks: 0, milestones: 0, deps: 0 }])
    await page.reload()
    await expectShell(page)
    await expect(page.getByText('Doomed project')).toHaveCount(0)
  })
})

test.describe('preferences and backup', () => {
  test('theme, week start, time zone and sidebar: stored per account, the same after a reload', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    await page.goto('/settings/appearance')
    await expectShell(page)
    const theme = page.getByRole('radiogroup', { name: 'Theme' })
    await theme.getByRole('radio', { name: 'Dark' }).click()
    const owner = await userId(email)
    const stored = () =>
      sim.sql(
        'select theme, week_starts_on, timezone, sidebar_collapsed from public.user_preferences where user_id = $1',
        [owner],
      )
    await expect.poll(async () => (await stored())[0]?.theme).toBe('dark')
    const week = page.getByRole('radiogroup', { name: 'Week starts on' })
    await week.getByRole('radio', { name: 'Sunday' }).click()
    const zone = page.getByRole('combobox', { name: /^Time zone:/ })
    await zone.click()
    await page.getByRole('combobox', { name: 'Time zones' }).fill('new york')
    await page.getByRole('option', { name: /America\/New York/ }).click()
    await expect(zone).toContainText('America/New York')
    await page.getByRole('button', { name: /Collapse sidebar/ }).click()
    await expect(syncIndicator(page, /Sync status: Saved/)).toBeVisible()
    await expect
      .poll(stored)
      .toEqual([
        { theme: 'dark', week_starts_on: 0, timezone: 'America/New_York', sidebar_collapsed: true },
      ])

    await page.reload()
    await expect(
      page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }),
    ).toBeChecked()
    await expect(
      page
        .getByRole('radiogroup', { name: 'Week starts on' })
        .getByRole('radio', { name: 'Sunday' }),
    ).toBeChecked()
    await expect(page.getByRole('combobox', { name: /^Time zone:/ })).toContainText(
      'America/New York',
    )
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
      true,
    )
  })

  test('export JSON, import it through the RPC as new copies: counted, stored, shown after a reload', async ({
    page,
  }) => {
    const email = await signUpNew(page)
    const owner = await userId(email)
    const { projectId, ids } = await seedProject(page, {
      name: 'Original',
      phases: ['Build'],
      tasks: [
        { key: 'p', title: 'Parent', phase: 'Build', start: '2026-11-05', due: '2026-11-07' },
        { key: 's', title: 'Sub', parent: 'p', phase: 'Build' },
        { key: 'o', title: 'Other', status: 'done' },
      ],
      milestones: [{ key: 'm', name: 'Beta', date: '2026-12-01', phase: 'Build' }],
      deps: [['p', 'o']],
    })
    await page.goto('/settings/data')
    await expectShell(page)
    const [download]: [Download, void] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    const text = readFileSync(await download.path(), 'utf8')
    expect(JSON.parse(text).data.tasks).toHaveLength(3)

    await page.getByLabel('Backup file').setInputFiles({
      name: 'my-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    })
    const dialog = page.getByRole('dialog', { name: 'Import backup' })
    await dialog.getByRole('button', { name: 'Import as new copies' }).click()
    await expect(dialog).toBeHidden()
    await expect(toast(page, 'Backup imported')).toContainText(
      'Added 1 project, 1 phase, 3 tasks, 1 milestone and 1 dependency as new copies.',
    )
    await expect(
      sim.sql(
        `select (select count(*) from public.projects where user_id = $1)::int as projects,
                (select count(*) from public.phases where user_id = $1)::int as phases,
                (select count(*) from public.tasks where user_id = $1)::int as tasks,
                (select count(*) from public.milestones where user_id = $1)::int as milestones,
                (select count(*) from public.task_dependencies where user_id = $1)::int as deps`,
        [owner],
      ),
    ).resolves.toEqual([{ projects: 2, phases: 2, tasks: 6, milestones: 2, deps: 2 }])
    // The originals are untouched; the copies have fresh ids and keep their structure and dates.
    const copies = await sim.sql<TaskDbRow & { start: string | null }>(
      `select t.*, t.start_date::text as start from public.tasks t where t.user_id = $1 and t.project_id <> $2`,
      [owner, projectId],
    )
    expect(copies.map((t) => t.id)).not.toContain(ids.p)
    const parentCopy = copies.find((t) => t.title === 'Parent')!
    expect(parentCopy.start).toBe('2026-11-05')
    expect(copies.find((t) => t.title === 'Sub')?.parent_task_id).toBe(parentCopy.id)
    expect(copies.find((t) => t.title === 'Other')?.status).toBe('done')

    await page.goto('/projects')
    await expectShell(page)
    await expect(page.getByRole('main').getByRole('link', { name: /^Original/ })).toHaveCount(2)
    await page.reload()
    await expect(page.getByRole('main').getByRole('link', { name: /^Original/ })).toHaveCount(2)
    expect(await rest(await accessToken(page), `projects?id=eq.${projectId}&select=name`)).toEqual({
      status: 200,
      body: [{ name: 'Original' }],
    })
  })
})
