/// <reference lib="dom" />
/**
 * New phases get a distinct default colour (UX-04, D37), in the real page:
 * - the List's inline "Add phase" and the "Add phase…" dialog pick the same next colour;
 * - what is saved survives a reload and shows the same in the List, the Board and the Gantt;
 * - "Use project color" in the dialog saves null; the existing phase is never recoloured.
 * The seeded project is violet with one phase "Design" that follows it (null → shown violet).
 */
import {
  expect,
  LOCAL_WORKSPACE_KEY,
  NOW,
  seedWorkspace,
  test,
} from './acceptance-gantt.helpers.ts'
import type { Page } from '@playwright/test'

test.use({ timezoneId: 'Asia/Taipei', locale: 'en-US', viewport: { width: 1280, height: 800 } })

const seed = seedWorkspace({
  tasks: [{ key: 'a', title: 'Wireframes', start: '2026-11-04', due: '2026-11-08', phase: true }],
})

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW)
  await page.addInitScript(
    ({ key, db }) => {
      if (sessionStorage.getItem('cairn-e2e-seeded')) return
      localStorage.setItem(key, JSON.stringify(db))
      sessionStorage.setItem('cairn-e2e-seeded', '1')
    },
    { key: LOCAL_WORKSPACE_KEY, db: seed.db },
  )
})

/** Saved colour of each phase by name. */
const storedColors = (page: Page) =>
  page.evaluate((key) => {
    const db = JSON.parse(localStorage.getItem(key) ?? '{}') as {
      phases?: Record<string, { name: string; color?: string | null }>
    }
    return Object.fromEntries(
      Object.values(db.phases ?? {}).map((phase) => [phase.name, phase.color ?? null]),
    )
  }, LOCAL_WORKSPACE_KEY)

async function addPhaseFromDialog(page: Page, name: string) {
  await page.getByRole('button', { name: 'Project actions' }).click()
  await page.getByRole('menuitem', { name: 'Add phase…' }).click()
  const dialog = page.getByRole('dialog', { name: 'New phase' })
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
  return dialog
}

test('inline "Add phase": each new phase a different colour; kept after a reload, same in every view', async ({
  page,
}) => {
  await page.goto(`/projects/${seed.projectId}/list`)
  await page.getByRole('button', { name: 'Add phase', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'New phase name' })
  for (const name of ['Build', 'Test', 'Ship']) {
    await input.fill(name)
    await input.press('Enter')
  }
  await input.press('Escape')

  // Design shows violet (the project's), so Build starts the palette; none repeats its neighbour.
  const expected = { Design: null, Build: 'blue', Test: 'pink', Ship: 'orange' }
  await expect.poll(() => storedColors(page)).toEqual(expected)
  await expect(
    page.getByRole('button', { name: /^Color of Design: Project color \(Violet\)/ }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /^Color of Build: Blue/ })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('button', { name: /^Color of Ship: Orange/ })).toBeVisible()
  expect(await storedColors(page)).toEqual(expected)

  // Board: the phase filter lists each phase with its dot.
  await page.goto(`/projects/${seed.projectId}/board`)
  await page.getByRole('combobox', { name: /^Phase filter/ }).click()
  const dot = (name: string) =>
    page.getByRole('option', { name }).locator('[data-color]').getAttribute('data-color')
  expect(await dot('Design')).toBe('violet')
  expect(await dot('Build')).toBe('blue')
  expect(await dot('Test')).toBe('pink')
  expect(await dot('Ship')).toBe('orange')
  await page.keyboard.press('Escape')

  // Gantt: the phase rows carry the same colours.
  await page.goto(`/projects/${seed.projectId}/gantt`)
  await expect(
    page.getByRole('button', { name: /^Color of Design: Project color \(Violet\)/ }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /^Color of Build: Blue/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Color of Test: Pink/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Color of Ship: Orange/ })).toBeVisible()
})

test('"Add phase…" dialog: suggests the same colour as the inline row; "Use project color" saves null', async ({
  page,
}) => {
  await page.goto(`/projects/${seed.projectId}/list`)

  // Same state as the inline test's first phase → the same suggestion, preselected.
  let dialog = await addPhaseFromDialog(page, 'Build')
  await expect(dialog.getByRole('radio', { name: 'Blue' })).toBeChecked()
  await dialog.getByRole('button', { name: 'Add phase' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(() => storedColors(page)).toEqual({ Design: null, Build: 'blue' })

  // Next suggestion moves on; the user overrides it with "Use project color".
  dialog = await addPhaseFromDialog(page, 'Test')
  await expect(dialog.getByRole('radio', { name: 'Pink' })).toBeChecked()
  await dialog.getByRole('button', { name: 'Use project color' }).click()
  await expect(dialog.getByRole('radio', { checked: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Add phase' }).click()
  await expect(dialog).toBeHidden()

  // A colour picked by hand is saved as picked.
  dialog = await addPhaseFromDialog(page, 'Ship')
  await dialog.getByRole('radio', { name: 'Teal' }).click()
  await dialog.getByRole('button', { name: 'Add phase' }).click()
  await expect(dialog).toBeHidden()

  const expected = { Design: null, Build: 'blue', Test: null, Ship: 'teal' }
  await expect.poll(() => storedColors(page)).toEqual(expected)
  await page.reload()
  await expect(
    page.getByRole('button', { name: /^Color of Test: Project color \(Violet\)/ }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /^Color of Ship: Teal/ })).toBeVisible()
  expect(await storedColors(page)).toEqual(expected)
})
