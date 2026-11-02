/**
 * Input validation shared by forms, the store (before optimistic writes), the local
 * repository, and backup import. Uses zod v4.
 */
import type { AppError, BackupFile, ISODate, Result } from './types'
import { notImplemented } from './_todo'

/** Trimmed, 1..max chars. Returns a validation AppError or null. */
export function validateName(value: string, max: number, label: string): AppError | null {
  return notImplemented('validateName' + value + max + label)
}
/** Both optional; when both set, due >= start. Also checks ISO format. */
export function validateDateRange(
  start: ISODate | null | undefined,
  due: ISODate | null | undefined,
): AppError | null {
  return notImplemented('validateDateRange' + start + due)
}
export function validateDescription(value: string | null | undefined): AppError | null {
  return notImplemented('validateDescription' + value)
}
/**
 * Parses and validates an exported backup (JSON already parsed). Checks app/formatVersion,
 * every entity's shape, referential integrity inside the file (tasks → projects/phases/parents,
 * dependencies → tasks in the same project, one-level subtasks) and returns a typed BackupFile.
 */
export function parseBackupFile(input: unknown): Result<BackupFile> {
  return notImplemented('parseBackupFile' + typeof input)
}
