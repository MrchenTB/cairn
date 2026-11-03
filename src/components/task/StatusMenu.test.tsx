import { useState } from 'react'
import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TaskStatus } from '@/domain/types'
import { renderUI } from '@/test/render'
import { StatusMenu } from './StatusMenu'

function Controlled({ onChange }: { onChange: (status: TaskStatus) => void }) {
  const [value, setValue] = useState<TaskStatus>('todo')
  return (
    <StatusMenu
      value={value}
      trigger="chip"
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

describe('StatusMenu', () => {
  it('shows the current status and lists every status with its label', async () => {
    const { user } = renderUI(<StatusMenu value="in_progress" onChange={() => {}} trigger="chip" />)
    const trigger = screen.getByRole('button', { name: 'Status: In Progress' })
    await user.click(trigger)
    const menu = await screen.findByRole('menu')
    const items = within(menu).getAllByRole('menuitemradio')
    expect(items.map((item) => item.textContent)).toEqual(['To Do1', 'In Progress2', 'Done3'])
    expect(within(menu).getByRole('menuitemradio', { name: /In Progress/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('changes status with the mouse and closes', async () => {
    const onChange = vi.fn()
    const { user } = renderUI(<Controlled onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Status: To Do' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Done/ }))
    expect(onChange).toHaveBeenCalledWith('done')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Status: Done' })).toBeInTheDocument()
  })

  it('is fully keyboard operable (Enter to open, arrows, Enter to pick)', async () => {
    const onChange = vi.fn()
    const { user } = renderUI(<Controlled onChange={onChange} />)
    screen.getByRole('button', { name: 'Status: To Do' }).focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    expect(menu).toBeInTheDocument()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenLastCalledWith('in_progress')
    // Focus returns to the trigger after closing.
    expect(screen.getByRole('button', { name: 'Status: In Progress' })).toHaveFocus()
  })

  it('accepts digit shortcuts while open', async () => {
    const onChange = vi.fn()
    const { user } = renderUI(<Controlled onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Status: To Do' }))
    await screen.findByRole('menu')
    await user.keyboard('3')
    expect(onChange).toHaveBeenCalledWith('done')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does not report a change when the current status is picked again', async () => {
    const onChange = vi.fn()
    const { user } = renderUI(<StatusMenu value="todo" onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Status: To Do' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /To Do/ }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
