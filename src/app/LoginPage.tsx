import { useId, useRef, useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router'
import { Eye, EyeOff, MailCheck, TriangleAlert } from 'lucide-react'
import { LogoMark } from '@/components/brand/Logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/data/hooks'
import { cn } from '@/lib/utils'
import { AppSplash } from './AppSplash'
import type { LoginRedirectState } from './AuthGate'

type FormMode = 'sign-in' | 'sign-up'

const MIN_PASSWORD_LENGTH = 8

/** Only same-app paths are accepted as a post-login destination. */
function safeTarget(from: string | undefined): string {
  if (!from || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/login')) {
    return '/overview'
  }
  return from
}

interface Notice {
  title: string
  body: string
}

function CredentialsForm() {
  const { actions } = useAuth()
  const ids = useId()
  const emailRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<FormMode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [pending, setPending] = useState<'submit' | 'reset' | null>(null)
  const [error, setError] = useState<{ field: 'email' | 'password' | null; message: string } | null>(
    null,
  )
  const [notice, setNotice] = useState<Notice | null>(null)

  const switchMode = (next: FormMode) => {
    setMode(next)
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const trimmed = email.trim()
    if (!/^\S+@\S+$/.test(trimmed)) {
      setError({ field: 'email', message: 'Enter a valid email address.' })
      return
    }
    if (!password) {
      setError({ field: 'password', message: 'Enter your password.' })
      return
    }
    if (mode === 'sign-up' && password.length < MIN_PASSWORD_LENGTH) {
      setError({
        field: 'password',
        message: `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`,
      })
      return
    }
    setPending('submit')
    if (mode === 'sign-in') {
      const result = await actions.signIn(trimmed, password)
      setPending(null)
      // On success the auth status flips to signed_in and the page redirects.
      if (!result.ok) setError({ field: null, message: result.error.message })
      return
    }
    const result = await actions.signUp(trimmed, password)
    setPending(null)
    if (!result.ok) {
      setError({ field: null, message: result.error.message })
    } else if (result.value.needsConfirmation) {
      setPassword('')
      setNotice({
        title: 'Confirm your email',
        body: `We sent a confirmation link to ${trimmed}. Open it, then come back here and sign in.`,
      })
    }
  }

  const sendReset = async () => {
    setError(null)
    const trimmed = email.trim()
    if (!/^\S+@\S+$/.test(trimmed)) {
      setError({ field: 'email', message: 'Enter your email address first, then choose “Forgot password?”.' })
      emailRef.current?.focus()
      return
    }
    setPending('reset')
    const result = await actions.sendPasswordReset(trimmed)
    setPending(null)
    if (!result.ok) {
      setError({ field: null, message: result.error.message })
      return
    }
    setNotice({
      title: 'Check your email',
      body: `If an account exists for ${trimmed}, you’ll receive a link to reset your password.`,
    })
  }

  if (notice) {
    return (
      <div className="flex flex-col items-center text-center" role="status">
        <MailCheck className="size-6 text-accent-text" strokeWidth={1.5} aria-hidden />
        <h2 className="mt-3 text-heading font-semibold text-fg">{notice.title}</h2>
        <p className="mt-1 text-ui text-fg-secondary">{notice.body}</p>
        <Button
          variant="secondary"
          size="md"
          className="mt-5 w-full"
          onClick={() => {
            setNotice(null)
            switchMode('sign-in')
          }}
        >
          Back to sign in
        </Button>
      </div>
    )
  }

  const emailId = `${ids}-email`
  const passwordId = `${ids}-password`
  const errorId = `${ids}-error`

  return (
    <>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={emailId}>Email</Label>
          <Input
            ref={emailRef}
            id={emailId}
            type="email"
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={error?.field === 'email' || undefined}
            aria-describedby={error ? errorId : undefined}
            placeholder="you@example.com"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={passwordId}>Password</Label>
          <div className="relative">
            <Input
              id={passwordId}
              type={showPassword ? 'text' : 'password'}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={error?.field === 'password' || undefined}
              aria-describedby={error ? errorId : undefined}
              className="pr-9"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-1 right-1"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((shown) => !shown)}
            >
              {showPassword ? <EyeOff /> : <Eye />}
            </Button>
          </div>
          {mode === 'sign-up' ? (
            <p className="text-meta text-fg-tertiary">At least {MIN_PASSWORD_LENGTH} characters.</p>
          ) : (
            <button
              type="button"
              onClick={sendReset}
              disabled={pending !== null}
              className="self-end rounded-sm text-meta text-fg-tertiary transition-colors duration-fast hover:text-fg disabled:opacity-50"
            >
              {pending === 'reset' ? 'Sending…' : 'Forgot password?'}
            </button>
          )}
        </div>
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="flex items-start gap-2 rounded-md bg-danger-subtle px-2.5 py-2 text-ui text-danger"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{error.message}</span>
          </p>
        ) : null}
        <Button type="submit" variant="primary" size="md" loading={pending === 'submit'} className="w-full">
          {mode === 'sign-in' ? 'Sign in' : 'Create account'}
        </Button>
      </form>
      <p className="mt-5 text-center text-ui text-fg-secondary">
        {mode === 'sign-in' ? 'New to Cairn?' : 'Already have an account?'}{' '}
        <button
          type="button"
          onClick={() => switchMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}
          className="rounded-sm font-medium text-accent-text hover:underline"
        >
          {mode === 'sign-in' ? 'Create an account' : 'Sign in'}
        </button>
      </p>
    </>
  )
}

/**
 * /login — Supabase email + password. Local mode has no accounts and redirects to /overview;
 * a signed-in user goes back to the page they originally asked for.
 */
export function LoginPage() {
  const { mode, status } = useAuth()
  const location = useLocation()
  const from = (location.state as LoginRedirectState | null)?.from

  if (mode === 'local') return <Navigate to="/overview" replace />
  if (status === 'signed_in') return <Navigate to={safeTarget(from)} replace />
  if (status === 'loading') return <AppSplash />

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-app px-4 py-12">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <LogoMark tone="brand" size={40} title="Cairn" />
          <h1 className="mt-4 text-title font-semibold tracking-(--letter-spacing-title) text-fg">
            Welcome to Cairn
          </h1>
          <p className="mt-1 text-ui text-fg-secondary">Plan clearly. Work simply.</p>
        </div>
        <div className={cn('rounded-xl border border-subtle bg-main p-6 shadow-panel')}>
          <CredentialsForm />
        </div>
      </div>
    </main>
  )
}
