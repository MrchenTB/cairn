import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from '@/data/store'
import type { Result } from '@/domain/types'
import { renderUI } from '@/test/render'
import { SyncIndicator } from './SyncIndicator'

const initial = useWorkspaceStore.getState()

afterEach(() => {
  useWorkspaceStore.setState(initial, true)
})

describe('SyncIndicator', () => {
  it('local mode: explains "Local only" and its backup link closes the popover', async () => {
    const { user, router } = renderUI(<SyncIndicator collapsed={false} />, { route: '/overview' })
    await user.click(screen.getByRole('button', { name: 'Sync status: Local only — not synced' }))
    const popover = await screen.findByRole('dialog')
    expect(popover).toHaveTextContent('Stored in this browser only')

    await user.click(within(popover).getByRole('link', { name: 'Backup & export' }))
    expect(router.state.location.pathname).toBe('/settings/data')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('a failed write offers Retry next to the label and in the popover', async () => {
    const retryLastFailed = vi.fn(async (): Promise<Result> => ({ ok: true, value: undefined }))
    useWorkspaceStore.setState({
      sync: {
        ...initial.sync,
        pending: 0,
        lastError: { kind: 'network', message: 'Network error.' },
        canRetry: true,
      },
      actions: { ...initial.actions, retryLastFailed },
    })
    const { user } = renderUI(<SyncIndicator collapsed={false} />, { route: '/overview' })
    expect(screen.getByRole('button', { name: "Sync status: Couldn't save" })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retryLastFailed).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: "Sync status: Couldn't save" }))
    const popover = await screen.findByRole('dialog')
    expect(popover).toHaveTextContent('Network error. The change was undone on screen')
    await user.click(within(popover).getByRole('button', { name: 'Retry' }))
    expect(retryLastFailed).toHaveBeenCalledTimes(2)
  })
})
