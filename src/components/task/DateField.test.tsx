import { screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from '@/data/store'
import { renderUI } from '@/test/render'
import { DateField } from './DateField'

/** Node's process (Vitest runs in Node; the app tsconfig has no Node types). */
declare const process: { env: Record<string, string | undefined> }

const ORIGINAL_TZ = process.env.TZ

/** Zones from UTC−11 to UTC+14: a UTC-midnight bug would shift the day in at least one. */
const TIME_ZONES = ['Pacific/Pago_Pago', 'America/Los_Angeles', 'UTC', 'Asia/Taipei', 'Pacific/Kiritimati']

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-02T12:00:00Z') })
  useWorkspaceStore.setState((state) => ({
    preferences: { ...state.preferences, timezone: 'UTC', weekStartsOn: 1 },
  }))
})

afterEach(() => {
  vi.useRealTimers()
  process.env.TZ = ORIGINAL_TZ
})

describe('DateField', () => {
  it.each(TIME_ZONES)('selecting a day yields the same ISO date in %s', async (zone) => {
    process.env.TZ = zone
    const onChange = vi.fn()
    const { user } = renderUI(<DateField label="Due date" value="2026-11-10" onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: /^Due date:/ }))
    await user.click(await screen.findByRole('button', { name: /November 15th, 2026/ }))
    expect(onChange).toHaveBeenCalledWith('2026-11-15')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the chosen date and an accessible full date', () => {
    renderUI(<DateField label="Due date" value="2026-11-10" onChange={() => {}} />)
    const trigger = screen.getByRole('button', { name: 'Due date: Tuesday, November 10, 2026' })
    expect(trigger).toHaveTextContent('Nov 10')
  })

  it('is keyboard accessible: focus starts on the selected day, arrows move, Enter picks', async () => {
    process.env.TZ = 'America/Los_Angeles'
    const onChange = vi.fn()
    const { user } = renderUI(<DateField label="Due date" value="2026-11-10" onChange={onChange} />)
    screen.getByRole('button', { name: /^Due date:/ }).focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('button', { name: /November 10th, 2026/ })).toHaveFocus()
    await user.keyboard('{ArrowRight}{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledWith('2026-11-18')
  })

  it('offers quick picks and Clear', async () => {
    const onChange = vi.fn()
    const { user } = renderUI(<DateField label="Due date" value="2026-11-10" onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: /^Due date:/ }))
    await user.click(await screen.findByRole('button', { name: 'Tomorrow Nov 3' }))
    expect(onChange).toHaveBeenLastCalledWith('2026-11-03')

    await user.click(screen.getByRole('button', { name: /^Due date:/ }))
    await user.click(await screen.findByRole('button', { name: 'Next week Nov 9' }))
    expect(onChange).toHaveBeenLastCalledWith('2026-11-09') // next Monday (week starts Monday)

    await user.click(screen.getByRole('button', { name: /^Due date:/ }))
    await user.click(await screen.findByRole('button', { name: 'Clear' }))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('disables days and quick picks outside min/max', async () => {
    const onChange = vi.fn()
    const { user } = renderUI(
      <DateField
        label="Due date"
        value={null}
        min="2026-11-04"
        max="2026-11-20"
        rangeHint="Due date can’t be before the start date."
        onChange={onChange}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Due date: not set' }))
    expect(await screen.findByRole('button', { name: 'Today Nov 2' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next week Nov 9' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /November 3rd, 2026/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /November 21st, 2026/ })).toBeDisabled()
    expect(screen.getByText('Due date can’t be before the start date.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /November 4th, 2026/ }))
    expect(onChange).toHaveBeenCalledWith('2026-11-04')
  })
})
