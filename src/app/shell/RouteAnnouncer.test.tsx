import { act, render, screen } from '@testing-library/react'
import { createMemoryRouter, Outlet } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouteAnnouncer } from './RouteAnnouncer'

function setup(initial: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <>
            <RouteAnnouncer />
            <Outlet />
          </>
        ),
        children: [
          { path: 'overview', handle: { crumb: 'Overview' }, element: <p>overview</p> },
          { path: 'projects', handle: { crumb: 'Projects' }, element: <p>projects</p> },
        ],
      },
    ],
    { initialEntries: [initial] },
  )
  render(<RouterProvider router={router} />)
  return router
}

/** Navigates and lets the announcer's settle delay pass. */
async function go(router: ReturnType<typeof setup>, to: string) {
  await act(() => router.navigate(to))
  await act(() => vi.advanceTimersByTimeAsync(200))
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('RouteAnnouncer', () => {
  it('announces the new page after an in-app navigation, but not the first page', async () => {
    const router = setup('/overview')
    const status = screen.getByRole('status')
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(status).toBeEmptyDOMElement()

    await go(router, '/projects')
    expect(status).toHaveTextContent('Projects')
    expect(status).toHaveAttribute('aria-live', 'polite')

    await go(router, '/overview')
    expect(status).toHaveTextContent('Overview')
  })

  it('stays quiet when only the query changes (e.g. ?task= opens the Task Modal)', async () => {
    const router = setup('/overview')
    await go(router, '/overview?task=t1')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })
})
