import { useCallback, useEffect, useRef, useState } from 'react'
import { toAppError } from '@/data/errors'
import { useActions, useAuth, useSyncState, useWorkspaceStatus } from '@/data/hooks'
import type { AppError, Result } from '@/domain/types'

export interface WorkspaceBootstrap {
  /** What the main area should show. */
  status: 'loading' | 'ready' | 'error'
  error: AppError | null
  retry: () => void
  retrying: boolean
  /** True once the workspace has loaded at least once (feature hosts mount from then on). */
  loadedOnce: boolean
}

/**
 * Loads the workspace once per signed-in user (StrictMode-safe) and exposes a loading / ready /
 * error view model with Retry. Robust to a store that reports failure only through the Result.
 */
export function useWorkspaceBootstrap(): WorkspaceBootstrap {
  const auth = useAuth()
  const { status, loadError } = useWorkspaceStatus()
  const { lastLoadedAt } = useSyncState()
  const actions = useActions()
  const [failure, setFailure] = useState<AppError | null>(null)
  const [retrying, setRetrying] = useState(false)
  const startedFor = useRef<string | null>(null)

  const userKey = auth.status === 'signed_in' ? (auth.user?.id ?? 'local') : null

  const runLoad = useCallback(
    () =>
      actions
        .load()
        .catch((error: unknown): Result => ({ ok: false, error: toAppError(error) }))
        .then((result) => {
          if (!result.ok) setFailure(result.error)
        }),
    [actions],
  )

  useEffect(() => {
    if (!userKey) {
      startedFor.current = null
      return
    }
    if (startedFor.current === userKey) return
    startedFor.current = userKey
    // Already loading/loaded (e.g. after a hot reload): don't start a second load.
    if (status !== 'idle') return
    void runLoad()
  }, [userKey, status, runLoad])

  const retry = useCallback(() => {
    setFailure(null)
    setRetrying(true)
    void runLoad().finally(() => setRetrying(false))
  }, [runLoad])

  const view: WorkspaceBootstrap['status'] =
    status === 'ready' ? 'ready' : status === 'error' || failure ? 'error' : 'loading'

  return {
    status: view,
    error: loadError ?? failure,
    retry,
    retrying,
    loadedOnce: status === 'ready' || lastLoadedAt !== null,
  }
}
