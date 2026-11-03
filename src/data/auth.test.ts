import { describe, expect, it, vi } from 'vitest'
import type { AuthService, AuthUser, WorkspaceState } from './contracts'
import {
  createLocalAuthService,
  createSupabaseAuthService,
  LOCAL_USER,
  toAuthError,
  type SupabaseAuthClient,
} from './auth'
import { RepositoryError } from './errors'
import { createAuthStore } from './store'

// ---------------------------------------------------------------------------
// Supabase auth service over a fake `supabase.auth`
// ---------------------------------------------------------------------------

type Session = { user: { id: string; email?: string } } | null

function fakeSupabaseAuth() {
  let session: Session = null
  let listener: ((event: string, session: Session) => void) | null = null
  const unsubscribe = vi.fn()
  const auth = {
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    onAuthStateChange: vi.fn((callback: (event: string, session: Session) => void) => {
      listener = callback
      return { data: { subscription: { unsubscribe } } }
    }),
    signInWithPassword: vi.fn(
      async (credentials: {
        email: string
        password: string
      }): Promise<{ data: { session: Session; user: unknown }; error: unknown }> => {
        session = { user: { id: 'u1', email: credentials.email } }
        return { data: { session, user: session.user }, error: null }
      },
    ),
    signUp: vi.fn(async (_credentials: unknown) => ({
      data: { session: null as Session, user: { id: 'u2' } },
      error: null as unknown,
    })),
    signOut: vi.fn(async (_options?: unknown) => ({ error: null as unknown })),
    resetPasswordForEmail: vi.fn(async (_email: string, _options?: unknown) => ({
      data: {},
      error: null as unknown,
    })),
  }
  return {
    auth,
    unsubscribe,
    service: createSupabaseAuthService(auth as unknown as SupabaseAuthClient, {
      redirectTo: () => 'https://cairn.example',
    }),
    setSession: (next: Session) => {
      session = next
    },
    emit: (event: string, next: Session) => listener?.(event, next),
  }
}

describe('Supabase auth service', () => {
  it('reads the current user from the stored session', async () => {
    const fake = fakeSupabaseAuth()
    expect(await fake.service.getUser()).toBeNull()
    fake.setSession({ user: { id: 'u1', email: 'me@example.com' } })
    expect(await fake.service.getUser()).toEqual({ id: 'u1', email: 'me@example.com' })
    fake.setSession({ user: { id: 'u3' } })
    expect(await fake.service.getUser()).toEqual({ id: 'u3', email: null })
  })

  it('delivers auth events outside the Supabase callback and can unsubscribe', async () => {
    vi.useFakeTimers()
    const fake = fakeSupabaseAuth()
    const seen: (AuthUser | null)[] = []
    const stop = fake.service.onChange((user) => seen.push(user))
    fake.emit('SIGNED_IN', { user: { id: 'u1', email: 'a@b.c' } })
    expect(seen).toEqual([]) // deferred
    await vi.runAllTimersAsync()
    fake.emit('SIGNED_OUT', null)
    await vi.runAllTimersAsync()
    expect(seen).toEqual([{ id: 'u1', email: 'a@b.c' }, null])
    stop()
    expect(fake.unsubscribe).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('signs up with the redirect URL and reports whether confirmation is needed', async () => {
    const fake = fakeSupabaseAuth()
    expect(await fake.service.signUp('me@example.com', 'secret123')).toEqual({
      needsConfirmation: true,
    })
    expect(fake.auth.signUp).toHaveBeenCalledWith({
      email: 'me@example.com',
      password: 'secret123',
      options: { emailRedirectTo: 'https://cairn.example' },
    })
    fake.auth.signUp.mockResolvedValueOnce({
      data: { session: { user: { id: 'u2' } }, user: { id: 'u2' } },
      error: null,
    })
    expect(await fake.service.signUp('me@example.com', 'secret123')).toEqual({
      needsConfirmation: false,
    })
  })

  it('signs out this device only and sends password resets back to the app', async () => {
    const fake = fakeSupabaseAuth()
    await fake.service.signOut()
    expect(fake.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    await fake.service.sendPasswordReset('me@example.com')
    expect(fake.auth.resetPasswordForEmail).toHaveBeenCalledWith('me@example.com', {
      redirectTo: 'https://cairn.example',
    })
  })

  it('turns Supabase errors into readable RepositoryErrors', async () => {
    const fake = fakeSupabaseAuth()
    fake.auth.signInWithPassword.mockResolvedValueOnce({
      data: { session: null, user: null as never },
      error: {
        name: 'AuthApiError',
        status: 400,
        code: 'invalid_credentials',
        message: 'Invalid login credentials',
      },
    })
    const error = await fake.service.signIn('me@example.com', 'wrong').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RepositoryError)
    expect(error).toMatchObject({ kind: 'auth', message: 'Incorrect email or password.' })
  })
})

describe('toAuthError', () => {
  it.each([
    [{ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' }, 'network'],
    [new TypeError('Failed to fetch'), 'network'],
    [
      {
        name: 'AuthApiError',
        status: 422,
        code: 'user_already_exists',
        message: 'User already registered',
      },
      'conflict',
    ],
    [
      {
        name: 'AuthApiError',
        status: 400,
        code: 'email_not_confirmed',
        message: 'Email not confirmed',
      },
      'auth',
    ],
    [
      {
        name: 'AuthApiError',
        status: 422,
        code: 'signup_disabled',
        message: 'Signups not allowed',
      },
      'permission',
    ],
    [
      {
        name: 'AuthApiError',
        status: 429,
        code: 'over_email_send_rate_limit',
        message: 'rate limit',
      },
      'unknown',
    ],
    [{ name: 'AuthApiError', status: 429, message: 'Too many requests' }, 'unknown'],
    [{ name: 'AuthApiError', status: 500, message: 'Database error saving new user' }, 'auth'],
  ] as const)('%o → %s', (error, kind) => {
    expect(toAuthError(error).kind).toBe(kind)
  })

  it('keeps the server explanation for weak passwords', () => {
    const error = toAuthError({
      name: 'AuthWeakPasswordError',
      status: 422,
      code: 'weak_password',
      message: 'Password should be at least 8 characters',
    })
    expect(error).toMatchObject({
      kind: 'validation',
      message: 'Password should be at least 8 characters.',
    })
  })
})

describe('local auth service', () => {
  it('is always signed in as the local user', async () => {
    const service = createLocalAuthService()
    expect(service.mode).toBe('local')
    expect(await service.getUser()).toEqual(LOCAL_USER)
    expect(await service.signUp('a@b.c', 'x')).toEqual({ needsConfirmation: false })
    await expect(service.signOut()).resolves.toBeUndefined()
    expect(service.onChange(() => {})).toBeTypeOf('function')
  })
})

// ---------------------------------------------------------------------------
// Auth store ↔ workspace wiring
// ---------------------------------------------------------------------------

function fakeWorkspace() {
  const actions = {
    load: vi.fn(async () => ({ ok: true as const, value: undefined })),
    reset: vi.fn(),
  }
  return { actions, store: { getState: () => ({ actions }) as unknown as WorkspaceState } }
}

function controllableService(initial: AuthUser | null = null) {
  let user = initial
  let callback: ((user: AuthUser | null) => void) | null = null
  const service: AuthService = {
    mode: 'supabase',
    getUser: vi.fn(async () => user),
    onChange: vi.fn((next: (user: AuthUser | null) => void) => {
      callback = next
      return () => {}
    }),
    signIn: vi.fn(async (email: string) => {
      user = { id: 'u1', email }
    }),
    signUp: vi.fn(async () => ({ needsConfirmation: true })),
    signOut: vi.fn(async () => {
      user = null
    }),
    sendPasswordReset: vi.fn(async () => {}),
  }
  return {
    service,
    emit: (next: AuthUser | null) => {
      user = next
      callback?.(next)
    },
  }
}

describe('auth store', () => {
  it('local mode starts signed in and loads the workspace once on init', async () => {
    const workspace = fakeWorkspace()
    const store = createAuthStore({
      mode: 'local',
      auth: createLocalAuthService(),
      workspace: workspace.store,
    })
    expect(store.getState()).toMatchObject({ mode: 'local', status: 'signed_in', user: LOCAL_USER })
    await store.getState().actions.init()
    await store.getState().actions.init()
    expect(workspace.actions.load).toHaveBeenCalledOnce()
  })

  it('Supabase mode follows the session: sign-in loads, refreshes do not, sign-out resets', async () => {
    const workspace = fakeWorkspace()
    const auth = controllableService()
    const store = createAuthStore({
      mode: 'supabase',
      auth: auth.service,
      workspace: workspace.store,
    })
    expect(store.getState().status).toBe('loading')
    await store.getState().actions.init()
    expect(store.getState()).toMatchObject({ status: 'signed_out', user: null })
    expect(workspace.actions.load).not.toHaveBeenCalled()

    auth.emit({ id: 'u1', email: 'me@example.com' })
    expect(store.getState()).toMatchObject({ status: 'signed_in', user: { id: 'u1' } })
    expect(workspace.actions.load).toHaveBeenCalledOnce()
    auth.emit({ id: 'u1', email: 'me@example.com' }) // token refresh
    expect(workspace.actions.load).toHaveBeenCalledOnce()

    auth.emit({ id: 'u9', email: 'other@example.com' }) // a different account
    expect(workspace.actions.reset).toHaveBeenCalledOnce()
    expect(workspace.actions.load).toHaveBeenCalledTimes(2)

    auth.emit(null)
    expect(store.getState()).toMatchObject({ status: 'signed_out', user: null })
    expect(workspace.actions.reset).toHaveBeenCalledTimes(2)
  })

  it('signIn validates input, maps failures and signs in', async () => {
    const workspace = fakeWorkspace()
    const auth = controllableService()
    const store = createAuthStore({
      mode: 'supabase',
      auth: auth.service,
      workspace: workspace.store,
    })
    await store.getState().actions.init()
    const { actions } = store.getState()

    expect(await actions.signIn('not-an-email', 'x')).toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    })
    expect(await actions.signIn('me@example.com', '')).toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    })
    expect(auth.service.signIn).not.toHaveBeenCalled()

    vi.mocked(auth.service.signIn).mockRejectedValueOnce(
      new RepositoryError('auth', 'Incorrect email or password.'),
    )
    expect(await actions.signIn('me@example.com', 'wrong')).toMatchObject({
      ok: false,
      error: { kind: 'auth', message: 'Incorrect email or password.' },
    })

    expect(await actions.signIn('  me@example.com ', 'right')).toEqual({
      ok: true,
      value: undefined,
    })
    expect(auth.service.signIn).toHaveBeenLastCalledWith('me@example.com', 'right')
    expect(store.getState()).toMatchObject({
      status: 'signed_in',
      user: { email: 'me@example.com' },
    })
    expect(workspace.actions.load).toHaveBeenCalledOnce()

    expect(await actions.signOut()).toEqual({ ok: true, value: undefined })
    expect(store.getState().status).toBe('signed_out')
    expect(workspace.actions.reset).toHaveBeenCalledOnce()
  })

  it('signUp reports when email confirmation is required', async () => {
    const workspace = fakeWorkspace()
    const auth = controllableService()
    const store = createAuthStore({
      mode: 'supabase',
      auth: auth.service,
      workspace: workspace.store,
    })
    await store.getState().actions.init()
    expect(await store.getState().actions.signUp('new@example.com', 'secret123')).toEqual({
      ok: true,
      value: { needsConfirmation: true },
    })
    expect(store.getState().status).toBe('signed_out')
    expect(await store.getState().actions.sendPasswordReset('new@example.com')).toEqual({
      ok: true,
      value: undefined,
    })
    expect(auth.service.sendPasswordReset).toHaveBeenCalledWith('new@example.com')
  })
})
