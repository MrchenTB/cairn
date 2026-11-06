import { Check, CircleAlert, CloudOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { SaveState } from './saveIndicator'

export interface SaveStatusProps {
  state: SaveState
  /** What failed, for the failed state: "title", "2 changes". */
  failedWhat: string | null
  onRetry: () => void
  retrying: boolean
}

function liveMessage(state: SaveState, failedWhat: string | null): string {
  if (state === 'saved') return 'Saved'
  if (state === 'failed') return `Couldn't save ${failedWhat ?? 'your change'}`
  if (state === 'offline') return "You're offline. Your text will be saved when you're back."
  return ''
}

/**
 * The footer's save state. The visible text is not a live region (it would interrupt typing);
 * a separate polite region announces only how a save ended.
 */
export function SaveStatus({ state, failedWhat, onRetry, retrying }: SaveStatusProps) {
  return (
    <>
      <span className="sr-only" aria-live="polite" aria-atomic>
        {liveMessage(state, failedWhat)}
      </span>
      <div className="flex min-w-0 shrink-0 items-center gap-1.5 text-meta" data-save-state={state}>
        {state === 'pending' ? <span className="text-fg-tertiary">Pending changes</span> : null}
        {state === 'saving' ? (
          <span className="inline-flex items-center gap-1.5 text-fg-tertiary">
            <Spinner size={12} label={null} />
            Saving…
          </span>
        ) : null}
        {state === 'saved' ? (
          <span className="inline-flex items-center gap-1 text-fg-tertiary">
            <Check className="size-3.5" aria-hidden />
            Saved
          </span>
        ) : null}
        {state === 'offline' ? (
          <span className="inline-flex items-center gap-1 text-fg-secondary">
            <CloudOff className="size-3.5" aria-hidden />
            Offline · saves when you’re back
          </span>
        ) : null}
        {state === 'invalid' ? <span className="text-danger">Not saved</span> : null}
        {state === 'restored' ? <span className="text-fg-secondary">Unsaved text</span> : null}
        {state === 'failed' ? (
          <>
            <span className="inline-flex min-w-0 items-center gap-1 text-danger">
              <CircleAlert className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">Couldn’t save {failedWhat ?? 'your change'}</span>
            </span>
            <span aria-hidden className="text-fg-disabled">
              ·
            </span>
            <Button
              variant="ghost"
              size="xs"
              className={cn('px-1.5 text-danger hover:text-danger')}
              loading={retrying}
              onClick={onRetry}
            >
              Retry
            </Button>
          </>
        ) : null}
      </div>
    </>
  )
}
