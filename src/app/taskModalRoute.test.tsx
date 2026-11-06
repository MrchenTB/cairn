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
      <button onClick={() => openTask('t-43')}>open other</button>
      <button onClick={() => closeTask()}>close</button>
      <button onClick={() => closeTask({ toParent: 't-42' })}>close to parent</button>
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

  it('opens with a PUSH and closes by stepping back, preserving path, params and hash', async () => {
    const router = setup('/projects/p1/list?group=phase#top')
    expect(screen.getByLabelText('task')).toHaveTextContent('none')

    act(() => screen.getByText('open').click())
    expect(router.state.historyAction).toBe('PUSH')
    expect(router.state.location.pathname).toBe('/projects/p1/list')
    expect(router.state.location.search).toBe('?group=phase&task=t-42')
    expect(router.state.location.hash).toBe('#top')
    expect(screen.getByLabelText('task')).toHaveTextContent('t-42')

    await act(async () => {
      screen.getByText('close').click()
    })
    expect(router.state.historyAction).toBe('POP')
    expect(router.state.location.search).toBe('?group=phase')
    expect(router.state.location.hash).toBe('#top')
    expect(screen.getByLabelText('task')).toHaveTextContent('none')
    // Nothing is left to go back over: the entry before the page is the page's own.
    expect(router.state.location.state).toBeNull()
  })

  it('closes a task opened from inside another task in one step', async () => {
    const router = setup('/projects/p1/list')
    act(() => screen.getByText('open').click())
    act(() => screen.getByText('open other').click())
    expect(router.state.location.search).toBe('?task=t-43')
    await act(async () => {
      screen.getByText('close').click()
    })
    expect(router.state.location.pathname).toBe('/projects/p1/list')
    expect(router.state.location.search).toBe('')
  })

  it('a subtask opened from its parent returns to it; a second close leaves the page', async () => {
    const router = setup('/projects/p/list')
    await act(() => screen.getByRole('button', { name: 'open' }).click())
    await act(() => screen.getByRole('button', { name: 'open other' }).click())
    expect(router.state.location.search).toBe('?task=t-43')

    await act(() => screen.getByRole('button', { name: 'close to parent' }).click())
    expect(router.state.location.search).toBe('?task=t-42')

    await act(() => screen.getByRole('button', { name: 'close' }).click())
    expect(router.state.location.search).toBe('')
    expect(router.state.location.pathname).toBe('/projects/p/list')
  })

  it('a subtask not opened from that parent closes as usual', async () => {
    const direct = setup('/projects/p/list')
    await act(() => screen.getByRole('button', { name: 'open other' }).click())
    await act(() => screen.getByRole('button', { name: 'close to parent' }).click())
    expect(direct.state.location.search).toBe('')
  })

  it('steps back only once when close is called twice before the step completes', async () => {
    const router = setup('/overview')
    act(() => screen.getByText('open').click())
    await act(async () => {
      screen.getByText('close').click()
      screen.getByText('close').click()
    })
    expect(router.state.location.pathname).toBe('/overview')
    expect(router.state.location.search).toBe('')
    // A second step back would have left the router's first entry behind.
    expect(router.state.historyAction).toBe('POP')
  })

  it('a task reopened with browser Forward can still be closed', async () => {
    const router = setup('/overview')
    act(() => screen.getByText('open').click())
    await act(async () => {
      screen.getByText('close').click()
    })
    await act(async () => {
      await router.navigate(1)
    })
    expect(screen.getByLabelText('task')).toHaveTextContent('t-42')
    await act(async () => {
      screen.getByText('close').click()
    })
    expect(screen.getByLabelText('task')).toHaveTextContent('none')
  })

  it('replaces the entry of a task that was not opened from the page (deep link)', () => {
    const router = setup('/overview?task=abc')
    act(() => screen.getByText('close').click())
    expect(router.state.historyAction).toBe('REPLACE')
    expect(router.state.location.search).toBe('')
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
