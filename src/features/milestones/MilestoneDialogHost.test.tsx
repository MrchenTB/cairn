import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/app/uiStore'
import { getWorkspaceActions, useWorkspaceStore } from '@/data/store'
import type { Milestone } from '@/domain/types'
import {
  must,
  openMilestoneDialog,
  renderHosts,
  resetTestWorld,
  seedWorkspace,
} from '@/features/task-modal/testHarness'
import { notify } from '@/lib/notify'

const nameBox = () => screen.getByRole('textbox', { name: 'Name' })
const milestones = () => Object.values(useWorkspaceStore.getState().data.milestones)

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
describe('Milestone dialog', { timeout: 20_000 }, () => {
  it('creates a milestone: name and date are required, phase is optional', async () => {
    const { project, writingId } = await seedWorkspace()
    const success = vi.spyOn(notify, 'success')
    const { user } = renderHosts(`/projects/${project.id}/gantt`)
    openMilestoneDialog({ mode: 'create', projectId: project.id })
    const dialog = await screen.findByRole('dialog', { name: 'New milestone' })

    expect(dialog).toHaveAccessibleDescription('Research')
    expect(
      within(dialog).getByText(/Milestones never count toward project progress\./),
    ).toBeInTheDocument()
    expect(nameBox()).toHaveFocus()
    const create = within(dialog).getByRole('button', { name: 'Create milestone' })
    expect(create).toBeDisabled()

    // ⌘↵ / Ctrl+↵ with nothing filled in explains both requirements.
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(await within(dialog).findByText('Milestone name is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Choose a date for this milestone.')).toBeInTheDocument()

    await user.type(nameBox(), 'Submission deadline')
    expect(create).toBeDisabled() // still no date
    await user.click(within(dialog).getByRole('button', { name: 'Date: not set' }))
    await user.click(await screen.findByRole('button', { name: /November 30th, 2026/ }))
    expect(screen.queryByText('Choose a date for this milestone.')).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('combobox', { name: 'Phase' }))
    await user.click(await screen.findByRole('option', { name: 'Writing' }))
    await user.click(create)

    await expectClosed()
    expect(milestones()).toEqual([
      expect.objectContaining({
        projectId: project.id,
        name: 'Submission deadline',
        date: '2026-11-30',
        phaseId: writingId,
      }),
    ])
    expect(success).toHaveBeenCalledWith('Milestone created')
  })

  it('opens with the requested phase and date (e.g. from a List group)', async () => {
    const { project, discoveryId } = await seedWorkspace()
    renderHosts(`/projects/${project.id}/list`)
    openMilestoneDialog({
      mode: 'create',
      projectId: project.id,
      phaseId: discoveryId,
      date: '2026-11-15',
    })
    const dialog = await screen.findByRole('dialog', { name: 'New milestone' })
    expect(within(dialog).getByRole('combobox', { name: 'Phase' })).toHaveTextContent('Discovery')
    expect(
      within(dialog).getByRole('button', { name: 'Date: Sunday, November 15, 2026' }),
    ).toBeInTheDocument()
  })

  async function seedMilestone(): Promise<{ projectId: string; milestone: Milestone }> {
    const { project } = await seedWorkspace()
    const milestone = must(
      await getWorkspaceActions().createMilestone({
        projectId: project.id,
        name: 'Draft review',
        date: '2026-11-20',
      }),
    )
    return { projectId: project.id, milestone }
  }

  it('edits a milestone: Save is enabled only after a change', async () => {
    const { projectId, milestone } = await seedMilestone()
    const { user } = renderHosts(`/projects/${projectId}/gantt`)
    openMilestoneDialog({ mode: 'edit', milestoneId: milestone.id })
    const dialog = await screen.findByRole('dialog', { name: 'Edit milestone' })
    expect(nameBox()).toHaveValue('Draft review')
    expect(
      within(dialog).getByRole('button', { name: 'Date: Friday, November 20, 2026' }),
    ).toBeInTheDocument()
    const save = within(dialog).getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()

    await user.clear(nameBox())
    expect(await within(dialog).findByText('Milestone name is required.')).toBeInTheDocument()
    await user.type(nameBox(), 'Advisor review{Enter}')
    await expectClosed()
    expect(useWorkspaceStore.getState().data.milestones[milestone.id]).toMatchObject({
      name: 'Advisor review',
      date: '2026-11-20',
    })
  })

  it('asks before discarding unsaved changes', async () => {
    const { projectId, milestone } = await seedMilestone()
    const { user } = renderHosts(`/projects/${projectId}/gantt`)
    openMilestoneDialog({ mode: 'edit', milestoneId: milestone.id })
    await screen.findByRole('dialog', { name: 'Edit milestone' })
    await user.type(nameBox(), ' 2')
    await user.keyboard('{Escape}')
    const confirmDialog = await screen.findByRole('alertdialog', { name: 'Discard changes?' })
    await user.click(within(confirmDialog).getByRole('button', { name: 'Discard' }))
    await expectClosed()
    expect(useUIStore.getState().milestoneDialog).toBeNull()
    expect(useWorkspaceStore.getState().data.milestones[milestone.id].name).toBe('Draft review')
  })

  it('deletes after confirmation', async () => {
    const { projectId, milestone } = await seedMilestone()
    const success = vi.spyOn(notify, 'success')
    const error = vi.spyOn(notify, 'error')
    const { user } = renderHosts(`/projects/${projectId}/gantt`)
    openMilestoneDialog({ mode: 'edit', milestoneId: milestone.id })
    const dialog = await screen.findByRole('dialog', { name: 'Edit milestone' })

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    let confirmDialog = await screen.findByRole('alertdialog', { name: 'Delete milestone?' })
    expect(confirmDialog).toHaveAccessibleDescription(
      '“Draft review” on Nov 20, 2026 will be deleted. This can’t be undone.',
    )
    await user.click(within(confirmDialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(milestones()).toHaveLength(1)

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    confirmDialog = await screen.findByRole('alertdialog', { name: 'Delete milestone?' })
    await user.click(within(confirmDialog).getByRole('button', { name: 'Delete' }))
    await expectClosed()
    expect(milestones()).toHaveLength(0)
    await waitFor(() => expect(success).toHaveBeenCalledWith('Milestone deleted'))
    expect(error).not.toHaveBeenCalled()
  })

  it('reports a milestone that no longer exists', async () => {
    await seedWorkspace()
    const error = vi.spyOn(notify, 'error')
    renderHosts('/overview')
    openMilestoneDialog({ mode: 'edit', milestoneId: 'gone' })
    await waitFor(() => expect(useUIStore.getState().milestoneDialog).toBeNull())
    expect(error).toHaveBeenCalledWith('Milestone not found', expect.anything())
  })
})
