/**
 * The Timeline on real store data (local repository in jsdom): empty / loading / error states,
 * one row per project with its bar and diamonds, expansion remembered for the session, the
 * read-only bars opening the Task Modal route and the milestone dialog, the project link to its
 * Gantt, Include completed (archived never), and the scale kept per page.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/app/uiStore'
import { getGanttScale, reloadViewPrefsForTests } from '@/app/viewPrefs'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getWorkspaceActions, useWorkspaceStore } from '@/data/store'
import { addDays, todayInTimeZone } from '@/domain/dates'
import type { Task } from '@/domain/types'
import { TimelinePage } from './TimelinePage'
import { reloadTimelinePrefsForTests } from './timelinePrefs'

function renderTimeline() {
  const router = createMemoryRouter(
    [
      {
        path: '/timeline',
        element: (
          <TooltipProvider delayDuration={0}>
            <TimelinePage />
          </TooltipProvider>
        ),
      },
      { path: '/projects/:projectId/gantt', element: <p>Project Gantt</p> },
    ],
    { initialEntries: ['/timeline'] },
  )
  const user = userEvent.setup()
  const view = render(<RouterProvider router={router} />)
  return { router, user, ...view }
}

function must<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

const at = (days: number) =>
  addDays(todayInTimeZone(useWorkspaceStore.getState().preferences.timezone), days)

async function seed() {
  const a = getWorkspaceActions()
  const launch = must(await a.createProject({ name: 'Launch', color: 'violet' }))
  const task = async (title: string, extra: Partial<Task> = {}) =>
    must(await a.createTask({ projectId: launch.id, title, ...extra }))
  const brief = await task('Brief', { startDate: at(-2), dueDate: at(1), status: 'done' })
  const wire = await task('Wireframes', { startDate: at(2), dueDate: at(5) })
  const review = await task('Review', { dueDate: at(9) })
  await task('Someday')
  const signOff = must(
    await a.createMilestone({ projectId: launch.id, name: 'Sign-off', date: at(9) }),
  )
  const research = must(
    await a.createProject({ name: 'Research', startDate: at(1), dueDate: at(20) }),
  )
  const ideas = must(await a.createProject({ name: 'Ideas' }))
  must(await a.createTask({ projectId: ideas.id, title: 'Undated idea' }))
  must(await a.load())
  return { launch, brief, wire, review, signOff, research, ideas }
}

const chart = () => screen.getByRole('region', { name: 'Timeline of all projects' })
const rowKeys = () =>
  Array.from(chart().querySelectorAll('[data-row-key]')).map((row) =>
    row.getAttribute('data-row-key'),
  )
const rowOf = (key: string) => chart().querySelector(`[data-row-key="${key}"]`) as HTMLElement

beforeEach(async () => {
  localStorage.clear()
  sessionStorage.clear()
  reloadViewPrefsForTests()
  reloadTimelinePrefsForTests()
  useWorkspaceStore.getState().actions.reset()
  useUIStore.setState({ milestoneDialog: null, projectDialog: null })
  must(await getWorkspaceActions().load())
  // jsdom has no layout: give the scroll container a desktop-sized viewport.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TimelinePage states', () => {
  it('shows the loading state until the workspace is ready', () => {
    useWorkspaceStore.setState({ status: 'loading' })
    renderTimeline()
    expect(screen.getByRole('status')).toHaveTextContent('Loading your timeline…')
    expect(screen.queryByRole('region', { name: 'Timeline of all projects' })).toBeNull()
  })

  it('shows the error state with a working Retry', async () => {
    useWorkspaceStore.setState({
      status: 'error',
      loadError: { kind: 'network', message: 'Network is down' },
    })
    const { user } = renderTimeline()
    expect(screen.getByRole('alert')).toHaveTextContent('Network is down')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { name: 'No projects yet' })).toBeInTheDocument()
  })

  it('without projects: an empty state that creates one', async () => {
    const { user } = renderTimeline()
    expect(screen.getByRole('heading', { name: 'No projects yet' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New project' }))
    expect(useUIStore.getState().projectDialog).toEqual({ mode: 'create' })
  })

  it('with only completed projects: offers Include completed; archived never appear', async () => {
    const a = getWorkspaceActions()
    must(await a.createProject({ name: 'Finished', status: 'completed', dueDate: at(-3) }))
    must(await a.createProject({ name: 'Shelved', status: 'archived', dueDate: at(-3) }))
    const { user } = renderTimeline()
    expect(screen.getByRole('heading', { name: 'No active projects' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Include completed' }))
    expect(within(chart()).getByRole('link', { name: 'Finished' })).toBeInTheDocument()
    expect(within(chart()).queryByRole('link', { name: 'Shelved' })).toBeNull()
    expect(screen.getByRole('switch', { name: /Include completed/ })).toBeChecked()
  })

  it('with nothing scheduled: lists the projects as Unscheduled and says what to do', async () => {
    const a = getWorkspaceActions()
    const ideas = must(await a.createProject({ name: 'Ideas' }))
    must(await a.createTask({ projectId: ideas.id, title: 'Undated' }))
    renderTimeline()
    expect(screen.getByRole('heading', { name: 'Nothing scheduled yet' })).toBeInTheDocument()
    expect(rowKeys()).toEqual(['section:unscheduled', `project:${ideas.id}`])
    expect(screen.getByRole('link', { name: 'Plan Ideas' })).toHaveAttribute(
      'href',
      `/projects/${ideas.id}/gantt`,
    )
    // Nothing to expand: no chevron on an unscheduled project.
    expect(within(rowOf(`project:${ideas.id}`)).queryByRole('button')).toBeNull()
  })

  it('hides the Include completed switch when no project is completed', async () => {
    await seed()
    renderTimeline()
    expect(screen.queryByRole('switch')).toBeNull()
  })
})

describe('TimelinePage rows', () => {
  it('starts with one row per project, unscheduled last, and draws no task rows', async () => {
    const s = await seed()
    renderTimeline()
    expect(rowKeys()).toEqual([
      `project:${s.launch.id}`,
      `project:${s.research.id}`,
      'section:unscheduled',
      `project:${s.ideas.id}`,
    ])
    expect(screen.queryByRole('heading', { name: 'Nothing scheduled yet' })).toBeNull()
    expect(chart().querySelector(`[data-project-bar="${s.launch.id}"]`)).not.toBeNull()
    expect(chart().querySelector(`[data-project-bar="${s.ideas.id}"]`)).toBeNull()
  })

  it('shows progress subtly on the bar and in words', async () => {
    const s = await seed()
    renderTimeline()
    const bar = chart().querySelector(`[data-project-bar="${s.launch.id}"]`) as HTMLElement
    // 1 of 4 leaf tasks done.
    expect(bar.querySelector('[data-progress-fill]')).toHaveStyle({ width: '25%' })
    expect(bar).toHaveAttribute('title', expect.stringContaining('1 of 4 tasks done · 25%'))
    expect(within(rowOf(`project:${s.launch.id}`)).getByText('25%')).toBeInTheDocument()
    // Own dates, no tasks: no fill, and never a fake 100%.
    const research = rowOf(`project:${s.research.id}`)
    expect(research.querySelector('[data-progress-fill]')).toBeNull()
    expect(within(research).getByText('No tasks')).toBeInTheDocument()
  })

  it('links the project name to its Gantt, describing the row for screen readers', async () => {
    const s = await seed()
    const { user, router } = renderTimeline()
    const link = within(rowOf(`project:${s.research.id}`)).getByRole('link', { name: 'Research' })
    expect(link).toHaveAccessibleDescription(expect.stringContaining('No tasks'))
    await user.click(link)
    expect(router.state.location.pathname).toBe(`/projects/${s.research.id}/gantt`)
    expect(screen.getByText('Project Gantt')).toBeInTheDocument()
  })

  it('expands a project into scheduled tasks and milestones, and collapses it again', async () => {
    const s = await seed()
    const { user } = renderTimeline()
    const expand = screen.getByRole('button', { name: 'Expand Launch, 4 scheduled items' })
    expect(expand).toHaveAttribute('aria-expanded', 'false')
    await user.click(expand)
    expect(rowKeys()).toEqual([
      `project:${s.launch.id}`,
      `task:${s.brief.id}`,
      `task:${s.wire.id}`,
      `task:${s.review.id}`,
      `milestone:${s.signOff.id}`,
      `project:${s.research.id}`,
      'section:unscheduled',
      `project:${s.ideas.id}`,
    ])
    const collapse = screen.getByRole('button', { name: 'Collapse Launch, 4 scheduled items' })
    expect(collapse).toHaveAttribute('aria-expanded', 'true')
    await user.click(collapse)
    expect(rowKeys()).toHaveLength(4)
  })

  it('remembers expansion for the session, across pages and a fresh page load', async () => {
    const s = await seed()
    const first = renderTimeline()
    await first.user.click(screen.getByRole('button', { name: /^Expand Launch/ }))
    expect(rowKeys()).toContain(`task:${s.wire.id}`)
    first.unmount()

    renderTimeline()
    expect(rowKeys()).toContain(`task:${s.wire.id}`)

    reloadTimelinePrefsForTests() // what a reload reads back from sessionStorage
    expect(rowKeys()).toContain(`task:${s.wire.id}`)
  })

  it('clicking the project bar toggles the same expansion', async () => {
    const s = await seed()
    const { user } = renderTimeline()
    await user.click(chart().querySelector(`[data-project-bar="${s.launch.id}"]`) as HTMLElement)
    expect(rowKeys()).toContain(`task:${s.wire.id}`)
  })

  it('draws read-only bars: no drag handles, Enter and click open the Task Modal route', async () => {
    const s = await seed()
    const { user, router } = renderTimeline()
    await user.click(screen.getByRole('button', { name: /^Expand Launch/ }))

    const bar = chart().querySelector(`[data-task-id="${s.wire.id}"]`) as HTMLElement
    expect(bar).toHaveAttribute('aria-keyshortcuts', 'Enter')
    expect(bar).toHaveClass('cursor-pointer')
    expect(bar.querySelector('[data-handle^="resize"], [data-handle^="link"]')).toBeNull()
    expect(bar).toHaveAccessibleDescription(expect.stringContaining('read-only'))

    await user.click(bar)
    expect(router.state.location.search).toBe(`?task=${s.wire.id}`)

    const review = chart().querySelector(`[data-task-id="${s.review.id}"]`) as HTMLElement
    review.focus()
    await user.keyboard('{Enter}')
    expect(router.state.location.search).toBe(`?task=${s.review.id}`)

    // The title in the pane opens it too.
    await user.click(within(rowOf(`task:${s.brief.id}`)).getByRole('button', { name: 'Brief' }))
    expect(router.state.location.search).toBe(`?task=${s.brief.id}`)
    // Never changes dates: read-only.
    const stored = useWorkspaceStore.getState().data.tasks[s.wire.id]
    expect(stored.startDate).toBe(at(2))
  })

  it('never moves a bar with the Gantt keyboard nudges', async () => {
    const s = await seed()
    const { user } = renderTimeline()
    await user.click(screen.getByRole('button', { name: /^Expand Launch/ }))
    const bar = chart().querySelector(`[data-task-id="${s.wire.id}"]`) as HTMLElement
    bar.focus()
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}')
    expect(useWorkspaceStore.getState().data.tasks[s.wire.id].startDate).toBe(at(2))
  })

  it('opens the milestone dialog from the diamond on the project row and its own row', async () => {
    const s = await seed()
    const { user } = renderTimeline()
    const diamond = within(rowOf(`project:${s.launch.id}`)).getByRole('button', {
      name: /^Milestone Sign-off/,
    })
    expect(diamond).toHaveAttribute('aria-keyshortcuts', 'Enter')
    await user.click(diamond)
    expect(useUIStore.getState().milestoneDialog).toEqual({
      mode: 'edit',
      milestoneId: s.signOff.id,
    })

    useUIStore.setState({ milestoneDialog: null })
    diamond.focus()
    await user.keyboard('{Enter}')
    expect(useUIStore.getState().milestoneDialog).toEqual({
      mode: 'edit',
      milestoneId: s.signOff.id,
    })

    useUIStore.setState({ milestoneDialog: null })
    await user.click(screen.getByRole('button', { name: /^Expand Launch/ }))
    await user.click(
      within(rowOf(`milestone:${s.signOff.id}`)).getByRole('button', { name: /Sign-off$/ }),
    )
    expect(useUIStore.getState().milestoneDialog).toEqual({
      mode: 'edit',
      milestoneId: s.signOff.id,
    })
  })

  it('marks a dependency conflict on the listed task, like the Gantt', async () => {
    const s = await seed()
    const a = getWorkspaceActions()
    // Violated: Brief starts (at -2) long before Review, its new predecessor, is due (at +9).
    must(await a.addDependency(s.review.id, s.brief.id))
    const { user } = renderTimeline()
    await user.click(screen.getByRole('button', { name: /^Expand Launch/ }))
    const bar = chart().querySelector(`[data-task-id="${s.brief.id}"]`) as HTMLElement
    expect(bar).toHaveAttribute('title', expect.stringContaining('Should start after “Review”'))
  })

  it('reflects store changes without a reload', async () => {
    const s = await seed()
    renderTimeline()
    expect(within(rowOf(`project:${s.launch.id}`)).getByText('25%')).toBeInTheDocument()
    must(await getWorkspaceActions().updateTask(s.wire.id, { status: 'done' }))
    await waitFor(() =>
      expect(within(rowOf(`project:${s.launch.id}`)).getByText('50%')).toBeInTheDocument(),
    )
    must(await getWorkspaceActions().updateProject(s.ideas.id, { startDate: at(3) }))
    await waitFor(() => expect(rowKeys()).not.toContain('section:unscheduled'))
  })
})

describe('TimelinePage controls', () => {
  it('Day / Week / Month are kept for this page, apart from any project', async () => {
    await seed()
    const { user } = renderTimeline()
    expect(screen.getByRole('radio', { name: 'Week' })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: 'Month' }))
    expect(getGanttScale('timeline')).toBe('month')
    expect(screen.getByRole('radio', { name: 'Month' })).toBeChecked()
  })

  it('Today and the T key scroll to today', async () => {
    await seed()
    const scrollTo = vi.fn()
    Element.prototype.scrollTo = scrollTo as typeof Element.prototype.scrollTo
    const { user } = renderTimeline()
    scrollTo.mockClear() // the virtualizer's own initial call
    await user.click(screen.getByRole('button', { name: 'Today' }))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.body, { key: 't' })
    expect(scrollTo).toHaveBeenCalledTimes(2)
    Reflect.deleteProperty(Element.prototype, 'scrollTo')
  })

  it('Include completed adds completed projects in project order', async () => {
    const a = getWorkspaceActions()
    must(await a.createProject({ name: 'Active', dueDate: at(4) }))
    must(await a.createProject({ name: 'Finished', status: 'completed', dueDate: at(-4) }))
    const { user } = renderTimeline()
    const toggle = screen.getByRole('switch', { name: /Include completed/ })
    expect(toggle).not.toBeChecked()
    expect(within(chart()).queryByRole('link', { name: 'Finished' })).toBeNull()
    await user.click(toggle)
    expect(within(chart()).getByRole('link', { name: 'Finished' })).toBeInTheDocument()
    expect(within(chart()).getByText('Completed')).toBeInTheDocument()
    expect(localStorage.getItem('cairn:timeline-include-completed')).toBe('true')
  })
})
