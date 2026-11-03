import { useCallback, useLayoutEffect, useRef } from 'react'
import { useActions } from '@/data/hooks'
import type { Result, Task, TaskStatus } from '@/domain/types'
import { restoreFocus } from '@/lib/focus'
import { getInputModality } from '@/lib/inputModality'
import { notify } from '@/lib/notify'
import { staysInList } from './myTasksModel'
import { rowStatusButton } from './rowFocus'

/** Remote failures are toasted (with Retry) and rolled back by the store; a rejected change here. */
async function reportRejected(pending: Promise<Result>): Promise<boolean> {
  const result = await pending
  if (!result.ok && result.error.kind === 'validation') {
    notify.error('Couldn’t change the status', { description: result.error.message })
  }
  return result.ok
}

export interface TaskStatusChangeOptions {
  /** Task ids in the order the list shows them (keyboard focus moves to a neighbour). */
  visibleIds: readonly string[]
  /** The list keeps done tasks (All with "Show completed"); otherwise a done task leaves it. */
  showsDone: boolean
}

/**
 * In-place status change for a cross-project task list. The store updates every view at once;
 * when the change takes the row out of this list (marked done where done tasks are hidden), a
 * toast confirms it with Undo — only after the server accepted it — and keyboard focus moves to
 * the next row's status menu instead of falling to the page.
 */
export function useTaskStatusChange({ visibleIds, showsDone }: TaskStatusChangeOptions) {
  const actions = useActions()
  const latest = useRef({ visibleIds, showsDone })
  useLayoutEffect(() => {
    latest.current = { visibleIds, showsDone }
  })

  return useCallback(
    (task: Task, status: TaskStatus) => {
      const previous = task.status
      if (status === previous) return
      const { visibleIds: ids, showsDone: keepsDone } = latest.current
      const leaves = !staysInList(status, keepsDone)
      const index = ids.indexOf(task.id)
      const focusId = leaves ? (ids[index + 1] ?? ids[index - 1] ?? null) : task.id
      const keyboard = getInputModality() === 'keyboard'

      const pending = actions.updateTask(task.id, { status })
      // The menu gives focus back to its trigger; when that row left (or moved to another group)
      // the trigger is gone and focus would fall to <body>.
      if (keyboard && focusId) {
        requestAnimationFrame(() => restoreFocus(rowStatusButton(focusId)))
      }
      void reportRejected(pending).then((ok) => {
        if (!ok || !leaves) return
        notify.success('Marked as done', {
          description: task.title,
          action: {
            label: 'Undo',
            onClick: () => void reportRejected(actions.updateTask(task.id, { status: previous })),
          },
        })
      })
    },
    [actions],
  )
}
