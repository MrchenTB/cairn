/** Client-side password rules shared by sign-up and "Set a new password". */

export const MIN_PASSWORD_LENGTH = 8

export interface NewPasswordErrors {
  password?: string
  confirm?: string
}

/**
 * Validates a new password and its confirmation. Returns an empty object when both are fine.
 * The server may still reject a password (e.g. too weak, same as before); show that message too.
 */
export function validateNewPassword(password: string, confirm: string): NewPasswordErrors {
  const errors: NewPasswordErrors = {}
  if (!password) errors.password = 'Enter a new password.'
  else if (password.length < MIN_PASSWORD_LENGTH)
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  if (!confirm) errors.confirm = 'Enter the new password again.'
  else if (password && confirm !== password) errors.confirm = 'The passwords don’t match.'
  return errors
}
