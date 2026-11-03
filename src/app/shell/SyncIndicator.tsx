import { useState } from 'react'
import { Link } from 'react-router'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip } from '@/components/ui/tooltip'
import { useActions, useDataMode, useSyncState } from '@/data/hooks'
import { cn } from '@/lib/utils'
import { sidebarItemClass } from './sidebarStyles'
import { deriveSyncStatus, type SyncKind } from './syncStatus'

const DOT: Record<SyncKind, string> = {
  local: 'bg-fg-tertiary',
  saving: 'bg-accent motion-safe:animate-breathe',
  saved: 'bg-success',
  offline: 'bg-warning',
  failed: 'bg-danger',
  stale: 'bg-warning',
}

function formatTime(epochMs: number): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(epochMs)
}

/**
 * Sidebar sync state: a 6px dot + label ("Local only — not synced", "Saving…", "Saved",
 * "Offline", "Couldn't save · Retry"). Opens a popover with details; Retry re-runs the failed
 * write.
 */
export function SyncIndicator({ collapsed }: { collapsed: boolean }) {
  const mode = useDataMode()
  const sync = useSyncState()
  const actions = useActions()
  const [retrying, setRetrying] = useState(false)
  const status = deriveSyncStatus(mode, sync)

  const retry = () => {
    setRetrying(true)
    void actions.retryLastFailed().finally(() => setRetrying(false))
  }

  return (
    <div className="flex items-center" data-sync={status.kind}>
      <Popover>
        <Tooltip content={status.label} side="right" disabled={!collapsed}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Sync status: ${status.label}`}
              className={cn(
                sidebarItemClass,
                'font-normal',
                collapsed ? 'w-9' : status.canRetry ? 'min-w-0' : 'min-w-0 flex-1',
                status.kind === 'failed' ? 'text-danger hover:text-danger' : 'text-fg-tertiary',
              )}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                <span className={cn('size-1.5 rounded-full', DOT[status.kind])} />
              </span>
              <span
                className={cn(
                  'min-w-0 truncate text-meta transition-opacity duration-fast',
                  collapsed && 'opacity-0',
                )}
              >
                {status.label}
              </span>
            </button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent
          side={collapsed ? 'right' : 'top'}
          align={collapsed ? 'end' : 'start'}
          className="w-72"
        >
          <div className="flex items-center gap-2">
            <span className={cn('size-1.5 shrink-0 rounded-full', DOT[status.kind])} />
            <p className="text-ui font-medium text-fg">{status.title}</p>
          </div>
          <p className="mt-1 text-meta text-fg-secondary">{status.detail}</p>
          {status.kind === 'saved' && sync.lastSavedAt ? (
            <p className="mt-2 text-meta text-fg-tertiary">
              Last saved at {formatTime(sync.lastSavedAt)}
            </p>
          ) : null}
          <div className="mt-3 flex items-center gap-2">
            {status.canRetry ? (
              <Button variant="secondary" size="xs" onClick={retry} loading={retrying}>
                {retrying ? null : <RefreshCw aria-hidden />}
                Retry
              </Button>
            ) : null}
            {status.kind === 'local' ? (
              <Button variant="link" size="xs" asChild>
                <Link to="/settings/data">Backup &amp; export</Link>
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
      {status.canRetry && !collapsed ? (
        <>
          <span aria-hidden className="px-0.5 text-meta text-fg-disabled">
            ·
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="px-1.5 text-danger hover:text-danger"
            onClick={retry}
            loading={retrying}
          >
            Retry
          </Button>
        </>
      ) : null}
    </div>
  )
}
