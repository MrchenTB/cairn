/**
 * Autosave for ONE text field of one task (no React, no store: everything comes through `env`, so
 * every rule below is unit-tested with fake timers).
 *
 * What it guarantees:
 * - While there is a draft, the field shows the draft. A server answer, a refresh or a rollback
 *   never rewrites what the user is typing (the store's value is only shown again once the draft
 *   is gone: the field lost focus and holds what is stored).
 * - IME: nothing is written, timed or persisted between compositionstart and compositionend. A
 *   composition cut short (focus left, another window, a click) is not a choice the user made,
 *   although the browser ends it with the pre-edit string as the text: that text is kept and shown,
 *   and is only saved if the user says so.
 * - Coalescing: at most one write per field is in flight. Text typed meanwhile is one follow-up
 *   write with the newest value, however many times it was committed.
 * - A failed write keeps the text (`failed`). Typing again withdraws that failure, so its Retry
 *   can never put the older text over the newer one.
 * - Invalid text (too long) is kept and never sent. An empty title is never sent either: a commit
 *   puts the stored title back and says so (`revertedTo`).
 *
 * Writes go through `env.write` (the store's `updateTask`: its queue, optimistic update, rollback
 * and Retry). This module only decides what to send and when.
 */
import type { AppError, Result } from '@/domain/types'

export type TextField = 'title' | 'description'

/** Description: quiet time before saving (a pause to think, not a pause between words). */
export const DESCRIPTION_DEBOUNCE_MS = 2000
/** Description: longest time text can go unsent while the user keeps typing. */
export const DESCRIPTION_MAX_WAIT_MS = 10_000

export type DraftPhase =
  /** Nothing to save. */
  | 'clean'
  /** Differs from what is stored; not sent yet. */
  | 'pending'
  /** A write of this field is in flight. */
  | 'saving'
  /** The last write failed; the text is kept. */
  | 'failed'
  /** The text can't be stored as it is (too long, empty title); it is kept and not sent. */
  | 'invalid'
  /** Offline: kept, and sent when the connection is back. */
  | 'held'
  /** Recovered text waiting for a decision (nothing is written until the user chooses). */
  | 'restored'
  /** Recovered text, but the stored value changed since: it is not shown over the newer value. */
  | 'conflict'

export interface DraftRules {
  /** null: never saves on a timer (the title saves on Enter and blur). */
  debounceMs: number | null
  maxWaitMs: number | null
  /** What would be stored for this text. */
  normalize(text: string): string | null
  /** Why this text can't be stored (null = it can). */
  validate(text: string): string | null
  /** Empty text can't be stored: a commit puts the stored text back instead of keeping it. */
  revertEmpty: boolean
}

export interface DraftEnv {
  /** The stored (optimistic) value now; undefined when the task does not exist any more. */
  readSaved(): string | null | undefined
  write(value: string | null): Promise<Result>
  /** The store's Retry for this field's failed write is no longer wanted. */
  withdrawFailure(): void
  isOffline(): boolean
  now(): number
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** The draft's state changed (persist, re-render). */
  onChange(): void
}

export interface DraftSnapshot {
  /** What the field shows; null = follow the stored value. */
  text: string | null
  phase: DraftPhase
  composing: boolean
  /** Why it is `failed` or `invalid`. */
  error: string | null
  /** A commit restored this stored text because the field was empty. */
  revertedTo: string | null
  /** The browser ended a composition the user did not finish: this text was never confirmed. */
  unconfirmed: boolean
  /** Writes of this field that succeeded so far (drives the quiet "Saved"). */
  saves: number
}

export type CommitOutcome =
  /** Nothing to do. */
  | 'clean'
  /** Handed to the store (or queued behind the write in flight). */
  | 'sent'
  /** An empty title: the stored one is back. */
  | 'reverted'
  /** Kept, not sent. */
  | 'invalid'
  | 'held'
  | 'restored'
  | 'composing'
  /** The last attempt failed: only Retry or new typing sends it again. */
  | 'failed'

/** What survives a reload (sessionStorage). Never contains text still being composed. */
export interface DraftRecord {
  value: string
  /** The stored value this text was written on top of. */
  base: string | null
  /** The last value sent (its answer may have been lost: stored == sent is not a conflict). */
  sent: string | null
}

const isRetryableKind = (error: AppError) => error.kind === 'network' || error.kind === 'unknown'

export class TextDraft {
  private readonly rules: DraftRules
  private readonly env: DraftEnv
  private text: string | null = null
  /** The text without any composition in progress. */
  private stable: string | null = null
  private composing = false
  /** Something other than the input method is ending this composition. */
  private compositionInterrupted = false
  private unconfirmed = false
  private focused = false
  private inFlight: { value: string | null } | null = null
  private queued = false
  private failure: AppError | null = null
  private held = false
  private restored = false
  private conflict = false
  private conflictAccepted = false
  private revertedTo: string | null = null
  private base: string | null = null
  private sent: string | null = null
  private timer: unknown = null
  private firstDirtyAt: number | null = null
  private disposed = false
  /** The text is what was last stored: the user has not touched it since. */
  private untouchedSinceSave = false
  private saves = 0
  private snapshot: DraftSnapshot = {
    text: null,
    phase: 'clean',
    composing: false,
    error: null,
    revertedTo: null,
    unconfirmed: false,
    saves: 0,
  }

  /** How many mounted forms show this draft (kept by the manager; 0 = it may be released). */
  attached = 0

  constructor(rules: DraftRules, env: DraftEnv, record?: DraftRecord) {
    this.rules = rules
    this.env = env
    if (record) {
      this.text = record.value
      this.stable = record.value
      this.base = record.base
      this.sent = record.sent
      this.restored = true
      this.snapshot = this.build()
    }
  }

  getSnapshot = (): DraftSnapshot => this.snapshot

  /** True while this draft must stay alive (work in progress, or text the user has not resolved). */
  get busy(): boolean {
    return this.text !== null || this.inFlight !== null || this.queued
  }

  get phase(): DraftPhase {
    return this.snapshot.phase
  }

  /** The recoverable text (without a composition in progress). */
  get recoverableText(): string | null {
    return this.composing ? this.stable : this.text
  }

  // -- field events ----------------------------------------------------------

  focus(): void {
    this.focused = true
  }

  input(value: string): void {
    this.focused = true
    this.untouchedSinceSave = false
    this.beginEditing()
    this.text = value
    this.revertedTo = null
    if (!this.composing) {
      this.stable = value
      this.held = false
      this.schedule()
    }
    this.emit()
  }

  compositionStart(current: string): void {
    this.focused = true
    this.untouchedSinceSave = false
    this.clearTimer()
    this.beginEditing()
    this.text = current
    this.stable = current
    this.composing = true
    this.emit()
  }

  compositionEnd(value: string): void {
    this.composing = false
    this.text = value
    this.stable = value
    if (this.compositionInterrupted) {
      this.compositionInterrupted = false
      // Never sent by itself: it stays in the field for the user to save, fix or drop.
      if (this.isDirty()) {
        this.restored = true
        this.unconfirmed = true
      }
      this.settle()
      this.emit()
      return
    }
    this.held = false
    this.schedule()
    this.settle()
    this.emit()
  }

  /** `windowOnly`: the window lost focus, the field did not (no empty-title revert). */
  blur(options: { windowOnly?: boolean } = {}): void {
    this.focused = false
    if (this.composing) {
      this.compositionInterrupted = true
      this.emit()
      return
    }
    this.commit({ revertEmpty: !options.windowOnly })
    this.settle()
    this.emit()
  }

  /** A click while composing: the browser is about to end the composition with the pre-edit text. */
  interruptComposition(): void {
    if (this.composing) this.compositionInterrupted = true
  }

  // -- commands --------------------------------------------------------------

  /**
   * Sends the draft if it can be sent. With `revertEmpty`, an empty title goes back to the stored
   * one (Enter, blur, close); without it, it stays as it is (a tab switch must not undo typing).
   */
  commit(options: { revertEmpty?: boolean } = {}): CommitOutcome {
    const { revertEmpty = true } = options
    this.clearTimer()
    if (this.disposed) return 'clean'
    if (this.restored) return 'restored'
    if (this.failure && !this.inFlight) return 'failed'
    if (this.text === null) return 'clean'
    if (this.composing) return 'composing'
    if (!this.isDirty()) {
      this.held = false
      this.emit()
      return 'clean'
    }
    const value = this.rules.normalize(this.text)
    if (this.rules.revertEmpty && value === '') {
      if (!revertEmpty) {
        this.emit()
        return 'invalid'
      }
      const saved = this.env.readSaved()
      this.revertedTo = saved ?? null
      this.text = null
      this.stable = null
      this.failure = null
      this.held = false
      this.emit()
      return 'reverted'
    }
    if (this.rules.validate(this.text) !== null) {
      this.emit()
      return 'invalid'
    }
    if (this.env.isOffline()) {
      this.held = true
      this.emit()
      return 'held'
    }
    this.held = false
    if (this.inFlight) {
      this.queued = true
      this.emit()
      return 'sent'
    }
    this.send(value)
    return 'sent'
  }

  /** Sends the kept text again (the footer's Retry). */
  retry(): void {
    if (this.restored) {
      this.saveRestored()
      return
    }
    this.failure = null
    this.commit({ revertEmpty: false })
    this.emit()
  }

  /** The user chose to keep recovered text: it becomes a normal draft and is saved. */
  saveRestored(): void {
    this.restored = false
    this.conflict = false
    this.conflictAccepted = false
    this.unconfirmed = false
    this.commit({ revertEmpty: false })
    this.settle()
    this.emit()
  }

  /** Shows the recovered text instead of the newer stored value (still nothing is written). */
  useRecovered(): void {
    this.conflict = false
    this.conflictAccepted = true
    this.emit()
  }

  /** Drops the text. A write already in flight can't be recalled. */
  discard(): void {
    this.clearTimer()
    if (this.failure) this.env.withdrawFailure()
    this.text = null
    this.stable = null
    this.failure = null
    this.queued = false
    this.held = false
    this.restored = false
    this.conflict = false
    this.conflictAccepted = false
    this.composing = false
    this.compositionInterrupted = false
    this.unconfirmed = false
    this.revertedTo = null
    this.firstDirtyAt = null
    this.emit()
  }

  clearRevertedNotice(): void {
    if (this.revertedTo === null) return
    this.revertedTo = null
    this.emit()
  }

  /**
   * The form went away (closed, navigated elsewhere). Valid text is sent; anything else stays here
   * to be recovered. Text still being composed is NOT unconfirmed text to write: what was stable
   * before the composition is kept as recovered text.
   */
  detach(): CommitOutcome {
    this.focused = false
    if (this.disposed) return 'clean'
    if (this.composing) {
      this.composing = false
      this.text = this.stable
      if (this.text !== null && this.isDirty()) this.restored = true
      this.settle()
      this.emit()
      return 'composing'
    }
    const outcome = this.commit({ revertEmpty: true })
    this.settle()
    this.emit()
    return outcome
  }

  /** The store changed: a Retry or a refresh may have stored this text, or something newer. */
  syncSaved(): void {
    if (this.inFlight) return
    if (this.text === null) return
    const saved = this.env.readSaved()
    if (saved !== undefined && this.rules.normalize(this.text) === saved) {
      this.failure = null
      this.restored = false
      this.unconfirmed = false
      this.conflict = false
      this.conflictAccepted = false
      this.held = false
      this.settle()
      this.emit()
      return
    }
    // Saved and not touched since, still in the field: a newer stored value (another device) is
    // not something to overwrite on the next blur. The field simply follows it.
    if (this.untouchedSinceSave && !this.composing) {
      this.text = null
      this.stable = null
      this.untouchedSinceSave = false
      this.emit()
      return
    }
    if (this.restored && !this.conflictAccepted) {
      const conflict = saved !== undefined && saved !== this.base && saved !== this.sent
      if (conflict !== this.conflict) {
        this.conflict = conflict
        this.emit()
      }
    }
  }

  /** The connection is back: text held for it, or lost to the outage, is sent now. */
  online(): void {
    if (this.restored) return
    if (this.held || (this.failure && isRetryableKind(this.failure))) {
      this.held = false
      this.failure = null
      this.commit({ revertEmpty: false })
      this.emit()
    }
  }

  /** Sent or held right away (the tab is being hidden). Never reverts an empty title. */
  flush(): CommitOutcome {
    const outcome = this.commit({ revertEmpty: false })
    this.settle()
    this.emit()
    return outcome
  }

  /** What to keep across a reload; null when nothing needs keeping. */
  toRecord(): DraftRecord | null {
    const value = this.recoverableText
    if (value === null) return null
    if (!this.inFlight && !this.failure && !this.restored && !this.isDirty()) return null
    return { value, base: this.base, sent: this.sent }
  }

  /** Stops timers and ignores later answers (sign-out, tests). */
  dispose(): void {
    this.clearTimer()
    this.disposed = true
  }

  // -- internals -------------------------------------------------------------

  private beginEditing(): void {
    if (this.text === null) {
      this.base = this.env.readSaved() ?? null
      this.sent = this.base
    }
    if (this.restored) {
      this.restored = false
      this.unconfirmed = false
      this.conflict = false
      this.conflictAccepted = false
      this.base = this.env.readSaved() ?? null
      this.sent = this.base
    }
    if (this.failure) {
      this.failure = null
      this.env.withdrawFailure()
    }
  }

  private isDirty(): boolean {
    if (this.text === null) return false
    return this.rules.normalize(this.text) !== this.env.readSaved()
  }

  private clearTimer(): void {
    if (this.timer === null) return
    this.env.clearTimer(this.timer)
    this.timer = null
  }

  private schedule(): void {
    this.clearTimer()
    const { debounceMs, maxWaitMs } = this.rules
    if (!this.isDirty() || this.text === null) {
      this.firstDirtyAt = null
      return
    }
    if (debounceMs === null || this.composing || this.restored || this.failure) return
    if (this.rules.validate(this.text) !== null) return
    const now = this.env.now()
    this.firstDirtyAt ??= now
    const left = maxWaitMs === null ? debounceMs : maxWaitMs - (now - this.firstDirtyAt)
    this.timer = this.env.setTimer(
      () => {
        this.timer = null
        this.commit({ revertEmpty: false })
        this.emit()
      },
      Math.max(0, Math.min(debounceMs, left)),
    )
  }

  private send(value: string | null): void {
    this.inFlight = { value }
    this.sent = value
    this.firstDirtyAt = null
    this.emit()
    const finish = (result: Result) => this.onAnswered(value, result)
    let running: Promise<Result>
    try {
      running = this.env.write(value)
    } catch (error) {
      running = Promise.reject(error)
    }
    running.then(finish, (error: unknown) =>
      finish({
        ok: false,
        error: { kind: 'unknown', message: error instanceof Error ? error.message : String(error) },
      }),
    )
  }

  private onAnswered(value: string | null, result: Result): void {
    this.inFlight = null
    if (this.disposed) return
    if (result.ok) {
      this.base = value
      this.failure = null
      this.saves += 1
      this.untouchedSinceSave = this.text !== null && this.rules.normalize(this.text) === value
    } else if (this.text !== null && this.rules.normalize(this.text) !== value) {
      // Newer text exists: that is what counts now, so this attempt's Retry must not stay around.
      this.env.withdrawFailure()
    } else {
      this.failure = result.error
    }
    if (this.queued) {
      this.queued = false
      this.commit({ revertEmpty: false })
    } else if (result.ok) {
      this.schedule()
    }
    this.settle()
    this.emit()
  }

  /** The draft has done its job: the field goes back to following the store. */
  private settle(): void {
    if (
      this.text !== null &&
      !this.focused &&
      !this.composing &&
      !this.inFlight &&
      !this.failure &&
      !this.restored &&
      !this.isDirty()
    ) {
      this.text = null
      this.stable = null
      this.firstDirtyAt = null
    }
  }

  private computePhase(): DraftPhase {
    if (this.restored) return this.conflict ? 'conflict' : 'restored'
    if (this.inFlight) return 'saving'
    if (this.failure) return 'failed'
    if (this.text === null || !this.isDirty()) return 'clean'
    if (this.rules.validate(this.text) !== null) return 'invalid'
    if (this.held) return 'held'
    return 'pending'
  }

  private build(): DraftSnapshot {
    const phase = this.computePhase()
    return {
      text: this.conflict ? null : this.text,
      phase,
      composing: this.composing,
      error:
        this.failure?.message ??
        (this.text !== null && !this.restored && this.isDirty()
          ? this.rules.validate(this.text)
          : null),
      revertedTo: this.revertedTo,
      unconfirmed: this.unconfirmed,
      saves: this.saves,
    }
  }

  private emit(): void {
    const next = this.build()
    const current = this.snapshot
    if (
      next.text !== current.text ||
      next.phase !== current.phase ||
      next.composing !== current.composing ||
      next.error !== current.error ||
      next.revertedTo !== current.revertedTo ||
      next.unconfirmed !== current.unconfirmed ||
      next.saves !== current.saves
    ) {
      this.snapshot = next
    }
    this.env.onChange()
  }
}
