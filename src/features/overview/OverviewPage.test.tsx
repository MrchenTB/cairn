import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, useLocation } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/app/uiStore'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useWorkspaceStore } from '@/data/store'
import { myTasks } from '@/domain/buckets'
import { formatDateSmart } from '@/domain/dates'
import { makeMilestone, makeProject, makeTask } from '@/domain/testFactories'
import type { Milestone, Task } from '@/domain/types'
import { resetWorkspace, seedWorkspace, testToday } from '@/features/my-tasks/testWorkspace'
import { notify, type NotifyAction } from '@/lib/notify'
import { OverviewPage } from './OverviewPage'

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

function renderOverview() {
  const router = createMemoryRouter(
    [
      {
        path: '/overview',
        element: (
          <>
            <OverviewPage />
            <LocationProbe />
          </>
        ),
      },
      { path: '*', element: <LocationProbe /> },
    ],
    { initialEntries: ['/overview'] },
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
const metric = (key: string) => document.querySelector(`[data-metric="${key}"] dd`) as HTMLElement
const metrics = () => ({
  active: metric('active').textContent,
  open: metric('open').textContent,
  soon: metric('soon').textContent,
  overdue: metric('overdue').textContent,
})
const section = (name: string) => screen.getByRole('region', { name })
/** The text of each row's open button, in order. */
const rowNames = (list: HTMLElement) =>
  Array.from(list.querySelectorAll('[data-row-open]')).map((button) =>
    (button.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
const upcomingList = () =>
  within(section('Upcoming tasks')).getByRole('list', { name: 'Upcoming tasks' })
const rowOf = (title: string) =>
  screen.getByRole('button', { name: new RegExp(`${title}$`) }).closest('li') as HTMLElement

const research = makeProject({
  id: 'p-research',
  name: 'Research Project',
  description: 'Interview study',
  color: 'blue',
  sortOrder: 'a0',
  dueDate: testToday(40),
})
const community = makeProject({ id: 'p-community', name: 'Community Event', sortOrder: 'a1' })
const website = makeProject({ id: 'p-website', name: 'Website Redesign', sortOrder: 'a2' })
const shipped = makeProject({
  id: 'p-shipped',
  name: 'Shipped Pilot',
  sortOrder: 'a3',
  status: 'completed',
})
const archived = makeProject({
  id: 'p-old',
  name: 'Old Archive',
  sortOrder: 'a4',
  status: 'archived',
})

const SUBTASK_ROW = 'Subtask of Recruit participants›: Send consent forms'

/**
 * Research: 6 leaf tasks (2 done) + the parent "Recruit participants" (not a leaf).
 * Community: 4 leaf tasks (1 done). Website Redesign: no tasks. Shipped: a done task. Archived:
 * an overdue task that must never be counted.
 */
function standardTasks(): Task[] {
  return [
    makeTask({
      id: 't-finalize',
      projectId: research.id,
      title: 'Finalize report',
      status: 'in_progress',
      dueDate: testToday(-3),
      startDate: testToday(-6),
      sortOrder: 'a0',
    }),
    makeTask({
      id: 't-review',
      projectId: research.id,
      title: 'Review prototype',
      dueDate: testToday(),
      priority: 'medium',
      sortOrder: 'a1',
    }),
    makeTask({
      id: 't-recruit',
      projectId: research.id,
      title: 'Recruit participants',
      dueDate: testToday(6),
      sortOrder: 'a2',
    }),
    makeTask({
      id: 't-consent',
      projectId: research.id,
      parentTaskId: 't-recruit',
      title: 'Send consent forms',
      dueDate: testToday(),
      sortOrder: 'a0',
    }),
    makeTask({
      id: 't-transcribe',
      projectId: research.id,
      title: 'Transcribe interviews',
      dueDate: testToday(14),
      sortOrder: 'a3',
    }),
    makeTask({
      id: 't-lit',
      projectId: research.id,
      title: 'Literature review',
      status: 'done',
      dueDate: testToday(-10),
      completedAt: '2026-11-01T00:00:00.000Z',
      sortOrder: 'a4',
    }),
    makeTask({
      id: 't-ethics',
      projectId: research.id,
      title: 'Ethics approval',
      status: 'done',
      completedAt: '2026-11-01T00:00:00.000Z',
      sortOrder: 'a5',
    }),
    makeTask({
      id: 't-venue',
      projectId: community.id,
      title: 'Confirm venue',
      dueDate: testToday(-1),
      sortOrder: 'a0',
    }),
    makeTask({
      id: 't-speakers',
      projectId: community.id,
      title: 'Speaker shortlist',
      dueDate: testToday(5),
      sortOrder: 'a1',
    }),
    makeTask({ id: 't-print', projectId: community.id, title: 'Print signage', sortOrder: 'a2' }),
    makeTask({
      id: 't-invites',
      projectId: community.id,
      title: 'Send invitations',
      status: 'done',
      completedAt: '2026-11-01T00:00:00.000Z',
      sortOrder: 'a3',
    }),
    makeTask({
      id: 't-pilot',
      projectId: shipped.id,
      title: 'Pilot report',
      status: 'done',
      completedAt: '2026-11-01T00:00:00.000Z',
    }),
    makeTask({
      id: 't-archived',
      projectId: archived.id,
      title: 'Should never appear',
      dueDate: testToday(-3),
    }),
  ]
}

function standardMilestones(): Milestone[] {
  return [
    makeMilestone({
      id: 'm-submit',
      projectId: research.id,
      name: 'Submission deadline',
      date: testToday(9),
    }),
    makeMilestone({
      id: 'm-doors',
      projectId: community.id,
      name: 'Doors open',
      date: testToday(21),
    }),
    makeMilestone({
      id: 'm-past',
      projectId: research.id,
      name: 'Ethics review',
      date: testToday(-10),
    }),
    makeMilestone({
      id: 'm-far',
      projectId: research.id,
      name: 'Series close',
      date: testToday(55),
    }),
    makeMilestone({
      id: 'm-hidden',
      projectId: archived.id,
      name: 'Archived launch',
      date: testToday(5),
    }),
  ]
}

async function seedStandard() {
  await seedWorkspace({
    projects: [research, community, website, shipped, archived],
    tasks: standardTasks(),
    milestones: standardMilestones(),
  })
}

beforeEach(() => {
  resetWorkspace()
  useUIStore.setState({ newTask: null, projectDialog: null })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OverviewPage metrics', () => {
  it('shows the four numbers from the store, in the My Tasks bucket language', async () => {
    await seedStandard()
    renderOverview()

    // Active: research, community, website (completed and archived projects are not).
    // Open: 5 research (incl. the parent and the subtask) + 3 community; archived is left out.
    // Due soon: today ×2, +5, +6. Overdue: -3 and -1.
    expect(metrics()).toEqual({ active: '3', open: '8', soon: '4', overdue: '2' })
    expect(metric('overdue')).toHaveClass('text-danger')
    expect(metric('open')).not.toHaveClass('text-danger')
    expect(screen.getByText('Due soon')).toBeInTheDocument()

    // The same buckets My Tasks counts — by construction, not by coincidence.
    const buckets = myTasks(useWorkspaceStore.getState().data, testToday())
    expect(Number(metrics().soon)).toBe(buckets.today.length + buckets.upcoming.length)
    expect(Number(metrics().overdue)).toBe(buckets.overdue.length)
  })

  it('keeps the overdue number neutral when nothing is overdue', async () => {
    await seedWorkspace({
      projects: [research],
      tasks: [makeTask({ projectId: research.id, dueDate: testToday(2) })],
    })
    renderOverview()
    expect(metrics()).toEqual({ active: '1', open: '1', soon: '1', overdue: '0' })
    expect(metric('overdue')).not.toHaveClass('text-danger')
  })
})

describe('OverviewPage metric cards', () => {
  it('link to the list each number counts', async () => {
    await seedStandard()
    renderOverview()
    const hrefOf = (key: string) =>
      document.querySelector(`[data-metric="${key}"] a`)?.getAttribute('href')
    expect(hrefOf('active')).toBe('/projects?status=active')
    expect(hrefOf('open')).toBe('/my-tasks/all')
    expect(hrefOf('soon')).toBe('/my-tasks/all?due=soon')
    expect(hrefOf('overdue')).toBe('/my-tasks/overdue')
    // The number is read with the link.
    expect(screen.getByRole('link', { name: 'Overdue' })).toHaveAccessibleDescription('2')
  })

  it('opens the destination with Enter on the focused card', async () => {
    await seedStandard()
    const { user } = renderOverview()
    const card = screen.getByRole('link', { name: /Due soon/ })
    card.focus()
    expect(card).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(location()).toBe('/my-tasks/all?due=soon')
  })

  it('shows a zero quietly: tertiary, never the danger or a result colour', async () => {
    await seedWorkspace({
      projects: [research],
      tasks: [makeTask({ projectId: research.id, dueDate: testToday(20) })],
    })
    renderOverview()
    expect(metrics()).toEqual({ active: '1', open: '1', soon: '0', overdue: '0' })
    expect(metric('soon')).toHaveClass('text-fg-tertiary')
    expect(metric('overdue')).toHaveClass('text-fg-tertiary')
    expect(metric('overdue')).not.toHaveClass('text-danger')
    expect(metric('open')).toHaveClass('text-fg')
  })
})

describe('OverviewPage active projects', () => {
  it('lists active projects with leaf-task progress, and "No tasks" instead of a fake 100%', async () => {
    await seedStandard()
    renderOverview()
    const active = section('Active projects')
    const items = within(
      within(active).getByRole('list', { name: 'Active projects' }),
    ).getAllByRole('listitem')
    expect(items.map((item) => within(item).getByRole('link').textContent)).toEqual([
      'Research Project',
      'Community Event',
      'Website Redesign',
    ])

    // Leaf tasks only: the parent "Recruit participants" is not counted twice, milestones never.
    const researchBar = within(items[0]).getByRole('progressbar', {
      name: 'Research Project progress',
    })
    expect(researchBar).toHaveAttribute('aria-valuenow', '33')
    expect(researchBar).toHaveAttribute('aria-valuetext', '33% · 2 of 6 tasks done')
    expect(within(items[1]).getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      '25% · 1 of 4 tasks done',
    )
    expect(within(items[2]).queryByRole('progressbar')).not.toBeInTheDocument()
    expect(within(items[2]).getByText('No tasks')).toBeInTheDocument()

    expect(within(active).queryByText('Shipped Pilot')).not.toBeInTheDocument()
    expect(within(active).queryByText('Old Archive')).not.toBeInTheDocument()
    expect(within(items[0]).getByRole('link')).toHaveAttribute('href', '/projects/p-research')
    expect(items[0]).toHaveTextContent(`Due ${formatDateSmart(testToday(40), testToday())}`)
    expect(within(active).getByRole('link', { name: /View all/ })).toHaveAttribute(
      'href',
      '/projects',
    )
  })

  it('shows each project’s open tasks and a date that is never passed off as a due date', async () => {
    const dated = makeProject({
      id: 'p-dated',
      name: 'Dated',
      sortOrder: 'b0',
      startDate: testToday(-5),
      dueDate: testToday(30),
    })
    const derived = makeProject({ id: 'p-derived', name: 'Derived', sortOrder: 'b1' })
    const bare = makeProject({ id: 'p-bare', name: 'Bare', sortOrder: 'b2' })
    await seedWorkspace({
      projects: [dated, derived, bare],
      tasks: [
        makeTask({ projectId: dated.id, title: 'A' }),
        makeTask({ projectId: dated.id, title: 'B', status: 'done' }),
        makeTask({
          projectId: derived.id,
          title: 'C',
          startDate: testToday(2),
          dueDate: testToday(9),
        }),
        makeTask({ projectId: derived.id, title: 'D', dueDate: testToday(12) }),
        makeTask({ projectId: bare.id, title: 'E' }),
      ],
    })
    renderOverview()
    const items = within(
      within(section('Active projects')).getByRole('list', { name: 'Active projects' }),
    ).getAllByRole('listitem')
    // Open = tasks that are not done (any level), the same count the Projects page shows.
    expect(items[0]).toHaveTextContent('1 open')
    expect(items[1]).toHaveTextContent('2 open')
    expect(items[2]).toHaveTextContent('1 open')
    // Own due date: plain "Due …".
    expect(items[0]).toHaveTextContent(`Due ${formatDateSmart(testToday(30), testToday())}`)
    expect(items[0]).not.toHaveTextContent('from tasks')
    // No due date but dated tasks: the span of the tasks, marked as derived, with its source.
    expect(items[1]).toHaveTextContent('from tasks')
    expect(items[1]).not.toHaveTextContent(/\bDue\b/)
    expect(items[1].querySelector('[title*="No due date is set"]')).not.toBeNull()
    // Nothing dated: no placeholder dash, only an assistive note.
    expect(items[2]).not.toHaveTextContent('—')
    expect(items[2]).toHaveTextContent('No dates')
    expect(items[2].querySelector('.sr-only')).not.toBeNull()
  })

  it('says so when no project is active', async () => {
    await seedWorkspace({ projects: [shipped, archived] })
    renderOverview()
    expect(screen.getByText('No active projects')).toBeInTheDocument()
    expect(
      screen.getByText(/Completed and archived projects are on the Projects page/),
    ).toBeInTheDocument()
    expect(metrics().active).toBe('0')
    // A workspace with only completed/archived projects is not "empty": no welcome screen.
    expect(screen.queryByText('Plan clearly. Work simply.')).not.toBeInTheDocument()
  })

  it('offers New project in the header', async () => {
    await seedStandard()
    const { user } = renderOverview()
    await user.click(screen.getByRole('button', { name: 'New project' }))
    expect(useUIStore.getState().projectDialog).toEqual({ mode: 'create' })
  })
})

describe('OverviewPage upcoming tasks', () => {
  it('lists overdue first, then today, then the next 7 days', async () => {
    await seedStandard()
    renderOverview()
    expect(rowNames(upcomingList())).toEqual([
      'Finalize report', // -3
      'Confirm venue', // -1
      'Review prototype', // today, priority beats the subtask's none
      SUBTASK_ROW, // today
      'Speaker shortlist', // +5
      'Recruit participants', // +6
    ])
    const overdueRow = rowOf('Finalize report')
    expect(within(overdueRow).getByText('(overdue)')).toBeInTheDocument()
    expect(
      within(rowOf('Review prototype')).getByText('Today').closest('[data-bucket]'),
    ).toHaveAttribute('data-bucket', 'today')
    // Project dot + name link to the project.
    expect(within(overdueRow).getByRole('link', { name: 'Research Project' })).toHaveAttribute(
      'href',
      '/projects/p-research',
    )
    // Nothing is cut, so there is no "Showing x of y".
    expect(within(section('Upcoming tasks')).queryByText(/^Showing/)).not.toBeInTheDocument()
    expect(
      within(section('Upcoming tasks')).getByRole('link', { name: /View all in My Tasks/ }),
    ).toHaveAttribute('href', '/my-tasks/all')
  })

  it('caps the list at eight rows and says how many there are', async () => {
    const tasks = Array.from({ length: 10 }, (_, index) =>
      makeTask({
        id: `t${index}`,
        projectId: research.id,
        title: `Task ${index + 1}`,
        dueDate: testToday((index % 7) + 1),
        sortOrder: `a${index}`,
      }),
    )
    await seedWorkspace({ projects: [research], tasks })
    renderOverview()
    expect(rowNames(upcomingList())).toHaveLength(8)
    expect(within(section('Upcoming tasks')).getByText('Showing 8 of 10')).toBeInTheDocument()
    expect(metrics().soon).toBe('10')
  })

  it('opens a task in the Task Modal through the URL', async () => {
    await seedStandard()
    const { user } = renderOverview()
    await user.click(screen.getByRole('button', { name: 'Speaker shortlist' }))
    expect(location()).toBe('/overview?task=t-speakers')
  })

  it('changes a status in place: the row leaves and every number follows', async () => {
    await seedStandard()
    const success = vi.spyOn(notify, 'success')
    const { user } = renderOverview()
    const progress = () =>
      within(section('Active projects')).getByRole('progressbar', {
        name: 'Research Project progress',
      })
    expect(progress()).toHaveAttribute('aria-valuetext', '33% · 2 of 6 tasks done')

    await user.click(
      within(rowOf('Review prototype')).getByRole('button', { name: 'Status: To Do' }),
    )
    await user.click(await screen.findByRole('menuitemradio', { name: /Done/ }))

    expect(storeTask('t-review')?.status).toBe('done')
    expect(rowNames(upcomingList())).not.toContain('Review prototype')
    expect(metrics()).toEqual({ active: '3', open: '7', soon: '3', overdue: '2' })
    expect(progress()).toHaveAttribute('aria-valuetext', '50% · 3 of 6 tasks done')
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1))
    const [message, options] = success.mock.calls[0]
    expect(message).toBe('Marked as done')

    const undo = options?.action as NotifyAction
    await act(async () => undo.onClick())
    await waitFor(() => expect(storeTask('t-review')?.status).toBe('todo'))
    expect(rowNames(upcomingList())).toContain('Review prototype')
    expect(metrics()).toEqual({ active: '3', open: '8', soon: '4', overdue: '2' })
    expect(progress()).toHaveAttribute('aria-valuetext', '33% · 2 of 6 tasks done')
  })

  it('rolls a failed status change back and never reports success', async () => {
    await seedStandard()
    const success = vi.spyOn(notify, 'success')
    const error = vi.spyOn(notify, 'error')
    const { user } = renderOverview()
    window.__cairnTest?.failNextWrites(1)

    await user.click(
      within(rowOf('Review prototype')).getByRole('button', { name: 'Status: To Do' }),
    )
    await user.click(await screen.findByRole('menuitemradio', { name: /Done/ }))
    await waitFor(() => expect(error).toHaveBeenCalled()) // the store's own toast (with Retry)
    expect(storeTask('t-review')?.status).toBe('todo')
    expect(rowNames(upcomingList())).toContain('Review prototype')
    expect(metrics().open).toBe('8')
    expect(success).not.toHaveBeenCalled()
  })

  it('has an empty section for "nothing soon", pointing at all tasks', async () => {
    await seedWorkspace({
      projects: [research],
      tasks: [
        makeTask({ projectId: research.id, title: 'Done already', status: 'done' }),
        makeTask({ projectId: research.id, title: 'Far away', dueDate: testToday(60) }),
      ],
    })
    renderOverview()
    const upcoming = section('Upcoming tasks')
    expect(within(upcoming).getByText('Nothing due in the next 7 days')).toBeInTheDocument()
    // The way out names what is behind it: the open tasks (the done one is not counted).
    expect(within(upcoming).getByRole('link', { name: 'View all 1 open task' })).toHaveAttribute(
      'href',
      '/my-tasks/all',
    )
    expect(within(upcoming).queryByRole('list')).not.toBeInTheDocument()
  })
})

describe('OverviewPage upcoming milestones', () => {
  it('lists the next 30 days by date and opens the project Gantt', async () => {
    await seedStandard()
    renderOverview()
    const list = within(section('Upcoming milestones')).getByRole('list', {
      name: 'Upcoming milestones',
    })
    const links = within(list).getAllByRole('link')
    // Not listed: a past milestone, one beyond 30 days, one in an archived project.
    expect(links.map((link) => link.textContent)).toEqual(['Submission deadline', 'Doors open'])
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/projects/p-research/gantt',
      '/projects/p-community/gantt',
    ])
    const [first] = within(list).getAllByRole('listitem')
    expect(first).toHaveTextContent('Research Project')
    expect(first).toHaveTextContent(formatDateSmart(testToday(9), testToday()))
  })

  it('includes day 30 and leaves out day 31', async () => {
    await seedWorkspace({
      projects: [research],
      milestones: [
        makeMilestone({ projectId: research.id, name: 'Day thirty', date: testToday(30) }),
        makeMilestone({ projectId: research.id, name: 'Day thirty-one', date: testToday(31) }),
      ],
    })
    renderOverview()
    expect(screen.getByRole('link', { name: 'Day thirty' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Day thirty-one' })).not.toBeInTheDocument()
  })
})

describe('OverviewPage mini timeline', () => {
  it('draws a small read-only timeline: project bars, milestone diamonds, a link to Timeline', async () => {
    await seedStandard()
    renderOverview()
    const timeline = section('Next 6 weeks')
    const rows = within(timeline).getAllByRole('listitem')
    expect(rows.map((row) => within(row).getByRole('link').textContent)).toEqual([
      'Research Project',
      'Community Event',
    ])
    expect(timeline.querySelectorAll('[data-span]')).toHaveLength(2)
    // Submission deadline (+9) and Doors open (+21); the past and far milestones are outside.
    expect(timeline.querySelectorAll('[data-milestone]')).toHaveLength(2)
    expect(within(rows[0]).getByRole('link')).toHaveAttribute('href', '/projects/p-research/gantt')
    expect(
      within(timeline).getByText('1 active project with nothing scheduled in these weeks'),
    ).toBeInTheDocument()
    expect(within(timeline).getByRole('link', { name: /Open Timeline/ })).toHaveAttribute(
      'href',
      '/timeline',
    )
    // Read-only: no editing controls, only links.
    expect(within(timeline).queryAllByRole('button')).toHaveLength(0)
  })

  it('names a bar’s dates and a diamond’s name and date on hover; both lead to the Gantt', async () => {
    await seedStandard()
    const { user } = renderOverview()
    const timeline = section('Next 6 weeks')
    const [bar] = Array.from(timeline.querySelectorAll<HTMLElement>('[data-span]'))
    expect(bar).toHaveAttribute('href', '/projects/p-research/gantt')
    await user.hover(bar)
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Research Project')
    // Research has its own due date but no own start: that end of the bar comes from its tasks.
    expect(tip).toHaveTextContent('from tasks')
    await user.unhover(bar)

    const [diamond] = Array.from(timeline.querySelectorAll<HTMLElement>('[data-milestone]'))
    expect(diamond).toHaveAttribute('href', '/projects/p-research/gantt')
    await user.hover(diamond)
    const milestoneTip = await screen.findByRole('tooltip')
    expect(milestoneTip).toHaveTextContent('Submission deadline')
    expect(milestoneTip).toHaveTextContent(/\d{4}/)
    await user.unhover(diamond)

    await user.click(bar)
    expect(location()).toBe('/projects/p-research/gantt')
  })

  it('says so when nothing is scheduled', async () => {
    await seedWorkspace({ projects: [website], tasks: [makeTask({ projectId: website.id })] })
    renderOverview()
    expect(screen.getByText('Nothing scheduled in the next 6 weeks')).toBeInTheDocument()
  })
})

describe('OverviewPage empty and failure states', () => {
  it('welcomes an empty workspace and creates the first project', async () => {
    await seedWorkspace({})
    const { user } = renderOverview()
    expect(screen.getByRole('heading', { name: 'Plan clearly. Work simply.' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Active projects' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create project' }))
    expect(useUIStore.getState().projectDialog).toEqual({ mode: 'create' })
  })

  it('shows calm empty sections when there are projects but no tasks', async () => {
    await seedWorkspace({ projects: [research, community] })
    const { user } = renderOverview()
    expect(metrics()).toEqual({ active: '2', open: '0', soon: '0', overdue: '0' })
    expect(within(section('Active projects')).getAllByText('No tasks')).toHaveLength(2)
    const upcoming = section('Upcoming tasks')
    expect(within(upcoming).getByText('No tasks yet')).toBeInTheDocument()
    expect(
      within(section('Upcoming milestones')).getByText('No milestones in the next 30 days'),
    ).toBeInTheDocument()
    await user.click(within(upcoming).getByRole('button', { name: 'New task' }))
    expect(useUIStore.getState().newTask).toEqual({})
  })

  it('shows a quiet loading state until the workspace is ready', () => {
    useWorkspaceStore.setState({ status: 'loading' })
    renderOverview()
    expect(screen.getByText('Loading your overview…').closest('[aria-busy="true"]')).not.toBeNull()
    expect(screen.queryByRole('heading', { name: 'Overview' })).not.toBeInTheDocument()
  })

  it('shows a load error with Retry that reloads the workspace', async () => {
    useWorkspaceStore.setState({
      status: 'error',
      loadError: { kind: 'network', message: 'The server did not answer.' },
    })
    const { user } = renderOverview()
    expect(
      screen.getByRole('heading', { name: 'Couldn’t load your workspace' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/The server did not answer/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    // Local mode reloads (an empty workspace here), so the welcome appears.
    expect(
      await screen.findByRole('heading', { name: 'Plan clearly. Work simply.' }),
    ).toBeInTheDocument()
  })
})
