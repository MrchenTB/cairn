import type { AppError, AppErrorKind } from '@/domain/types'

/** User-facing message for failed requests (no connection, DNS, timeout, CORS…). */
export const NETWORK_ERROR_MESSAGE = 'Network error — check your connection.'
export const UNKNOWN_ERROR_MESSAGE = 'Something went wrong.'

/** Error thrown by Repository/AuthService implementations. */
export class RepositoryError extends Error implements AppError {
  readonly kind: AppErrorKind
  override readonly cause?: unknown

  constructor(kind: AppErrorKind, message: string, cause?: unknown) {
    super(message)
    this.name = 'RepositoryError'
    this.kind = kind
    this.cause = cause
  }
}

/** True for errors thrown by `fetch` itself (offline, DNS, CORS, aborted/timed-out request). */
export function isFetchFailure(error: unknown): boolean {
  if (error instanceof TypeError) return /fetch|network|load failed/i.test(error.message)
  if (error instanceof Error) return error.name === 'AbortError' || error.name === 'TimeoutError'
  return false
}

/** Normalises anything thrown into an AppError with a user-safe message. */
export function toAppError(error: unknown): AppError {
  if (error instanceof RepositoryError) {
    return { kind: error.kind, message: error.message, cause: error.cause }
  }
  if (isFetchFailure(error)) {
    return { kind: 'network', message: NETWORK_ERROR_MESSAGE, cause: error }
  }
  return { kind: 'unknown', message: UNKNOWN_ERROR_MESSAGE, cause: error }
}

/** Failures that may succeed when the same write is sent again. */
export function isRetryable(error: AppError): boolean {
  return error.kind === 'network' || error.kind === 'unknown'
}

/**
 * Returns `message` as a sentence when it reads like prose meant for people (our trigger and
 * RPC messages), or null for technical database text (constraint names, SQL, JSON…).
 */
export function readableServerMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null
  const text = message.trim()
  if (text === '' || text.length > 200) return null
  if (
    /violates|constraint|relation|column|syntax|operator|function|duplicate key|null value|invalid input|out of range|jsonb?\b|uuid|PGRST|SQL|JWT|permission denied|TypeError|fetch|unicode|escape sequence|byte sequence|encoding/i.test(
      text,
    )
  ) {
    return null
  }
  const sentence = text.charAt(0).toUpperCase() + text.slice(1)
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}
