import { screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthState } from '@/data/contracts'
import { useAuthStore } from '@/data/store'
import type { Result } from '@/domain/types'
import { renderUI } from '@/test/render'
import { LoginPage } from './LoginPage'

const OK: Result = { ok: true, value: undefined }
const initial = useAuthStore.getState()

function signedOut(actions: Partial<AuthState['actions']> = {}) {
  const mocks = {
    init: vi.fn(async () => {}),
    signIn: vi.fn(async (): Promise<Result> => OK),
    signUp: vi.fn(async () => ({ ok: true as const, value: { needsConfirmation: true } })),
    signOut: vi.fn(async (): Promise<Result> => OK),
    sendPasswordReset: vi.fn(async (): Promise<Result> => OK),
    ...actions,
  }
  useAuthStore.setState({
    mode: 'supabase',
    status: 'signed_out',
    user: null,
    actions: { ...initial.actions, ...mocks },
  })
  return mocks
}

beforeEach(() => {
  useAuthStore.setState(initial, true)
})
afterEach(() => {
  useAuthStore.setState(initial, true)
})

describe('LoginPage', () => {
  it('redirects to /overview in local mode (no accounts)', async () => {
    const { router } = renderUI(<LoginPage />, { route: '/login' })
    await waitFor(() => expect(router.state.location.pathname).toBe('/overview'))
  })

  it('validates the email inline and only describes the field it concerns', async () => {
    const actions = signedOut()
    const { user } = renderUI(<LoginPage />, { route: '/login' })
    const email = screen.getByLabelText('Email')
    const password = screen.getByLabelText('Password')
    expect(email).toHaveFocus()
    await user.type(email, 'not-an-email')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address.')
    expect(email).toHaveAttribute('aria-invalid', 'true')
    expect(email).toHaveAccessibleDescription('Enter a valid email address.')
    expect(password).not.toHaveAttribute('aria-describedby')
    expect(email).toHaveFocus()
    expect(actions.signIn).not.toHaveBeenCalled()
  })

  it('shows a failed sign-in as a form error (both fields described)', async () => {
    const actions = signedOut({
      signIn: vi.fn(async (): Promise<Result> => ({
        ok: false,
        error: { kind: 'auth', message: 'Incorrect email or password.' },
      })),
    })
    const { user } = renderUI(<LoginPage />, { route: '/login' })
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong-password{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.')
    expect(actions.signIn).toHaveBeenCalledWith('me@example.com', 'wrong-password')
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(
      'Incorrect email or password.',
    )
  })

  it('sign-up: links the length hint, then moves focus to the confirmation notice', async () => {
    const actions = signedOut()
    const { user } = renderUI(<LoginPage />, { route: '/login' })
    await user.click(screen.getByRole('button', { name: 'Create an account' }))
    const password = screen.getByLabelText('Password')
    expect(password).toHaveAttribute('autocomplete', 'new-password')
    expect(password).toHaveAccessibleDescription('At least 8 characters.')
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(password, 'short{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('Use at least 8 characters')
    expect(actions.signUp).not.toHaveBeenCalled()

    await user.clear(password)
    await user.type(password, 'long-enough{Enter}')
    const heading = await screen.findByRole('heading', { name: 'Confirm your email' })
    expect(heading).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }))
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('"Forgot password?" asks for the email first, then confirms without revealing accounts', async () => {
    const actions = signedOut()
    const { user } = renderUI(<LoginPage />, { route: '/login' })
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your email address first')
    expect(screen.getByLabelText('Email')).toHaveFocus()
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }))
    expect(actions.sendPasswordReset).toHaveBeenCalledWith('me@example.com')
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toHaveFocus()
    expect(screen.getByText(/If an account exists for me@example.com/)).toBeInTheDocument()
  })

  it('the password toggle keeps its name and reports state with aria-pressed', async () => {
    signedOut()
    const { user } = renderUI(<LoginPage />, { route: '/login' })
    const toggle = screen.getByRole('button', { name: 'Show password' })
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text')
  })
})
