/**
 * The Overview's four number cards lead to pages that must show exactly what the number counts.
 * Each test clicks a card and counts what the destination really lists — no re-derived numbers.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeProject, makeTask } from '@/domain/testFactories'
import { MyTasksPage } from '@/features/my-tasks/MyTasksPage'
import { resetWorkspace, seedWorkspace, testToday } from '@/features/my-tasks/testWorkspace'
import { ProjectsPage } from '@/features/projects/ProjectsPage'
import { OverviewPage } from './OverviewPage'

const a = makeProject({ id: 'p-a', name: 'Alpha', sortOrder: 'a0' })
const b = makeProject({ id: 'p-b', name: 'Beta', sortOrder: 'a1' })
const done = makeProject({ id: 'p-c', name: 'Gamma', sortOrder: 'a2', status: 'completed' })
const archived = makeProject({ id: 'p-d', name: 'Delta', sortOrder: 'a3', status: 'archived' })

beforeEach(async () => {
  resetWorkspace()
  await seedWorkspace({
    projects: [a, b, done, archived],
    tasks: [
      makeTask({ projectId: a.id, title: 'Late one', dueDate: testToday(-4) }),
      makeTask({ projectId: a.id, title: 'Late two', dueDate: testToday(-1) }),
      makeTask({ projectId: a.id, title: 'Today one', dueDate: testToday() }),
      makeTask({ projectId: b.id, title: 'Today two', dueDate: testToday() }),
      makeTask({ projectId: b.id, title: 'Tomorrow', dueDate: testToday(1) }),
      makeTask({ projectId: b.id, title: 'In a week', dueDate: testToday(7) }),
      makeTask({ projectId: b.id, title: 'In eight days', dueDate: testToday(8) }),
      makeTask({ projectId: b.id, title: 'Undated' }),
      makeTask({ projectId: b.id, title: 'Finished', status: 'done', dueDate: testToday(2) }),
      makeTask({ projectId: done.id, title: 'In a completed project', dueDate: testToday(3) }),
      makeTask({ projectId: archived.id, title: 'Never counted', dueDate: testToday(-3) }),
    ],
  })
})

function renderApp() {
  const router = createMemoryRouter(
    [
      { path: '/overview', element: <OverviewPage /> },
      { path: '/my-tasks/:tab', element: <MyTasksPage /> },
      { path: '/projects', element: <ProjectsPage /> },
    ],
    { initialEntries: ['/overview'] },
  )
  const user = userEvent.setup()
  render(
    <TooltipProvider delayDuration={0}>
      <RouterProvider router={router} />
    </TooltipProvider>,
  )
  return { user }
}

const metric = (key: string) =>
  Number(document.querySelector(`[data-metric="${key}"] dd`)?.textContent)
const card = (key: string) => document.querySelector(`[data-metric="${key}"] a`) as HTMLElement
const taskRows = () => document.querySelectorAll('[data-task-row]').length

describe('Overview metric cards and their destinations', () => {
  it('Open tasks → My Tasks All lists that many open tasks', async () => {
    const { user } = renderApp()
    const expected = metric('open')
    expect(expected).toBe(9) // archived-project and done tasks are not counted
    await user.click(card('open'))
    expect(taskRows()).toBe(expected)
  })

  it('Overdue → My Tasks Overdue lists that many tasks', async () => {
    const { user } = renderApp()
    const expected = metric('overdue')
    expect(expected).toBe(2)
    await user.click(card('overdue'))
    expect(taskRows()).toBe(expected)
  })

  it('Due soon → a filtered list of exactly that many tasks (Today + Upcoming together)', async () => {
    const { user } = renderApp()
    const expected = metric('soon')
    expect(expected).toBe(5) // today ×2, tomorrow, in a week, in a completed project
    await user.click(card('soon'))
    const region = screen.getByRole('region', { name: 'Tasks due soon' })
    expect(region.querySelectorAll('[data-task-row]')).toHaveLength(expected)
    expect(document.querySelector('[data-slot="due-soon-filter"]')).toHaveTextContent(
      `${expected} tasks`,
    )
    // The tasks outside the definition are not on the page.
    for (const title of ['Late one', 'In eight days', 'Undated']) {
      expect(within(region).queryByText(title)).not.toBeInTheDocument()
    }
  })

  it('Active projects → the Projects page lists that many active projects', async () => {
    const { user } = renderApp()
    const expected = metric('active')
    expect(expected).toBe(2)
    await user.click(card('active'))
    const table = screen.getByRole('table', { name: 'Projects' })
    // One header row plus one row per project.
    expect(within(table).getAllByRole('row')).toHaveLength(expected + 1)
    expect(within(table).queryByText('Gamma')).not.toBeInTheDocument()
  })
})
