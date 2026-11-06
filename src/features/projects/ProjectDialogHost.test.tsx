import { act, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useUIStore } from '@/app/uiStore'
import { ConfirmHost } from '@/components/ui/confirm'
import { getWorkspaceActions, useWorkspaceStore } from '@/data/store'
import { renderUI } from '@/test/render'
import { ProjectDialogHost } from './ProjectDialogHost'

function renderHost() {
  return renderUI(
    <>
      <ProjectDialogHost />
      <ConfirmHost />
    </>,
    { route: '/projects' },
  )
}

const dialog = () => screen.getByRole('dialog')
const nameField = () => within(dialog()).getByRole('textbox', { name: 'Name' })

beforeEach(async () => {
  localStorage.clear()
  useWorkspaceStore.getState().actions.reset()
  await getWorkspaceActions().load()
  act(() => useUIStore.setState({ projectDialog: null }))
})

describe('ProjectDialogHost — create', () => {
  it('requires a name, then creates the project and opens its List view', async () => {
    const { user, router } = renderHost()
    act(() => useUIStore.getState().openProjectDialog({ mode: 'create' }))
    await screen.findByRole('dialog', { name: 'New project' })

    await user.click(within(dialog()).getByRole('button', { name: 'Create project' }))
    expect(nameField()).toHaveAttribute('aria-invalid', 'true')
    expect(nameField()).toHaveAccessibleDescription('Project name is required.')
    expect(Object.keys(useWorkspaceStore.getState().data.projects)).toHaveLength(0)

    await user.type(nameField(), '  Research  ')
    await user.click(within(dialog()).getByRole('button', { name: 'Create project' }))

    await waitFor(() => expect(useUIStore.getState().projectDialog).toBeNull())
    const [project] = Object.values(useWorkspaceStore.getState().data.projects)
    expect(project.name).toBe('Research')
    expect(project.status).toBe('active')
    expect(router.state.location.pathname).toBe(`/projects/${project.id}/list`)
  })

  it('creates with ⌘/Ctrl+Enter from any field', async () => {
    const { user } = renderHost()
    act(() => useUIStore.getState().openProjectDialog({ mode: 'create' }))
    await screen.findByRole('dialog', { name: 'New project' })
    await user.type(nameField(), 'Launch')
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() =>
      expect(Object.values(useWorkspaceStore.getState().data.projects).map((p) => p.name)).toEqual([
        'Launch',
      ]),
    )
  })
})

describe('ProjectDialogHost — edit', () => {
  it('starts a fresh form on every opening and asks before discarding changes', async () => {
    const created = await getWorkspaceActions().createProject({ name: 'Research' })
    if (!created.ok) throw new Error(created.error.message)
    const projectId = created.value.id
    const { user } = renderHost()

    // 1st opening: rename and save.
    act(() => useUIStore.getState().openProjectDialog({ mode: 'edit', projectId }))
    await screen.findByRole('dialog', { name: 'Edit project' })
    expect(nameField()).toHaveValue('Research')
    await user.clear(nameField())
    await user.type(nameField(), 'Research v2')
    await user.click(within(dialog()).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(useUIStore.getState().projectDialog).toBeNull())
    expect(useWorkspaceStore.getState().data.projects[projectId].name).toBe('Research v2')

    // 2nd opening of the same project: the saved values, not the first form's leftovers.
    act(() => useUIStore.getState().openProjectDialog({ mode: 'edit', projectId }))
    await waitFor(() => expect(nameField()).toHaveValue('Research v2'))

    // Closing untouched needs no confirmation…
    await user.keyboard('{Escape}')
    await waitFor(() => expect(useUIStore.getState().projectDialog).toBeNull())

    // …but unsaved changes do.
    act(() => useUIStore.getState().openProjectDialog({ mode: 'edit', projectId }))
    await waitFor(() => expect(nameField()).toHaveValue('Research v2'))
    await user.type(nameField(), '!')
    await user.keyboard('{Escape}')
    const confirmDialog = await screen.findByRole('alertdialog', { name: 'Discard changes?' })
    await user.click(within(confirmDialog).getByRole('button', { name: 'Keep editing' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(nameField()).toHaveValue('Research v2!')

    await user.keyboard('{Escape}')
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }),
    )
    await waitFor(() => expect(useUIStore.getState().projectDialog).toBeNull())
    expect(useWorkspaceStore.getState().data.projects[projectId].name).toBe('Research v2')
  })
})

describe('ProjectDialogHost — a create that failed', () => {
  const projects = () => Object.values(useWorkspaceStore.getState().data.projects)

  async function failFirstCreate() {
    const view = renderHost()
    act(() => useUIStore.getState().openProjectDialog({ mode: 'create' }))
    await screen.findByRole('dialog', { name: 'New project' })
    await view.user.type(nameField(), 'Research')
    window.__cairnTest?.failNextWrites(1)
    await view.user.click(within(dialog()).getByRole('button', { name: 'Create project' }))
    await within(dialog()).findByText('Couldn’t create the project')
    expect(projects()).toHaveLength(0)
    return view
  }

  it('keeps the form and creates the project on "Try again"', async () => {
    const { user, router } = await failFirstCreate()
    await user.click(within(dialog()).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(useUIStore.getState().projectDialog).toBeNull())
    expect(projects().map((project) => project.name)).toEqual(['Research'])
    expect(router.state.location.pathname).toBe(`/projects/${projects()[0].id}/list`)
  })

  it('finishes with the project a Retry from outside the form created (never a second one)', async () => {
    const { user, router } = await failFirstCreate()
    // The sidebar's / the toast's Retry re-sends the failed create while the form is still open.
    await act(async () => {
      await getWorkspaceActions().retryLastFailed()
    })
    await waitFor(() => expect(useUIStore.getState().projectDialog).toBeNull())
    expect(projects().map((project) => project.name)).toEqual(['Research'])
    expect(router.state.location.pathname).toBe(`/projects/${projects()[0].id}/list`)
    expect(user).toBeDefined()
  })
})
