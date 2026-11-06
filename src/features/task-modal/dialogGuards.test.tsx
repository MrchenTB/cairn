import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusIfNotCovered } from './dialogGuards'

function openDialog(): HTMLElement {
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.dataset.state = 'open'
  document.body.append(dialog)
  return dialog
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('focusIfNotCovered', () => {
  it('moves focus into a dialog that is the only one open', () => {
    const modal = openDialog()
    const move = vi.fn()
    expect(focusIfNotCovered(modal, move)).toBe(true)
    expect(move).toHaveBeenCalledOnce()
  })

  it('does nothing while another dialog (the search overlay) is open', () => {
    const modal = openDialog()
    openDialog()
    const move = vi.fn()
    expect(focusIfNotCovered(modal, move)).toBe(false)
    expect(move).not.toHaveBeenCalled()
  })

  it('ignores a dialog that is already closing', () => {
    const modal = openDialog()
    openDialog().dataset.state = 'closed'
    const move = vi.fn()
    expect(focusIfNotCovered(modal, move)).toBe(true)
  })
})
