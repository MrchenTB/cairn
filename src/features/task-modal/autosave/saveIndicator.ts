/**
 * What the Task Modal's footer says about saving, and when. Quiet by design:
 * - a fast write (local mode, a good connection) never flashes "Saving…";
 * - once shown, "Saving…" stays long enough to be read;
 * - "Pending changes" only appears when text has really been waiting, not on every keystroke;
 * - "Saved" stays briefly and then gives way to the timestamps.
 * Problems (failed, offline, not valid) show at once and stay until they are over.
 */
import { useEffect, useRef, useState } from 'react'

export const SAVING_DELAY_MS = 400
export const SAVING_MIN_MS = 600
export const PENDING_DELAY_MS = 1000
export const SAVED_MS = 2000

export type SaveState =
  'idle' | 'pending' | 'saving' | 'saved' | 'offline' | 'invalid' | 'restored' | 'failed'

export interface SaveFacts {
  failed: boolean
  invalid: boolean
  restored: boolean
  offline: boolean
  saving: boolean
  pending: boolean
  /** Successful writes so far. */
  saves: number
}

/** The state these facts call for right now, most important first. */
export function rawSaveState(facts: SaveFacts): SaveState {
  if (facts.failed) return 'failed'
  if (facts.invalid) return 'invalid'
  if (facts.restored) return 'restored'
  if (facts.saving) return 'saving'
  if (facts.offline) return 'offline'
  if (facts.pending) return 'pending'
  return 'idle'
}

export function useSaveIndicator(facts: SaveFacts): SaveState {
  const raw = rawSaveState(facts)
  const [shown, setShown] = useState<SaveState>(() => (raw === 'pending' ? 'idle' : raw))
  const shownRef = useRef(shown)
  const savingShownAt = useRef<number | null>(null)
  const seenSaves = useRef(facts.saves)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const show = (state: SaveState) => {
      shownRef.current = state
      if (state === 'saving') savingShownAt.current = Date.now()
      setShown(state)
    }
    const after = (ms: number, run: () => void) => {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        run()
      }, ms)
    }
    const cancel = () => {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
    }
    const showSaved = () => {
      show('saved')
      after(SAVED_MS, () => show('idle'))
    }

    const wroteSomething = facts.saves !== seenSaves.current
    seenSaves.current = facts.saves

    switch (raw) {
      case 'failed':
      case 'invalid':
      case 'restored':
      case 'offline':
        cancel()
        show(raw)
        break
      case 'saving':
        if (shownRef.current !== 'saving') after(SAVING_DELAY_MS, () => show('saving'))
        break
      case 'pending':
        if (shownRef.current === 'pending') break
        if (shownRef.current !== 'saving') after(PENDING_DELAY_MS, () => show('pending'))
        break
      case 'idle': {
        if (shownRef.current === 'saving') {
          // Shown: stays for its minimum, then says how it ended.
          const left = SAVING_MIN_MS - (Date.now() - (savingShownAt.current ?? 0))
          after(Math.max(0, left), showSaved)
        } else if (wroteSomething) {
          cancel()
          showSaved()
        } else if (shownRef.current !== 'saved') {
          cancel()
          show('idle')
        }
        break
      }
    }
  }, [raw, facts.saves])

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  return shown
}
