/**
 * Confirmation step of "Import backup…": shows what the (already validated) file contains and
 * says plainly that it is added as NEW copies — nothing existing is changed, overwritten or
 * deleted. The import itself is `actions.importBackup`; a success closes the dialog.
 *
 * A failed import keeps the dialog open with the reason. While it is open it owns the retry: the
 * store's failure toast (whose Retry would run the same import a second time next to the button
 * here) is taken away, and "Try again" re-sends the SAME copy through the store's retry — same
 * ids, so an attempt that did reach the server but whose answer was lost is never added twice.
 */
import { useState, type RefObject } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useActions } from '@/data/hooks'
import { isRetryable } from '@/data/errors'
import type { BackupFile, ImportSummary, Result } from '@/domain/types'
import { dismissSyncErrorToast } from '@/features/projects/syncToast'
import { BusyButton } from './BusyButton'
import { countRows, formatTimestamp } from './format'

const ROWS: readonly [keyof ImportSummary, string][] = [
  ['projects', 'Projects'],
  ['phases', 'Phases'],
  ['tasks', 'Tasks'],
  ['milestones', 'Milestones'],
  ['dependencies', 'Dependencies'],
]

interface Failure {
  message: string
  /** The store kept the failed import and can send the same copy again. */
  retryable: boolean
}

export function ImportBackupDialog({
  file,
  fileName,
  onClose,
  onImported,
  returnFocusTo,
}: {
  file: BackupFile
  fileName: string
  onClose: () => void
  onImported: (summary: ImportSummary) => void
  /** Where keyboard focus goes when the dialog closes (the button that started the import). */
  returnFocusTo?: RefObject<HTMLElement | null>
}) {
  const actions = useActions()
  const [importing, setImporting] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const counts = countRows(file.data)
  const empty = ROWS.every(([key]) => counts[key] === 0)

  const attempt = async (): Promise<Result<ImportSummary>> => {
    if (!failure?.retryable) return actions.importBackup(file)
    const retried = await actions.retryLastFailed()
    return retried.ok ? { ok: true, value: counts } : retried
  }

  const submit = async () => {
    setImporting(true)
    const result = await attempt()
    setImporting(false)
    if (result.ok) {
      onImported(result.value)
      return
    }
    // Rejected files (validation) never reach the store's toast; every other failure did.
    if (result.error.kind !== 'validation') dismissSyncErrorToast()
    setFailure({ message: result.error.message, retryable: isRetryable(result.error) })
  }

  // While the import runs the dialog stays: its outcome is shown here.
  const keepOpen = (event: Event) => {
    if (importing) event.preventDefault()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !importing && onClose()}>
      <DialogContent
        size="sm"
        onEscapeKeyDown={keepOpen}
        onPointerDownOutside={keepOpen}
        onCloseAutoFocus={(event) => {
          // The element focused before opening is gone or disabled by now (the button was busy
          // while the file was read): focus goes back to the button that started the import.
          if (!returnFocusTo?.current) return
          event.preventDefault()
          returnFocusTo.current.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Import backup</DialogTitle>
          <DialogDescription>
            <span className="block truncate">{fileName}</span>
            <span className="block">Exported {formatTimestamp(file.exportedAt)}</span>
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 pb-2">
          <dl className="divide-y divide-subtle overflow-hidden rounded-lg border border-default">
            {ROWS.map(([key, label]) => (
              <div key={key} className="flex items-center justify-between px-3 py-2 text-ui">
                <dt className="text-fg-secondary">{label}</dt>
                <dd className="font-medium text-fg tabular-nums">{counts[key]}</dd>
              </div>
            ))}
          </dl>
          <p className="text-meta text-fg-secondary">
            {empty
              ? 'This backup has no projects or tasks, so there is nothing to import.'
              : 'Everything above is added as new copies next to your current data. Nothing that exists today is changed, overwritten or deleted — importing the same file twice adds two copies. Settings stored in the file (theme, time zone…) are not applied.'}
          </p>
          {failure ? (
            <div role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-meta">
              <p className="font-medium text-danger">Couldn't import the backup</p>
              <p className="mt-0.5 text-fg-secondary">{failure.message}</p>
              {failure.retryable ? (
                <p className="mt-1 text-fg-tertiary">
                  Your file is still loaded. Trying again sends the same copy, so nothing is added
                  twice.
                </p>
              ) : null}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="md" disabled={importing} onClick={onClose}>
            Cancel
          </Button>
          <BusyButton
            variant="primary"
            size="md"
            busy={importing}
            disabled={empty}
            onClick={() => void submit()}
          >
            {failure?.retryable ? 'Try again' : 'Import as new copies'}
          </BusyButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
