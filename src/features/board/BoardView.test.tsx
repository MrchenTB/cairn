import { useState } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useUIStore } from '@/app/uiStore'
import { getWorkspaceActions, useWorkspaceStore } from '@/data/store'
import type { Task } from '@/domain/types'
import { ViewBarSlotProvider } from '@/features/projects/viewBar'
import { BoardView } from './BoardView'

function Harness() {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  return (
    <TooltipProvider delayDuration={0}>
      <div ref={setSlot} data-testid="view-bar" />
      <ViewBarSlotProvider slot={slot}>
        <BoardView />
      </ViewBarSlotProvider>
    </TooltipProvider>
  )
}

function renderBoard(url: string) {
  const router = createMemoryRouter(
    [{ path: '/projects/:projectId/board', element: <Harness /> }],
    {
      initialEntries: [url],
    },
  )
  const user = userEvent.setup()
  render(<RouterProvider router={router} />)
  return { router, user }
}

function must<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

interface Seeded {
  projectId: string
  discoveryId: string
  tasks: Record<string, Task>
}

/** A project with two phases, top-level tasks in all columns and subtasks — via store actions. */
async function seed(): Promise<Seeded> {
  const a = getWorkspaceActions()
  const project = must(await a.createProject({ name: 'Research' }))
  const discovery = must(await a.createPhase({ projectId: project.id, name: 'Discovery' }))
  must(await a.createPhase({ projectId: project.id, name: 'Build' }))
  const tasks: Record<string, Task> = {}
  const add = async (title: string, extra: Partial<Task> = {}) => {
    tasks[title] = must(await a.createTask({ projectId: project.id, title, ...extra }))
  }
  await add('Interview users', { phaseId: discovery.id, priority: 'high' })
  await add('Draft survey')
  await add('Prototype', { status: 'in_progress' })
  await add('Write brief', { status: 'done' })
  await add('Plan retro')
  for (const [title, status] of [
    ['Recruit', 'done'],
    ['Schedule', 'todo'],
    ['Notes', 'todo'],
  ] as const) {
    must(
      await a.createTask({
        projectId: project.id,
        title,
        status,
        parentTaskId: tasks['Interview users'].id,
      }),
    )
  }
  must(await a.load())
  return { projectId: project.id, discoveryId: discovery.id, tasks }
}

const column = (name: RegExp) => screen.getByRole('region', { name })
const cardTitles = (region: HTMLElement) =>
  Array.from(region.querySelectorAll('[data-card-activator]')).map((el) =>
    el.getAttribute('aria-label'),
  )
const storeTask = (id: string) => useWorkspaceStore.getState().data.tasks[id]

/** The local repository's test hooks (installed in dev/test builds, local mode). */
function testHooks() {
  const hooks = window.__cairnTest
  if (!hooks) throw new Error('window.__cairnTest is not installed')
  return hooks
}

beforeEach(() => {
  localStorage.clear()
  window.__cairnTest?.failNextWrites(0)
  window.__cairnTest?.setLatency(0)
  useWorkspaceStore.getState().actions.reset()
  useUIStore.setState({ newTask: null })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BoardView', () => {
  it('shows three fixed columns with counts and the top-level tasks in project order', async () => {
    const { projectId } = await seed()
    renderBoard(`/projects/${projectId}/board`)

    const todo = column(/^To Do/)
    expect(todo).toHaveAccessibleName('To Do 3 tasks')
    expect(cardTitles(todo)).toEqual(['Interview users', 'Draft survey', 'Plan retro'])
    expect(cardTitles(column(/^In Progress/))).toEqual(['Prototype'])
    expect(cardTitles(column(/^Done/))).toEqual(['Write brief'])
    // Subtasks are summarised on their parent, never shown as cards.
    expect(screen.queryByRole('button', { name: 'Recruit' })).not.toBeInTheDocument()
  })

  it('renders card meta: priority only when set, subtask summary, phase chip, readable description', async () => {
    const { projectId } = await seed()
    renderBoard(`/projects/${projectId}/board`)

    const interview = screen.getByRole('button', { name: 'Interview users' })
    expect(interview).toHaveAccessibleDescription(
      expect.stringContaining('Priority: High. 1 of 3 subtasks done. Phase: Discovery.'),
    )
    const interviewCard = interview.closest('li') as HTMLElement
    expect(interviewCard.querySelector('[data-priority="high"]')).not.toBeNull()
    expect(interviewCard).toHaveTextContent('1/3')
    expect(interviewCard).toHaveTextContent('Discovery')

    const draftCard = screen
      .getByRole('button', { name: 'Draft survey' })
      .closest('li') as HTMLElement
    expect(draftCard.querySelector('[data-priority]')).toBeNull()
    expect(draftCard).not.toHaveTextContent('/')
  })

  it('opens the Task Modal (?task=) on click and on Enter', async () => {
    const { projectId, tasks } = await seed()
    const { router, user } = renderBoard(`/projects/${projectId}/board`)

    await user.click(screen.getByRole('button', { name: 'Draft survey' }))
    expect(router.state.location.search).toBe(`?task=${tasks['Draft survey'].id}`)

    await act(() => router.navigate(`/projects/${projectId}/board`))
    screen.getByRole('button', { name: 'Prototype' }).focus()
    await user.keyboard('{Enter}')
    expect(router.state.location.search).toBe(`?task=${tasks.Prototype.id}`)
  })

  it('keys the card and its ⋯ button so focus finds them again after the card moved columns', async () => {
    const { projectId, tasks } = await seed()
    const { user } = renderBoard(`/projects/${projectId}/board`)
    const id = tasks['Plan retro'].id
    expect(screen.getByRole('button', { name: 'Plan retro' })).toHaveAttribute(
      'data-focus-key',
      `board-card:${id}`,
    )
    expect(screen.getByRole('button', { name: 'More actions for Plan retro' })).toHaveAttribute(
      'data-focus-key',
      `board-card-menu:${id}`,
    )

    // The card is a new element in its new column, with the same key.
    const before = screen.getByRole('button', { name: 'Plan retro' })
    const card = before.closest('li') as HTMLElement
    await user.click(within(card).getByRole('button', { name: 'Status: To Do' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /In Progress/ }))
    const after = screen.getByRole('button', { name: 'Plan retro' })
    expect(before.isConnected).toBe(false)
    expect(after).toHaveAttribute('data-focus-key', `board-card:${id}`)
  })

  it('changes column through the status menu (non-drag alternative)', async () => {
    const { projectId, tasks } = await seed()
    const { user } = renderBoard(`/projects/${projectId}/board`)

    const card = screen.getByRole('button', { name: 'Plan retro' }).closest('li') as HTMLElement
    await user.click(within(card).getByRole('button', { name: 'Status: To Do' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /In Progress/ }))

    expect(storeTask(tasks['Plan retro'].id).status).toBe('in_progress')
    expect(cardTitles(column(/^In Progress/))).toContain('Plan retro')
    expect(cardTitles(column(/^To Do/))).not.toContain('Plan retro')
  })

  it('rolls a failed status change back and keeps keyboard focus on the card', async () => {
    const { projectId, tasks } = await seed()
    const { user } = renderBoard(`/projects/${projectId}/board`)
    testHooks().failNextWrites(1)

    const card = screen.getByRole('button', { name: 'Plan retro' }).closest('li') as HTMLElement
    await user.click(within(card).getByRole('button', { name: 'Status: To Do' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /In Progress/ }))

    // Optimistic first, then rolled back once the write failed.
    await waitFor(() => expect(cardTitles(column(/^To Do/))).toContain('Plan retro'))
    expect(cardTitles(column(/^In Progress/))).not.toContain('Plan retro')
    expect(storeTask(tasks['Plan retro'].id).status).toBe('todo')
    expect(useWorkspaceStore.getState().sync.lastError).not.toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Plan retro' })).toHaveFocus())
  })

  it('moves focus between cards with the arrow keys', async () => {
    const { projectId } = await seed()
    const { user } = renderBoard(`/projects/${projectId}/board`)
    const card = (name: string) => screen.getByRole('button', { name })

    card('Interview users').focus()
    await user.keyboard('{ArrowDown}')
    expect(card('Draft survey')).toHaveFocus()
    await user.keyboard('{ArrowRight}') // In Progress has one card: its last
    expect(card('Prototype')).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(card('Write brief')).toHaveFocus()
    await user.keyboard('{ArrowUp}{ArrowRight}') // nothing above, no column further right
    expect(card('Write brief')).toHaveFocus()
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(card('Interview users')).toHaveFocus()
  })

  it('reorders within a column from the ⋯ menu without touching status', async () => {
    const { projectId, tasks } = await seed()
    const { user } = renderBoard(`/projects/${projectId}/board`)

    const card = screen
      .getByRole('button', { name: 'Interview users' })
      .closest('li') as HTMLElement
    await user.click(within(card).getByRole('button', { name: /More actions/ }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Move up' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.click(within(menu).getByRole('menuitem', { name: 'Move down' }))

    await waitFor(() =>
      expect(cardTitles(column(/^To Do/))).toEqual([
        'Draft survey',
        'Interview users',
        'Plan retro',
      ]),
    )
    expect(storeTask(tasks['Interview users'].id).status).toBe('todo')
  })

  it('puts a card back where it was when a menu move fails', async () => {
    const { projectId } = await seed()
    const { user } = renderBoard(`/projects/${projectId}/board`)
    testHooks().failNextWrites(1)

    const card = screen
      .getByRole('button', { name: 'Interview users' })
      .closest('li') as HTMLElement
    await user.click(within(card).getByRole('button', { name: /More actions/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move to bottom' }))

    await waitFor(() => expect(useWorkspaceStore.getState().sync.lastError).not.toBeNull())
    expect(cardTitles(column(/^To Do/))).toEqual(['Interview users', 'Draft survey', 'Plan retro'])
  })

  it('adds tasks inline at the end of a column and keeps focus for rapid entry', async () => {
    const { projectId } = await seed()
    const { user } = renderBoard(`/projects/${projectId}/board`)

    await user.click(screen.getByRole('button', { name: 'Add task to Done' }))
    const input = screen.getByRole('textbox', { name: 'New task in Done' })
    expect(input).toHaveFocus()
    await user.type(input, 'Ship it{Enter}')
    await user.type(input, 'Celebrate{Enter}')

    expect(input).toHaveFocus()
    expect(input).toHaveValue('')
    expect(cardTitles(column(/^Done/))).toEqual(['Write brief', 'Ship it', 'Celebrate'])
    const created = Object.values(useWorkspaceStore.getState().data.tasks).find(
      (task) => task.title === 'Celebrate',
    )
    expect(created).toMatchObject({ status: 'done', phaseId: null, parentTaskId: null })

    // Whitespace only creates nothing; Esc closes and returns focus to the button.
    await user.type(input, '   {Enter}')
    expect(cardTitles(column(/^Done/))).toHaveLength(3)
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add task to Done' })).toHaveFocus(),
    )
  })

  it('shows validation errors inline and gives the text back', async () => {
    const { projectId } = await seed()
    const actions = useWorkspaceStore.getState().actions
    vi.spyOn(actions, 'createTask').mockResolvedValue({
      ok: false,
      error: { kind: 'validation', message: 'Task title is too long.' },
    })
    const { user } = renderBoard(`/projects/${projectId}/board`)

    await user.click(screen.getByRole('button', { name: 'Add task to To Do' }))
    const input = screen.getByRole('textbox', { name: 'New task in To Do' })
    await user.type(input, 'Too long{Enter}')

    expect(await screen.findByText('Task title is too long.')).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Task title is too long.')
    expect(input).toHaveValue('Too long')
  })

  it('opens the full Task Modal pre-set to the column from the header "+"', async () => {
    const { projectId } = await seed()
    const { user } = renderBoard(`/projects/${projectId}/board`)

    await user.click(screen.getByRole('button', { name: 'New task in In Progress' }))
    expect(useUIStore.getState().newTask).toEqual({
      projectId,
      status: 'in_progress',
      phaseId: null,
    })
  })

  it('filters by phase from the URL, and new tasks join the filtered phase', async () => {
    const { projectId, discoveryId } = await seed()
    const { user, router } = renderBoard(`/projects/${projectId}/board?phase=${discoveryId}`)

    expect(screen.getByTestId('view-bar')).toHaveTextContent('Discovery')
    expect(cardTitles(column(/^To Do/))).toEqual(['Interview users'])
    expect(cardTitles(column(/^In Progress/))).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Add task to In Progress' }))
    await user.type(
      screen.getByRole('textbox', { name: 'New task in In Progress' }),
      'Synthesis{Enter}',
    )
    const created = Object.values(useWorkspaceStore.getState().data.tasks).find(
      (task) => task.title === 'Synthesis',
    )
    expect(created).toMatchObject({ status: 'in_progress', phaseId: discoveryId })

    await user.click(screen.getByRole('button', { name: 'Clear phase filter' }))
    expect(router.state.location.search).toBe('')
    expect(cardTitles(column(/^To Do/))).toEqual(['Interview users', 'Draft survey', 'Plan retro'])
  })

  it('explains an empty filtered board and offers to clear the filter', async () => {
    const { projectId } = await seed()
    const build = Object.values(useWorkspaceStore.getState().data.phases).find(
      (p) => p.name === 'Build',
    )
    const { user, router } = renderBoard(`/projects/${projectId}/board?phase=${build?.id}`)

    expect(screen.getByText('No tasks in Build')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear filter' }))
    expect(router.state.location.search).toBe('')
  })

  it('shows the whole due date on hover, and a click on it still opens the task', async () => {
    const { projectId, tasks } = await seed()
    must(
      await getWorkspaceActions().updateTask(tasks['Draft survey'].id, { dueDate: '2026-11-13' }),
    )
    const { user, router } = renderBoard(`/projects/${projectId}/board`)

    const card = screen.getByRole('button', { name: 'Draft survey' }).closest('li') as HTMLElement
    const due = card.querySelector('[data-bucket]') as HTMLElement
    expect(due).toHaveAttribute(
      'title',
      expect.stringMatching(/^(Overdue · )?Due Friday, November 13, 2026$/),
    )
    await user.click(due)
    expect(router.state.location.search).toContain(`task=${tasks['Draft survey'].id}`)
  })

  it('explains the count of a column: top-level tasks, subtasks stay on their parent', async () => {
    const { projectId } = await seed()
    renderBoard(`/projects/${projectId}/board`)
    expect(column(/^To Do/).querySelector('h2 [title]')).toHaveAttribute(
      'title',
      'Top-level tasks; subtasks show on their parent’s card',
    )
  })

  it('says so when the "No phase" filter matches nothing', async () => {
    const a = getWorkspaceActions()
    const project = must(await a.createProject({ name: 'Research' }))
    const build = must(await a.createPhase({ projectId: project.id, name: 'Build' }))
    must(await a.createTask({ projectId: project.id, title: 'Ship it', phaseId: build.id }))
    must(await a.load())
    renderBoard(`/projects/${project.id}/board?phase=none`)
    expect(screen.getByText('Every task in this project has a phase.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear filter' })).toBeInTheDocument()
  })

  it('shows skeletons while loading and an error with Retry when loading failed', async () => {
    const { projectId } = await seed()
    act(() => useWorkspaceStore.setState({ status: 'loading' }))
    renderBoard(`/projects/${projectId}/board`)
    expect(screen.getByRole('status')).toHaveTextContent('Loading board…')

    act(() =>
      useWorkspaceStore.setState({
        status: 'error',
        loadError: { kind: 'network', message: 'Network error — check your connection.' },
      }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load this board')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
