import { afterEach, describe, expect, it } from 'vitest'
import {
  EXPIRED_LINK_MESSAGE,
  FAILED_LINK_MESSAGE,
  authRedirectErrorMessage,
  captureAuthRedirectError,
  clearAuthRedirectError,
  peekAuthRedirectError,
} from './authRedirectError'

afterEach(() => clearAuthRedirectError())

describe('auth redirect errors (expired / used email links)', () => {
  it('recognises Supabase’s expired-link redirect in the hash (implicit flow)', () => {
    expect(
      authRedirectErrorMessage(
        'https://cairn.example/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
      ),
    ).toBe(EXPIRED_LINK_MESSAGE)
  })

  it('reads the query string too (PKCE flow)', () => {
    expect(
      authRedirectErrorMessage(
        'https://cairn.example/?error=access_denied&error_code=flow_state_expired&error_description=x',
      ),
    ).toBe(EXPIRED_LINK_MESSAGE)
  })

  it('never shows the text from the URL (anyone can craft such a link)', () => {
    const crafted =
      'https://cairn.example/#error=server_error&error_description=Your+account+is+locked.+Call+us'
    expect(authRedirectErrorMessage(crafted)).toBe(FAILED_LINK_MESSAGE)
    expect(FAILED_LINK_MESSAGE).not.toContain('locked')
  })

  it('ignores ordinary URLs, a bare ?error= and malformed input', () => {
    expect(authRedirectErrorMessage('https://cairn.example/overview?task=t1#top')).toBeNull()
    expect(authRedirectErrorMessage('https://cairn.example/?error=1')).toBeNull()
    expect(authRedirectErrorMessage('not a url')).toBeNull()
  })

  it('is captured once at startup and forgotten after it was shown', () => {
    captureAuthRedirectError('https://cairn.example/#error_code=otp_expired&error_description=x')
    expect(peekAuthRedirectError()).toBe(EXPIRED_LINK_MESSAGE)
    clearAuthRedirectError()
    expect(peekAuthRedirectError()).toBeNull()
    captureAuthRedirectError('https://cairn.example/overview')
    expect(peekAuthRedirectError()).toBeNull()
  })
})
