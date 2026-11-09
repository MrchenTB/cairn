import type { DataMode, SyncState } from '@/data/contracts'

export type SyncKind = 'local' | 'saving' | 'saved' | 'offline' | 'failed' | 'stale'

export interface SyncStatus {
  kind: SyncKind
  /** Short sidebar label. */
  label: string
  /** Popover heading. */
  title: string
  /** Popover explanation. */
  detail: string
  /** A failed write can be re-run with actions.retryLastFailed(). */
  canRetry: boolean
}

/**
 * Maps the store's sync state to what the sidebar shows. Priority: saving → failed write →
 * offline (cloud only) → local mode → saved. Local mode is always labelled "Local only — not
 * synced" so it is never mistaken for cloud sync.
 */
export function deriveSyncStatus(mode: DataMode, sync: SyncState): SyncStatus {
  if (sync.pending > 0) {
    return {
      kind: 'saving',
      label: 'Saving…',
      title: 'Saving changes…',
      detail:
        mode === 'local'
          ? 'Writing your latest changes to this browser.'
          : 'Sending your latest changes to the cloud.',
      canRetry: false,
    }
  }
  // A failed write waiting for Retry is never covered by "Saved", whatever else is known.
  if (sync.canRetry) {
    const reason = sync.lastError ? `${sync.lastError.message} ` : ''
    return {
      kind: 'failed',
      label: "Couldn't save",
      title: "Couldn't save your last change",
      detail: `${reason}The change was undone on screen; retry to apply it again.`,
      canRetry: true,
    }
  }
  if (mode === 'supabase' && !sync.online) {
    return {
      kind: 'offline',
      label: 'Offline',
      title: "You're offline",
      detail:
        "Changes can't be saved until the connection is back. Anything that fails can be retried.",
      canRetry: false,
    }
  }
  if (mode === 'local') {
    return {
      kind: 'local',
      label: 'Local only — not synced',
      title: 'Stored in this browser only',
      detail:
        'Your data is stored in this browser only. It is not backed up or available on other devices. Export a backup from Settings → Data.',
      canRetry: false,
    }
  }
  if (sync.lastError) {
    return {
      kind: 'stale',
      label: "Couldn't sync",
      title: "Couldn't refresh from the cloud",
      detail: `${sync.lastError.message} Your saved data is safe; Cairn will try again automatically.`,
      canRetry: false,
    }
  }
  return {
    kind: 'saved',
    label: 'Saved',
    title: 'All changes saved',
    detail: 'Everything is synced to the cloud and available on your other devices.',
    canRetry: false,
  }
}
