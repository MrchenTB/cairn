import { useState } from 'react'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderUI } from '@/test/render'
import { Button } from './button'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './dialog'

/** A dialog opened from app state (no Radix Trigger), like the shortcuts help or search. */
function StateDialog({ autoFocusField = false }: { autoFocusField?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Opener</Button>
      <Button>Elsewhere</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Help</DialogTitle>
          {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the case under test */}
          {autoFocusField ? <input aria-label="Field" autoFocus /> : null}
        </DialogContent>
      </Dialog>
    </>
  )
}

describe('DialogContent focus return', () => {
  it('gives focus back to where it was when a trigger-less dialog closes', async () => {
    const { user } = renderUI(<StateDialog />)
    const opener = screen.getByRole('button', { name: 'Opener' })
    await user.click(opener)
    expect(await screen.findByRole('dialog', { name: 'Help' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('remembers the opener even when an autoFocus field takes focus on open', async () => {
    const { user } = renderUI(<StateDialog autoFocusField />)
    const opener = screen.getByRole('button', { name: 'Opener' })
    await user.click(opener)
    expect(await screen.findByRole('textbox', { name: 'Field' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('still returns focus to a Radix Trigger', async () => {
    const { user } = renderUI(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Rename</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus())
  })

  it('lets the consumer take over with preventDefault', async () => {
    function Custom() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <Button onClick={() => setOpen(true)}>Opener</Button>
          <Button id="target">Target</Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
              aria-describedby={undefined}
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                document.getElementById('target')?.focus()
              }}
            >
              <DialogTitle>Custom</DialogTitle>
            </DialogContent>
          </Dialog>
        </>
      )
    }
    const { user } = renderUI(<Custom />)
    await user.click(screen.getByRole('button', { name: 'Opener' }))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Target' })).toHaveFocus())
    act(() => {}) // flush the restore timer: it must not move focus back to the opener
    expect(screen.getByRole('button', { name: 'Target' })).toHaveFocus()
  })
})

describe('DialogContent outside clicks', () => {
  /** A left click outside the panel (Radix dismisses on the click that follows pointerdown). */
  async function clickOutside(element: Element) {
    fireEvent.pointerDown(element, { button: 0 })
    fireEvent.mouseDown(element, { button: 0 })
    fireEvent.pointerUp(element, { button: 0 })
    fireEvent.mouseUp(element, { button: 0 })
    fireEvent.click(element, { button: 0 })
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)))
  }

  function Harness({ onRetry }: { onRetry: () => void }) {
    const [open, setOpen] = useState(true)
    return (
      <>
        <Button>Page button</Button>
        {/* The markup sonner renders for a toast with an action. */}
        <section aria-label="Notifications">
          <ol data-sonner-toaster="">
            <li data-sonner-toast="">
              <button type="button" onClick={onRetry}>
                Retry
              </button>
            </li>
          </ol>
        </section>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Edit</DialogTitle>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  it('using a toast action keeps the dialog open', async () => {
    const onRetry = vi.fn()
    renderUI(<Harness onRetry={onRetry} />)
    await screen.findByRole('dialog', { name: 'Edit' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 0))) // Radix arms its listener

    // While the modal is open the rest of the page is hidden from assistive tech.
    const retry = screen.getByRole('button', { name: 'Retry', hidden: true })
    await clickOutside(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog', { name: 'Edit' })).toBeInTheDocument()

    await clickOutside(screen.getByRole('button', { name: 'Page button', hidden: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('DialogContent input-method keys', () => {
  function renderForm() {
    const onOpenChange = vi.fn()
    renderUI(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Name it</DialogTitle>
          <form noValidate onSubmit={(event) => event.preventDefault()}>
            <input aria-label="Name" />
          </form>
        </DialogContent>
      </Dialog>,
    )
    return { onOpenChange, field: screen.getByRole('textbox', { name: 'Name' }) }
  }

  it('Esc during a composition does not close; a plain Esc does', () => {
    const { onOpenChange, field } = renderForm()
    fireEvent.keyDown(field, { key: 'Escape', isComposing: true })
    // Safari: the Esc that drops the pre-edit string arrives after compositionend, keyCode 229.
    fireEvent.keyDown(field, { key: 'Escape', keyCode: 229, isComposing: false })
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('the Enter that picks a candidate is never left to implicit form submission', () => {
    const { field } = renderForm()
    // fireEvent returns false when the default action was prevented (no implicit submit then).
    expect(fireEvent.keyDown(field, { key: 'Enter', isComposing: true })).toBe(false)
    expect(fireEvent.keyDown(field, { key: 'Enter', keyCode: 229, isComposing: false })).toBe(false)
    expect(fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 })).toBe(true)
  })
})
