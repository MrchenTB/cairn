import { act, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/data/store'
import { renderUI } from '@/test/render'
import { AuthGate } from './AuthGate'
import { LoginPage } from './LoginPage'

const initial = useAuthStore.getState()

/** The stored session could not be confirmed: the server did not answer. */
function unreachable() {
  const retrySession = vi.fn(async () => {})
  useAuthStore.setState({
    mode: 'supabase',
    status: 'unreachable',
    user: null,
    actions: { ...initial.actions, retrySession },
  })
  return retrySession
}

function renderApp(route: string) {
  return renderUI(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AuthGate />}>
        <Route path="*" element={<p>Workspace</p>} />
      </Route>
    </Routes>,
    { route },
  )
}

beforeEach(() => {
  useAuthStore.setState(initial, true)
})
afterEach(() => {
  useAuthStore.setState(initial, true)
})

describe('a server that cannot be reached at startup', () => {
  it('says so instead of showing sign-in, and shows no data', async () => {
    unreachable()
    const { router } = renderApp('/projects/p1/list')
    expect(await screen.findByRole('heading', { name: 'Can’t reach Cairn' })).toBeInTheDocument()
    expect(screen.queryByText('Workspace')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/projects/p1/list') // not sent to /login
  })

  it('Try again reads the session again; the page follows the outcome', async () => {
    const retrySession = unreachable()
    retrySession.mockImplementationOnce(async () => {
      useAuthStore.setState({ status: 'signed_in', user: { id: 'u1', email: 'me@example.com' } })
    })
    const { user } = renderApp('/projects/p1/list')
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(retrySession).toHaveBeenCalledOnce()
    expect(await screen.findByText('Workspace')).toBeInTheDocument()
  })

  it('tries again by itself when the browser comes back online (once per event, no timer)', async () => {
    const retrySession = unreachable()
    renderApp('/overview')
    await screen.findByRole('button', { name: 'Try again' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(retrySession).not.toHaveBeenCalled()
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await waitFor(() => expect(retrySession).toHaveBeenCalledOnce())
  })

  it('the sign-in page shows the same screen, not the form', async () => {
    unreachable()
    renderApp('/login')
    expect(await screen.findByRole('heading', { name: 'Can’t reach Cairn' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
  })

  it('a session the server refused (signed out) still goes to sign-in', async () => {
    unreachable()
    const { router } = renderApp('/overview')
    await screen.findByRole('button', { name: 'Try again' })
    act(() => useAuthStore.setState({ status: 'signed_out' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
  })
})
