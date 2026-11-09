import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, useLocation } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/app/uiStore'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useWorkspaceStore } from '@/data/store'
import { makeProject, makeTask } from '@/domain/testFactories'
import type { Task } from '@/domain/types'
import { notify, type NotifyAction } from '@/lib/notify'
import { MyTasksPage } from './MyTasksPage'
import { resetWorkspace, seedWorkspace, testToday } from './testWorkspace'

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

function renderMyTasks(url: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/my-tasks/:tab',
        element: (
          <>
            <MyTasksPage />
            <LocationProbe />
          </>
        ),
      },
      { path: '*', element: <LocationProbe /> },
    ],
    { initialEntries: [url] },
  )
  const user = userEvent.setup()
  render(
    <TooltipProvider delayDuration={0}>
      <RouterProvider router={router} />
    </TooltipProvider>,
  )
  return { router, user }
}

const location = () => screen.getByTestId('location').textContent
const storeTask = (id: string): Task | undefined => useWorkspaceStore.getState().data.tasks[id]
/** The open buttons of a list's rows, in order (their accessible names). */
const rowNames = (list: HTMLElement) =>
  Array.from(list.querySelectorAll('[data-row-open]')).map((button) =>
    (button.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
/**
 * The row of "Send consent forms" (a subtask of "Recruit participants"): its text, and its name
 * as assistive tech hears it. Whitespace around the sr-only parts differs between engines
 * (jsdom trims it, Chrome adds a space), so the name is matched modulo whitespace.
 */
const SUBTASK_ROW = 'Subtask of Recruit participants›: Send consent forms'
const SUBTASK_NAME = /^Subtask of\s*Recruit participants\s*:\s*Send consent forms$/
const rowOf = (title: string) => {
  const button = screen.getByRole('button', { name: new RegExp(`${title}$`) })
  return button.closest('li') as HTMLElement
}

const research = makeProject({ id: 'p-research', name: 'Research', sortOrder: 'a0', color: 'blue' })
const community = makeProject({ id: 'p-community', name: 'Community', sortOrder: 'a1' })
const archived = makeProject({ id: 'p-old', name: 'Old', sortOrder: 'a2', status: 'archived' })

function standardTasks(): Task[] {
  return [
    makeTask({
      id: 't-venue',
      projectId: community.id,
      title: 'Confirm venue',
      dueDate: testToday(-2),
      priority: 'urgent',
    }),
    makeTask({
      id: 't-room',
      projectId: research.id,
      title: 'Book a room',
      dueDate: testToday(),
      priority: 'medium',
      sortOrder: 'a1',
    }),
    makeTask({
      id: 't-recruit',
      projectId: research.id,
      title: 'Recruit participants',
      sortOrder: 'a2',
    }),
    makeTask({
      id: 't-consent',
      projectId: research.id,
      parentTaskId: 't-recruit',
      title: 'Send consent forms',
      dueDate: testToday(),
    }),
    makeTask({
      id: 't-speakers',
      projectId: community.id,
      title: 'Speaker shortlist',
      dueDate: testToday(3),
      status: 'in_progress',
    }),
    makeTask({
      id: 't-report',
      projectId: research.id,
      title: 'Write report',
      dueDate: testToday(20),
      sortOrder: 'a3',
    }),
    makeTask({ id: 't-ideas', projectId: research.id, title: 'Brainstorm', sortOrder: 'a4' }),
    makeTask({
      id: 't-guide',
      projectId: research.id,
      title: 'Draft guide',
      status: 'done',
      dueDate: testToday(-5),
      completedAt: '2026-11-01T00:00:00.000Z',
      sortOrder: 'a5',
    }),
    makeTask({
      id: 't-archived',
      projectId: archived.id,
      title: 'Archived task',
      dueDate: testToday(-1),
    }),
  ]
}

async function seedStandard() {
  await seedWorkspace({ projects: [research, community, archived], tasks: standardTasks() })
}

beforeEach(() => {
  resetWorkspace()
  useUIStore.setState({ newTask: null })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MyTasksPage', () => {
  it('shows the four bucket tabs with counts and today’s open tasks', async () => {
    await seedStandard()
    renderMyTasks('/my-tasks/today')

    const tabs = screen.getByRole('navigation', { name: 'My Tasks' })
    const links = within(tabs).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([
      'Today2, 2 tasks',
      'Upcoming1, 1 task',
      'Overdue1, 1 task',
      'All Tasks7, 7 open tasks',
    ])
    expect(within(tabs).getByRole('link', { name: /^Today/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(tabs).getByRole('link', { name: /^Overdue/ })).toHaveAttribute(
      'href',
      '/my-tasks/overdue',
    )

    const list = screen.getByRole('region', { name: 'Today tasks' })
    // Priority breaks the due-date tie; a subtask carries its parent as a prefix.
    expect(rowNames(list)).toEqual(['Book a room', SUBTASK_ROW])
    // The decorative "›" is aria-hidden: assistive tech hears "Subtask of …: title".
    expect(screen.getByRole('button', { name: SUBTASK_NAME })).toBeInTheDocument()
    // Project link, priority glyph and the due label in the bucket language.
    const room = rowOf('Book a room')
    expect(within(room).getByRole('link', { name: 'Research' })).toHaveAttribute(
      'href',
      '/projects/p-research',
    )
    expect(within(room).getByRole('img', { name: 'Priority: Medium' })).toBeInTheDocument()
    expect(within(room).getByText('Today').closest('[data-bucket]')).toHaveAttribute(
      'data-bucket',
      'today',
    )
    expect(screen.queryByText('Archived task')).not.toBeInTheDocument()
  })

  it('treats an unknown tab as Today', async () => {
    await seedStandard()
    renderMyTasks('/my-tasks/bogus')
    expect(rowNames(screen.getByRole('region', { name: 'Today tasks' }))).toEqual([
      'Book a room',
      SUBTASK_ROW,
    ])
  })

  it('switches tabs through the URL (Upcoming, Overdue)', async () => {
    await seedStandard()
    const { user } = renderMyTasks('/my-tasks/today')
    const tabs = screen.getByRole('navigation', { name: 'My Tasks' })

    await user.click(within(tabs).getByRole('link', { name: /^Overdue/ }))
    expect(location()).toBe('/my-tasks/overdue')
    const overdue = screen.getByRole('list', { name: 'Overdue tasks' })
    expect(rowNames(overdue)).toEqual(['Confirm venue'])
    expect(
      within(overdue)
        .getByText(/Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep/)
        .closest('[data-bucket]'),
    ).toHaveAttribute('data-bucket', 'overdue')

    await user.click(within(tabs).getByRole('link', { name: /^Upcoming/ }))
    expect(location()).toBe('/my-tasks/upcoming')
    expect(rowNames(screen.getByRole('list', { name: 'Upcoming tasks' }))).toEqual([
      'Speaker shortlist',
    ])
  })

  it('groups All by due date and shows completed tasks on request', async () => {
    await seedStandard()
    const { user } = renderMyTasks('/my-tasks/all')
    const region = screen.getByRole('region', { name: 'All tasks' })
    const headings = within(region).getAllByRole('heading', { level: 2 })
    expect(headings.map((heading) => heading.textContent)).toEqual([
      'Overdue1, 1 task',
      'Today2, 2 tasks',
      'Upcoming1, 1 task',
      'Later1, 1 task',
      'No due date2, 2 tasks',
    ])
    expect(screen.queryByText('Draft guide')).not.toBeInTheDocument()

    const toggle = screen.getByRole('switch', { name: /Show completed/ })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.click(toggle)
    expect(location()).toBe('/my-tasks/all?completed=1')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    const completed = screen.getByRole('region', { name: /^Completed/ })
    expect(rowNames(completed)).toEqual(['Draft guide'])
    expect(screen.queryByText('Archived task')).not.toBeInTheDocument()
  })

  it('narrows All to Today + Upcoming with ?due=soon (the Overview’s Due soon)', async () => {
    await seedStandard()
    const { user } = renderMyTasks('/my-tasks/all?due=soon')
    const region = screen.getByRole('region', { name: 'Tasks due soon' })
    const headings = within(region).getAllByRole('heading', { level: 2 })
    expect(headings.map((heading) => heading.textContent)).toEqual([
      'Today2, 2 tasks',
      'Upcoming1, 1 task',
    ])
    // Today 2 + Upcoming 1 = the Overview's number; overdue, later and undated tasks are out.
    expect(region.querySelectorAll('[data-task-row]')).toHaveLength(3)
    expect(screen.queryByText('Confirm venue')).not.toBeInTheDocument()
    expect(screen.queryByText('Write report')).not.toBeInTheDocument()
    // The filter says what it keeps and has a way out; the completed switch has nothing to do.
    const bar = document.querySelector('[data-slot="due-soon-filter"]') as HTMLElement
    expect(bar).toHaveTextContent('Due soon · 3 tasks')
    expect(screen.queryByRole('switch', { name: /Show completed/ })).not.toBeInTheDocument()
    await user.click(within(bar).getByRole('link', { name: 'Clear filter' }))
    expect(location()).toBe('/my-tasks/all')
    expect(screen.getByRole('region', { name: 'All tasks' })).toBeInTheDocument()
    expect(document.querySelector('[data-slot="due-soon-filter"]')).toBeNull()
  })

  it('ignores ?due=soon off the All tab and unknown values', async () => {
    await seedStandard()
    renderMyTasks('/my-tasks/overdue?due=soon')
    expect(document.querySelector('[data-slot="due-soon-filter"]')).toBeNull()
    expect(rowNames(screen.getByRole('list', { name: 'Overdue tasks' }))).toEqual(['Confirm venue'])
  })

  it('says so when nothing is due soon, and leads back to all open tasks', async () => {
    await seedWorkspace({
      projects: [research],
      tasks: [makeTask({ projectId: research.id, title: 'Far away', dueDate: testToday(30) })],
    })
    renderMyTasks('/my-tasks/all?due=soon')
    expect(
      screen.getByRole('heading', { name: 'Nothing due in the next 7 days' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View all 1 open task' })).toHaveAttribute(
      'href',
      '/my-tasks/all',
    )
  })

  it('has an empty state for every tab', async () => {
    await seedWorkspace({
      projects: [research],
      tasks: [makeTask({ id: 'done', projectId: research.id, title: 'Done', status: 'done' })],
    })
    const { user } = renderMyTasks('/my-tasks/today')
    expect(screen.getByRole('heading', { name: 'Nothing for today' })).toBeInTheDocument()

    const tabs = screen.getByRole('navigation', { name: 'My Tasks' })
    await user.click(within(tabs).getByRole('link', { name: /^Upcoming/ }))
    expect(
      screen.getByRole('heading', { name: 'Nothing due in the next 7 days' }),
    ).toBeInTheDocument()
    await user.click(within(tabs).getByRole('link', { name: /^Overdue/ }))
    expect(screen.getByRole('heading', { name: 'No overdue tasks' })).toBeInTheDocument()
    await user.click(within(tabs).getByRole('link', { name: /^All/ }))
    expect(screen.getByRole('heading', { name: 'No open tasks' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show 1 completed task' }))
    expect(location()).toBe('/my-tasks/all?completed=1')
    expect(rowNames(screen.getByRole('region', { name: 'All tasks' }))).toEqual(['Done'])
  })

  it('offers New task when there are no tasks at all', async () => {
    await seedWorkspace({ projects: [research] })
    const { user } = renderMyTasks('/my-tasks/all')
    expect(screen.getByRole('heading', { name: 'No tasks yet' })).toBeInTheDocument()
    const buttons = screen.getAllByRole('button', { name: 'New task' })
    await user.click(buttons[buttons.length - 1])
    expect(useUIStore.getState().newTask).toEqual({})
  })

  it('points the Today empty state at overdue work', async () => {
    await seedWorkspace({
      projects: [research],
      tasks: [makeTask({ projectId: research.id, title: 'Late', dueDate: testToday(-1) })],
    })
    const { user } = renderMyTasks('/my-tasks/today')
    await user.click(screen.getByRole('link', { name: 'View 1 overdue task' }))
    expect(location()).toBe('/my-tasks/overdue')
  })

  it('changes the status in place, confirms with Undo, and Undo restores it', async () => {
    await seedStandard()
    const success = vi.spyOn(notify, 'success')
    const { user } = renderMyTasks('/my-tasks/today')

    await user.click(within(rowOf('Book a room')).getByRole('button', { name: 'Status: To Do' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Done/ }))
    expect(storeTask('t-room')?.status).toBe('done')
    // Done tasks leave Today at once (every view reads the same store).
    expect(rowNames(screen.getByRole('region', { name: 'Today tasks' }))).toEqual([SUBTASK_ROW])
    expect(
      within(screen.getByRole('navigation', { name: 'My Tasks' })).getByRole('link', {
        name: /^Today/,
      }),
    ).toHaveAccessibleName('Today, 1 task')
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1))
    const [message, options] = success.mock.calls[0]
    expect(message).toBe('Marked as done')
    expect(options?.description).toBe('Book a room')

    const undo = options?.action as NotifyAction
    await act(async () => undo.onClick())
    await waitFor(() => expect(storeTask('t-room')?.status).toBe('todo'))
    expect(rowNames(screen.getByRole('region', { name: 'Today tasks' }))).toContain('Book a room')
  })

  it('keeps a task whose status stays open in the list, without a toast', async () => {
    await seedStandard()
    const success = vi.spyOn(notify, 'success')
    const { user } = renderMyTasks('/my-tasks/today')
    await user.click(within(rowOf('Book a room')).getByRole('button', { name: 'Status: To Do' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /In Progress/ }))
    await waitFor(() => expect(storeTask('t-room')?.status).toBe('in_progress'))
    expect(
      within(rowOf('Book a room')).getByRole('button', { name: 'Status: In Progress' }),
    ).toBeInTheDocument()
    expect(success).not.toHaveBeenCalled()
  })

  it('rolls a failed status change back and never reports success', async () => {
    await seedStandard()
    const success = vi.spyOn(notify, 'success')
    const error = vi.spyOn(notify, 'error')
    const { user } = renderMyTasks('/my-tasks/today')
    window.__cairnTest?.failNextWrites(1)

    await user.click(within(rowOf('Book a room')).getByRole('button', { name: 'Status: To Do' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Done/ }))
    await waitFor(() => expect(error).toHaveBeenCalled()) // the store's toast (with Retry)
    expect(storeTask('t-room')?.status).toBe('todo')
    expect(rowNames(screen.getByRole('region', { name: 'Today tasks' }))).toContain('Book a room')
    expect(success).not.toHaveBeenCalled()
  })

  it('opens a task in the Task Modal through ?task=', async () => {
    await seedStandard()
    const { user } = renderMyTasks('/my-tasks/all?completed=1')
    await user.click(screen.getByRole('button', { name: 'Write report' }))
    expect(location()).toBe('/my-tasks/all?completed=1&task=t-report')
  })

  it('moves between rows with the arrow keys', async () => {
    await seedStandard()
    const { user } = renderMyTasks('/my-tasks/all')
    const first = screen.getByRole('button', { name: 'Confirm venue' })
    first.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('button', { name: 'Book a room' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(first).toHaveFocus()
  })

  it('creates a task due today from Today, and a plain one elsewhere', async () => {
    await seedStandard()
    const { user } = renderMyTasks('/my-tasks/today')
    await user.click(screen.getByRole('button', { name: 'New task' }))
    expect(useUIStore.getState().newTask).toEqual({ dueDate: testToday() })

    act(() => useUIStore.setState({ newTask: null }))
    await user.click(
      within(screen.getByRole('navigation', { name: 'My Tasks' })).getByRole('link', {
        name: /^Upcoming/,
      }),
    )
    await user.click(screen.getByRole('button', { name: 'New task' }))
    expect(useUIStore.getState().newTask).toEqual({})
  })

  it('shows a quiet loading state until the workspace is ready', () => {
    useWorkspaceStore.setState({ status: 'loading' })
    renderMyTasks('/my-tasks/today')
    expect(screen.getByText('Loading your tasks…').closest('[aria-busy="true"]')).not.toBeNull()
    expect(screen.queryByRole('heading', { name: 'My Tasks' })).not.toBeInTheDocument()
  })

  it('shows a load error with Retry that reloads the workspace', async () => {
    useWorkspaceStore.setState({
      status: 'error',
      loadError: { kind: 'network', message: 'The server did not answer.' },
    })
    const { user } = renderMyTasks('/my-tasks/today')
    expect(screen.getByRole('heading', { name: 'Couldn’t load your tasks' })).toBeInTheDocument()
    expect(screen.getByText(/The server did not answer/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    // Local mode reloads (an empty workspace here): the page is back, with its empty state.
    expect(await screen.findByRole('heading', { name: 'Nothing for today' })).toBeInTheDocument()
  })

  it('explains the definitions', async () => {
    await seedStandard()
    const { user } = renderMyTasks('/my-tasks/today')
    await user.click(screen.getByRole('button', { name: 'How tasks are grouped' }))
    const dialog = await screen.findByRole('dialog', { name: 'How tasks are grouped' })
    expect(
      within(dialog).getByText('Due today, or between its start and due dates'),
    ).toBeInTheDocument()
    expect(within(dialog).getByText('Due in the next 7 days, after today')).toBeInTheDocument()
    expect(within(dialog).getByText('Past their due date and not done')).toBeInTheDocument()
  })
})

describe('MyTasksPage — Today with scheduled tasks', () => {
  const task = (id: string, title: string, overrides: Partial<Task> = {}) =>
    makeTask({ id, projectId: research.id, title, ...overrides })

  async function seedScheduled() {
    await seedWorkspace({
      projects: [research, archived],
      tasks: [
        task('t-due', 'Due today task', { dueDate: testToday(), sortOrder: 'a1' }),
        task('t-span-due', 'Span ends today', {
          startDate: testToday(-3),
          dueDate: testToday(),
          sortOrder: 'a2',
        }),
        task('t-span', 'Span task', {
          startDate: testToday(-2),
          dueDate: testToday(5),
          sortOrder: 'a3',
        }),
        task('t-starts', 'Starts today', {
          startDate: testToday(),
          dueDate: testToday(2),
          sortOrder: 'a4',
        }),
        task('t-start-only', 'Start only', { startDate: testToday(-4), sortOrder: 'a5' }),
        task('t-future', 'Future start', {
          startDate: testToday(1),
          dueDate: testToday(9),
          sortOrder: 'a6',
        }),
        task('t-overdue', 'Overdue span', {
          startDate: testToday(-6),
          dueDate: testToday(-1),
          sortOrder: 'a7',
        }),
        task('t-done', 'Finished span', {
          startDate: testToday(-2),
          dueDate: testToday(4),
          status: 'done',
          sortOrder: 'a8',
        }),
        makeTask({
          id: 't-archived',
          projectId: archived.id,
          title: 'Archived span',
          startDate: testToday(-2),
          dueDate: testToday(4),
        }),
      ],
    })
  }

  const todayRegion = () => screen.getByRole('region', { name: 'Today tasks' })
  const sectionOf = (name: RegExp) => within(todayRegion()).getByRole('region', { name })
  const headings = () =>
    within(todayRegion())
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent)
  const todayTab = () =>
    within(screen.getByRole('navigation', { name: 'My Tasks' })).getByRole('link', {
      name: /^Today/,
    })

  it('shows Due today and Scheduled today sections whose rows add up to the Today count', async () => {
    await seedScheduled()
    renderMyTasks('/my-tasks/today')

    expect(headings()).toEqual(['Due today2, 2 tasks', 'Scheduled today2, 2 tasks'])
    expect(rowNames(sectionOf(/^Due today/))).toEqual(['Due today task', 'Span ends today'])
    expect(rowNames(sectionOf(/^Scheduled today/))).toEqual(['Starts today', 'Span task'])

    // Not shown: start only, future start, overdue, done, archived project.
    for (const title of [
      'Start only',
      'Future start',
      'Overdue span',
      'Finished span',
      'Archived span',
    ]) {
      expect(screen.queryByText(title)).not.toBeInTheDocument()
    }

    // The tab count is the number of distinct rows on screen.
    const rows = Array.from(todayRegion().querySelectorAll('[data-task-row]'))
    expect(new Set(rows.map((row) => row.getAttribute('data-task-row'))).size).toBe(4)
    expect(rows).toHaveLength(4)
    expect(todayTab()).toHaveAccessibleName('Today, 4 tasks')
    // The other tabs keep their due-date meaning.
    const tabs = screen.getByRole('navigation', { name: 'My Tasks' })
    expect(within(tabs).getByRole('link', { name: /^Upcoming/ })).toHaveAccessibleName(
      'Upcoming, 2 tasks',
    )
    expect(within(tabs).getByRole('link', { name: /^Overdue/ })).toHaveAccessibleName(
      'Overdue, 1 task',
    )
  })

  it('leaves out an empty section', async () => {
    await seedWorkspace({
      projects: [research],
      tasks: [task('t-span', 'Span task', { startDate: testToday(-2), dueDate: testToday(5) })],
    })
    renderMyTasks('/my-tasks/today')
    expect(headings()).toEqual(['Scheduled today1, 1 task'])
  })

  it('says "Nothing for today" with the new description and keeps the secondary link', async () => {
    await seedWorkspace({
      projects: [research],
      tasks: [
        task('t-start-only', 'Start only', { startDate: testToday(-2) }),
        task('t-late', 'Late', { dueDate: testToday(-1) }),
      ],
    })
    renderMyTasks('/my-tasks/today')
    expect(screen.getByRole('heading', { name: 'Nothing for today' })).toBeInTheDocument()
    expect(
      screen.getByText(
        'Tasks due today, or with today between their start and due dates, show up here.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View 1 overdue task' })).toHaveAttribute(
      'href',
      '/my-tasks/overdue',
    )
  })

  it('keeps the ?due=soon filter on the due date: its count excludes scheduled-only tasks', async () => {
    await seedWorkspace({
      projects: [research],
      tasks: [
        task('t-due', 'Due today task', { dueDate: testToday() }),
        task('t-soon', 'Due soon task', { dueDate: testToday(3) }),
        // Scheduled across today but due beyond the window: Today tab yes, Due soon no.
        task('t-far', 'Far span', { startDate: testToday(-1), dueDate: testToday(30) }),
        // Scheduled across today and due within the window: counted once, by its due date.
        task('t-near', 'Near span', { startDate: testToday(-1), dueDate: testToday(2) }),
      ],
    })
    renderMyTasks('/my-tasks/all?due=soon')
    const bar = document.querySelector('[data-slot="due-soon-filter"]') as HTMLElement
    expect(bar).toHaveTextContent('Due soon · 3 tasks')
    expect(screen.queryByText('Far span')).not.toBeInTheDocument()
    const region = screen.getByRole('region', { name: 'Tasks due soon' })
    expect(region.querySelectorAll('[data-task-row]')).toHaveLength(3)
    // Today tab = 1 due today + 2 scheduled; the filter's 3 is a different set.
    expect(todayTab()).toHaveAccessibleName('Today, 3 tasks')
  })

  it('updates Today when a task’s dates or status change', async () => {
    await seedScheduled()
    renderMyTasks('/my-tasks/today')
    const actions = useWorkspaceStore.getState().actions
    const names = () => rowNames(todayRegion())
    expect(names()).toContain('Span task')
    expect(names()).not.toContain('Start only')

    // Give a start-only task a due date after today: it is now scheduled today.
    await act(async () => {
      await actions.updateTask('t-start-only', { dueDate: testToday(3) })
    })
    expect(rowNames(sectionOf(/^Scheduled today/))).toContain('Start only')
    expect(todayTab()).toHaveAccessibleName('Today, 5 tasks')

    // Pushing a start into the future takes it out.
    await act(async () => {
      await actions.updateTask('t-span', { startDate: testToday(1) })
    })
    expect(names()).not.toContain('Span task')

    // Moving a due date to today moves it from Scheduled to Due today.
    await act(async () => {
      await actions.updateTask('t-starts', { dueDate: testToday() })
    })
    expect(rowNames(sectionOf(/^Due today/))).toContain('Starts today')
    expect(rowNames(sectionOf(/^Scheduled today/))).not.toContain('Starts today')

    // Done leaves; reopening brings it back.
    await act(async () => {
      await actions.updateTask('t-start-only', { status: 'done' })
    })
    expect(names()).not.toContain('Start only')
    await act(async () => {
      await actions.updateTask('t-start-only', { status: 'todo' })
    })
    expect(names()).toContain('Start only')
    expect(todayTab()).toHaveAccessibleName(`Today, ${names().length} tasks`)
  })

  it('moves between rows across the two sections with the arrow keys', async () => {
    await seedScheduled()
    const { user } = renderMyTasks('/my-tasks/today')
    screen.getByRole('button', { name: 'Span ends today' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('button', { name: 'Starts today' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('button', { name: 'Span ends today' })).toHaveFocus()
  })

  it('judges "today" in the preference time zone, not the browser’s', async () => {
    // 20:00 UTC on Nov 9 is already Nov 10 in Taipei (UTC+8).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-09T20:00:00Z') })
    try {
      await seedWorkspace({
        projects: [research],
        tasks: [
          task('t-due', 'Due Nov 10', { dueDate: '2026-11-10', sortOrder: 'a1' }),
          // Scheduled in Taipei's today only (starts Nov 10); the UTC date would not include it.
          task('t-starts', 'Starts Nov 10', {
            startDate: '2026-11-10',
            dueDate: '2026-11-12',
            sortOrder: 'a2',
          }),
          // Due on the UTC date: already overdue for the user.
          task('t-utc', 'Due Nov 9', {
            startDate: '2026-11-05',
            dueDate: '2026-11-09',
            sortOrder: 'a3',
          }),
        ],
      })
      renderMyTasks('/my-tasks/today')
      expect(rowNames(sectionOf(/^Due today/))).toEqual(['Due Nov 10'])
      expect(rowNames(sectionOf(/^Scheduled today/))).toEqual(['Starts Nov 10'])
      expect(screen.queryByText('Due Nov 9')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
