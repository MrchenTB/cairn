import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { getInputModality } from '@/lib/inputModality'
import { renderUI } from '@/test/render'
import { Button } from './button'
import { Tooltip } from './tooltip'

function setup() {
  const view = renderUI(
    <div>
      <Button>Before</Button>
      <Tooltip content="Theme: Dark" shortcut="mod+k">
        <Button aria-label="Theme">T</Button>
      </Tooltip>
    </div>,
  )
  return { ...view, trigger: screen.getByRole('button', { name: 'Theme' }) }
}

describe('Tooltip', () => {
  it('opens on keyboard focus with its text and shortcut', async () => {
    const { user, trigger } = setup()
    await user.tab()
    await user.tab()
    expect(trigger).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Theme: Dark')
  })

  it('does not open when focus returns to the trigger after a pointer interaction', async () => {
    const { user, trigger } = setup()
    await user.click(screen.getByRole('button', { name: 'Before' }))
    expect(getInputModality()).toBe('pointer')
    act(() => trigger.focus()) // e.g. a menu closed by clicking one of its items
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    // Hovering still shows it, and the next key press restores focus tooltips.
    await user.hover(trigger)
    expect(await screen.findByRole('tooltip')).toBeInTheDocument()
    await user.unhover(trigger)
    fireEvent.keyDown(document, { key: 'Shift' })
    expect(getInputModality()).toBe('keyboard')
  })

  it('renders nothing extra when disabled or empty', async () => {
    const { user } = renderUI(
      <Tooltip content="Hidden" disabled>
        <Button>Plain</Button>
      </Tooltip>,
    )
    await user.tab()
    expect(screen.getByRole('button', { name: 'Plain' })).toHaveFocus()
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })
})
