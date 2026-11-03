/**
 * Bridge between the planner (plain async code, callable from any view) and the one
 * <RescheduleDialogHost/> mounted in the app shell. `requestReschedule` shows the preview and
 * resolves once the user cancelled or the chosen write finished. Only one preview is open at a
 * time: a new request cancels the previous one.
 */
import { create } from 'zustand'
import type { AppError, Result, ScheduleChange } from '@/domain/types'
import type { ScheduleChangeSource } from './plannerTypes'

export type RescheduleRequest =
  /** Auto mode: the user changed a task's dates and successors must move. */
  | { kind: 'change'; projectId: string; change: ScheduleChange; source: ScheduleChangeSource }
  /** Auto mode: a newly drawn dependency is already violated. */
  | { kind: 'dependency'; projectId: string; dependencyId: string }
  /** "Resolve all…": move every successor that starts too early. */
  | { kind: 'resolve'; projectId: string }

/** 'only' = write just the user's change; 'apply' = the change plus every shift, atomically. */
export type RescheduleDecision = 'only' | 'apply'

/** Performs the write for a decision. `writes` is exactly what the dialog showed. */
export type RescheduleExecutor = (
  decision: RescheduleDecision,
  writes: readonly ScheduleChange[],
) => Promise<Result>

export type RescheduleOutcome =
  | { status: 'cancelled' }
  | { status: 'written'; decision: RescheduleDecision }
  /** Remote failure: the store already rolled back and showed a toast with Retry. */
  | { status: 'failed'; error: AppError }

export interface ActiveReschedule {
  id: number
  request: RescheduleRequest
  execute: RescheduleExecutor
  /** Closes the dialog and resolves the request (idempotent). */
  settle: (outcome: RescheduleOutcome) => void
}

interface RescheduleState {
  active: ActiveReschedule | null
}

export const useRescheduleStore = create<RescheduleState>(() => ({ active: null }))

let nextId = 1

export function requestReschedule(
  request: RescheduleRequest,
  execute: RescheduleExecutor,
): Promise<RescheduleOutcome> {
  useRescheduleStore.getState().active?.settle({ status: 'cancelled' })
  return new Promise((resolve) => {
    const id = nextId++
    let settled = false
    const settle = (outcome: RescheduleOutcome) => {
      if (settled) return
      settled = true
      if (useRescheduleStore.getState().active?.id === id) useRescheduleStore.setState({ active: null })
      resolve(outcome)
    }
    useRescheduleStore.setState({ active: { id, request, execute, settle } })
  })
}
