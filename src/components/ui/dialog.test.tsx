import { useState } from 'react'
import { act, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
