import { screen, waitFor, within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from '@/data/store'
import { notify } from '@/lib/notify'
import {
  must,
  renderHosts,
  resetTestWorld,
  seedWorkspace,
  storeTask,
  storeTasks,
  testHooks,
} from './testHarness'

const titleBox = () => screen.getByRole('textbox', { name: 'Task title' })
const doneButton = () => screen.getByRole('button', { name: 'Done' })
const dependencies = () => Object.values(useWorkspaceStore.getState().data.dependencies)
const blockedByList = () => screen.getByRole('list', { name: 'Blocked by' })

async function findModal(title: string) {
  return screen.findByRole('dialog', { name: `Edit task: ${title}` })
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
describe('Task Modal · edit', { timeout: 20_000 }, () => {
  it('opens from ?task=<id> and closing removes only the task param', async () => {
    const { project, tasks } = await seedWorkspace()
    const review = tasks['Write literature review']
    const { user, router } = renderHosts(
      `/projects/${project.id}/list?view=compact&task=${review.id}`,
    )
    const modal = await findModal('Write literature review')

    expect(titleBox()).toHaveValue('Write literature review')
    expect(titleBox()).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue(
      'Summarise the core papers.',
    )
    expect(within(modal).getByRole('button', { name: 'Status: In Progress' })).toBeInTheDocument()
    expect(within(modal).getByRole('button', { name: 'Priority: High' })).toBeInTheDocument()
    expect(within(modal).getByRole('button', { name: 'Phase: Writing' })).toBeInTheDocument()
    // Read-only project link (tasks never move between projects).
    expect(within(modal).getByRole('link', { name: 'Research' })).toHaveAttribute(
      'href',
      `/projects/${project.id}`,
    )
    expect(within(modal).getByText(/^Created/)).toBeInTheDocument()
    // Saves by itself: no Save, no Cancel, only a way to finish.
    expect(doneButton()).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()

    await user.click(within(modal).getByRole('button', { name: 'Close' }))
    await expectClosed()
    expect(router.state.location.pathname).toBe(`/projects/${project.id}/list`)
    expect(router.state.location.search).toBe('?view=compact')
  })

  it('an unknown task id reports "Task not found" and removes the param', async () => {
    const { project } = await seedWorkspace()
    const error = vi.spyOn(notify, 'error')
    const { router } = renderHosts(`/projects/${project.id}/list?task=missing-task`)
    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(error).toHaveBeenCalledWith('Task not found', expect.anything())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('requires a title: empty on blur puts the saved title back and says so', async () => {
    const { project, tasks } = await seedWorkspace()
    const { user } = renderHosts(`/projects/${project.id}/list?task=${tasks['Book a room'].id}`)
    await findModal('Book a room')

    await user.clear(titleBox())
    expect(await screen.findByText('Task title is required.')).toBeInTheDocument()
    expect(titleBox()).toHaveAttribute('aria-invalid', 'true')

    await user.tab()
    await waitFor(() => expect(titleBox()).toHaveValue('Book a room'))
    expect(screen.getByText('A task needs a title, so “Book a room” was kept.')).toBeInTheDocument()
    expect(screen.queryByText('Task title is required.')).not.toBeInTheDocument()
    expect(storeTask(tasks['Book a room'].id)?.title).toBe('Book a room')
  })

  it('the start can’t be picked after the due date, nor the due date before the start', async () => {
    const { project, tasks } = await seedWorkspace()
    const review = tasks['Write literature review']
    const { user } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
    await findModal('Write literature review')

    await user.click(screen.getByRole('button', { name: /^Start date:/ }))
    expect(await screen.findByRole('button', { name: /November 13th, 2026/ })).toBeDisabled()
    expect(screen.getByText('The start can’t be after the due date.')).toBeInTheDocument()
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: /^Due date:/ }))
    expect(await screen.findByRole('button', { name: /November 4th, 2026/ })).toBeDisabled()
    expect(screen.getByText('Due date can’t be before the start date.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /November 24th, 2026/ }))
    // Saved at once, as a pair; the banner describes what is stored now.
    await waitFor(() =>
      expect(storeTask(review.id)).toMatchObject({
        startDate: '2026-11-05',
        dueDate: '2026-11-24',
      }),
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Dependency conflict“Submit draft” starts before this task finishes. It should start on or after Nov 25.',
    )
  })

  it('clearing both dates saves each pick (empty dates are stored as null)', async () => {
    const { project, tasks } = await seedWorkspace()
    const submit = tasks['Submit draft']
    const { user } = renderHosts(`/projects/${project.id}/list?task=${submit.id}`)
    await findModal('Submit draft')

    await user.click(screen.getByRole('button', { name: /^Start date:/ }))
    await user.click(await screen.findByRole('button', { name: 'Clear' }))
    await waitFor(() =>
      expect(storeTask(submit.id)).toMatchObject({ startDate: null, dueDate: '2026-11-11' }),
    )
    await user.click(screen.getByRole('button', { name: /^Due date:/ }))
    await user.click(await screen.findByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(storeTask(submit.id)).toMatchObject({ dueDate: null }))
    expect(screen.getByRole('button', { name: 'Start date: not set' })).toBeInTheDocument()
  })

  it.each([
    ['Esc', async (user: UserEvent) => user.keyboard('{Escape}')],
    [
      'the X button',
      async (user: UserEvent) => user.click(screen.getByRole('button', { name: 'Close' })),
    ],
    ['Done', async (user: UserEvent) => user.click(doneButton())],
    ['⌘↵', async (user: UserEvent) => user.keyboard('{Control>}{Enter}{/Control}')],
  ])('%s keeps what was typed and closes, without asking', async (_name, leave) => {
    const { project, tasks } = await seedWorkspace()
    const room = tasks['Book a room']
    const { user, router } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
    await findModal('Book a room')

    await user.type(titleBox(), ' for Friday')
    await leave(user)
    await expectClosed()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(router.state.location.search).toBe('')
    await waitFor(() => expect(storeTask(room.id)?.title).toBe('Book a room for Friday'))
  })

  it('typing and undoing an edit writes nothing', async () => {
    const { project, tasks } = await seedWorkspace()
    const room = tasks['Book a room']
    const update = vi.spyOn(useWorkspaceStore.getState().actions, 'updateTask')
    const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
    await findModal('Book a room')
    await user.type(titleBox(), 'x')
    await user.type(titleBox(), '{Backspace}')
    await user.keyboard('{Escape}')
    await expectClosed()
    expect(update).not.toHaveBeenCalled()
  })

  it('subtasks: rows open the subtask, status and "Add subtask" save immediately', async () => {
    const { project, tasks } = await seedWorkspace()
    const review = tasks['Write literature review']
    const draft = tasks['Draft related work']
    const { user, router } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
    await findModal('Write literature review')

    const section = screen.getByRole('region', { name: 'Subtasks' })
    expect(within(section).getByText('One level of subtasks')).toBeInTheDocument()
    expect(within(section).getByText('1/2')).toBeInTheDocument()

    await user.click(
      within(section).getByRole('button', { name: 'Status of “Draft related work”: To Do' }),
    )
    await user.click(await screen.findByRole('menuitemradio', { name: /Done/ }))
    await waitFor(() => expect(storeTask(draft.id)?.status).toBe('done'))
    expect(within(section).getByText('2/2')).toBeInTheDocument()

    const add = within(section).getByRole('textbox', { name: 'Add subtask' })
    await user.type(add, 'Check citations{Enter}')
    await waitFor(() =>
      expect(storeTasks().find((task) => task.title === 'Check citations')).toMatchObject({
        parentTaskId: review.id,
      }),
    )
    expect(add).toHaveValue('')
    expect(add).toHaveFocus()

    await user.click(within(section).getByRole('button', { name: 'Draft related work' }))
    await waitFor(() => expect(router.state.location.search).toBe(`?task=${draft.id}`))
    const subtaskModal = await findModal('Draft related work')
    expect(within(subtaskModal).getByText('Subtask of Write literature review')).toBeInTheDocument()
    // One level only: a subtask has no Subtasks section, and its phase follows the parent.
    expect(screen.queryByRole('region', { name: 'Subtasks' })).not.toBeInTheDocument()
    // The limit is stated where someone would look for "Add subtask" (PRD §5.1), not just implied.
    expect(subtaskModal).toHaveTextContent(
      'A subtask can’t have subtasks of its own (one level only).',
    )
    expect(within(subtaskModal).getByRole('button', { name: 'Phase: Writing' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('a failed "Add subtask" gives its text back; Retry storing it clears the line (no duplicate)', async () => {
    const { project, tasks } = await seedWorkspace()
    const review = tasks['Write literature review']
    const { user } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
    await findModal('Write literature review')
    const add = screen.getByRole('textbox', { name: 'Add subtask' })

    testHooks().failNextWrites(1)
    await user.type(add, 'Check citations{Enter}')
    await waitFor(() => expect(add).toHaveValue('Check citations'))
    expect(storeTasks().some((task) => task.title === 'Check citations')).toBe(false)

    must(await useWorkspaceStore.getState().actions.retryLastFailed())
    await waitFor(() => expect(add).toHaveValue(''))
    expect(storeTasks().filter((task) => task.title === 'Check citations')).toHaveLength(1)
  })

  it('⌘↵ in "Add subtask" adds the typed subtask and stays', async () => {
    const { project, tasks } = await seedWorkspace()
    const review = tasks['Write literature review']
    const { user } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
    await findModal('Write literature review')
    const add = screen.getByRole('textbox', { name: 'Add subtask' })

    await user.type(add, 'Check citations')
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() =>
      expect(storeTasks().find((task) => task.title === 'Check citations')?.parentTaskId).toBe(
        review.id,
      ),
    )
    expect(add).toHaveValue('')
    expect(screen.getByRole('dialog', { name: /Edit task/ })).toBeInTheDocument()
  })

  it('closing with text in "Add subtask" adds it, with an Undo', async () => {
    const { project, tasks } = await seedWorkspace()
    const review = tasks['Write literature review']
    const success = vi.spyOn(notify, 'success')
    const { user } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
    await findModal('Write literature review')
    await user.type(screen.getByRole('textbox', { name: 'Add subtask' }), 'Not lost')
    await user.click(doneButton())
    await expectClosed()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(storeTasks().find((task) => task.title === 'Not lost')?.parentTaskId).toBe(review.id),
    )
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(
        'Subtask added',
        expect.objectContaining({
          description: 'Not lost',
          action: expect.objectContaining({ label: 'Undo' }),
        }),
      ),
    )
  })

  it('dependency picker: same-project tasks only, and an invalid link says why', async () => {
    const { project, other, tasks } = await seedWorkspace()
    const review = tasks['Write literature review']
    const elsewhere = await useWorkspaceStore
      .getState()
      .actions.createTask({ projectId: other.id, title: 'Rent chairs' })
    expect(elsewhere.ok).toBe(true)
    const { user } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
    await findModal('Write literature review')

    const blockedBy = screen.getByRole('list', { name: 'Blocked by' })
    const blocking = screen.getByRole('list', { name: 'Blocking' })
    expect(within(blockedBy).getByRole('button', { name: 'Collect sources' })).toBeInTheDocument()
    expect(within(blocking).getByRole('button', { name: 'Submit draft' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add a task that blocks this one' }))
    const listbox = await screen.findByRole('listbox')
    const names = within(listbox)
      .getAllByRole('option')
      .map((option) => option.querySelector('span span')?.textContent)
    // Not itself, not its own subtasks, not an existing blocker, not another project's task.
    // (phases in order, then the tasks without a phase — the List's order)
    expect(names).toEqual(['Submit draft', 'Book a room'])

    // "Submit draft" is blocked BY this task: linking it the other way would be a cycle.
    const cycle = within(listbox).getByRole('option', { name: /Submit draft/ })
    expect(cycle).toHaveAttribute('aria-disabled', 'true')
    expect(cycle).toHaveTextContent('This would create a circular dependency.')

    // Search narrows the list (domain search), then Enter links the task.
    await user.keyboard('room')
    await waitFor(() => expect(within(listbox).getAllByRole('option')).toHaveLength(1))
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(within(blockedBy).getByRole('button', { name: 'Book a room' })).toBeInTheDocument(),
    )
    expect(
      dependencies().some(
        (d) => d.predecessorId === tasks['Book a room'].id && d.successorId === review.id,
      ),
    ).toBe(true)

    // Chips are removable (immediately); focus stays in the row (here: the chip before).
    await user.click(screen.getByRole('button', { name: 'Remove “Book a room” from Blocked by' }))
    await waitFor(() =>
      expect(dependencies().some((d) => d.predecessorId === tasks['Book a room'].id)).toBe(false),
    )
    expect(
      screen.getByRole('button', { name: 'Remove “Collect sources” from Blocked by' }),
    ).toHaveFocus()
  })

  describe('undated-link hint', () => {
    const hint = /This task has no dates, so its links aren't drawn on the chart/

    it('shows for an undated task that has a link', async () => {
      const { project, tasks } = await seedWorkspace()
      const book = tasks['Book a room']
      expect(
        (
          await useWorkspaceStore
            .getState()
            .actions.addDependency(book.id, tasks['Submit draft'].id)
        ).ok,
      ).toBe(true)
      renderHosts(`/projects/${project.id}/list?task=${book.id}`)
      await findModal('Book a room')
      expect(screen.getByText(hint)).toHaveTextContent(
        "This task has no dates, so its links aren't drawn on the chart and don't pass scheduling constraints on to other tasks.",
      )
    })

    it('is hidden when the task has dates', async () => {
      const { project, tasks } = await seedWorkspace()
      const review = tasks['Write literature review']
      renderHosts(`/projects/${project.id}/list?task=${review.id}`)
      await findModal('Write literature review')
      expect(screen.queryByText(hint)).not.toBeInTheDocument()
    })

    it('is hidden when the task has no links', async () => {
      const { project, tasks } = await seedWorkspace()
      const book = tasks['Book a room']
      renderHosts(`/projects/${project.id}/list?task=${book.id}`)
      await findModal('Book a room')
      expect(screen.queryByText(hint)).not.toBeInTheDocument()
    })
  })

  it('removing a chip moves focus to the next chip of the row', async () => {
    const { project, tasks } = await seedWorkspace()
    const review = tasks['Write literature review']
    const actions = useWorkspaceStore.getState().actions
    expect((await actions.addDependency(tasks['Book a room'].id, review.id)).ok).toBe(true)
    const { user } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
    await findModal('Write literature review')

    screen.getByRole('button', { name: 'Remove “Collect sources” from Blocked by' }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(dependencies().some((d) => d.predecessorId === tasks['Collect sources'].id)).toBe(
        false,
      ),
    )
    expect(
      screen.getByRole('button', { name: 'Remove “Book a room” from Blocked by' }),
    ).toHaveFocus()
    // The last chip of the row: focus goes to "Add".
    await user.keyboard('{Enter}')
    await waitFor(() => expect(within(blockedByList()).queryAllByRole('listitem')).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Add a task that blocks this one' })).toHaveFocus()
  })

  it('shows the dependency conflict with the required start date and a Gantt link', async () => {
    const { project, tasks } = await seedWorkspace()
    const submit = tasks['Submit draft']
    const { user } = renderHosts(`/projects/${project.id}/list?task=${submit.id}`)
    await findModal('Submit draft')

    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('Dependency conflict')
    expect(banner).toHaveTextContent(
      'Starts before “Write literature review” finishes. Start on or after Nov 13.',
    )
    expect(within(banner).getByRole('link', { name: 'Open Gantt' })).toHaveAttribute(
      'href',
      `/projects/${project.id}/gantt?task=${submit.id}`,
    )

    // The banner follows the saved dates: the due date first (the start can't pass it), then
    // starting on Nov 13 resolves it.
    await user.click(screen.getByRole('button', { name: /^Due date:/ }))
    await user.click(await screen.findByRole('button', { name: /November 14th, 2026/ }))
    await user.click(screen.getByRole('button', { name: /^Start date:/ }))
    await user.click(await screen.findByRole('button', { name: /November 13th, 2026/ }))
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })

  it('delete: a task with subtasks asks whether to keep them (moved to top level)', async () => {
    const { project, tasks } = await seedWorkspace()
    const review = tasks['Write literature review']
    const success = vi.spyOn(notify, 'success')
    const { user, router } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
    await findModal('Write literature review')

    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByRole('menuitem', { name: /Delete task/ }))
    const choice = await screen.findByRole('alertdialog', {
      name: 'Delete “Write literature review”?',
    })
    expect(choice).toHaveAccessibleDescription(expect.stringContaining('It has 2 subtasks.'))
    expect(
      within(choice)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Cancel', 'Keep subtasks (move to top level)', 'Delete subtasks too'])
    // Destructive choice: focus starts on Cancel.
    expect(within(choice).getByRole('button', { name: 'Cancel' })).toHaveFocus()

    await user.click(
      within(choice).getByRole('button', { name: 'Keep subtasks (move to top level)' }),
    )
    await expectClosed()
    expect(router.state.location.search).toBe('')
    await waitFor(() => expect(success).toHaveBeenCalledWith('Task deleted · subtasks kept'))
    expect(storeTask(review.id)).toBeUndefined()
    expect(storeTask(tasks['Outline chapters'].id)?.parentTaskId).toBeNull()
    expect(storeTask(tasks['Draft related work'].id)?.parentTaskId).toBeNull()
  })

  it('delete: "Delete subtasks too" removes the subtasks; Cancel keeps everything', async () => {
    const { project, tasks } = await seedWorkspace()
    const review = tasks['Write literature review']
    const error = vi.spyOn(notify, 'error')
    const { user } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
    await findModal('Write literature review')

    const openDelete = async () => {
      await user.click(screen.getByRole('button', { name: 'More actions' }))
      await user.click(await screen.findByRole('menuitem', { name: /Delete task/ }))
      return screen.findByRole('alertdialog')
    }

    let choice = await openDelete()
    await user.click(within(choice).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: /Edit task/ })).toBeInTheDocument()
    expect(storeTask(review.id)).toBeDefined()

    choice = await openDelete()
    await user.click(within(choice).getByRole('button', { name: 'Delete subtasks too' }))
    await expectClosed()
    expect(storeTask(review.id)).toBeUndefined()
    expect(storeTask(tasks['Outline chapters'].id)).toBeUndefined()
    expect(storeTask(tasks['Draft related work'].id)).toBeUndefined()
    // Its dependencies went with it; the deleted task is not reported "not found".
    expect(dependencies()).toHaveLength(0)
    expect(error).not.toHaveBeenCalledWith('Task not found', expect.anything())
  })

  it('delete: a task without subtasks gets a plain confirmation', async () => {
    const { project, tasks } = await seedWorkspace()
    const room = tasks['Book a room']
    const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
    await findModal('Book a room')
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByRole('menuitem', { name: /Delete task/ }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete task?' })
    expect(dialog).toHaveAccessibleDescription(
      '“Book a room” will be deleted. This can’t be undone.',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await expectClosed()
    expect(storeTask(room.id)).toBeUndefined()
  })

  it('a slow save finishing after the user moved on never navigates back', async () => {
    const { project, tasks } = await seedWorkspace()
    const room = tasks['Book a room']
    const { user, router } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
    await findModal('Book a room')

    testHooks().setLatency(150)
    await user.type(titleBox(), ' for Friday')
    // Closing does not wait for the network.
    await user.keyboard('{Escape}')
    await expectClosed()
    expect(storeTask(room.id)?.title).toBe('Book a room for Friday')
    await router.navigate('/overview')

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(storeTask(room.id)?.title).toBe('Book a room for Friday')
    expect(router.state.location.pathname).toBe('/overview')
  })

  it('a slow save does not close another task opened meanwhile', async () => {
    const { project, tasks } = await seedWorkspace()
    const room = tasks['Book a room']
    const submit = tasks['Submit draft']
    const { user, router } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
    await findModal('Book a room')

    testHooks().setLatency(150)
    await user.type(titleBox(), '!')
    await user.keyboard('{Escape}')
    await expectClosed()
    await router.navigate(`/projects/${project.id}/list?task=${submit.id}`)
    await findModal('Submit draft')

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(storeTask(room.id)?.title).toBe('Book a room!')
    expect(router.state.location.search).toBe(`?task=${submit.id}`)
    expect(screen.getByRole('dialog', { name: 'Edit task: Submit draft' })).toBeInTheDocument()
  })
})
