/**
 * The app's draft manager, wired to the real stores (the logic lives in DraftManager and TextDraft;
 * this file only connects them). Drafts follow the signed-in account, re-check themselves when the
 * store changes, and are sent when the tab is hidden or the connection comes back.
 */
import { useSyncExternalStore } from 'react'
import { openTaskFromAnywhere } from '@/app/taskModalRoute'
import type { WriteOptions } from '@/data/contracts'
import { getWorkspaceActions, useAuthStore, useWorkspaceStore } from '@/data/store'
import { notify } from '@/lib/notify'
import { DraftManager, type DraftSummary } from './draftManager'
import type { TextField } from './textDraft'

const TITLE_IN_MESSAGE_MAX = 60

/** How a failed write from the Task Modal is reported: which task, which field, and a way back. */
export function taskWriteOptions(
  taskId: string,
  taskTitle: string,
  fieldName: string,
): WriteOptions {
  const title =
    taskTitle.length > TITLE_IN_MESSAGE_MAX
      ? `${taskTitle.slice(0, TITLE_IN_MESSAGE_MAX)}…`
      : taskTitle
  return {
    label: `save the ${fieldName} of “${title}”`,
    secondaryAction: { label: 'Open', onClick: () => openTaskFromAnywhere(taskId) },
  }
}

function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function announceRecovered(drafts: readonly DraftSummary[]): void {
  const [first] = drafts
  if (!first) return
  notify.info('Unsaved text recovered', {
    description:
      drafts.length === 1
        ? `The ${first.field} of “${first.taskTitle}” wasn’t saved before this page reloaded.`
        : `${drafts.length} texts weren’t saved before this page reloaded. They’re listed under the sync status in the sidebar.`,
    duration: 10_000,
    action: first.taskExists
      ? { label: 'Open', onClick: () => openTaskFromAnywhere(first.taskId) }
      : undefined,
  })
}

/** The app's drafts. */
export const taskDrafts = new DraftManager({
  readTask: (taskId) => {
    const { tasks } = useWorkspaceStore.getState().data
    return Object.hasOwn(tasks, taskId) ? tasks[taskId] : undefined
  },
  isReady: () => useWorkspaceStore.getState().status === 'ready',
  write: (taskId, patch, field: TextField) => {
    const { tasks } = useWorkspaceStore.getState().data
    const title = Object.hasOwn(tasks, taskId) ? tasks[taskId].title : ''
    return getWorkspaceActions().updateTask(taskId, patch, taskWriteOptions(taskId, title, field))
  },
  withdrawFailure: (taskId, field) => getWorkspaceActions().withdrawFailedChanges(taskId, [field]),
  isOffline: () => {
    const { mode, sync } = useWorkspaceStore.getState()
    return mode === 'supabase' && !sync.online
  },
  storage: sessionStore,
  now: () => Date.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  onRecovered: announceRecovered,
})

/** Text that was not saved and is no longer on screen (see DraftManager). */
export function useUnsavedDrafts(): readonly DraftSummary[] {
  return useSyncExternalStore(taskDrafts.subscribe, taskDrafts.getOutstanding)
}

const lifetime = new AbortController()
import.meta.hot?.dispose(() => lifetime.abort())

const scopeOfAuth = () => {
  const { status, user } = useAuthStore.getState()
  return status === 'signed_in' && user ? user.id : null
}

taskDrafts.setScope(scopeOfAuth())
lifetime.signal.addEventListener(
  'abort',
  useAuthStore.subscribe(() => {
    taskDrafts.setScope(scopeOfAuth())
  }),
  { once: true },
)
lifetime.signal.addEventListener(
  'abort',
  useWorkspaceStore.subscribe((state, previous) => {
    if (state.data !== previous.data || state.status !== previous.status) {
      taskDrafts.storeChanged()
    }
    if (state.sync.online && !previous.sync.online) taskDrafts.online()
  }),
  { once: true },
)

if (typeof document !== 'undefined') {
  const flush = () => taskDrafts.flushAll()
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState === 'hidden') flush()
    },
    { signal: lifetime.signal },
  )
  window.addEventListener('pagehide', flush, { signal: lifetime.signal })
}
