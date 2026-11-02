import type { AppError, AppErrorKind } from '@/domain/types'

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

/** Normalises anything thrown into an AppError with a user-safe message. */
export function toAppError(error: unknown): AppError {
  if (error instanceof RepositoryError) {
    return { kind: error.kind, message: error.message, cause: error.cause }
  }
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return { kind: 'network', message: 'Network error — check your connection.', cause: error }
  }
  return { kind: 'unknown', message: 'Something went wrong.', cause: error }
}
