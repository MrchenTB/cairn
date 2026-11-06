import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { makeTask } from '@/domain/testFactories'
import { BoardCardOverlay } from './BoardCard'

function lifted(previewStatus?: 'todo' | 'in_progress' | 'done') {
  // Due long ago: overdue unless the task is done.
  const task = makeTask({
    id: 't1',
    projectId: 'p1',
    title: 'Late report',
    status: 'todo',
    dueDate: '2020-01-01',
  })
  return (
    <BoardCardOverlay
      task={task}
      previewStatus={previewStatus}
      phase={null}
      subtasksDone={0}
      subtasksTotal={0}
      showPhase={false}
    />
  )
}

describe('BoardCardOverlay', () => {
  it('shows the status of the column the card is over, glyph and due tone included', () => {
    const { container, rerender } = render(lifted())
    const glyph = () => container.querySelector('svg[data-status]')
    const bucket = () => container.querySelector('[data-bucket]')

    // No preview yet: the task's own status.
    expect(glyph()).toHaveAttribute('data-status', 'todo')
    expect(bucket()).toHaveAttribute('data-bucket', 'overdue')

    rerender(lifted('in_progress'))
    expect(glyph()).toHaveAttribute('data-status', 'in_progress')
    expect(bucket()).toHaveAttribute('data-bucket', 'overdue')

    // Over Done the card would not be overdue any more.
    rerender(lifted('done'))
    expect(glyph()).toHaveAttribute('data-status', 'done')
    expect(bucket()).toHaveAttribute('data-bucket', 'done')

    rerender(lifted('todo'))
    expect(glyph()).toHaveAttribute('data-status', 'todo')
    expect(bucket()).toHaveAttribute('data-bucket', 'overdue')
  })

  it('is marked as the drag overlay and carries no actions', () => {
    const { container } = render(lifted())
    expect(container.querySelector('[data-board-drag-overlay]')).not.toBeNull()
    expect(container.querySelector('button')).toBeNull()
  })
})
