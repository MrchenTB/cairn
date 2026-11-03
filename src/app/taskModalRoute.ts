/**
 * The Task Modal for an existing task is URL-driven: `?task=<taskId>` on ANY route, so refresh,
 * back/forward and deep links work. Other search params and the hash are always preserved.
 * Opening pushes a history entry; closing replaces it.
 */
import { useCallback } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'

export const TASK_PARAM = 'task'

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

/** Opens the Task Modal for a task on the current page (pushes history). */
export function useOpenTask(): (taskId: string) => void {
  const navigate = useNavigate()
  const { pathname, search, hash } = useLocation()
  return useCallback(
    (taskId: string) => {
      navigate(
        { pathname, search: withTaskParam(search, taskId), hash },
        { preventScrollReset: true },
      )
    },
    [navigate, pathname, search, hash],
  )
}

/** Closes the Task Modal, keeping the rest of the URL (replaces the history entry). */
export function useCloseTask(): () => void {
  const navigate = useNavigate()
  const { pathname, search, hash } = useLocation()
  return useCallback(() => {
    if (!new URLSearchParams(search).has(TASK_PARAM)) return
    navigate(
      { pathname, search: withTaskParam(search, null), hash },
      { replace: true, preventScrollReset: true },
    )
  }, [navigate, pathname, search, hash])
}

/** Link target (`{ pathname, search }`) that opens a task over a given page, e.g. from search. */
export function taskLocation(pathname: string, taskId: string, search = '') {
  return { pathname, search: withTaskParam(search, taskId) }
}
