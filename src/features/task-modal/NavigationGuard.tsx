import { useCallback, useEffect, type RefObject } from 'react'
import { useBlocker, type BlockerFunction } from 'react-router'
import { TASK_PARAM } from '@/app/taskModalRoute'
import { confirmDiscard } from './discard'

export interface NavigationGuardProps {
  /** The task being edited: navigations that keep `?task=<taskId>` are never blocked. */
  taskId: string
  /** Set to true right before a navigation the modal itself already confirmed. */
  allowRef: RefObject<boolean>
}

/**
 * Mounted only while the edit form has unsaved changes. Back/forward, search results and links
 * that would leave this task first ask "Discard changes?"; closing or reloading the tab gets the
 * browser's own prompt.
 */
export function NavigationGuard({ taskId, allowRef }: NavigationGuardProps) {
  const shouldBlock = useCallback<BlockerFunction>(
    ({ nextLocation }) => {
      if (allowRef.current) return false
      return new URLSearchParams(nextLocation.search).get(TASK_PARAM) !== taskId
    },
    [taskId, allowRef],
  )
  const blocker = useBlocker(shouldBlock)

  useEffect(() => {
    if (blocker.state !== 'blocked') return undefined
    let active = true
    void confirmDiscard().then((discard) => {
      if (!active) return
      if (discard) {
        allowRef.current = true
        blocker.proceed()
      } else {
        blocker.reset()
      }
    })
    return () => {
      active = false
    }
  }, [blocker, allowRef])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Legacy browsers need a return value to show the prompt.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  return null
}
