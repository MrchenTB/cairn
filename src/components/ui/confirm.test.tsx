import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderUI } from '@/test/render'
import { choose, confirm, ConfirmHost } from './confirm'

async function waitForClosed() {
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
}

describe('confirm()', () => {
  it('resolves true on confirm and focuses Cancel first when destructive', async () => {
    const { user } = renderUI(<ConfirmHost />)
    let result!: Promise<boolean>
    act(() => {
      result = confirm({
        title: 'Delete project?',
        description: 'Deletes 12 tasks. This can’t be undone.',
        confirmLabel: 'Delete',
        destructive: true,
      })
    })
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete project?' })
    expect(dialog).toHaveAccessibleDescription('Deletes 12 tasks. This can’t be undone.')
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await expect(result).resolves.toBe(true)
    await waitForClosed()
  })

  it('resolves false on Cancel and on Escape', async () => {
    const { user } = renderUI(<ConfirmHost />)
    let first!: Promise<boolean>
    act(() => {
      first = confirm({ title: 'Discard changes?' })
    })
    const dialog = await screen.findByRole('alertdialog', { name: 'Discard changes?' })
    // Non-destructive: the action is focused first.
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await expect(first).resolves.toBe(false)
    await waitForClosed()

    let second!: Promise<boolean>
    act(() => {
      second = confirm({ title: 'Leave page?' })
    })
    await screen.findByRole('alertdialog', { name: 'Leave page?' })
    await user.keyboard('{Escape}')
    await expect(second).resolves.toBe(false)
    await waitForClosed()
  })

  it('queues requests and shows them one at a time', async () => {
    const { user } = renderUI(<ConfirmHost />)
    let a!: Promise<boolean>
    let b!: Promise<boolean>
    act(() => {
      a = confirm({ title: 'First?' })
      b = confirm({ title: 'Second?' })
    })
    await user.click(
      within(await screen.findByRole('alertdialog', { name: 'First?' })).getByRole('button', {
        name: 'Confirm',
      }),
    )
    await expect(a).resolves.toBe(true)
    await user.click(
      within(await screen.findByRole('alertdialog', { name: 'Second?' })).getByRole('button', {
        name: 'Cancel',
      }),
    )
    await expect(b).resolves.toBe(false)
    await waitForClosed()
  })

  it('choose() resolves the picked value', async () => {
    const { user } = renderUI(<ConfirmHost />)
    let result!: Promise<'keep' | 'delete' | null>
    act(() => {
      result = choose({
        title: 'Delete “Write report”?',
        description: 'It has 3 subtasks.',
        choices: [
          { value: 'keep', label: 'Keep subtasks' },
          { value: 'delete', label: 'Delete all', variant: 'danger' },
        ],
      })
    })
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Keep subtasks' }))
    await expect(result).resolves.toBe('keep')
    await waitForClosed()
  })

  it('returns focus to what asked, but not when another dialog took focus meanwhile', async () => {
    const { user } = renderUI(
      <>
        <button>Opener</button>
        <ConfirmHost />
      </>,
    )
    const opener = screen.getByRole('button', { name: 'Opener' })
    opener.focus()
    act(() => {
      void confirm({ title: 'Sure?', confirmLabel: 'Yes' })
    })
    let dialog = await screen.findByRole('alertdialog', { name: 'Sure?' })
    await user.click(within(dialog).getByRole('button', { name: 'Yes' }))
    await waitForClosed()
    await waitFor(() => expect(opener).toHaveFocus())

    // Again, but a search-like dialog opens (and takes focus) while the prompt is closing.
    opener.focus()
    act(() => {
      void confirm({ title: 'Sure again?', confirmLabel: 'Yes' })
    })
    dialog = await screen.findByRole('alertdialog', { name: 'Sure again?' })
    const search = document.createElement('div')
    search.setAttribute('role', 'dialog')
    search.dataset.state = 'open'
    const input = document.createElement('input')
    search.append(input)
    // ⌘K lands while the prompt is closing: the overlay mounts and takes focus in the instant the
    // prompt unmounts, before the prompt's own focus return (a task later) runs.
    const yes = within(dialog).getByRole('button', { name: 'Yes' })
    const observer = new MutationObserver(() => {
      if (document.querySelector('[role="alertdialog"]')) return
      observer.disconnect()
      document.body.append(search)
      input.focus()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    await user.click(yes)
    await waitForClosed()
    // Radix runs the focus return a task after unmounting: give it time to (wrongly) act.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(input).toHaveFocus()
    search.remove()
  })
})
