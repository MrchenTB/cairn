import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AddTaskComposer } from './AddTaskComposer'

describe('AddTaskComposer buttons (Safari / Firefox on macOS do not focus buttons on click)', () => {
  it('keeps the input focused on mousedown of Add task / Cancel so an empty composer is not closed by blur', () => {
    render(<AddTaskComposer columnLabel="To Do" onCreate={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add task to To Do' }))
    const input = screen.getByLabelText('New task in To Do')
    for (const name of ['Add task', 'Cancel']) {
      // fireEvent returns false when the event was default-prevented (focus would not move).
      expect(fireEvent.mouseDown(screen.getByRole('button', { name }))).toBe(false)
    }
    expect(input).toBe(document.activeElement)
  })
})
