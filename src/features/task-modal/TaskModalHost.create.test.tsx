import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/app/uiStore'
import { useWorkspaceStore } from '@/data/store'
import { notify } from '@/lib/notify'
import {
  must,
  openNewTask,
  renderHosts,
  resetTestWorld,
  seedEmptyWorkspace,
  seedWorkspace,
  storeTasks,
  testHooks,
} from './testHarness'

const titleBox = () => screen.getByRole('textbox', { name: 'Task title' })
const createButton = () => screen.getByRole('button', { name: /^Create (sub)?task$/ })

async function findModal(name: string | RegExp = /^New (sub)?task$/) {
  return screen.findByRole('dialog', { name })
}

async function expectClosed() {
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
}

beforeEach(() => {
  resetTestWorld()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Interaction-heavy (user-event typing): generous timeout for parallel / loaded runs.
describe('Task Modal · create', { timeout: 20_000 }, () => {
  it('requires a title: Create stays disabled and Enter explains what is missing', async () => {
    const { project } = await seedWorkspace()
    const before = storeTasks().length
    const { user } = renderHosts(`/projects/${project.id}/list`)
    openNewTask({ projectId: project.id })
    await findModal()

    expect(titleBox()).toHaveFocus()
    expect(createButton()).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Task title is required.')).toBeInTheDocument()
    expect(titleBox()).toHaveAttribute('aria-invalid', 'true')

    // Spaces are not a title either.
    await user.type(titleBox(), '   ')
    expect(createButton()).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(storeTasks()).toHaveLength(before)

    await user.type(titleBox(), 'Draft survey')
    expect(screen.queryByText('Task title is required.')).not.toBeInTheDocument()
    expect(createButton()).toBeEnabled()
  })

  it('creates with the defaults (To Do, no priority, no dates) and offers to open the task', async () => {
    const { project } = await seedWorkspace()
    const createTask = vi.spyOn(useWorkspaceStore.getState().actions, 'createTask')
    const success = vi.spyOn(notify, 'success')
    const { user, router } = renderHosts(`/projects/${project.id}/list`)
    openNewTask({ projectId: project.id })
    const modal = await findModal()

    // Default property chips.
    expect(within(modal).getByRole('button', { name: 'Status: To Do' })).toBeInTheDocument()
    expect(within(modal).getByRole('button', { name: 'Priority: No priority' })).toBeInTheDocument()
    expect(within(modal).getByRole('button', { name: 'Start date: not set' })).toBeInTheDocument()
    expect(within(modal).getByRole('button', { name: 'Due date: not set' })).toBeInTheDocument()
    expect(within(modal).getByRole('button', { name: 'Phase: No phase' })).toBeInTheDocument()

    await user.type(titleBox(), '  Draft survey questions ')
    await user.click(screen.getByRole('textbox', { name: 'Description' }))
    await user.keyboard('Ten questions, max.')
    await user.click(createButton())

    await expectClosed()
    expect(createTask).toHaveBeenCalledTimes(1)
    expect(createTask).toHaveBeenCalledWith({
      projectId: project.id,
      title: 'Draft survey questions',
      description: 'Ten questions, max.',
      status: 'todo',
      priority: 'none',
      startDate: null,
      dueDate: null,
      phaseId: null,
      parentTaskId: null,
    })
    const created = storeTasks().find((task) => task.title === 'Draft survey questions')
    expect(created).toMatchObject({ status: 'todo', priority: 'none', parentTaskId: null })

    expect(success).toHaveBeenCalledWith(
      'Task created',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Open' }) }),
    )
    const [, options] = success.mock.calls[0]
    options?.action?.onClick()
    await waitFor(() => expect(router.state.location.search).toBe(`?task=${created?.id}`))
    expect(await findModal(/^Edit task/)).toBeInTheDocument()
    expect(titleBox()).toHaveValue('Draft survey questions')
  })

  it("uses the opener's defaults: phase, status, priority, dates and placement", async () => {
    const { project, writingId, tasks } = await seedWorkspace()
    const createTask = vi.spyOn(useWorkspaceStore.getState().actions, 'createTask')
    const { user } = renderHosts(`/projects/${project.id}/board`)
    openNewTask({
      projectId: project.id,
      phaseId: writingId,
      status: 'in_progress',
      priority: 'high',
      startDate: '2026-11-09',
      dueDate: '2026-11-13',
      placement: { afterId: tasks['Submit draft'].id },
    })
    const modal = await findModal()
    expect(within(modal).getByRole('button', { name: 'Status: In Progress' })).toBeInTheDocument()
    expect(within(modal).getByRole('button', { name: 'Priority: High' })).toBeInTheDocument()
    expect(within(modal).getByRole('button', { name: 'Phase: Writing' })).toBeInTheDocument()
    expect(
      within(modal).getByRole('button', { name: 'Start date: Monday, November 9, 2026' }),
    ).toBeInTheDocument()

    await user.type(titleBox(), 'Proofread{Enter}')
    await expectClosed()
    expect(createTask).toHaveBeenCalledWith({
      projectId: project.id,
      title: 'Proofread',
      description: null,
      status: 'in_progress',
      priority: 'high',
      startDate: '2026-11-09',
      dueDate: '2026-11-13',
      phaseId: writingId,
      parentTaskId: null,
      placement: { afterId: tasks['Submit draft'].id },
    })
  })

  it('global New task asks for a project and remembers the last one used', async () => {
    const { project, other } = await seedWorkspace()
    const { user } = renderHosts('/overview')
    openNewTask()
    const modal = await findModal()

    const picker = within(modal).getByRole('button', { name: 'Project: none chosen' })
    // The footer says why Create is unavailable; trying anyway turns it into the field error.
    expect(within(modal).getByText('Choose a project to create this task.')).toBeInTheDocument()
    await user.type(titleBox(), 'Order snacks{Enter}')
    expect(await screen.findByText('Choose a project for this task.')).toBeInTheDocument()
    expect(within(modal).queryByText('Choose a project to create this task.')).toBeNull()
    expect(createButton()).toBeDisabled()

    await user.click(picker)
    const menu = await screen.findByRole('menu')
    // Only active projects are offered.
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['Research', 'Community event'])
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Community event' }))
    await user.click(createButton())
    await expectClosed()
    expect(storeTasks().find((task) => task.title === 'Order snacks')?.projectId).toBe(other.id)

    openNewTask()
    const again = await findModal()
    expect(within(again).getByRole('button', { name: 'Project: Community event' })).toBeVisible()
    expect(project.id).not.toBe(other.id)
  })

  it('without any project it explains why and offers to create one', async () => {
    await seedEmptyWorkspace()
    const { user } = renderHosts('/overview')
    openNewTask()
    const modal = await findModal()

    expect(within(modal).getByText('Create a project first')).toBeInTheDocument()
    expect(createButton()).toBeDisabled()
    await user.type(titleBox(), 'First task')
    await user.click(within(modal).getByRole('button', { name: 'Create project' }))
    await expectClosed()
    expect(useUIStore.getState().projectDialog).toEqual({ mode: 'create' })
    expect(useUIStore.getState().newTask).toBeNull()

    // The project dialog creates a project and closes: New task comes back with the draft.
    const created = await useWorkspaceStore.getState().actions.createProject({ name: 'Thesis' })
    expect(created.ok).toBe(true)
    act(() => useUIStore.getState().closeProjectDialog())
    const back = await findModal()
    expect(within(back).getByRole('button', { name: 'Project: Thesis' })).toBeInTheDocument()
    expect(titleBox()).toHaveValue('First task')
    await user.click(createButton())
    await expectClosed()
    expect(storeTasks()).toEqual([expect.objectContaining({ title: 'First task' })])
  })

  it('cancelling the project dialog does not bring New task back', async () => {
    await seedEmptyWorkspace()
    const { user } = renderHosts('/overview')
    openNewTask()
    await findModal()
    await user.type(titleBox(), 'Maybe later')
    await user.click(screen.getByRole('button', { name: 'Create project' }))
    await expectClosed()
    act(() => useUIStore.getState().closeProjectDialog())
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useUIStore.getState().newTask).toBeNull()
  })

  it('a failed create keeps the modal open with everything typed (no success toast)', async () => {
    const { project } = await seedWorkspace()
    const success = vi.spyOn(notify, 'success')
    const { user } = renderHosts(`/projects/${project.id}/list`)
    openNewTask({ projectId: project.id })
    await findModal()

    testHooks().failNextWrites(1)
    await user.type(titleBox(), 'This one fails')
    await user.click(screen.getByRole('button', { name: 'Priority: No priority' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Urgent/ }))
    await user.click(createButton())

    // The store rolled the optimistic task back (and toasted the error with Retry).
    await waitFor(() => expect(createButton()).toBeEnabled())
    expect(storeTasks().some((task) => task.title === 'This one fails')).toBe(false)
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeInTheDocument()
    expect(titleBox()).toHaveValue('This one fails')
    expect(screen.getByRole('button', { name: 'Priority: Urgent' })).toBeInTheDocument()
    expect(success).not.toHaveBeenCalled()

    // Trying again works.
    await user.click(createButton())
    await expectClosed()
    expect(storeTasks().find((task) => task.title === 'This one fails')?.priority).toBe('urgent')
  })

  it('when Retry stores the task a failed create left behind, the form closes (no duplicate)', async () => {
    const { project } = await seedWorkspace()
    const success = vi.spyOn(notify, 'success')
    const { user } = renderHosts(`/projects/${project.id}/list`)
    openNewTask({ projectId: project.id })
    await findModal()

    testHooks().failNextWrites(1)
    await user.type(titleBox(), 'Retried task')
    await user.click(createButton())
    await waitFor(() => expect(createButton()).toBeEnabled())
    expect(storeTasks().some((task) => task.title === 'Retried task')).toBe(false)

    // The toast's Retry (here the store action behind it) stores the task behind the open form.
    must(await useWorkspaceStore.getState().actions.retryLastFailed())
    await expectClosed()
    expect(storeTasks().filter((task) => task.title === 'Retried task')).toHaveLength(1)
    // The form confirms its task; the store's Retry adds its generic "Saved" (decision D13).
    expect(success).toHaveBeenCalledTimes(2)
    expect(success).toHaveBeenCalledWith('Saved')
    expect(success).toHaveBeenCalledWith(
      'Task created',
      expect.objectContaining({ description: 'Retried task' }),
    )
  })

  it('a form changed after a failure stays open when an older Retry lands', async () => {
    const { project } = await seedWorkspace()
    const { user } = renderHosts(`/projects/${project.id}/list`)
    openNewTask({ projectId: project.id })
    await findModal()

    testHooks().failNextWrites(1)
    await user.type(titleBox(), 'First try')
    await user.click(createButton())
    await waitFor(() => expect(createButton()).toBeEnabled())

    // The user carries on with the form: it no longer stands for the failed attempt.
    await user.type(titleBox(), ' (renamed)')
    must(await useWorkspaceStore.getState().actions.retryLastFailed())
    await waitFor(() => expect(storeTasks().some((task) => task.title === 'First try')).toBe(true))
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeInTheDocument()
    expect(titleBox()).toHaveValue('First try (renamed)')
  })

  it('a "New task" request takes over from an edit form, which keeps what was typed', async () => {
    const { project, tasks } = await seedWorkspace()
    const review = tasks['Write literature review']
    const { user } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
    await findModal(/^Edit task: Write literature review$/)

    await user.type(titleBox(), '!')
    await user.type(screen.getByRole('textbox', { name: 'Add subtask' }), 'Kept as well')
    openNewTask({ projectId: project.id })

    // Nothing to ask: the edit form saves as it goes.
    await findModal()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(titleBox()).toHaveValue('')
    await waitFor(() =>
      expect(storeTasks().find((task) => task.id === review.id)?.title).toBe(
        'Write literature review!',
      ),
    )
    await waitFor(() =>
      expect(storeTasks().find((task) => task.title === 'Kept as well')?.parentTaskId).toBe(
        review.id,
      ),
    )
  })

  it('a "New task" request keeps a typed create form unless the user agrees to discard it', async () => {
    const { project, other } = await seedWorkspace()
    const { user } = renderHosts(`/projects/${project.id}/list`)
    openNewTask({ projectId: project.id })
    await findModal()
    await user.type(titleBox(), 'Half-typed')

    openNewTask({ projectId: other.id })
    const prompt = await screen.findByRole('alertdialog', { name: 'Discard changes?' })
    await user.click(within(prompt).getByRole('button', { name: 'Keep editing' }))
    await waitFor(() => expect(titleBox()).toHaveFocus())
    expect(titleBox()).toHaveValue('Half-typed')
    expect(screen.getByRole('button', { name: 'Project: Research' })).toBeInTheDocument()

    openNewTask({ projectId: other.id })
    await user.click(
      within(await screen.findByRole('alertdialog', { name: 'Discard changes?' })).getByRole(
        'button',
        { name: 'Discard' },
      ),
    )
    await waitFor(() => expect(titleBox()).toHaveValue(''))
    expect(screen.getByRole('button', { name: 'Project: Community event' })).toBeInTheDocument()
  })

  it('a clean form is replaced by a "New task" request without asking', async () => {
    const { project, tasks } = await seedWorkspace()
    const review = tasks['Write literature review']
    renderHosts(`/projects/${project.id}/list?task=${review.id}`)
    await findModal(/^Edit task: Write literature review$/)

    openNewTask({ projectId: project.id })
    await findModal()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('asks before discarding a typed task; an untouched form closes right away', async () => {
    const { project } = await seedWorkspace()
    const { user } = renderHosts(`/projects/${project.id}/list`)

    openNewTask({ projectId: project.id })
    await findModal()
    await user.keyboard('{Escape}')
    await expectClosed()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

    openNewTask({ projectId: project.id })
    await findModal()
    await user.type(titleBox(), 'Half a thought')
    await user.keyboard('{Escape}')
    const confirmDialog = await screen.findByRole('alertdialog', { name: 'Discard changes?' })
    await user.click(within(confirmDialog).getByRole('button', { name: 'Keep editing' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(titleBox()).toHaveValue('Half a thought')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    const again = await screen.findByRole('alertdialog', { name: 'Discard changes?' })
    await user.click(within(again).getByRole('button', { name: 'Discard' }))
    await expectClosed()
    expect(storeTasks().some((task) => task.title === 'Half a thought')).toBe(false)
  })

  it('gives focus back to the element that opened it', async () => {
    const { project } = await seedWorkspace()
    const { user } = renderHosts(`/projects/${project.id}/list`)
    const opener = document.createElement('button')
    opener.textContent = 'New task'
    document.body.append(opener)
    try {
      opener.focus()
      openNewTask({ projectId: project.id })
      await findModal()
      expect(titleBox()).toHaveFocus()
      await user.keyboard('{Escape}')
      await expectClosed()
      await waitFor(() => expect(opener).toHaveFocus())
    } finally {
      opener.remove()
    }
  })

  it('Esc that cancels an IME composition does not close the modal', async () => {
    const { project } = await seedWorkspace()
    const { user } = renderHosts(`/projects/${project.id}/list`)
    openNewTask({ projectId: project.id })
    await findModal()
    fireEvent.keyDown(titleBox(), { key: 'Escape', isComposing: true })
    fireEvent.keyDown(titleBox(), { key: 'Escape', keyCode: 229 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await expectClosed()
  })

  it('a slow create finishing later still confirms, without closing the next New task', async () => {
    const { project } = await seedWorkspace()
    const success = vi.spyOn(notify, 'success')
    const { user } = renderHosts(`/projects/${project.id}/list`)
    openNewTask({ projectId: project.id })
    await findModal()

    testHooks().setLatency(150)
    await user.type(titleBox(), 'First{Enter}')
    // In flight: closing does not ask, and a new "New task" can start right away.
    await user.keyboard('{Escape}')
    await expectClosed()
    openNewTask({ projectId: project.id })
    await findModal()
    await user.type(titleBox(), 'Second')

    await waitFor(() => expect(success).toHaveBeenCalledWith('Task created', expect.anything()))
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeInTheDocument()
    expect(titleBox()).toHaveValue('Second')
  })
})
