import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router'
import { MailCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { useAuth } from '@/data/hooks'
import { AppSplash } from './AppSplash'
import { AuthLayout, FormAlert } from './AuthLayout'
import type { LoginRedirectState } from './AuthGate'
import { safeReturnPath } from './loginRedirect'
import { MIN_PASSWORD_LENGTH } from './passwordRules'

type FormMode = 'sign-in' | 'sign-up'

interface Notice {
  title: string
  body: string
}

/** `field` = the input the message is about (null = the whole form, e.g. a server error). */
interface FormError {
  field: 'email' | 'password' | null
  message: string
}

function NoticePanel({ notice, onBack }: { notice: Notice; onBack: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  // The form that had focus is gone: move focus to the message so it is read and Tab continues.
  useEffect(() => headingRef.current?.focus(), [])
  return (
    <div className="flex flex-col items-center text-center" role="status">
      <MailCheck className="size-6 text-accent-text" strokeWidth={1.5} aria-hidden />
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="mt-3 rounded-sm text-heading font-semibold text-fg focus:outline-none"
      >
        {notice.title}
      </h2>
      <p className="mt-1 text-ui text-fg-secondary">{notice.body}</p>
      <Button variant="secondary" size="md" className="mt-5 w-full" onClick={onBack}>
        Back to sign in
      </Button>
    </div>
  )
}

function CredentialsForm() {
  const { actions } = useAuth()
  const ids = useId()
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<FormMode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState<'submit' | 'reset' | null>(null)
  const [error, setError] = useState<FormError | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const switchMode = (next: FormMode) => {
    setMode(next)
    setError(null)
  }

  const fail = (next: FormError) => {
    setError(next)
    if (next.field === 'email') emailRef.current?.focus()
    if (next.field === 'password') passwordRef.current?.focus()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const trimmed = email.trim()
    if (!/^\S+@\S+$/.test(trimmed)) {
      fail({ field: 'email', message: 'Enter a valid email address.' })
      return
    }
    if (!password) {
      fail({ field: 'password', message: 'Enter your password.' })
      return
    }
    if (mode === 'sign-up' && password.length < MIN_PASSWORD_LENGTH) {
      fail({
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
      fail({
        field: 'email',
        message: 'Enter your email address first, then choose “Forgot password?”.',
      })
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
      <NoticePanel
        notice={notice}
        onBack={() => {
          setNotice(null)
          switchMode('sign-in')
        }}
      />
    )
  }

  const emailId = `${ids}-email`
  const passwordId = `${ids}-password`
  const hintId = `${ids}-password-hint`
  const errorId = `${ids}-error`
  // Each field is described only by the messages that concern it.
  const describe = (field: 'email' | 'password', hint?: string) =>
    [hint, error && (error.field === field || error.field === null) ? errorId : undefined]
      .filter(Boolean)
      .join(' ') || undefined

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
            aria-describedby={describe('email')}
            placeholder="you@example.com"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={passwordId}>Password</Label>
          <PasswordInput
            ref={passwordRef}
            id={passwordId}
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={error?.field === 'password' || undefined}
            aria-describedby={describe('password', mode === 'sign-up' ? hintId : undefined)}
          />
          {mode === 'sign-up' ? (
            <p id={hintId} className="text-meta text-fg-tertiary">
              At least {MIN_PASSWORD_LENGTH} characters.
            </p>
          ) : (
            <button
              type="button"
              onClick={sendReset}
              disabled={pending !== null}
              className="self-end rounded-sm text-meta text-fg-tertiary transition-colors duration-fast hover:text-fg hover:duration-instant disabled:opacity-50"
            >
              {pending === 'reset' ? 'Sending…' : 'Forgot password?'}
            </button>
          )}
        </div>
        {error ? <FormAlert id={errorId}>{error.message}</FormAlert> : null}
        <Button
          type="submit"
          variant="primary"
          size="md"
          loading={pending === 'submit'}
          className="w-full"
        >
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
  if (status === 'signed_in') return <Navigate to={safeReturnPath(from)} replace />
  if (status === 'loading') return <AppSplash />

  return (
    <AuthLayout title="Welcome to Cairn" subtitle="Plan clearly. Work simply.">
      <CredentialsForm />
    </AuthLayout>
  )
}
