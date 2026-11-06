import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/app/uiStore'
import { getProjectView, reloadViewPrefsForTests } from '@/app/viewPrefs'
import { ConfirmHost } from '@/components/ui/confirm'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getWorkspaceActions, useWorkspaceStore } from '@/data/store'
import type { Result } from '@/domain/types'
import { ProjectLayout } from './ProjectLayout'
import { ViewBarActions } from './viewBar'

function must<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** A project view that puts a control into the view bar (like Gantt's scale switcher). */
function FakeView({ name }: { name: string }) {
  return (
    <>
      <ViewBarActions>
        <button type="button">{name} control</button>
      </ViewBarActions>
      <p>{name} body</p>
    </>
  )
}

function renderLayout(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/projects', element: <p>Projects page</p> },
      {
        path: '/projects/:projectId',
        element: (
          <TooltipProvider delayDuration={0}>
            <ProjectLayout />
            <ConfirmHost />
          </TooltipProvider>
        ),
        children: [
          { path: 'list', element: <FakeView name="List" /> },
          { path: 'board', element: <FakeView name="Board" /> },
          { path: 'gantt', element: <FakeView name="Gantt" /> },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  const user = userEvent.setup()
  render(<RouterProvider router={router} />)
  return { router, user }
}

vi.setConfig({ testTimeout: 20_000 })

beforeEach(async () => {
  localStorage.clear()
  reloadViewPrefsForTests()
  useWorkspaceStore.getState().actions.reset()
  must(await getWorkspaceActions().load())
  act(() => useUIStore.setState({ newTask: null, projectDialog: null, milestoneDialog: null }))
})

async function seedResearch(status: 'active' | 'archived' = 'active') {
  const a = getWorkspaceActions()
  const project = must(
    await a.createProject({
      name: 'Research',
      description: 'Interviews for the roadmap',
      status,
      startDate: '2026-10-20',
      dueDate: '2026-12-15',
    }),
  )
  const phase = must(await a.createPhase({ projectId: project.id, name: 'Discovery' }))
  const parent = must(await a.createTask({ projectId: project.id, title: 'Recruit' }))
  must(
    await a.createTask({
      projectId: project.id,
      title: 'Email',
      parentTaskId: parent.id,
      status: 'done',
    }),
  )
  must(await a.createTask({ projectId: project.id, title: 'Forum', parentTaskId: parent.id }))
  must(
    await a.createTask({
      projectId: project.id,
      title: 'Guide',
      phaseId: phase.id,
      status: 'done',
    }),
  )
  must(await a.createMilestone({ projectId: project.id, name: 'Kick-off', date: '2026-10-20' }))
  return { project, phase }
}

describe('ProjectLayout — header and view bar', () => {
  it('shows the project, its leaf-task progress and dates, and hosts the view controls', async () => {
    const { project } = await seedResearch()
    renderLayout(`/projects/${project.id}/list`)

    expect(screen.getByRole('heading', { level: 1, name: 'Research' })).toBeInTheDocument()
    expect(screen.getByText('Interviews for the roadmap')).toBeInTheDocument()
    // Leaf tasks: Email ✓, Forum, Guide ✓ (the parent and the milestone never count) → 66%.
    expect(screen.getByRole('progressbar', { name: 'Project progress' })).toHaveAttribute(
      'aria-valuetext',
      '66% · 2 of 3 tasks done',
    )
    expect(screen.getByText('Oct 20 – Dec 15', { exact: false })).toBeInTheDocument()

    const tabs = screen.getByRole('navigation', { name: 'Project views' })
    expect(within(tabs).getByRole('link', { name: 'List' })).toHaveAttribute('aria-current', 'page')
    // The view's own controls are portalled into the view bar.
    expect(await screen.findByRole('button', { name: 'List control' })).toBeInTheDocument()
    expect(screen.getByText('List body')).toBeInTheDocument()
  })

  it('switches views with 1 / 2 / 3 and remembers the last one', async () => {
    const { project } = await seedResearch()
    const { router, user } = renderLayout(`/projects/${project.id}/list`)

    await user.keyboard('2')
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/projects/${project.id}/board`),
    )
    expect(await screen.findByText('Board body')).toBeInTheDocument()
    expect(getProjectView(project.id)).toBe('board')

    await user.keyboard('3')
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/projects/${project.id}/gantt`),
    )
    await user.click(screen.getByRole('link', { name: 'List' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${project.id}/list`))
    expect(getProjectView(project.id)).toBe('list')
  })

  it('opens the new-task modal for this project', async () => {
    const { project } = await seedResearch()
    const { user } = renderLayout(`/projects/${project.id}/list`)
    await user.click(screen.getByRole('button', { name: 'New task' }))
    expect(useUIStore.getState().newTask).toEqual({ projectId: project.id })
  })
})

describe('ProjectLayout — states', () => {
  it('says when the project does not exist and links back', async () => {
    const { user, router } = renderLayout('/projects/missing-id/list')
    expect(screen.getByRole('heading', { name: 'Project not found' })).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'Back to Projects' }))
    expect(router.state.location.pathname).toBe('/projects')
  })

  it('shows a banner on an archived project and unarchives it', async () => {
    const { project } = await seedResearch('archived')
    const { user } = renderLayout(`/projects/${project.id}/list`)
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('This project is archived.')
    await user.click(within(banner).getByRole('button', { name: 'Unarchive' }))
    await waitFor(() =>
      expect(useWorkspaceStore.getState().data.projects[project.id].status).toBe('active'),
    )
    expect(screen.queryByText(/This project is archived/)).not.toBeInTheDocument()
  })
})

describe('ProjectLayout — menu', () => {
  it('adds a phase from the dialog', async () => {
    const { project } = await seedResearch()
    const { user } = renderLayout(`/projects/${project.id}/list`)
    await user.click(screen.getByRole('button', { name: 'Project actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Add phase…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New phase' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Report{Enter}')
    await waitFor(() =>
      expect(
        Object.values(useWorkspaceStore.getState().data.phases)
          .filter((phase) => phase.projectId === project.id)
          .map((phase) => phase.name),
      ).toEqual(['Discovery', 'Report']),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('adds a phase with a colour chosen in the dialog (optional)', async () => {
    const { project } = await seedResearch()
    const { user } = renderLayout(`/projects/${project.id}/list`)
    await user.click(screen.getByRole('button', { name: 'Project actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Add phase…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New phase' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Launch')
    expect(within(dialog).queryByRole('radio', { name: 'Red' })).toBeNull()
    await user.click(within(dialog).getByRole('radio', { name: 'Pink' }))
    await user.click(within(dialog).getByRole('button', { name: 'Add phase' }))
    await waitFor(() => {
      const launch = Object.values(useWorkspaceStore.getState().data.phases).find(
        (phase) => phase.name === 'Launch',
      )
      expect(launch?.color).toBe('pink')
    })
  })

  it('adds a phase without a colour: it follows the project colour', async () => {
    const { project } = await seedResearch()
    const { user } = renderLayout(`/projects/${project.id}/list`)
    await user.click(screen.getByRole('button', { name: 'Project actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Add phase…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New phase' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Plain{Enter}')
    await waitFor(() => {
      const plain = Object.values(useWorkspaceStore.getState().data.phases).find(
        (phase) => phase.name === 'Plain',
      )
      expect(plain).toBeDefined()
      expect(plain?.color).toBeNull()
    })
  })

  it('adds a failed phase once: a Retry from outside the dialog finishes it', async () => {
    const { project } = await seedResearch()
    const { user } = renderLayout(`/projects/${project.id}/list`)
    await user.click(screen.getByRole('button', { name: 'Project actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Add phase…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New phase' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Report')
    window.__cairnTest?.failNextWrites(1)
    await user.keyboard('{Enter}')
    await within(dialog).findByText('Couldn’t add the phase')
    const names = () =>
      Object.values(useWorkspaceStore.getState().data.phases)
        .filter((phase) => phase.projectId === project.id)
        .map((phase) => phase.name)
    expect(names()).toEqual(['Discovery'])

    // The sidebar's / the toast's Retry sends the failed phase while the dialog is still open.
    await act(async () => {
      await getWorkspaceActions().retryLastFailed()
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(names()).toEqual(['Discovery', 'Report'])
  })

  it('confirms a delete with exactly what goes with it, then leaves the project', async () => {
    const { project } = await seedResearch()
    const { user, router } = renderLayout(`/projects/${project.id}/list`)
    await user.click(screen.getByRole('button', { name: 'Project actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete project…' }))
    const confirmDialog = await screen.findByRole('alertdialog', { name: 'Delete “Research”?' })
    expect(confirmDialog).toHaveTextContent(
      'Deletes 2 tasks, 2 subtasks, 1 phase and 1 milestone along with the project.',
    )
    await user.click(within(confirmDialog).getByRole('button', { name: 'Delete project' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'))
    await waitFor(() =>
      expect(Object.hasOwn(useWorkspaceStore.getState().data.projects, project.id)).toBe(false),
    )
  })
})
