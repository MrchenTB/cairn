/**
 * Task Modal autosave through the real store and local repository: when each field saves, what the
 * footer says, what a failure leaves behind, and how closing behaves. Timer and IME details are in
 * autosave/textDraft.test.ts; real IME input is in e2e/task-autosave.spec.ts.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from '@/data/store'
import { resetDateUndoForTests } from '@/features/gantt/dateUndo'
import { notify } from '@/lib/notify'
import { DRAFTS_STORAGE_KEY } from './autosave/draftManager'
import { taskDrafts } from './autosave/taskDrafts'
import {
  renderHosts,
  resetTestWorld,
  seedWorkspace,
  storeTask,
  storeTasks,
  testHooks,
} from './testHarness'

const titleBox = () => screen.getByRole('textbox', { name: 'Task title' })
const descriptionBox = () => screen.getByRole('textbox', { name: 'Description' })
const doneButton = () => screen.getByRole('button', { name: 'Done' })
const actions = () => useWorkspaceStore.getState().actions
const footerState = () => document.querySelector('[data-save-state]')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function findModal(title: string) {
  return screen.findByRole('dialog', { name: `Edit task: ${title}` })
}

async function expectClosed() {
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
}

/** The same tab after a reload: memory is gone, sessionStorage is not. */
function simulateReload() {
  act(() => {
    taskDrafts.setScope(null)
    taskDrafts.setScope('local-user')
  })
}

beforeEach(() => {
  resetTestWorld()
  resetDateUndoForTests()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Task Modal · autosave', { timeout: 20_000 }, () => {
  describe('properties save when picked', () => {
    it('status, priority and phase are stored at once, with the modal still open', async () => {
      const { project, tasks, discoveryId } = await seedWorkspace()
      const room = tasks['Book a room']
      const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')

      await user.click(screen.getByRole('button', { name: 'Status: To Do' }))
      await user.click(await screen.findByRole('menuitemradio', { name: /In Progress/ }))
      await waitFor(() => expect(storeTask(room.id)?.status).toBe('in_progress'))

      await user.click(screen.getByRole('button', { name: /^Priority:/ }))
      await user.click(await screen.findByRole('menuitemradio', { name: /Urgent/ }))
      await waitFor(() => expect(storeTask(room.id)?.priority).toBe('urgent'))

      await user.click(screen.getByRole('button', { name: /^Phase:/ }))
      await user.click(await screen.findByRole('menuitemradio', { name: 'Discovery' }))
      await waitFor(() => expect(storeTask(room.id)?.phaseId).toBe(discoveryId))

      expect(screen.getByRole('dialog', { name: /Edit task/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Status: In Progress' })).toBeInTheDocument()
    })

    it('a failed pick rolls back, names the field, and Retry stores it', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      const error = vi.spyOn(notify, 'error')
      const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')

      testHooks().failNextWrites(1)
      await user.click(screen.getByRole('button', { name: 'Status: To Do' }))
      await user.click(await screen.findByRole('menuitemradio', { name: /In Progress/ }))

      expect(await screen.findByText('Couldn’t save status')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Status: To Do' })).toBeInTheDocument()
      expect(storeTask(room.id)?.status).toBe('todo')
      // The toast says which task and which field, and offers a way back.
      expect(error).toHaveBeenCalledWith(
        "Couldn't save the status of “Book a room”",
        expect.objectContaining({ cancel: expect.objectContaining({ label: 'Open' }) }),
      )

      await user.click(screen.getByRole('button', { name: 'Retry' }))
      await waitFor(() => expect(storeTask(room.id)?.status).toBe('in_progress'))
      await waitFor(() =>
        expect(screen.queryByText('Couldn’t save status')).not.toBeInTheDocument(),
      )
    })

    it('the toast’s Retry clears the footer too', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')

      testHooks().failNextWrites(1)
      await user.click(screen.getByRole('button', { name: /^Priority:/ }))
      await user.click(await screen.findByRole('menuitemradio', { name: /High/ }))
      await screen.findByText('Couldn’t save priority')

      await act(async () => {
        await actions().retryLastFailed()
      })
      expect(storeTask(room.id)?.priority).toBe('high')
      await waitFor(() =>
        expect(screen.queryByText('Couldn’t save priority')).not.toBeInTheDocument(),
      )
    })

    it('fast changes of one field end on the newest, whatever an older answer says', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')

      testHooks().setLatency(120)
      await user.click(screen.getByRole('button', { name: 'Status: To Do' }))
      await user.click(await screen.findByRole('menuitemradio', { name: /Done/ }))
      await user.click(await screen.findByRole('button', { name: 'Status: Done' }))
      await user.click(await screen.findByRole('menuitemradio', { name: /In Progress/ }))

      await waitFor(() => expect(useWorkspaceStore.getState().sync.pending).toBe(0))
      expect(storeTask(room.id)?.status).toBe('in_progress')
      expect(screen.getByRole('button', { name: 'Status: In Progress' })).toBeInTheDocument()
    })
  })

  describe('dates', () => {
    it('a completed task’s dates can still be changed by hand', async () => {
      const { project, tasks } = await seedWorkspace()
      const done = tasks['Collect sources']
      const { user } = renderHosts(`/projects/${project.id}/list?task=${done.id}`)
      await findModal('Collect sources')

      await user.click(screen.getByRole('button', { name: /^Due date:/ }))
      await user.click(await screen.findByRole('button', { name: /November 5th, 2026/ }))
      await waitFor(() => expect(storeTask(done.id)?.dueDate).toBe('2026-11-05'))
      expect(storeTask(done.id)?.status).toBe('done')
    })

    it('a date change offers Undo; the Undo refuses once the dates moved on', async () => {
      const { project, tasks } = await seedWorkspace()
      const review = tasks['Write literature review']
      const success = vi.spyOn(notify, 'success')
      const info = vi.spyOn(notify, 'info')
      const { user } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
      await findModal('Write literature review')

      await user.click(screen.getByRole('button', { name: /^Due date:/ }))
      await user.click(await screen.findByRole('button', { name: /November 13th, 2026/ }))
      await waitFor(() => expect(storeTask(review.id)?.dueDate).toBe('2026-11-13'))
      const first = success.mock.calls.at(-1)
      expect(first?.[0]).toMatch(/^Updated · /)

      await user.click(screen.getByRole('button', { name: /^Due date:/ }))
      await user.click(await screen.findByRole('button', { name: /November 14th, 2026/ }))
      await waitFor(() => expect(storeTask(review.id)?.dueDate).toBe('2026-11-14'))

      // The first toast's Undo is out of date: it says so and leaves the newer dates alone.
      await act(async () => first?.[1]?.action?.onClick())
      expect(info).toHaveBeenCalledWith('Can’t undo', expect.anything())
      expect(storeTask(review.id)?.dueDate).toBe('2026-11-14')

      // The latest Undo goes back to before the burst.
      await act(async () => success.mock.calls.at(-1)?.[1]?.action?.onClick())
      await waitFor(() => expect(storeTask(review.id)?.dueDate).toBe('2026-11-12'))
    })

    it('manual mode: a conflict shows in the banner, without a toast for each pick', async () => {
      const { project, tasks } = await seedWorkspace()
      const review = tasks['Write literature review']
      const warning = vi.spyOn(notify, 'warning')
      const { user } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
      await findModal('Write literature review')

      await user.click(screen.getByRole('button', { name: /^Due date:/ }))
      await user.click(await screen.findByRole('button', { name: /November 20th, 2026/ }))
      await waitFor(() => expect(storeTask(review.id)?.dueDate).toBe('2026-11-20'))
      expect(screen.getByRole('status')).toHaveTextContent('Dependency conflict')
      expect(warning).not.toHaveBeenCalled()
      // Manual: the successor is never moved.
      expect(storeTask(tasks['Submit draft'].id)?.startDate).toBe('2026-11-10')
    })
  })

  describe('title', () => {
    it('Enter saves and stays in the field; no line break', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')

      await user.type(titleBox(), '!')
      expect(storeTask(room.id)?.title).toBe('Book a room')
      await user.keyboard('{Enter}')
      await waitFor(() => expect(storeTask(room.id)?.title).toBe('Book a room!'))
      expect(titleBox()).toHaveValue('Book a room!')
      expect(titleBox()).toHaveFocus()
    })

    it('blur saves', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')

      await user.type(titleBox(), '!')
      await user.tab()
      await waitFor(() => expect(storeTask(room.id)?.title).toBe('Book a room!'))
    })

    it('an Enter that confirms an IME candidate (key code 229) saves nothing', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')

      fireEvent.compositionStart(titleBox())
      fireEvent.change(titleBox(), { target: { value: 'Book a roomㄓ' } })
      fireEvent.keyDown(titleBox(), { key: 'Enter', keyCode: 229 })
      fireEvent.compositionEnd(titleBox(), { data: '專' })
      expect(storeTask(room.id)?.title).toBe('Book a room')
    })

    it('a title over the limit is kept and explained; closing asks what to do with it', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')
      const tooLong = 'x'.repeat(501)

      fireEvent.change(titleBox(), { target: { value: tooLong } })
      expect(await screen.findByText(/at most 500 characters/)).toBeInTheDocument()
      await user.tab()
      expect(titleBox()).toHaveValue(tooLong)
      expect(storeTask(room.id)?.title).toBe('Book a room')

      await user.click(doneButton())
      let prompt = await screen.findByRole('alertdialog', { name: /Can’t save this title/ })
      await user.click(within(prompt).getByRole('button', { name: 'Keep editing' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      expect(titleBox()).toHaveValue(tooLong)
      await waitFor(() => expect(titleBox()).toHaveFocus())

      await user.click(doneButton())
      prompt = await screen.findByRole('alertdialog', { name: /Can’t save this title/ })
      await user.click(within(prompt).getByRole('button', { name: 'Discard text' }))
      await expectClosed()
      expect(storeTask(room.id)?.title).toBe('Book a room')
      expect(taskDrafts.getOutstanding()).toEqual([])
    })

    it('closing with an empty title keeps the saved one and says so', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      const info = vi.spyOn(notify, 'info')
      const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')

      await user.clear(titleBox())
      await user.keyboard('{Escape}')
      await expectClosed()
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(storeTask(room.id)?.title).toBe('Book a room')
      expect(info).toHaveBeenCalledWith(
        'Title not changed',
        expect.objectContaining({ description: expect.stringContaining('Book a room') }),
      )
    })
  })

  describe('description', () => {
    it('waits for a pause, says it is pending meanwhile, then says Saved', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')

      await user.type(descriptionBox(), 'Ask the office')
      expect(storeTask(room.id)?.description).toBeNull()
      expect(screen.queryByText('Pending changes')).not.toBeInTheDocument() // not on every keystroke
      expect(await screen.findByText('Pending changes')).toBeInTheDocument()
      await waitFor(() => expect(storeTask(room.id)?.description).toBe('Ask the office'), {
        timeout: 3000,
      })
      await waitFor(() => expect(footerState()).toHaveAttribute('data-save-state', 'saved'))
      expect(descriptionBox()).toHaveValue('Ask the office')
      expect(descriptionBox()).toHaveFocus()
    })

    it('blur saves right away; whitespace only is stored as nothing', async () => {
      const { project, tasks } = await seedWorkspace()
      const review = tasks['Write literature review']
      const { user } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
      await findModal('Write literature review')

      fireEvent.change(descriptionBox(), { target: { value: '  \n' } })
      await user.click(titleBox())
      await waitFor(() => expect(storeTask(review.id)?.description).toBeNull())
    })

    it('over the limit: kept, counted, never sent', async () => {
      const { project, tasks } = await seedWorkspace()
      const review = tasks['Write literature review']
      const { user } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
      await findModal('Write literature review')
      const tooLong = 'x'.repeat(10_001)

      fireEvent.change(descriptionBox(), { target: { value: tooLong } })
      await user.click(titleBox())
      expect(screen.getByText('10,001 / 10,000')).toBeInTheDocument()
      expect(descriptionBox()).toHaveValue(tooLong)
      expect(screen.getByText('Not saved')).toBeInTheDocument()
      expect(storeTask(review.id)?.description).toBe('Summarise the core papers.')
    })

    it('IME: leaving during a composition never saves the unconfirmed text', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')
      const box = descriptionBox()

      act(() => box.focus())
      fireEvent.compositionStart(box)
      fireEvent.change(box, { target: { value: 'ㄓㄨ' } })
      act(() => box.blur())
      await sleep(50)
      expect(storeTask(room.id)?.description).toBeNull()
      expect(box).toHaveValue('ㄓㄨ')

      // The browser ends the composition with the pre-edit string as the text.
      fireEvent.compositionEnd(box, { data: 'ㄓㄨ' })
      await screen.findByText(/interrupted before you confirmed it/)
      expect(storeTask(room.id)?.description).toBeNull()

      // Closing does not skip over it: its Save and Discard are right there.
      await user.click(doneButton())
      expect(await screen.findByText(/Save or discard the interrupted text/)).toBeInTheDocument()
      expect(screen.getByRole('dialog', { name: /Edit task/ })).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Discard: description' }))
      await waitFor(() => expect(box).toHaveValue(''))
      await user.click(doneButton())
      await expectClosed()
      expect(storeTask(room.id)?.description).toBeNull()
    })
  })

  describe('failure', () => {
    it('keeps the text in the field and Retry stores it', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      const error = vi.spyOn(notify, 'error')
      const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')

      testHooks().failNextWrites(1)
      await user.type(titleBox(), ' v2{Enter}')

      expect(await screen.findByText(/Your text is kept here/)).toBeInTheDocument()
      expect(titleBox()).toHaveValue('Book a room v2')
      expect(storeTask(room.id)?.title).toBe('Book a room')
      expect(screen.getByText('Couldn’t save title')).toBeInTheDocument()
      expect(error).toHaveBeenCalledWith(
        "Couldn't save the title of “Book a room”",
        expect.anything(),
      )

      await user.click(screen.getByRole('button', { name: 'Retry' }))
      await waitFor(() => expect(storeTask(room.id)?.title).toBe('Book a room v2'))
      await waitFor(() =>
        expect(screen.queryByText(/Your text is kept here/)).not.toBeInTheDocument(),
      )
    })

    it('typing after a failure withdraws the old Retry, even typing the stored text back', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')

      testHooks().failNextWrites(1)
      await user.type(titleBox(), '!{Enter}')
      await screen.findByText(/Your text is kept here/)
      expect(useWorkspaceStore.getState().sync.canRetry).toBe(true)

      await user.type(titleBox(), '{Backspace}')
      expect(titleBox()).toHaveValue('Book a room')
      await waitFor(() => expect(useWorkspaceStore.getState().sync.canRetry).toBe(false))
      expect(useWorkspaceStore.getState().sync.lastError).toBeNull()
      await act(async () => {
        await actions().retryLastFailed()
      })
      expect(storeTask(room.id)?.title).toBe('Book a room')
    })

    it('a failure after the modal closed: reopening finds the text', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      const { user, router } = renderHosts(`/projects/${project.id}/list`)

      await act(() => router.navigate(`/projects/${project.id}/list?task=${room.id}`))
      await findModal('Book a room')
      testHooks().setLatency(60)
      testHooks().failNextWrites(1)
      await user.type(titleBox(), ' v2')
      await user.keyboard('{Escape}')
      await expectClosed()
      expect(storeTask(room.id)?.title).toBe('Book a room v2') // optimistic

      await waitFor(() => expect(storeTask(room.id)?.title).toBe('Book a room')) // rolled back
      await waitFor(() =>
        expect(taskDrafts.getOutstanding()).toMatchObject([
          { taskId: room.id, field: 'title', phase: 'failed', text: 'Book a room v2' },
        ]),
      )

      testHooks().setLatency(0)
      await act(() => router.navigate(`/projects/${project.id}/list?task=${room.id}`))
      await findModal('Book a room')
      expect(titleBox()).toHaveValue('Book a room v2')
      expect(screen.getByText(/Your text is kept here/)).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Retry' }))
      await waitFor(() => expect(storeTask(room.id)?.title).toBe('Book a room v2'))
      await waitFor(() => expect(taskDrafts.getOutstanding()).toEqual([]))
    })

    it('a failure of one field leaves the others saved', async () => {
      const { project, tasks } = await seedWorkspace()
      const review = tasks['Write literature review']
      const { user } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
      await findModal('Write literature review')

      testHooks().failNextWrites(1)
      await user.type(titleBox(), ' v2{Enter}')
      await screen.findByText(/Your text is kept here/)
      await user.click(screen.getByRole('button', { name: /^Priority:/ }))
      await user.click(await screen.findByRole('menuitemradio', { name: /Low/ }))
      await waitFor(() => expect(storeTask(review.id)?.priority).toBe('low'))
      expect(storeTask(review.id)?.title).toBe('Write literature review')
      expect(titleBox()).toHaveValue('Write literature review v2')
    })
  })

  describe('reload (sessionStorage)', () => {
    async function failedDescription(text: string) {
      const seeded = await seedWorkspace()
      const room = seeded.tasks['Book a room']
      const view = renderHosts(`/projects/${seeded.project.id}/list?task=${room.id}`)
      await findModal('Book a room')
      testHooks().failNextWrites(1)
      fireEvent.change(descriptionBox(), { target: { value: text } })
      await view.user.click(titleBox())
      await screen.findByText(/Your text is kept here/)
      return { ...view, room, seeded }
    }

    it('text is offered again, and nothing is written until the user says so', async () => {
      const { user, room } = await failedDescription('Ask the office')
      expect(sessionStorage.getItem(DRAFTS_STORAGE_KEY)).toContain('Ask the office')

      simulateReload()
      await screen.findByText('Recovered text that wasn’t saved.')
      expect(descriptionBox()).toHaveValue('Ask the office')
      expect(storeTask(room.id)?.description).toBeNull()

      await user.click(screen.getByRole('button', { name: 'Save: description' }))
      await waitFor(() => expect(storeTask(room.id)?.description).toBe('Ask the office'))
      await waitFor(() => expect(sessionStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull())
    })

    it('Discard really drops it', async () => {
      const { user, room } = await failedDescription('Ask the office')
      simulateReload()
      await user.click(await screen.findByRole('button', { name: 'Discard: description' }))
      await waitFor(() => expect(descriptionBox()).toHaveValue(''))
      expect(storeTask(room.id)?.description).toBeNull()
      expect(sessionStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull()
    })

    it('never shows old text over a newer value', async () => {
      const { user, room } = await failedDescription('Ask the office')
      await act(async () => {
        await actions().updateTask(room.id, { description: 'Changed since' })
      })
      simulateReload()
      await screen.findByText(/unsaved text from earlier/)
      expect(descriptionBox()).toHaveValue('Changed since')

      await user.click(screen.getByRole('button', { name: 'Show my text: description' }))
      expect(descriptionBox()).toHaveValue('Ask the office')
      expect(storeTask(room.id)?.description).toBe('Changed since')
    })

    it('another account never sees it', async () => {
      await failedDescription('Private')
      act(() => {
        taskDrafts.setScope(null)
        taskDrafts.setScope('someone-else')
      })
      expect(taskDrafts.getOutstanding()).toEqual([])
      expect(sessionStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull()
      act(() => taskDrafts.setScope('local-user'))
    })
  })

  describe('closing', () => {
    it('from a subtask opened from its parent, every way out returns to the parent', async () => {
      const { project, tasks } = await seedWorkspace()
      const review = tasks['Write literature review']
      const draft = tasks['Draft related work']
      const { user, router } = renderHosts(`/projects/${project.id}/list`)
      const section = () => screen.getByRole('region', { name: 'Subtasks' })
      const openSubtask = async () => {
        await user.click(within(section()).getByRole('button', { name: /^Draft related work/ }))
        await screen.findByRole('dialog', { name: /^Edit task: Draft related work/ })
      }

      // Opened from the page: a real pushed entry, as a row click makes.
      await act(() =>
        router.navigate(`/projects/${project.id}/list?task=${review.id}`, {
          state: { cairnTaskDepth: 1 },
        }),
      )
      await findModal('Write literature review')

      for (const leave of [
        () => user.keyboard('{Escape}'),
        () => user.click(screen.getByRole('button', { name: 'Close' })),
        () => user.click(doneButton()),
        () => user.keyboard('{Control>}{Enter}{/Control}'),
      ]) {
        await openSubtask()
        await user.type(titleBox(), '!')
        await leave()
        await findModal('Write literature review')
        expect(router.state.location.search).toBe(`?task=${review.id}`)
      }
      expect(storeTask(draft.id)?.title).toBe('Draft related work!!!!')

      // And from the parent the same action closes.
      await user.click(doneButton())
      await expectClosed()
      expect(router.state.location.search).toBe('')
    })

    it('a subtask opened directly closes (there is no parent to return to)', async () => {
      const { project, tasks } = await seedWorkspace()
      const draft = tasks['Draft related work']
      const { user, router } = renderHosts(`/projects/${project.id}/list?task=${draft.id}`)
      await findModal('Draft related work')
      await user.keyboard('{Escape}')
      await expectClosed()
      expect(router.state.location.search).toBe('')
    })

    it('another task opened from a subtask row saves first', async () => {
      const { project, tasks } = await seedWorkspace()
      const review = tasks['Write literature review']
      const { user } = renderHosts(`/projects/${project.id}/list?task=${review.id}`)
      await findModal('Write literature review')
      await user.type(titleBox(), '!')
      await user.click(screen.getByRole('button', { name: 'Draft related work' }))
      await findModal('Draft related work')
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(storeTask(review.id)?.title).toBe('Write literature review!')
    })

    it('leaving through navigation saves valid text, and keeps invalid text for later', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      const info = vi.spyOn(notify, 'info')
      const { user, router } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')

      await user.type(titleBox(), '!')
      await act(() => router.navigate('/overview'))
      await expectClosed()
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(storeTask(room.id)?.title).toBe('Book a room!')

      await act(() => router.navigate(`/projects/${project.id}/list?task=${room.id}`))
      await findModal('Book a room!')
      const tooLong = 'x'.repeat(501)
      fireEvent.change(titleBox(), { target: { value: tooLong } })
      await act(() => router.navigate('/overview'))
      await expectClosed()
      expect(info).toHaveBeenCalledWith('Unsaved text kept', expect.anything())
      expect(storeTask(room.id)?.title).toBe('Book a room!')
      expect(taskDrafts.getOutstanding()).toMatchObject([{ phase: 'invalid', text: tooLong }])

      taskDrafts.discardDraft(room.id, 'title')
    })

    it('deleting drops the unsent text; no write reaches the deleted task', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      const update = vi.spyOn(useWorkspaceStore.getState().actions, 'updateTask')
      const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')

      await user.type(descriptionBox(), 'Never mind')
      await user.click(screen.getByRole('button', { name: 'More actions' }))
      await user.click(await screen.findByRole('menuitem', { name: /Delete task/ }))
      const dialog = await screen.findByRole('alertdialog', { name: 'Delete task?' })
      // Moving to the menu blurred the field, which saved it; the point is what happens after.
      update.mockClear()
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await expectClosed()
      await waitFor(() => expect(storeTask(room.id)).toBeUndefined())
      expect(update).not.toHaveBeenCalled()
      expect(taskDrafts.getOutstanding()).toEqual([])
      expect(storeTasks().some((task) => task.title === 'Book a room')).toBe(false)
    })
  })

  describe('footer state', () => {
    it('a fast save never flashes "Saving…", and a slow one does', async () => {
      const { project, tasks } = await seedWorkspace()
      const room = tasks['Book a room']
      const { user } = renderHosts(`/projects/${project.id}/list?task=${room.id}`)
      await findModal('Book a room')

      await user.click(screen.getByRole('button', { name: 'Status: To Do' }))
      await user.click(await screen.findByRole('menuitemradio', { name: /In Progress/ }))
      await waitFor(() => expect(footerState()).toHaveAttribute('data-save-state', 'saved'))
      expect(screen.queryByText('Saving…')).not.toBeInTheDocument()

      testHooks().setLatency(700)
      await user.click(screen.getByRole('button', { name: /^Priority:/ }))
      await user.click(await screen.findByRole('menuitemradio', { name: /High/ }))
      await waitFor(() => expect(footerState()).toHaveAttribute('data-save-state', 'saving'))
      await waitFor(() => expect(footerState()).toHaveAttribute('data-save-state', 'saved'))
      testHooks().setLatency(0)
    })
  })
})
