/**
 * A create that failed keeps its form open with everything typed (nothing is lost), while the
 * store's toast and the sidebar indicator offer Retry. If that Retry stores the entity, the form's
 * job is done: left as it is, a second "Create" would add the same thing twice.
 *
 * `useRetryFulfilment` recognises that moment. After a retryable failure the form calls `arm()`
 * with a matcher for what it tried to create; when an entity that did not exist at that moment and
 * satisfies the matcher shows up (the Retry's optimistic insert, or the store's refresh finding the
 * write was applied after all), `onFulfilled` is called once. The form disarms itself as soon as
 * the user changes anything or submits again, because it no longer stands for the failed attempt.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useWorkspaceStore } from '@/data/store'
import type { Milestone, Task } from '@/domain/types'

export interface RetryFulfilment<T> {
  /** Right after a retryable failure: what the failed create was (matched against new entities). */
  arm: (matches: (entity: T) => boolean) => void
  /** The form moved on (edited, submitted again): a later Retry no longer concerns it. */
  disarm: () => void
}

interface Armed<T> {
  /** Ids that existed when the failure was rolled back (a Retry's insert is not among them). */
  known: ReadonlySet<string>
  matches: (entity: T) => boolean
}

/** The workspace's tasks right now (not a hook: read at the moment a failure is handled). */
export function currentTasks(): readonly Task[] {
  return Object.values(useWorkspaceStore.getState().data.tasks)
}

/** The workspace's milestones right now (see currentTasks). */
export function currentMilestones(): readonly Milestone[] {
  return Object.values(useWorkspaceStore.getState().data.milestones)
}

/**
 * @param entities the live list the form's entity would appear in (from a data hook)
 * @param readCurrent the same list read straight from the store (post-rollback snapshot)
 * @param onFulfilled called once with the entity a Retry (or a refresh) stored
 */
export function useRetryFulfilment<T extends { id: string }>(
  entities: readonly T[],
  readCurrent: () => readonly T[],
  onFulfilled: (entity: T) => void,
): RetryFulfilment<T> {
  const armed = useRef<Armed<T> | null>(null)
  const latest = useRef({ readCurrent, onFulfilled })
  useLayoutEffect(() => {
    latest.current = { readCurrent, onFulfilled }
  })

  const arm = useCallback((matches: (entity: T) => boolean) => {
    // The store has already rolled the failed insert back when the action's result arrives.
    armed.current = {
      known: new Set(latest.current.readCurrent().map((entity) => entity.id)),
      matches,
    }
  }, [])
  const disarm = useCallback(() => {
    armed.current = null
  }, [])

  useEffect(() => {
    const current = armed.current
    if (!current) return
    const stored = entities.find(
      (entity) => !current.known.has(entity.id) && current.matches(entity),
    )
    if (!stored) return
    armed.current = null
    latest.current.onFulfilled(stored)
  }, [entities])

  return useMemo(() => ({ arm, disarm }), [arm, disarm])
}
