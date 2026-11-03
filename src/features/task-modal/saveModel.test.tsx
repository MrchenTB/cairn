/**
 * Save model with the planner stubbed: dates always go through planScheduleChange (source
 * 'modal'), and when the planner does not write them (preview cancelled, write failed, rejected)
 * the modal stays open and the other fields are NOT saved.
 */
import { screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceActions, useWorkspaceStore } from '@/data/store'
import type { ScheduleChange } from '@/domain/types'
import type { PlanOutcome } from '@/features/gantt/planner'
import { renderHosts, resetTestWorld, seedWorkspace, storeTask } from './testHarness'

const planner = vi.hoisted(() => ({
  planScheduleChangeDetailed: vi.fn<(...args: unknown[]) => Promise<PlanOutcome>>(),
  reviewNewDependency: vi.fn(async () => ({ status: 'unchanged' }) as PlanOutcome),
}))
vi.mock('@/features/gantt/planner', () => planner)

const titleBox = () => screen.getByRole('textbox', { name: 'Task title' })
const saveButton = () => screen.getByRole('button', { name: 'Save' })

beforeEach(() => {
  resetTestWorld()
  planner.planScheduleChangeDetailed.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function editReview() {
  const seeded = await seedWorkspace()
  const review = seeded.tasks['Write literature review']
  const updateTask = vi.spyOn(useWorkspaceStore.getState().actions, 'updateTask')
  const view = renderHosts(`/projects/${seeded.project.id}/gantt?task=${review.id}`)
  await screen.findByRole('dialog', { name: 'Edit task: Write literature review' })
  // Title + due date (Nov 12 → Nov 13).
  await view.user.type(titleBox(), ' (v2)')
  await view.user.click(screen.getByRole('button', { name: /^Due date:/ }))
  await view.user.click(await screen.findByRole('button', { name: /November 13th, 2026/ }))
  return { ...view, review, updateTask }
}

// Interaction-heavy (user-event typing): generous timeout for parallel / loaded runs.
describe('Task Modal · save model', { timeout: 20_000 }, () => {
  it('cancelled auto-schedule preview: nothing else is saved and the modal stays open', async () => {
    planner.planScheduleChangeDetailed.mockResolvedValue({ status: 'cancelled' })
    const { user, review, updateTask } = await editReview()

    await user.click(saveButton())
    await waitFor(() => expect(planner.planScheduleChangeDetailed).toHaveBeenCalledTimes(1))
    expect(planner.planScheduleChangeDetailed).toHaveBeenCalledWith(
      { taskId: review.id, startDate: '2026-11-05', dueDate: '2026-11-13' },
      { source: 'modal' },
    )
    await waitFor(() => expect(saveButton()).toBeEnabled())
    expect(updateTask).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: /Edit task/ })).toBeInTheDocument()
    expect(titleBox()).toHaveValue('Write literature review (v2)')
    expect(storeTask(review.id)?.title).toBe('Write literature review')
  })

  it('a failed date write keeps the modal open (the store already toasted it)', async () => {
    planner.planScheduleChangeDetailed.mockResolvedValue({
      status: 'failed',
      error: { kind: 'network', message: 'Offline' },
    })
    const { user, updateTask } = await editReview()
    await user.click(saveButton())
    await waitFor(() => expect(saveButton()).toBeEnabled())
    expect(updateTask).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: /Edit task/ })).toBeInTheDocument()
  })

  it('a rejected change is explained inline', async () => {
    planner.planScheduleChangeDetailed.mockResolvedValue({
      status: 'invalid',
      error: { kind: 'validation', message: 'That task no longer exists.' },
    })
    const { user, updateTask } = await editReview()
    await user.click(saveButton())
    expect(await screen.findByText('That task no longer exists.')).toBeInTheDocument()
    expect(updateTask).not.toHaveBeenCalled()
  })

  it('written dates: the other fields are saved with updateTask and the modal closes', async () => {
    // Like the real planner in Manual mode: one applySchedule write.
    planner.planScheduleChangeDetailed.mockImplementation(async (change) => {
      const result = await getWorkspaceActions().applySchedule([change as ScheduleChange])
      return result.ok ? { status: 'written' } : { status: 'failed', error: result.error }
    })
    const { user, review, updateTask, router } = await editReview()
    await user.click(saveButton())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(updateTask).toHaveBeenCalledWith(review.id, { title: 'Write literature review (v2)' })
    expect(storeTask(review.id)).toMatchObject({
      title: 'Write literature review (v2)',
      dueDate: '2026-11-13',
    })
    expect(router.state.location.search).toBe('')
  })

  it('without date changes the planner is not involved', async () => {
    const seeded = await seedWorkspace()
    const room = seeded.tasks['Book a room']
    const { user } = renderHosts(`/projects/${seeded.project.id}/list?task=${room.id}`)
    await screen.findByRole('dialog', { name: 'Edit task: Book a room' })
    await user.click(screen.getByRole('button', { name: 'Status: To Do' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /In Progress/ }))
    await user.click(saveButton())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(planner.planScheduleChangeDetailed).not.toHaveBeenCalled()
    expect(storeTask(room.id)?.status).toBe('in_progress')
  })
})
