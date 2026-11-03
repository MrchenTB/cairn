import { act, render, screen } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { describe, expect, it } from 'vitest'
import { useCloseTask, useOpenTask, useTaskParam, withTaskParam } from './taskModalRoute'

function Probe() {
  const taskId = useTaskParam()
  const openTask = useOpenTask()
  const closeTask = useCloseTask()
  return (
    <div>
      <output aria-label="task">{taskId ?? 'none'}</output>
      <button onClick={() => openTask('t-42')}>open</button>
      <button onClick={closeTask}>close</button>
    </div>
  )
}

function setup(url: string) {
  const router = createMemoryRouter([{ path: '*', Component: Probe }], { initialEntries: [url] })
  render(<RouterProvider router={router} />)
  return router
}

describe('task modal URL state', () => {
  it('builds search strings that keep other params', () => {
    expect(withTaskParam('?group=phase', 't1')).toBe('?group=phase&task=t1')
    expect(withTaskParam('?task=t1&group=phase', null)).toBe('?group=phase')
    expect(withTaskParam('?task=t1', null)).toBe('')
  })

  it('opens with a PUSH and closes with a REPLACE, preserving path, params and hash', () => {
    const router = setup('/projects/p1/list?group=phase#top')
    expect(screen.getByLabelText('task')).toHaveTextContent('none')

    act(() => screen.getByText('open').click())
    expect(router.state.historyAction).toBe('PUSH')
    expect(router.state.location.pathname).toBe('/projects/p1/list')
    expect(router.state.location.search).toBe('?group=phase&task=t-42')
    expect(router.state.location.hash).toBe('#top')
    expect(screen.getByLabelText('task')).toHaveTextContent('t-42')

    act(() => screen.getByText('close').click())
    expect(router.state.historyAction).toBe('REPLACE')
    expect(router.state.location.search).toBe('?group=phase')
    expect(router.state.location.hash).toBe('#top')
    expect(screen.getByLabelText('task')).toHaveTextContent('none')
  })

  it('reads a deep-linked task id', () => {
    setup('/overview?task=abc')
    expect(screen.getByLabelText('task')).toHaveTextContent('abc')
  })

  it('treats an empty ?task= as no task', () => {
    setup('/overview?task=&group=phase')
    expect(screen.getByLabelText('task')).toHaveTextContent('none')
  })

  it('does not push a duplicate entry when the task is already open', () => {
    const router = setup('/projects/p1/board?task=t-42')
    const before = router.state.location.key
    act(() => screen.getByText('open').click())
    expect(router.state.location.key).toBe(before)
    expect(router.state.location.search).toBe('?task=t-42')
  })
})
