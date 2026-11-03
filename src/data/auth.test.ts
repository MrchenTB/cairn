import { describe, expect, it, vi } from 'vitest'
import { makeProject, makeTask } from '@/domain/testFactories'
import type { AuthChangeEvent, AuthService, AuthUser, WorkspaceState } from './contracts'
import {
  createLocalAuthService,
  createSupabaseAuthService,
  LOCAL_USER,
  toAuthError,
  type SupabaseAuthClient,
} from './auth'
import { RepositoryError } from './errors'
import { createMemoryStorage, LocalRepository } from './localRepository'
import { createAuthStore, createWorkspaceStore } from './store'

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
    updateUser: vi.fn(async (_attributes: { password?: string }) => ({
      data: { user: session?.user ?? null },
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

  it('reports a password-recovery link as its own event', async () => {
    vi.useFakeTimers()
    const fake = fakeSupabaseAuth()
    const seen: [AuthUser | null, AuthChangeEvent | undefined][] = []
    fake.service.onChange((user, event) => seen.push([user, event]))
    fake.emit('PASSWORD_RECOVERY', { user: { id: 'u1', email: 'a@b.c' } })
    fake.emit('TOKEN_REFRESHED', { user: { id: 'u1', email: 'a@b.c' } })
    fake.emit('SOMETHING_NEW', { user: { id: 'u1', email: 'a@b.c' } })
    await vi.runAllTimersAsync()
    expect(seen).toEqual([
      [{ id: 'u1', email: 'a@b.c' }, 'password_recovery'],
      [{ id: 'u1', email: 'a@b.c' }, 'token_refreshed'],
      [{ id: 'u1', email: 'a@b.c' }, undefined],
    ])
    vi.useRealTimers()
  })

  it('sets a new password with updateUser and maps its errors', async () => {
    const fake = fakeSupabaseAuth()
    await fake.service.updatePassword('new-secret-1')
    expect(fake.auth.updateUser).toHaveBeenCalledWith({ password: 'new-secret-1' })
    fake.auth.updateUser.mockResolvedValueOnce({
      data: { user: null },
      error: { name: 'AuthApiError', status: 422, code: 'same_password', message: 'same' },
    })
    await expect(fake.service.updatePassword('old')).rejects.toMatchObject({
      kind: 'validation',
      message: 'Choose a password different from the current one.',
    })
    fake.auth.updateUser.mockResolvedValueOnce({
      data: { user: null },
      error: { name: 'AuthApiError', status: 401, code: 'reauthentication_needed', message: 'x' },
    })
    await expect(fake.service.updatePassword('another')).rejects.toMatchObject({ kind: 'auth' })
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
  let callback: ((user: AuthUser | null, event?: AuthChangeEvent) => void) | null = null
  const unsubscribe = vi.fn()
  const service: AuthService = {
    mode: 'supabase',
    getUser: vi.fn(async () => user),
    onChange: vi.fn((next: (user: AuthUser | null, event?: AuthChangeEvent) => void) => {
      callback = next
      return unsubscribe
    }),
    signIn: vi.fn(async (email: string) => {
      user = { id: 'u1', email }
    }),
    signUp: vi.fn(async () => ({ needsConfirmation: true })),
    signOut: vi.fn(async () => {
      user = null
    }),
    sendPasswordReset: vi.fn(async () => {}),
    updatePassword: vi.fn(async () => {}),
  }
  return {
    service,
    unsubscribe,
    emit: (next: AuthUser | null, event?: AuthChangeEvent) => {
      user = next
      callback?.(next, event)
    },
    /** The session ends on the server without an event reaching this tab (yet). */
    expireSilently: () => {
      user = null
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

describe('password recovery', () => {
  it('a reset link signs in and asks for a new password until one is saved', async () => {
    const workspace = fakeWorkspace()
    const auth = controllableService()
    const store = createAuthStore({
      mode: 'supabase',
      auth: auth.service,
      workspace: workspace.store,
    })
    await store.getState().actions.init()
    expect(store.getState().passwordRecovery).toBe(false)

    auth.emit({ id: 'u1', email: 'me@example.com' }, 'password_recovery')
    expect(store.getState()).toMatchObject({ status: 'signed_in', passwordRecovery: true })
    expect(workspace.actions.load).toHaveBeenCalledOnce()
    auth.emit({ id: 'u1', email: 'me@example.com' }, 'token_refreshed')
    expect(store.getState().passwordRecovery).toBe(true)

    const { actions } = store.getState()
    expect(await actions.updatePassword('')).toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    })
    expect(auth.service.updatePassword).not.toHaveBeenCalled()

    vi.mocked(auth.service.updatePassword).mockRejectedValueOnce(
      new RepositoryError('validation', 'Password should be at least 6 characters.'),
    )
    expect(await actions.updatePassword('short')).toMatchObject({
      ok: false,
      error: { message: 'Password should be at least 6 characters.' },
    })
    expect(store.getState().passwordRecovery).toBe(true) // still asking

    expect(await actions.updatePassword('a-much-better-one')).toEqual({
      ok: true,
      value: undefined,
    })
    expect(auth.service.updatePassword).toHaveBeenLastCalledWith('a-much-better-one')
    expect(store.getState().passwordRecovery).toBe(false)
  })

  it('can be dismissed, and sign-out ends it', async () => {
    const auth = controllableService()
    const store = createAuthStore({
      mode: 'supabase',
      auth: auth.service,
      workspace: fakeWorkspace().store,
    })
    await store.getState().actions.init()
    auth.emit({ id: 'u1', email: 'me@example.com' }, 'password_recovery')
    store.getState().actions.dismissPasswordRecovery()
    expect(store.getState().passwordRecovery).toBe(false)
    auth.emit({ id: 'u1', email: 'me@example.com' }, 'password_recovery')
    auth.emit(null, 'signed_out')
    expect(store.getState()).toMatchObject({ status: 'signed_out', passwordRecovery: false })
  })

  it('local mode never asks and updatePassword is a no-op', async () => {
    const store = createAuthStore({
      mode: 'local',
      auth: createLocalAuthService(),
      workspace: fakeWorkspace().store,
    })
    await store.getState().actions.init()
    expect(store.getState().passwordRecovery).toBe(false)
    expect(await store.getState().actions.updatePassword('anything')).toEqual({
      ok: true,
      value: undefined,
    })
  })
})

describe('session transitions', () => {
  function realWorkspace() {
    const storage = createMemoryStorage()
    const repo = new LocalRepository({ storage })
    const store = createWorkspaceStore({
      mode: 'supabase',
      repository: repo,
      notify: { error: vi.fn(), dismiss: vi.fn() },
      storage: null,
      randomId: () => crypto.randomUUID(),
    })
    return { store, repo }
  }

  it('re-checks the session when the server rejects it, and signs out when it is gone', async () => {
    const { store: workspace, repo } = realWorkspace()
    const auth = controllableService({ id: 'u1', email: 'me@example.com' })
    const store = createAuthStore({ mode: 'supabase', auth: auth.service, workspace })
    await store.getState().actions.init()
    await vi.waitFor(() => expect(workspace.getState().status).toBe('ready'))
    await repo.insertProject(makeProject({ id: 'p1' }))
    await workspace.getState().actions.refresh()

    auth.expireSilently() // revoked elsewhere; no auth event has arrived here
    vi.spyOn(repo, 'updateProject').mockRejectedValueOnce(
      new RepositoryError('auth', 'Your session has expired. Sign in again.'),
    )
    const calls = vi.mocked(auth.service.getUser).mock.calls.length
    await workspace.getState().actions.updateProject('p1', { name: 'Renamed' })
    await vi.waitFor(() => expect(store.getState().status).toBe('signed_out'))
    expect(vi.mocked(auth.service.getUser).mock.calls.length).toBe(calls + 1)
    expect(workspace.getState().data.projects).toEqual({})
  })

  it('sign-out waits for pending writes, so the last change is saved', async () => {
    const { store: workspace, repo } = realWorkspace()
    const auth = controllableService({ id: 'u1', email: 'me@example.com' })
    const store = createAuthStore({ mode: 'supabase', auth: auth.service, workspace })
    await store.getState().actions.init()
    await vi.waitFor(() => expect(workspace.getState().status).toBe('ready'))
    await repo.insertProject(makeProject({ id: 'p1' }))
    await repo.insertTask(makeTask({ id: 't1', projectId: 'p1' }))
    await workspace.getState().actions.refresh()

    repo.setLatency(30)
    // the first write is in flight, the second still queued behind it
    void workspace.getState().actions.updateTask('t1', { title: 'Last edit' })
    void workspace.getState().actions.updateTask('t1', { priority: 'high' })
    expect(await store.getState().actions.signOut()).toEqual({ ok: true, value: undefined })
    repo.setLatency(0)
    expect((await repo.loadWorkspace()).tasks[0]).toMatchObject({
      title: 'Last edit',
      priority: 'high',
    })
    expect(auth.service.signOut).toHaveBeenCalledOnce()
    expect(store.getState().status).toBe('signed_out')
    expect(workspace.getState().data.tasks).toEqual({})
  })

  it('stops listening once its signal is aborted (hot reload)', async () => {
    const controller = new AbortController()
    const workspace = fakeWorkspace()
    const auth = controllableService()
    const store = createAuthStore({
      mode: 'supabase',
      auth: auth.service,
      workspace: workspace.store,
      signal: controller.signal,
    })
    await store.getState().actions.init()
    controller.abort()
    expect(auth.unsubscribe).toHaveBeenCalledOnce()
  })
})
