/**
 * Settings → Data: where changes are saved and whether anything is waiting or failed.
 * Everything shown is the store's real sync state; "Sync now" re-reads the workspace and Retry
 * re-runs the failed writes.
 */
import { useEffect, useRef, useState } from 'react'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { deriveSyncStatus, type SyncKind } from '@/app/shell/syncStatus'
import { useActions, useDataMode, useSyncState } from '@/data/hooks'
import { useWorkspaceStore } from '@/data/store'
import { notify } from '@/lib/notify'
import { cn } from '@/lib/utils'
import { BusyButton } from './BusyButton'
import { formatMoment } from './format'
import { FactRow, SettingsGroup } from './SettingsLayout'

const DOT: Record<SyncKind, string> = {
  local: 'bg-fg-tertiary',
  saving: 'bg-accent motion-safe:animate-breathe',
  saved: 'bg-success',
  offline: 'bg-warning',
  failed: 'bg-danger',
  stale: 'bg-warning',
}

export function SyncCard() {
  const mode = useDataMode()
  const sync = useSyncState()
  const actions = useActions()
  const [syncing, setSyncing] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [refreshError, setRefreshError] = useState<{ message: string; at: number } | null>(null)
  const syncButton = useRef<HTMLButtonElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  const retryHadFocus = useRef(false)
  const status = deriveSyncStatus(mode, sync)
  const cloud = mode === 'supabase'
  // A refresh that failed stays on the card until a later load succeeds.
  const refreshFailure =
    refreshError && (sync.lastLoadedAt === null || sync.lastLoadedAt < refreshError.at)
      ? refreshError.message
      : null
  const lastError = sync.lastError?.message ?? refreshFailure

  // The Retry button leaves once the failed change is saved: keep keyboard focus on this card.
  // Only after the attempt ended, and only if it succeeded (a failed one keeps the button).
  useEffect(() => {
    if (retrying || !retryHadFocus.current) return
    retryHadFocus.current = false
    if (!sync.canRetry && sync.pending === 0) syncButton.current?.focus()
  }, [retrying, sync.canRetry, sync.pending])

  const syncNow = async () => {
    const startedAt = Date.now()
    setSyncing(true)
    setRefreshError(null)
    // Silent: the store's loading state would replace the whole workspace (this page and the
    // sidebar's project list) with skeletons for as long as the request takes. The button shows
    // the progress and a failure is reported right here instead.
    const result = await actions.refresh({ silent: true, reportFailure: true })
    setSyncing(false)
    if (!result.ok) {
      setRefreshError({ message: result.error.message, at: Date.now() })
      notify.error("Couldn't refresh", { description: result.error.message })
      return
    }
    // The store answers "ok" without reading when the data changed meanwhile: say what happened.
    const loadedAt = useWorkspaceStore.getState().sync.lastLoadedAt
    if (loadedAt !== null && loadedAt >= startedAt) {
      notify.success(cloud ? 'Synced with the cloud' : 'Reloaded from this browser')
    } else {
      notify.info('Nothing was refreshed', {
        description: 'Your data changed while syncing. Try again in a moment.',
      })
    }
  }

  const retry = async () => {
    const hadFocus = document.activeElement === retryButton.current
    setRetrying(true)
    await actions.retryLastFailed() // failures are toasted by the store
    retryHadFocus.current = hadFocus
    setRetrying(false)
  }

  return (
    <SettingsGroup
      title="Sync status"
      description={
        cloud
          ? 'Changes are saved to the cloud as you make them.'
          : 'Changes are saved to this browser as you make them.'
      }
    >
      <div className="flex flex-col gap-3 px-4 py-3.5 @lg:flex-row @lg:items-start @lg:justify-between @lg:gap-6">
        <div className="min-w-0 flex-1">
          <div role="status">
            <div className="flex items-center gap-2" data-sync={status.kind}>
              <span
                className={cn('size-1.5 shrink-0 rounded-full', DOT[status.kind])}
                aria-hidden
              />
              <p className="text-ui font-medium text-fg">{status.title}</p>
            </div>
            <p className="mt-0.5 text-meta text-fg-secondary">{status.detail}</p>
          </div>
          {refreshFailure ? (
            <p role="alert" className="mt-1.5 text-meta text-danger">
              Couldn't refresh · {refreshFailure}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 @lg:shrink-0">
          {sync.canRetry ? (
            <BusyButton
              ref={retryButton}
              variant="secondary"
              size="md"
              busy={retrying}
              icon={<RotateCcw aria-hidden />}
              onClick={() => void retry()}
            >
              Retry
            </BusyButton>
          ) : null}
          <BusyButton
            ref={syncButton}
            variant="secondary"
            size="md"
            busy={syncing}
            disabled={sync.pending > 0}
            icon={<RefreshCw aria-hidden />}
            title={
              cloud
                ? undefined
                : "Reads this browser's storage again, e.g. after changes made in another tab"
            }
            onClick={() => void syncNow()}
          >
            Sync now
          </BusyButton>
        </div>
      </div>
      <dl className="divide-y divide-subtle">
        <FactRow label="Mode">
          {cloud ? 'Cloud sync (Supabase)' : 'Local only — this browser'}
        </FactRow>
        <FactRow label="Connection">
          {sync.online ? 'Online' : 'Offline'}
          {cloud ? null : <span className="text-fg-tertiary"> · not needed in local mode</span>}
        </FactRow>
        <FactRow label="Last loaded">
          {sync.lastLoadedAt !== null ? formatMoment(sync.lastLoadedAt) : 'Not loaded yet'}
        </FactRow>
        <FactRow label="Last saved">
          {sync.lastSavedAt !== null ? (
            formatMoment(sync.lastSavedAt)
          ) : (
            <span className="text-fg-tertiary">No changes saved in this session</span>
          )}
        </FactRow>
        <FactRow label="Pending changes">
          {sync.pending === 0 ? 'None' : `${sync.pending} waiting to be saved`}
        </FactRow>
        <FactRow label="Last error">
          {lastError ? (
            <span className="text-danger">{lastError}</span>
          ) : (
            <span className="text-fg-tertiary">None</span>
          )}
        </FactRow>
      </dl>
      {sync.pending > 0 ? (
        <p className="px-4 py-2.5 text-meta text-fg-tertiary">
          Syncing is available again once the pending changes are saved.
        </p>
      ) : null}
    </SettingsGroup>
  )
}
