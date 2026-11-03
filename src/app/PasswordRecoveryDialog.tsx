import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { confirm as askToConfirm } from '@/components/ui/confirm'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { useAuth } from '@/data/hooks'
import type { Result } from '@/domain/types'
import { notify } from '@/lib/notify'
import { FormAlert } from './AuthLayout'
import { MIN_PASSWORD_LENGTH, validateNewPassword, type NewPasswordErrors } from './passwordRules'

export interface SetNewPasswordFormStatus {
  /** Something was typed in either field. */
  dirty: boolean
  /** A save is waiting for the server's answer. */
  saving: boolean
}

export interface SetNewPasswordFormProps {
  /** Saves the password; resolves with the store's Result (never throws). */
  onSubmit: (password: string) => Promise<Result>
  /** Called after a successful save. */
  onSuccess?: () => void
  /** "Not now": leave without changing the password. */
  onCancel: () => void
  /** Reports dirty / saving changes (the dialog uses it to guard Esc). */
  onStatusChange?: (status: SetNewPasswordFormStatus) => void
}

/**
 * New password + confirmation (min 8 characters) with show/hide toggles. Errors appear inline
 * on submit (then update live); a server error shows in an alert and success is reported only
 * after the save resolved OK. Focus moves to the first invalid field. Renders the dialog body
 * and footer, so it lives inside a DialogContent.
 */
export function SetNewPasswordForm({
  onSubmit,
  onSuccess,
  onCancel,
  onStatusChange,
}: SetNewPasswordFormProps) {
  const ids = useId()
  const passwordRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const dirty = password !== '' || confirm !== ''

  const onStatusChangeRef = useRef(onStatusChange)
  useLayoutEffect(() => {
    onStatusChangeRef.current = onStatusChange
  })
  useLayoutEffect(() => {
    onStatusChangeRef.current?.({ dirty, saving })
  }, [dirty, saving])

  const errors: NewPasswordErrors = attempted ? validateNewPassword(password, confirm) : {}

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    setAttempted(true)
    setServerError(null)
    const problems = validateNewPassword(password, confirm)
    if (problems.password || problems.confirm) {
      ;(problems.password ? passwordRef : confirmRef).current?.focus()
      return
    }
    setSaving(true)
    const result = await onSubmit(password)
    setSaving(false)
    if (!result.ok) {
      setServerError(result.error.message)
      passwordRef.current?.focus()
      return
    }
    onSuccess?.()
  }

  const passwordId = `${ids}-password`
  const confirmId = `${ids}-confirm`
  const hintId = `${ids}-hint`
  const passwordErrorId = `${ids}-password-error`
  const confirmErrorId = `${ids}-confirm-error`
  const serverErrorId = `${ids}-server-error`

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
      <DialogBody className="flex flex-col gap-4 pt-1 pb-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={passwordId}>New password</Label>
          <PasswordInput
            ref={passwordRef}
            id={passwordId}
            autoComplete="new-password"
            autoFocus
            revealLabel="new password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={
              [errors.password ? passwordErrorId : hintId, serverError ? serverErrorId : '']
                .filter(Boolean)
                .join(' ') || undefined
            }
          />
          {errors.password ? (
            <p id={passwordErrorId} className="text-meta text-danger">
              {errors.password}
            </p>
          ) : (
            <p id={hintId} className="text-meta text-fg-tertiary">
              At least {MIN_PASSWORD_LENGTH} characters.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={confirmId}>Confirm new password</Label>
          <PasswordInput
            ref={confirmRef}
            id={confirmId}
            autoComplete="new-password"
            revealLabel="password confirmation"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            aria-invalid={errors.confirm ? true : undefined}
            aria-describedby={errors.confirm ? confirmErrorId : undefined}
          />
          {errors.confirm ? (
            <p id={confirmErrorId} className="text-meta text-danger">
              {errors.confirm}
            </p>
          ) : null}
        </div>
        {serverError ? <FormAlert id={serverErrorId}>{serverError}</FormAlert> : null}
      </DialogBody>
      <DialogFooter>
        <Button size="md" onClick={onCancel} disabled={saving}>
          Not now
        </Button>
        <Button type="submit" variant="primary" size="md" loading={saving}>
          Update password
        </Button>
      </DialogFooter>
    </form>
  )
}

/**
 * Shown over the app after the user opened a password-reset link (Supabase mode: they are
 * signed in and `passwordRecovery` is true). A click outside never dismisses it — only
 * "Not now" or Esc (an explicit choice) does. Esc asks first once something was typed, and
 * waits while a save is running (so a failure is never hidden); a successful update closes it
 * with a toast.
 */
export function PasswordRecoveryDialog() {
  const { user, passwordRecovery, actions } = useAuth()
  const statusRef = useRef<SetNewPasswordFormStatus>({ dirty: false, saving: false })

  const confirmDiscard = async () => {
    const discard = await askToConfirm({
      title: 'Discard the new password?',
      description:
        'Your password stays as it is. You can request another reset link from the sign-in page.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      destructive: true,
    })
    if (discard) actions.dismissPasswordRecovery()
  }

  return (
    <Dialog
      open={passwordRecovery === true}
      onOpenChange={(open) => {
        if (!open) actions.dismissPasswordRecovery()
      }}
    >
      <DialogContent
        size="sm"
        position="top"
        showClose={false}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          const { dirty, saving } = statusRef.current
          if (!dirty && !saving) return // nothing typed: Esc is "Not now"
          event.preventDefault()
          if (!saving) void confirmDiscard()
        }}
      >
        <DialogHeader className="pr-5">
          <DialogTitle>Set a new password</DialogTitle>
          <DialogDescription>
            {user?.email
              ? `Choose a new password for ${user.email}.`
              : 'Choose a new password for your account.'}
          </DialogDescription>
        </DialogHeader>
        <SetNewPasswordForm
          onSubmit={(password) => actions.updatePassword(password)}
          onSuccess={() =>
            notify.success('Password updated', {
              description: 'Use your new password the next time you sign in.',
            })
          }
          onCancel={() => actions.dismissPasswordRecovery()}
          onStatusChange={(status) => {
            statusRef.current = status
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
