/// <reference lib="dom" />
/**
 * P1-P3: size and speed. P1 asserts that nothing is cut off at the server's row limit; P2 and P3
 * only record how long things take (test-results/staging/metrics.json, printed at the end), as a
 * baseline for later runs. The set-up (thousands of tasks) is made by plain inserts in batches.
 */
import {
  countRows,
  createBulkProject,
  createTestProject,
  expect,
  expectShell,
  listScroll,
  median,
  recordMetric,
  rest,
  test,
  tokenFor,
} from './support.ts'

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } })

/** The Projects page row of a project: "<open> open of <total> tasks". */
const totalOf = async (page: import('@playwright/test').Page, name: string) => {
  const row = page.getByRole('main').getByRole('row').filter({ hasText: name })
  const text = (await row.innerText()).replace(/\s+/g, ' ')
  return Number(/of ([\d,]+) tasks?/.exec(text)?.[1]?.replace(/,/g, ''))
}

test.describe('size and speed (P)', () => {
  test('P1: 1,250 tasks in one project are all read, not cut off at 1,000', async ({ device }) => {
    test.setTimeout(300_000)
    const { projectId, name } = await createBulkProject('A', 'P1', 1250)
    const token = await tokenFor('A')
    expect(await countRows(token, 'tasks', `project_id=eq.${projectId}`)).toBe(1250)
    // What one plain request returns: the server's row limit, which the app has to page around.
    const plain = await rest(token, `tasks?project_id=eq.${projectId}&select=id`)
    const cutAt = Array.isArray(plain.body) ? plain.body.length : 0

    const page = await device('A')
    await page.goto('/projects')
    await expectShell(page)
    await expect.poll(() => totalOf(page, name), { timeout: 60_000 }).toBe(1250)

    // And the last task is really there when the List is scrolled to its end.
    await page.goto(`/projects/${projectId}/list`)
    await expectShell(page)
    await listScroll(page).evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(
      page.getByRole('button', { name: 'Move Bulk task 01250', exact: true }),
    ).toBeVisible({ timeout: 30_000 })
    recordMetric({
      id: 'P1',
      name: 'tasks the app shows (of 1,250)',
      value: 1250,
      unit: 'tasks',
      note:
        cutAt < 1250
          ? `one plain read is cut at ${cutAt} rows; the app read them all`
          : 'the server returned all 1,250 in one read, so paging was not exercised',
    })
  })

  test('P2: cold load with 2,000 tasks (the time is recorded; over 5 s is reported)', async ({
    device,
  }) => {
    test.setTimeout(300_000)
    const { projectId } = await createBulkProject('A', 'P2', 2000)
    const page = await device('A') // a new context: nothing cached

    const started = performance.now()
    await page.goto(`/projects/${projectId}/list`)
    await expectShell(page)
    await expect(page.locator('[data-task-row]').first()).toBeVisible({ timeout: 120_000 })
    const ms = performance.now() - started
    recordMetric({
      id: 'P2',
      name: 'cold load, 2,000 tasks',
      value: ms,
      unit: 'ms',
      note: ms > 5000 ? 'OVER 5 s: report this' : 'under 5 s',
    })
  })

  test('P3: ten single-field writes over REST: median and slowest are recorded', async () => {
    const { ids } = await createTestProject('A', {
      label: 'P3',
      tasks: [{ key: 't', title: 'Timed' }],
    })
    const token = await tokenFor('A')
    const times: number[] = []
    for (let index = 1; index <= 10; index += 1) {
      const started = performance.now()
      const answer = await rest(token, `tasks?id=eq.${ids.t}`, {
        method: 'PATCH',
        body: { title: `Timed ${index}` },
        prefer: 'return=minimal',
      })
      times.push(performance.now() - started)
      expect(answer.status, `write ${index}`).toBeLessThan(300)
    }
    recordMetric({ id: 'P3', name: 'single-field write, median', value: median(times), unit: 'ms' })
    recordMetric({
      id: 'P3',
      name: 'single-field write, slowest',
      value: Math.max(...times),
      unit: 'ms',
    })
  })
})
