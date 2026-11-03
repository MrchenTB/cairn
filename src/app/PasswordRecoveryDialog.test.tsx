import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmHost } from '@/components/ui/confirm'
import type { AuthState } from '@/data/contracts'
import { useAuthStore } from '@/data/store'
import type { Result } from '@/domain/types'
import { notify } from '@/lib/notify'
import { renderUI } from '@/test/render'
import { validateNewPassword } from './passwordRules'
import { PasswordRecoveryDialog, SetNewPasswordForm } from './PasswordRecoveryDialog'

const OK: Result = { ok: true, value: undefined }
const initial = useAuthStore.getState()

afterEach(() => {
  useAuthStore.setState(initial, true)
})

describe('validateNewPassword', () => {
  it('requires 8+ characters and a matching confirmation', () => {
    expect(validateNewPassword('', '')).toEqual({
      password: 'Enter a new password.',
      confirm: 'Enter the new password again.',
    })
    expect(validateNewPassword('short', 'short').password).toBe('Use at least 8 characters.')
    expect(validateNewPassword('long enough', 'long enougH').confirm).toBe(
      'The passwords don’t match.',
    )
    expect(validateNewPassword('long enough', 'long enough')).toEqual({})
  })
})

describe('SetNewPasswordForm', () => {
  function setup(onSubmit = vi.fn(async (_password: string): Promise<Result> => OK)) {
    const onSuccess = vi.fn()
    const onCancel = vi.fn()
    const view = renderUI(
      <SetNewPasswordForm onSubmit={onSubmit} onSuccess={onSuccess} onCancel={onCancel} />,
    )
    return {
      ...view,
      onSubmit,
      onSuccess,
      onCancel,
      password: screen.getByLabelText('New password'),
      confirm: screen.getByLabelText('Confirm new password'),
      submit: screen.getByRole('button', { name: 'Update password' }),
    }
  }

  it('focuses the new password and links the length hint', () => {
    const { password } = setup()
    expect(password).toHaveFocus()
    expect(password).toHaveAccessibleDescription('At least 8 characters.')
  })

  it('shows inline errors on submit, focuses the first invalid field, then validates live', async () => {
    const { user, password, confirm, submit, onSubmit } = setup()
    await user.click(submit)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(password).toHaveAttribute('aria-invalid', 'true')
    expect(password).toHaveAccessibleDescription('Enter a new password.')
    expect(confirm).toHaveAccessibleDescription('Enter the new password again.')
    expect(password).toHaveFocus()

    await user.type(password, 'sunrise-42')
    expect(password).not.toHaveAttribute('aria-invalid')
    expect(password).toHaveAccessibleDescription('At least 8 characters.')
    await user.type(confirm, 'sunrise-24')
    await user.click(submit)
    expect(confirm).toHaveAttribute('aria-invalid', 'true')
    expect(confirm).toHaveAccessibleDescription('The passwords don’t match.')
    expect(confirm).toHaveFocus()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('saves a valid password and only then reports success', async () => {
    const { user, password, confirm, onSubmit, onSuccess } = setup()
    await user.type(password, 'sunrise-42')
    await user.type(confirm, 'sunrise-42{Enter}')
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith('sunrise-42')
  })

  it('shows the server message and never reports success when saving fails', async () => {
    const failing = vi.fn(async (): Promise<Result> => ({
      ok: false,
      error: { kind: 'validation', message: 'Choose a password different from the current one.' },
    }))
    const { user, password, confirm, submit, onSuccess } = setup(failing)
    await user.type(password, 'sunrise-42')
    await user.type(confirm, 'sunrise-42')
    await user.click(submit)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose a password different from the current one.',
    )
    expect(onSuccess).not.toHaveBeenCalled()
    expect(password).toHaveFocus()
    expect(password).toHaveAccessibleDescription(
      'At least 8 characters. Choose a password different from the current one.',
    )
  })

  it('reveals each password with its own toggle (aria-pressed, stable names)', async () => {
    const { user, password, confirm } = setup()
    const toggle = screen.getByRole('button', { name: 'Show new password' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(password).toHaveAttribute('type', 'text')
    expect(confirm).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: 'Show password confirmation' }))
    expect(confirm).toHaveAttribute('type', 'text')
  })
})

describe('PasswordRecoveryDialog', () => {
  let actions: Pick<AuthState['actions'], 'updatePassword' | 'dismissPasswordRecovery'>

  beforeEach(() => {
    actions = {
      updatePassword: vi.fn(async (): Promise<Result> => {
        useAuthStore.setState({ passwordRecovery: false }) // what the store does on success
        return OK
      }),
      dismissPasswordRecovery: vi.fn(() => useAuthStore.setState({ passwordRecovery: false })),
    }
    useAuthStore.setState({
      mode: 'supabase',
      status: 'signed_in',
      user: { id: 'u1', email: 'me@example.com' },
      passwordRecovery: true,
      actions: { ...initial.actions, ...actions },
    })
  })

  it('stays closed unless the user arrived through a reset link', () => {
    useAuthStore.setState({ passwordRecovery: false })
    renderUI(<PasswordRecoveryDialog />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('asks for a new password, saves it, toasts and closes', async () => {
    const success = vi.spyOn(notify, 'success').mockImplementation(() => 1)
    const { user } = renderUI(<PasswordRecoveryDialog />)
    const dialog = screen.getByRole('dialog', { name: 'Set a new password' })
    expect(dialog).toHaveAccessibleDescription('Choose a new password for me@example.com.')
    expect(screen.getByLabelText('New password')).toHaveFocus()
    await user.type(screen.getByLabelText('New password'), 'sunrise-42')
    await user.type(screen.getByLabelText('Confirm new password'), 'sunrise-42{Enter}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(actions.updatePassword).toHaveBeenCalledWith('sunrise-42')
    expect(success).toHaveBeenCalledWith('Password updated', expect.any(Object))
    success.mockRestore()
  })

  it('"Not now" and Esc dismiss explicitly; a click outside does not', async () => {
    const { user } = renderUI(<PasswordRecoveryDialog />)
    fireEvent.pointerDown(document.body)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(actions.dismissPasswordRecovery).not.toHaveBeenCalled()

    await user.keyboard('{Escape}')
    expect(actions.dismissPasswordRecovery).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    act(() => useAuthStore.setState({ passwordRecovery: true }))
    await user.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(actions.dismissPasswordRecovery).toHaveBeenCalledTimes(2)
  })

  it('asks before Esc discards a typed password', async () => {
    const { user } = renderUI(
      <>
        <PasswordRecoveryDialog />
        <ConfirmHost />
      </>,
    )
    await user.type(screen.getByLabelText('New password'), 'sunrise')
    await user.keyboard('{Escape}')
    const ask = await screen.findByRole('alertdialog', { name: 'Discard the new password?' })
    expect(actions.dismissPasswordRecovery).not.toHaveBeenCalled()

    await user.click(within(ask).getByRole('button', { name: 'Keep editing' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: 'Set a new password' })).toBeInTheDocument()
    expect(screen.getByLabelText('New password')).toHaveValue('sunrise')
    await waitFor(() => expect(screen.getByLabelText('New password')).toHaveFocus())

    await user.keyboard('{Escape}')
    await user.click(await screen.findByRole('button', { name: 'Discard' }))
    expect(actions.dismissPasswordRecovery).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('ignores Esc while the new password is being saved', async () => {
    let finish: (result: Result) => void = () => {}
    vi.mocked(actions.updatePassword).mockImplementationOnce(
      () => new Promise<Result>((resolve) => (finish = resolve)),
    )
    const { user } = renderUI(
      <>
        <PasswordRecoveryDialog />
        <ConfirmHost />
      </>,
    )
    await user.type(screen.getByLabelText('New password'), 'sunrise-42')
    await user.type(screen.getByLabelText('Confirm new password'), 'sunrise-42{Enter}')
    expect(screen.getByRole('button', { name: 'Update password' })).toHaveAttribute('aria-busy')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Set a new password' })).toBeInTheDocument()
    expect(actions.dismissPasswordRecovery).not.toHaveBeenCalled()

    await act(async () =>
      finish({ ok: false, error: { kind: 'network', message: 'You appear to be offline.' } }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('You appear to be offline.')
  })
})
