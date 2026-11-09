/**
 * Settings → Data → Backup: export everything as JSON (re-importable), export tasks as
 * CSV (spreadsheets) and import a backup file. An import is validated first, previewed, and only
 * ever ADDS new copies — it never deletes or overwrites anything (see ImportBackupDialog).
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Download, FileSpreadsheet, FileUp, Info, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import {
  backupFileName,
  downloadBackup,
  downloadTasksCsv,
  readBackupFile,
  tasksCsvFileName,
} from '@/data/backup'
import { useActions, useDataMode, useWorkspaceData } from '@/data/hooks'
import { useWorkspaceStore } from '@/data/store'
import { taskDrafts } from '@/features/task-modal/autosave/taskDrafts'
import type { AppError, BackupFile, ImportSummary } from '@/domain/types'
import { notify } from '@/lib/notify'
import { BusyButton } from './BusyButton'
import { describeAge, describeCounts, countRows } from './format'
import { ImportBackupDialog } from './ImportBackupDialog'
import { readLastBackupAt, writeLastBackupAt } from './lastBackup'
import { SettingRow, SettingsGroup, SettingsNotice } from './SettingsLayout'

/** Problems listed from an invalid file (the rest is summarised). */
const MAX_LISTED_PROBLEMS = 8

type ImportState =
  | { status: 'idle' }
  | { status: 'reading'; fileName: string }
  | { status: 'invalid'; fileName: string; error: AppError }
  | { status: 'preview'; fileName: string; file: BackupFile }

/** The individual problems the backup validator found (empty for whole-file failures). */
function problemsOf(error: AppError): string[] {
  const cause: unknown = error.cause
  if (typeof cause !== 'object' || cause === null || !('problems' in cause)) return []
  const { problems } = cause
  return Array.isArray(problems)
    ? problems.filter((problem): problem is string => typeof problem === 'string')
    : []
}

export function BackupCard() {
  const mode = useDataMode()
  const data = useWorkspaceData()
  const actions = useActions()
  const inputRef = useRef<HTMLInputElement>(null)
  const importButton = useRef<HTMLButtonElement>(null)
  const invalidAlert = useRef<HTMLDivElement>(null)
  const readToken = useRef(0)
  const [lastBackupAt, setLastBackupAt] = useState(readLastBackupAt)
  const [exporting, setExporting] = useState(false)
  const [importState, setImportState] = useState<ImportState>({ status: 'idle' })
  const hasTasks = Object.keys(data.tasks).length > 0
  const invalid = importState.status === 'invalid'

  // The notice is below the buttons: on a short window it could be out of sight.
  useEffect(() => {
    if (invalid) invalidAlert.current?.scrollIntoView?.({ block: 'nearest' })
  }, [invalid])

  const exportJson = async () => {
    // Text that can still go out goes out first; what can't is named below.
    taskDrafts.flushAll()
    setExporting(true)
    try {
      // The backup is read from the saved data, not from the screen, once the writes in flight
      // (the text just sent included) have their answer.
      const result = await actions.exportSavedBackup()
      if (!result.ok) {
        notify.error("Couldn't export the backup", { description: result.error.message })
        return
      }
      // Only now is it known what could not be saved: say so before handing out the file.
      const unsavedText = taskDrafts.getOutstanding().length > 0
      const failedWrites = useWorkspaceStore.getState().sync.canRetry
      if (unsavedText || failedWrites) {
        const agreed = await confirm({
          title: "Some changes aren't saved",
          description:
            "The backup will contain what's saved, without the changes that couldn't be saved. Retry them first to include them.",
          confirmLabel: 'Export anyway',
        })
        if (!agreed) return
      }
      const file = result.value
      downloadBackup(file)
      const now = Date.now()
      writeLastBackupAt(now)
      setLastBackupAt(now)
      const contents = describeCounts(countRows(file.data))
      notify.success('Backup exported', {
        description: `${backupFileName()} · ${contents === 'nothing' ? 'no projects or tasks yet' : contents}`,
      })
    } catch (error) {
      notify.error("Couldn't export the backup", {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setExporting(false)
    }
  }

  const exportCsv = () => {
    try {
      downloadTasksCsv(data)
      notify.success('Tasks exported', { description: tasksCsvFileName() })
    } catch (error) {
      notify.error("Couldn't export the tasks", {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = '' // choosing the same file again must fire a new change event
    if (!file) return
    const token = ++readToken.current
    setImportState({ status: 'reading', fileName: file.name })
    const result = await readBackupFile(file)
    if (token !== readToken.current) return // a newer choice replaced this one
    setImportState(
      result.ok
        ? { status: 'preview', fileName: file.name, file: result.value }
        : { status: 'invalid', fileName: file.name, error: result.error },
    )
  }

  const imported = (summary: ImportSummary) => {
    setImportState({ status: 'idle' })
    notify.success('Backup imported', {
      description: `Added ${describeCounts(summary)} as new copies.`,
    })
  }

  const problems = importState.status === 'invalid' ? problemsOf(importState.error) : []

  return (
    <SettingsGroup
      title="Backup"
      description="Your data is yours: export it any time, bring it back as copies."
    >
      <SettingRow
        title="JSON backup"
        description={
          <>
            Everything — projects, phases, tasks, milestones, dependencies and preferences — in one
            file you can import again.{' '}
            <span className="text-fg-tertiary">
              {lastBackupAt !== null
                ? `Last exported ${describeAge(lastBackupAt)} from this browser.`
                : "You haven't exported a backup from this browser yet."}
            </span>
          </>
        }
      >
        <BusyButton
          variant="secondary"
          size="md"
          busy={exporting}
          icon={<Download aria-hidden />}
          onClick={() => void exportJson()}
        >
          Export JSON backup
        </BusyButton>
      </SettingRow>
      <SettingRow
        title="Tasks spreadsheet"
        description={
          hasTasks
            ? "One row per task, for Excel, Numbers or Google Sheets. It can't be imported back."
            : 'No tasks to export yet.'
        }
      >
        <Button variant="secondary" size="md" disabled={!hasTasks} onClick={exportCsv}>
          <FileSpreadsheet aria-hidden />
          Export tasks CSV
        </Button>
      </SettingRow>
      <SettingRow
        title="Restore from a backup"
        description="Adds the contents of a Cairn backup (.json) as new copies. Nothing that exists today is changed or deleted."
      >
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          aria-label="Backup file"
          tabIndex={-1}
          className="sr-only"
          onChange={(event) => void chooseFile(event)}
        />
        <BusyButton
          ref={importButton}
          variant="secondary"
          size="md"
          busy={importState.status === 'reading'}
          icon={<FileUp aria-hidden />}
          onClick={() => inputRef.current?.click()}
        >
          Import backup…
        </BusyButton>
      </SettingRow>
      {importState.status === 'invalid' ? (
        <div
          ref={invalidAlert}
          role="alert"
          className="flex items-start gap-2.5 bg-danger-subtle px-4 py-3 text-meta"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-danger">Couldn't import "{importState.fileName}"</p>
            {problems.length > 0 ? (
              <>
                <p className="mt-0.5 text-fg-secondary">
                  This isn't a valid Cairn backup. Nothing was imported.
                </p>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-fg-secondary">
                  {problems.slice(0, MAX_LISTED_PROBLEMS).map((problem, index) => (
                    <li key={index}>{problem}</li>
                  ))}
                </ul>
                {problems.length > MAX_LISTED_PROBLEMS ? (
                  <p className="mt-1 text-fg-tertiary">
                    …and {problems.length - MAX_LISTED_PROBLEMS} more.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="mt-0.5 text-fg-secondary">{importState.error.message}</p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss"
            onClick={() => setImportState({ status: 'idle' })}
          >
            <X />
          </Button>
        </div>
      ) : null}
      <SettingsNotice icon={Info}>
        {mode === 'supabase'
          ? "Supabase's Free plan has no automatic backups, so nobody can restore deleted data for you. Export a JSON backup regularly and keep it somewhere safe."
          : "Local mode keeps everything in this browser only. Clearing the site's data or switching browsers loses it. Export a JSON backup regularly and keep it somewhere safe."}
      </SettingsNotice>
      {importState.status === 'preview' ? (
        <ImportBackupDialog
          file={importState.file}
          fileName={importState.fileName}
          onClose={() => setImportState({ status: 'idle' })}
          onImported={imported}
          returnFocusTo={importButton}
        />
      ) : null}
    </SettingsGroup>
  )
}
