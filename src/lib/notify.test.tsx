import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Toaster } from '@/components/ui/toaster'
import { notify } from './notify'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  act(() => notify.dismiss())
})

describe('notify.error with an id', () => {
  it('shows a failure raised right after the previous one with the same id was dismissed', async () => {
    render(<Toaster />)
    act(() => {
      notify.error("Couldn't move task", { id: 'sync-error', description: 'First attempt' })
    })
    await screen.findByText('First attempt')

    // A Retry starts (the toast is dismissed) and fails again at once: the second toast must
    // not be lost with the one that is being removed.
    act(() => {
      notify.dismiss('sync-error')
    })
    await waitFor(() => expect(document.querySelector('[data-removed="true"]')).not.toBeNull())
    act(() => {
      notify.error("Couldn't move task", { id: 'sync-error', description: 'Second attempt' })
    })

    await screen.findByText('Second attempt')
    await act(() => sleep(600)) // past the removal of the first toast
    expect(screen.getByText('Second attempt')).toBeInTheDocument()
    expect(screen.queryByText('First attempt')).not.toBeInTheDocument()
  })

  it('replaces a toast that is still showing, and one id dismisses the current toast only', async () => {
    render(<Toaster />)
    act(() => {
      notify.error('Couldn’t save', { id: 'sync-error', description: 'old' })
      notify.error('Couldn’t save', { id: 'sync-error', description: 'new' })
      notify.error('Other', { id: 'other', description: 'unrelated' })
    })
    await screen.findByText('new')
    await waitFor(() => expect(screen.queryByText('old')).not.toBeInTheDocument())

    act(() => {
      notify.dismiss('sync-error')
      notify.dismiss('sync-error') // repeating is harmless
    })
    await waitFor(() => expect(screen.queryByText('new')).not.toBeInTheDocument())
    expect(screen.getByText('unrelated')).toBeInTheDocument()
  })

  it('toasts without an id are independent', async () => {
    render(<Toaster />)
    act(() => {
      notify.error('One', { description: 'first' })
      notify.error('Two', { description: 'second' })
    })
    await screen.findByText('first')
    expect(screen.getByText('second')).toBeInTheDocument()
  })
})

describe('one failure, one message', () => {
  it('a caller repeating what the failure toast just said adds nothing; other messages still show', async () => {
    render(<Toaster />)
    act(() => {
      notify.error("Couldn't update task", {
        id: 'sync-error',
        description: 'Refused by the server',
      })
      notify.error("Couldn't change status", { description: 'Refused by the server' })
      notify.error("Couldn't change status", { description: 'Something else' })
    })
    await screen.findByText('Something else')
    expect(screen.getAllByText('Refused by the server')).toHaveLength(1)
    expect(screen.getByText("Couldn't update task")).toBeInTheDocument()
  })
})
