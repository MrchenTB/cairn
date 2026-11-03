/**
 * Backup / export helpers for Settings → Data: download a JSON backup (everything, re-importable),
 * download tasks as CSV (for spreadsheets), and read + validate an uploaded backup file.
 * Building the backup itself is `actions.exportBackup()`; importing is `actions.importBackup()`.
 */
import { getBrowserTimeZone, todayInTimeZone } from '@/domain/dates'
import { buildProjectOutline } from '@/domain/hierarchy'
import { sortByOrder } from '@/domain/ordering'
import type {
  BackupFile,
  ISODate,
  Phase,
  Project,
  Result,
  Task,
  TaskPriority,
  TaskStatus,
} from '@/domain/types'
import { parseBackupFile } from '@/domain/validation'

/** Uploads larger than this are rejected before parsing. */
export const MAX_BACKUP_FILE_BYTES = 25 * 1024 * 1024

const UTF8_BOM = '﻿'

export const CSV_COLUMNS = [
  'Project',
  'Phase',
  'Parent task',
  'Title',
  'Status',
  'Priority',
  'Start',
  'Due',
  'Completed at',
  'Description',
] as const

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
}
const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
}

function localToday(): ISODate {
  return todayInTimeZone(getBrowserTimeZone())
}

/** `cairn-backup-YYYY-MM-DD.json` */
export function backupFileName(today: ISODate = localToday()): string {
  return `cairn-backup-${today}.json`
}

/** `cairn-tasks-YYYY-MM-DD.csv` */
export function tasksCsvFileName(today: ISODate = localToday()): string {
  return `cairn-tasks-${today}.csv`
}

/**
 * One RFC 4180 field: quoted when it contains a comma, quote, CR/LF or edge whitespace, with
 * inner quotes doubled. Text starting with = + - @ (or tab/CR) gets a leading apostrophe so
 * spreadsheet apps never evaluate it as a formula (CSV injection).
 */
export function csvField(value: string | null | undefined): string {
  let text = value ?? ''
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text
}

/** Rows (fields already as strings) → CSV text with CRLF line breaks. */
export function toCsv(rows: readonly (readonly (string | null)[])[]): string {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n'
}

type Rows<T> = readonly T[] | Readonly<Record<string, T>>

function list<T>(rows: Rows<T>): T[] {
  return Array.isArray(rows) ? [...rows] : Object.values(rows)
}

/**
 * Tasks as CSV for Excel/Numbers/Sheets: UTF-8 with BOM, one row per task in List order
 * (projects in their order, ungrouped tasks first, then phases; subtasks after their parent).
 */
export function buildTasksCsv(data: {
  projects: Rows<Project>
  phases: Rows<Phase>
  tasks: Rows<Task>
}): string {
  const phases = list(data.phases)
  const tasks = list(data.tasks)
  const phaseNames = new Map(phases.map((phase) => [phase.id, phase.name]))
  const rows: (string | null)[][] = [[...CSV_COLUMNS]]
  const row = (project: Project, task: Task, parent: Task | null) => [
    project.name,
    task.phaseId ? (phaseNames.get(task.phaseId) ?? '') : '',
    parent?.title ?? '',
    task.title,
    STATUS_LABELS[task.status] ?? task.status,
    PRIORITY_LABELS[task.priority] ?? task.priority,
    task.startDate,
    task.dueDate,
    task.completedAt,
    task.description,
  ]
  for (const project of sortByOrder(list(data.projects))) {
    const outline = buildProjectOutline(project, phases, tasks, [])
    for (const group of outline.groups) {
      for (const { task, subtasks } of group.tasks) {
        rows.push(row(project, task, null))
        for (const subtask of subtasks) rows.push(row(project, subtask, task))
      }
    }
  }
  return UTF8_BOM + toCsv(rows)
}

/** Pretty-printed JSON of a backup file. */
export function serializeBackup(file: BackupFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

/** Starts a browser download of `text` (UTF-8). */
export function downloadTextFile(fileName: string, text: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Downloads `cairn-backup-YYYY-MM-DD.json`. */
export function downloadBackup(file: BackupFile, today?: ISODate): void {
  downloadTextFile(backupFileName(today), serializeBackup(file), 'application/json')
}

/** Downloads `cairn-tasks-YYYY-MM-DD.csv`. */
export function downloadTasksCsv(data: Parameters<typeof buildTasksCsv>[0], today?: ISODate): void {
  downloadTextFile(tasksCsvFileName(today), buildTasksCsv(data), 'text/csv;charset=utf-8')
}

/** Parses backup JSON text (a leading BOM is ignored) and validates it with parseBackupFile. */
export function parseBackupText(text: string): Result<BackupFile> {
  let json: unknown
  try {
    json = JSON.parse(text.startsWith(UTF8_BOM) ? text.slice(1) : text)
  } catch {
    return {
      ok: false,
      error: {
        kind: 'validation',
        message: "This file isn't valid JSON, so it can't be a Cairn backup.",
      },
    }
  }
  return parseBackupFile(json)
}

/** Blob.text(), with a FileReader fallback for environments without it (e.g. jsdom). */
function readText(file: Blob): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

/** Reads an uploaded file (e.g. from <input type="file">) and validates it as a Cairn backup. */
export async function readBackupFile(file: Blob): Promise<Result<BackupFile>> {
  if (file.size > MAX_BACKUP_FILE_BYTES) {
    return {
      ok: false,
      error: {
        kind: 'validation',
        message: 'This file is too large to be a Cairn backup (max 25 MB).',
      },
    }
  }
  let text: string
  try {
    text = await readText(file)
  } catch (cause) {
    return { ok: false, error: { kind: 'unknown', message: "Couldn't read the file.", cause } }
  }
  return parseBackupText(text)
}
