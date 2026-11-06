import { useSyncExternalStore } from 'react'
import { useDataMode, useSyncState } from '@/data/hooks'
import { taskDrafts } from '@/features/task-modal/autosave/taskDrafts'
import { useUnloadPrompt } from '@/features/task-modal/useUnloadPrompt'

const hasUnsavedText = () => taskDrafts.hasUnsavedText()

/**
 * Closing or reloading the tab asks first while something could be lost: task text not saved yet
 * (both modes), and in cloud mode writes still being saved or waiting for Retry. Local writes are
 * synchronous, so without unsaved text local mode never prompts. Separate from AppShell so sync
 * changes re-render only this null component.
 */
export function UnsavedWritesGuard() {
  const mode = useDataMode()
  const sync = useSyncState()
  const unsavedText = useSyncExternalStore(taskDrafts.subscribe, hasUnsavedText)
  useUnloadPrompt(unsavedText || (mode === 'supabase' && (sync.pending > 0 || sync.canRetry)))
  return null
}
