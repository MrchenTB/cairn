/**
 * The suite's last line of defence: an account holding anything but test data stops every cleanup
 * without touching a thing. Dry run only, because proving it means creating a project that doesn't
 * look like a test project, and a real run must never do that.
 */
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { deleteTestProjects, getRow, isDryRun, rest, testProjectName, tokenFor } from './api.ts'

test.describe('guard', () => {
  test.skip(!isDryRun(), 'Creates a project that is not a test project: simulator only.')

  test('G1: a project the suite did not create stops the cleanup; nothing is deleted', async () => {
    const token = await tokenFor('A')
    const realId = randomUUID()
    const testId = randomUUID()
    const insert = (id: string, name: string) =>
      rest(token, 'projects', { method: 'POST', body: { id, name, sort_order: 'a0' } })
    expect((await insert(realId, 'My real project')).status).toBeLessThan(300)
    expect((await insert(testId, testProjectName('next to a real one'))).status).toBeLessThan(300)

    try {
      await expect(deleteTestProjects('A')).rejects.toThrow(/not created by these tests/)
      // Not even the test project went: the run stops without touching anything.
      expect(await getRow(token, 'projects', realId, 'id')).toBeDefined()
      expect(await getRow(token, 'projects', testId, 'id')).toBeDefined()
    } finally {
      await rest(token, `projects?id=eq.${realId}`, { method: 'DELETE' })
      await rest(token, `projects?id=eq.${testId}`, { method: 'DELETE' })
    }
  })

  test('G2: the error names no project', async () => {
    const token = await tokenFor('A')
    const id = randomUUID()
    await rest(token, 'projects', {
      method: 'POST',
      body: { id, name: 'Secret client name', sort_order: 'a0' },
    })
    try {
      const failure = await deleteTestProjects('A').catch((error: Error) => error.message)
      expect(failure).toContain('1 project')
      expect(failure).not.toContain('Secret client name')
    } finally {
      await rest(token, `projects?id=eq.${id}`, { method: 'DELETE' })
    }
  })
})
