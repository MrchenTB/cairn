import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from '@/data/store'
import { DueLabel } from './DueLabel'

beforeEach(() => {
  // "Today" is 2026-11-02 in the user's configured zone.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-02T12:00:00Z') })
  useWorkspaceStore.setState((state) => ({
    preferences: { ...state.preferences, timezone: 'UTC' },
  }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DueLabel', () => {
  it('marks open tasks due before today as overdue (tone + icon + text for AT)', () => {
    const { container } = render(<DueLabel dueDate="2026-10-30" status="in_progress" />)
    const label = container.querySelector('[data-bucket]') as HTMLElement
    expect(label).toHaveAttribute('data-bucket', 'overdue')
    expect(label).toHaveClass('text-danger')
    expect(label).toHaveTextContent('Oct 30')
    expect(screen.getByText('(overdue)')).toHaveClass('sr-only')
    expect(label.querySelector('svg')).not.toBeNull()
    expect(label).toHaveAttribute('title', 'Overdue · Due Friday, October 30, 2026')
  })

  it('spells the whole date out in its hover title', () => {
    const { container } = render(<DueLabel dueDate="2026-11-13" status="todo" />)
    expect(container.querySelector('[data-bucket]')).toHaveAttribute(
      'title',
      'Due Friday, November 13, 2026',
    )
  })

  it('shows "Today" in the warning tone for tasks due today', () => {
    const { container } = render(<DueLabel dueDate="2026-11-02" status="todo" />)
    const label = container.querySelector('[data-bucket]') as HTMLElement
    expect(label).toHaveAttribute('data-bucket', 'today')
    expect(label).toHaveClass('text-warning')
    expect(label).toHaveTextContent('Today')
  })

  it('uses the neutral tone for upcoming dates ("Tomorrow", short date)', () => {
    render(
      <>
        <DueLabel dueDate="2026-11-03" status="todo" />
        <DueLabel dueDate="2026-11-20" status="todo" />
      </>,
    )
    expect(screen.getByText('Tomorrow').parentElement).toHaveClass('text-fg-tertiary')
    expect(screen.getByText('Nov 20').parentElement).toHaveClass('text-fg-tertiary')
  })

  it('keeps done tasks neutral even when their due date has passed', () => {
    const { container } = render(<DueLabel dueDate="2026-10-30" status="done" />)
    const label = container.querySelector('[data-bucket]') as HTMLElement
    expect(label).toHaveAttribute('data-bucket', 'done')
    expect(label).toHaveClass('text-fg-tertiary')
    expect(label).not.toHaveClass('text-danger')
    expect(screen.queryByText('(overdue)')).not.toBeInTheDocument()
  })

  it('renders the empty fallback without a due date', () => {
    const { container, rerender } = render(<DueLabel dueDate={null} status="todo" />)
    expect(container).toBeEmptyDOMElement()
    rerender(<DueLabel dueDate={null} status="todo" empty="No date" />)
    expect(screen.getByText('No date')).toBeInTheDocument()
  })

  it('follows the configured time zone for "today"', () => {
    // 12:00 UTC on Nov 2 is already Nov 3 in Kiritimati (UTC+14).
    useWorkspaceStore.setState((state) => ({
      preferences: { ...state.preferences, timezone: 'Pacific/Kiritimati' },
    }))
    const { container } = render(<DueLabel dueDate="2026-11-02" status="todo" />)
    expect(container.querySelector('[data-bucket]')).toHaveAttribute('data-bucket', 'overdue')
  })
})
