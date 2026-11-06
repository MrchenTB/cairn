/**
 * The Task Modal for an existing task is URL-driven: `?task=<taskId>` on ANY route, so refresh,
 * back/forward and deep links work. Other search params and the hash are always preserved.
 * Opening pushes a history entry and remembers how many task entries it stacked on top of the
 * page; closing walks back over exactly those, so the first Back afterwards leaves the page
 * instead of landing on an identical entry. A task entry that was not opened from the page
 * (deep link, reload into a new tab) is replaced instead.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'

export const TASK_PARAM = 'task'
/** History state key: consecutive task entries pushed since the page they were opened from. */
const DEPTH_KEY = 'cairnTaskDepth'

function depthOf(state: unknown, search: string): number {
  if (!new URLSearchParams(search).has(TASK_PARAM)) return 0
  const depth = (state as Record<string, unknown> | null)?.[DEPTH_KEY]
  return typeof depth === 'number' && Number.isInteger(depth) && depth > 0 ? depth : 0
}

/** Returns a `?…` search string with `task` set (or removed when taskId is null). */
export function withTaskParam(search: string, taskId: string | null): string {
  const params = new URLSearchParams(search)
  if (taskId) params.set(TASK_PARAM, taskId)
  else params.delete(TASK_PARAM)
  const next = params.toString()
  return next ? `?${next}` : ''
}

/** The task id in the URL, or null. */
export function useTaskParam(): string | null {
  const [searchParams] = useSearchParams()
  return searchParams.get(TASK_PARAM) || null
}

/**
 * Opens the Task Modal for a task on the current page (pushes history). Opening the task that is
 * already open does nothing, so Back never has to step through duplicate entries.
 */
export function useOpenTask(): (taskId: string) => void {
  const navigate = useNavigate()
  const { pathname, search, hash, state } = useLocation()
  return useCallback(
    (taskId: string) => {
      if (!taskId || new URLSearchParams(search).get(TASK_PARAM) === taskId) return
      navigate(
        { pathname, search: withTaskParam(search, taskId), hash },
        { preventScrollReset: true, state: { [DEPTH_KEY]: depthOf(state, search) + 1 } },
      )
    },
    [navigate, pathname, search, hash, state],
  )
}

/** Closes the Task Modal, keeping the rest of the URL (steps back over the entries it pushed). */
export function useCloseTask(): () => void {
  const navigate = useNavigate()
  const { pathname, search, hash, state, key } = useLocation()
  /** The entry a step back was already requested from: a second close must not step again. */
  const leavingRef = useRef<string | null>(null)
  // The step happened: Forward can bring this very entry (same key) back, and it can be left again.
  useEffect(() => {
    leavingRef.current = null
  }, [key])
  return useCallback(() => {
    if (!new URLSearchParams(search).has(TASK_PARAM)) return
    const depth = depthOf(state, search)
    if (depth > 0) {
      if (leavingRef.current === key) return
      leavingRef.current = key
      navigate(-depth)
      return
    }
    navigate(
      { pathname, search: withTaskParam(search, null), hash },
      { replace: true, preventScrollReset: true },
    )
  }, [navigate, pathname, search, hash, state, key])
}

/** Link target (`{ pathname, search }`) that opens a task over a given page, e.g. from search. */
export function taskLocation(pathname: string, taskId: string, search = '') {
  return { pathname, search: withTaskParam(search, taskId) }
}
