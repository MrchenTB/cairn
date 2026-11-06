/**
 * When a JSON backup was last exported FROM THIS BROWSER (device-only memory, never synced), so
 * Settings can remind the user that the Supabase Free plan keeps no backups for them.
 */
import { readJSON, writeJSON } from '@/lib/storage'

const KEY = 'cairn:last-backup'

export function readLastBackupAt(): number | null {
  const value = readJSON(KEY)
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function writeLastBackupAt(epochMs: number): void {
  writeJSON(KEY, epochMs)
}
