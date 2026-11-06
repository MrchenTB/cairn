/**
 * Every text draft that still matters, per task and field, whether or not a modal shows it.
 *
 * A draft outlives the form that made it: a write that fails after the modal closed must still be
 * findable (reopening the task shows the text; the sidebar lists it). The manager also keeps a copy
 * in `sessionStorage`, so a reload of this tab can recover it. That copy is a safety net for this
 * tab, not a backup: closing the tab loses it.
 *
 * Isolation between accounts: the stored copy names its account (scope), and only one scope is ever
 * kept. Signing in as someone else removes the previous account's text unread; signing out on
 * purpose removes it too (`purgeStored`). An expired session leaves it, for the same account to
 * pick up after signing in again.
 *
 * A recovered draft never overwrites anything by itself (see TextDraft `restored`): compared with
 * the stored value it is dropped when it was saved after all, offered when the stored value is what
 * it was written on, and set apart as a conflict when the stored value changed since.
 */
import { validateDescription, validateName } from '@/domain/validation'
import { TITLE_MAX_LENGTH, type Result, type TaskPatch } from '@/domain/types'
import {
  TextDraft,
  DESCRIPTION_DEBOUNCE_MS,
  DESCRIPTION_MAX_WAIT_MS,
  type DraftPhase,
  type DraftRecord,
  type DraftRules,
  type TextField,
} from './textDraft'

export const DRAFTS_STORAGE_KEY = 'cairn:task-drafts:v1'

/** Titles are single-line: pasted line breaks become spaces (the store only trims). */
export function normalizeTitleText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim()
}

/** Empty / whitespace-only descriptions are stored as null. */
export function normalizeDescriptionText(text: string): string | null {
  return text.trim() === '' ? null : text
}

export const FIELD_RULES: Record<TextField, DraftRules> = {
  title: {
    debounceMs: null,
    maxWaitMs: null,
    revertEmpty: true,
    normalize: normalizeTitleText,
    validate: (text) =>
      validateName(normalizeTitleText(text), TITLE_MAX_LENGTH, 'Task title')?.message ?? null,
  },
  description: {
    debounceMs: DESCRIPTION_DEBOUNCE_MS,
    maxWaitMs: DESCRIPTION_MAX_WAIT_MS,
    revertEmpty: false,
    normalize: normalizeDescriptionText,
    validate: (text) => validateDescription(normalizeDescriptionText(text))?.message ?? null,
  },
}

export interface DraftManagerEnv {
  readTask(taskId: string): { title: string; description: string | null } | undefined
  /** The workspace is loaded: stored values can be compared with recovered text. */
  isReady(): boolean
  write(taskId: string, patch: TaskPatch, field: TextField): Promise<Result>
  withdrawFailure(taskId: string, field: TextField): void
  isOffline(): boolean
  storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  now(): number
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** Text from before a reload is waiting for a decision (once per recovery). */
  onRecovered?(drafts: readonly DraftSummary[]): void
}

export interface DraftSummary {
  key: string
  taskId: string
  field: TextField
  /** The task's title when this was saved (the task may be gone). */
  taskTitle: string
  /** False when the task does not exist any more: only the text can be saved by hand. */
  taskExists: boolean
  phase: DraftPhase
  text: string
  error: string | null
}

interface StoredDraft extends DraftRecord {
  taskId: string
  field: TextField
  taskTitle: string
}

interface StoredDrafts {
  version: 1
  scope: string
  drafts: StoredDraft[]
}

const isField = (value: unknown): value is TextField => value === 'title' || value === 'description'
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

function parseStored(raw: string | null): StoredDrafts | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StoredDrafts> | null
    if (parsed?.version !== 1 || typeof parsed.scope !== 'string') return null
    if (!Array.isArray(parsed.drafts)) return null
    const drafts = parsed.drafts.filter(
      (draft): draft is StoredDraft =>
        typeof draft?.taskId === 'string' &&
        isField(draft.field) &&
        typeof draft.value === 'string' &&
        isNullableString(draft.base) &&
        isNullableString(draft.sent) &&
        typeof draft.taskTitle === 'string',
    )
    return { version: 1, scope: parsed.scope, drafts }
  } catch {
    return null
  }
}

/** Phases the user has to act on (or that a closed form left behind). */
const OUTSTANDING: ReadonlySet<DraftPhase> = new Set([
  'failed',
  'invalid',
  'held',
  'restored',
  'conflict',
])

export class DraftManager {
  private readonly env: DraftManagerEnv
  private readonly drafts = new Map<string, TextDraft>()
  private readonly taskTitles = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private scope: string | null = null
  private version = 0
  private summaries: DraftSummary[] = []
  private recoveryPending = false

  constructor(env: DraftManagerEnv) {
    this.env = env
  }

  // -- subscription ----------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  /** Drafts the user still has to resolve, oldest first. Stable until something changes. */
  getOutstanding = (): readonly DraftSummary[] => this.summaries

  /** True when leaving the page now could lose text (including text not sent yet). */
  hasUnsavedText(): boolean {
    for (const draft of this.drafts.values()) {
      if (draft.phase !== 'clean') return true
    }
    return false
  }

  // -- drafts ----------------------------------------------------------------

  private key(taskId: string, field: TextField): string {
    return `${taskId}|${field}`
  }

  /** The draft of this field (created when needed). */
  get(taskId: string, field: TextField): TextDraft {
    const key = this.key(taskId, field)
    return this.drafts.get(key) ?? this.create(taskId, field)
  }

  private create(taskId: string, field: TextField, record?: DraftRecord): TextDraft {
    const key = this.key(taskId, field)
    const draft: TextDraft = new TextDraft(
      FIELD_RULES[field],
      {
        readSaved: () => {
          const task = this.env.readTask(taskId)
          if (!task) return undefined
          return field === 'title' ? task.title : task.description
        },
        write: (value) =>
          this.env.write(
            taskId,
            field === 'title' ? { title: value ?? '' } : { description: value },
            field,
          ),
        withdrawFailure: () => this.env.withdrawFailure(taskId, field),
        isOffline: () => this.env.isOffline(),
        now: () => this.env.now(),
        setTimer: (callback, ms) => this.env.setTimer(callback, ms),
        clearTimer: (handle) => this.env.clearTimer(handle),
        onChange: () => this.onDraftChange(key),
      },
      record,
    )
    this.drafts.set(key, draft)
    return draft
  }

  /** A form shows this draft now (re-registers it: Strict Mode runs effects twice). */
  attach(taskId: string, field: TextField, draft: TextDraft): void {
    draft.attached += 1
    this.drafts.set(this.key(taskId, field), draft)
    const title = this.env.readTask(taskId)?.title
    if (title !== undefined) this.taskTitles.set(taskId, title)
  }

  detach(taskId: string, field: TextField, draft: TextDraft) {
    draft.attached -= 1
    const outcome = draft.attached <= 0 ? draft.detach() : 'clean'
    this.onDraftChange(this.key(taskId, field))
    return outcome
  }

  private onDraftChange(key: string): void {
    const draft = this.drafts.get(key)
    // Forgotten, not disposed: Strict Mode attaches the same draft again right after detaching it.
    if (draft && draft.attached <= 0 && !draft.busy) this.drafts.delete(key)
    this.persist()
    this.publish()
  }

  private forEachDraft(run: (draft: TextDraft) => void): void {
    // A draft may release itself while it runs.
    for (const draft of [...this.drafts.values()]) run(draft)
  }

  /** The store changed: drafts compare themselves with what is stored now. */
  storeChanged(): void {
    if (!this.env.isReady()) return
    this.forEachDraft((draft) => draft.syncSaved())
    if (this.recoveryPending) {
      this.recoveryPending = false
      this.publish()
      const recovered = this.summaries.filter(
        (summary) => summary.phase === 'restored' || summary.phase === 'conflict',
      )
      if (recovered.length > 0) this.env.onRecovered?.(recovered)
    }
  }

  /** The connection is back. */
  online(): void {
    this.forEachDraft((draft) => draft.online())
  }

  /** Sends what can be sent right now (the tab is being hidden; before signing out). */
  flushAll(): void {
    this.forEachDraft((draft) => draft.flush())
  }

  /** Drops every draft of a task (it is being deleted). */
  discardTask(taskId: string): void {
    for (const field of ['title', 'description'] as const) {
      this.drafts.get(this.key(taskId, field))?.discard()
    }
  }

  discardDraft(taskId: string, field: TextField): void {
    this.drafts.get(this.key(taskId, field))?.discard()
  }

  // -- account scope ---------------------------------------------------------

  /** The signed-in account (null = nobody). See the header for what each change does. */
  setScope(scope: string | null): void {
    if (scope === this.scope) return
    for (const draft of this.drafts.values()) draft.dispose()
    this.drafts.clear()
    this.taskTitles.clear()
    this.scope = scope
    this.recoveryPending = false
    if (scope !== null) this.hydrate(scope)
    this.publish()
  }

  private hydrate(scope: string): void {
    const storage = this.env.storage()
    if (!storage) return
    let stored: StoredDrafts | null = null
    try {
      stored = parseStored(storage.getItem(DRAFTS_STORAGE_KEY))
      if (stored && stored.scope !== scope) {
        // Another account's text: never read by this one.
        storage.removeItem(DRAFTS_STORAGE_KEY)
        stored = null
      }
    } catch {
      return
    }
    if (!stored || stored.drafts.length === 0) return
    for (const { taskId, field, taskTitle, value, base, sent } of stored.drafts) {
      this.taskTitles.set(taskId, taskTitle)
      this.create(taskId, field, { value, base, sent })
    }
    this.recoveryPending = true
    this.storeChanged()
  }

  /** Removes the stored copy for good (the user signed out on purpose). */
  purgeStored(): void {
    try {
      this.env.storage()?.removeItem(DRAFTS_STORAGE_KEY)
    } catch {
      // Nothing more can be done about storage that refuses.
    }
  }

  // -- persistence + summaries -----------------------------------------------

  private persist(): void {
    if (this.scope === null) return
    const storage = this.env.storage()
    if (!storage) return
    const drafts: StoredDraft[] = []
    for (const [key, draft] of this.drafts) {
      const record = draft.toRecord()
      if (!record) continue
      const [taskId, field] = key.split('|') as [string, TextField]
      const taskTitle = this.env.readTask(taskId)?.title ?? this.taskTitles.get(taskId) ?? ''
      this.taskTitles.set(taskId, taskTitle)
      drafts.push({ ...record, taskId, field, taskTitle })
    }
    try {
      if (drafts.length === 0) {
        storage.removeItem(DRAFTS_STORAGE_KEY)
      } else {
        const stored: StoredDrafts = { version: 1, scope: this.scope, drafts }
        storage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(stored))
      }
    } catch {
      // Storage full or blocked: the draft stays in memory, only the reload safety net is gone.
    }
  }

  private publish(): void {
    const next: DraftSummary[] = []
    for (const [key, draft] of this.drafts) {
      const { phase } = draft
      // A form on screen shows its own state; a closed one has nobody else to tell.
      const pendingUnseen = draft.attached <= 0 && phase === 'pending'
      if (!OUTSTANDING.has(phase) && !pendingUnseen) continue
      const [taskId, field] = key.split('|') as [string, TextField]
      const task = this.env.readTask(taskId)
      next.push({
        key,
        taskId,
        field,
        taskTitle: task?.title ?? this.taskTitles.get(taskId) ?? 'Deleted task',
        taskExists: task !== undefined,
        phase,
        text: draft.recoverableText ?? '',
        error: draft.getSnapshot().error,
      })
    }
    const same =
      next.length === this.summaries.length &&
      next.every((summary, index) => {
        const other = this.summaries[index]
        return (
          summary.key === other.key &&
          summary.phase === other.phase &&
          summary.taskTitle === other.taskTitle &&
          summary.taskExists === other.taskExists &&
          summary.text === other.text &&
          summary.error === other.error
        )
      })
    if (!same) this.summaries = next
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  /** Forgets everything, storage included (tests). */
  resetForTests(): void {
    for (const draft of this.drafts.values()) draft.dispose()
    this.drafts.clear()
    this.taskTitles.clear()
    this.summaries = []
    this.recoveryPending = false
    this.purgeStored()
    this.publish()
  }
}
