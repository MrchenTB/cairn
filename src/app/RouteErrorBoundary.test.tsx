import { render, screen } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContentErrorBoundary } from './RouteErrorBoundary'

const CHUNK_ERROR = new TypeError('Failed to fetch dynamically imported module: /src/Settings.tsx')

function renderBoundary(error: unknown) {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        loader: () => {
          throw error
        },
        element: <p>page</p>,
        ErrorBoundary: ContentErrorBoundary,
      },
    ],
    { initialEntries: ['/settings/data'] },
  )
  render(<RouterProvider router={router} />)
  return router
}

afterEach(() => vi.restoreAllMocks())

describe('ContentErrorBoundary', () => {
  it('online: a chunk that is gone means a new version, and Reload is the way out', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true)
    renderBoundary(CHUNK_ERROR)
    expect(
      await screen.findByRole('heading', { name: 'A new version of Cairn is available' }),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeVisible()
  })

  it('offline: says the page needs a connection (not "a new version") and offers Try again', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    renderBoundary(CHUNK_ERROR)
    expect(await screen.findByRole('heading', { name: "You're offline" })).toBeVisible()
    expect(screen.getByText(/saved data is safe/i)).toBeVisible()
    expect(screen.queryByText(/new version/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument()
  })

  it('offline: Try again loads the page once the connection is back', async () => {
    let online = false
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online)
    let failing = true
    const router = createMemoryRouter(
      [
        {
          path: '*',
          loader: () => {
            if (failing) throw CHUNK_ERROR
            return null
          },
          element: <p>page loaded</p>,
          ErrorBoundary: ContentErrorBoundary,
        },
      ],
      { initialEntries: ['/settings/data?x=1'] },
    )
    render(<RouterProvider router={router} />)
    const retry = await screen.findByRole('button', { name: 'Try again' })
    online = true
    failing = false
    retry.click()
    expect(await screen.findByText('page loaded')).toBeVisible()
    expect(router.state.location.pathname + router.state.location.search).toBe('/settings/data?x=1')
  })
})
