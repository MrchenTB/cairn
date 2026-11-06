/**
 * Dates with the planner stubbed: they always go through it as a pair (source 'modal'), and what it
 * answers decides what the chips show. The other fields don't wait for dates, or the other way
 * round: each field saves by itself.
 */
import { screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWorkspaceActions, useWorkspaceStore } from '@/data/store'
import type { ScheduleChange } from '@/domain/types'
import type { PlanOutcome } from '@/features/gantt/planner'
import { renderHosts, resetTestWorld, seedWorkspace, storeTask } from './testHarness'

const planner = vi.hoisted(() => ({
  planScheduleChangeDetailed: vi.fn<(...args: unknown[]) => Promise<PlanOutcome>>(),
  undoScheduleWrite: vi.fn(),
  reviewNewDependency: vi.fn(async () => ({ status: 'unchanged' }) as PlanOutcome),
}))
vi.mock('@/features/gantt/planner', () => planner)

const titleBox = () => screen.getByRole('textbox', { name: 'Task title' })
const dueChip = () => screen.getByRole('button', { name: /^Due date:/ })

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
  return { ...view, review, updateTask }
}

async function pickNov13(user: Awaited<ReturnType<typeof editReview>>['user']) {
  await user.click(dueChip())
  await user.click(await screen.findByRole('button', { name: /November 13th, 2026/ }))
}

// Interaction-heavy (user-event typing): generous timeout for parallel / loaded runs.
describe('Task Modal · dates through the planner', { timeout: 20_000 }, () => {
  it('a pick sends both dates at once, with source "modal"', async () => {
    planner.planScheduleChangeDetailed.mockResolvedValue({ status: 'unchanged' })
    const { user, review } = await editReview()
    await pickNov13(user)
    await waitFor(() => expect(planner.planScheduleChangeDetailed).toHaveBeenCalledTimes(1))
    expect(planner.planScheduleChangeDetailed).toHaveBeenCalledWith(
      { taskId: review.id, startDate: '2026-11-05', dueDate: '2026-11-13' },
      expect.objectContaining({ source: 'modal' }),
    )
  })

  it('while the preview is open the chip shows the pick; a cancel puts the stored date back', async () => {
    let answer: (outcome: PlanOutcome) => void = () => {}
    planner.planScheduleChangeDetailed.mockImplementation(
      () => new Promise<PlanOutcome>((resolve) => (answer = resolve)),
    )
    const { user, review } = await editReview()
    await pickNov13(user)
    await waitFor(() => expect(dueChip()).toHaveAccessibleName(/November 13/))

    answer({ status: 'cancelled' })
    await waitFor(() => expect(dueChip()).toHaveAccessibleName(/November 12/))
    expect(await screen.findByText('Dates not changed.')).toBeInTheDocument()
    expect(storeTask(review.id)?.dueDate).toBe('2026-11-12')
  })

  it('a cancelled preview takes nothing else back', async () => {
    planner.planScheduleChangeDetailed.mockResolvedValue({ status: 'cancelled' })
    const { user, review, updateTask } = await editReview()
    await user.type(titleBox(), ' (v2)')
    await pickNov13(user) // moving to the chip already saved the title
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith(
        review.id,
        { title: 'Write literature review (v2)' },
        expect.anything(),
      ),
    )
    await screen.findByText('Dates not changed.')
    expect(storeTask(review.id)?.title).toBe('Write literature review (v2)')
  })

  it('a failed date write names the field and offers Retry, which plans the same pair', async () => {
    planner.planScheduleChangeDetailed.mockResolvedValue({
      status: 'failed',
      error: { kind: 'network', message: 'Offline' },
    })
    const { user } = await editReview()
    await pickNov13(user)
    expect(await screen.findByText(/Couldn’t save dates/)).toBeInTheDocument()
    expect(dueChip()).toHaveAccessibleName(/November 12/)

    planner.planScheduleChangeDetailed.mockImplementation(async (change) => {
      const result = await getWorkspaceActions().applySchedule([change as ScheduleChange])
      return result.ok ? { status: 'written' } : { status: 'failed', error: result.error }
    })
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(dueChip()).toHaveAccessibleName(/November 13/))
    await waitFor(() => expect(screen.queryByText(/Couldn’t save dates/)).not.toBeInTheDocument())
  })

  it('a rejected change is explained inline', async () => {
    planner.planScheduleChangeDetailed.mockResolvedValue({
      status: 'invalid',
      error: { kind: 'validation', message: 'That task no longer exists.' },
    })
    const { user } = await editReview()
    await pickNov13(user)
    expect(await screen.findByText('That task no longer exists.')).toBeInTheDocument()
  })

  it('a change that only touches other fields does not involve the planner', async () => {
    const seeded = await seedWorkspace()
    const room = seeded.tasks['Book a room']
    const { user } = renderHosts(`/projects/${seeded.project.id}/list?task=${room.id}`)
    await screen.findByRole('dialog', { name: 'Edit task: Book a room' })
    await user.click(screen.getByRole('button', { name: 'Status: To Do' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /In Progress/ }))
    await waitFor(() => expect(storeTask(room.id)?.status).toBe('in_progress'))
    expect(planner.planScheduleChangeDetailed).not.toHaveBeenCalled()
  })
})
