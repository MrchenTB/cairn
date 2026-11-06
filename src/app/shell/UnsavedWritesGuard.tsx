import { useDataMode, useSyncState } from '@/data/hooks'
import { useUnloadPrompt } from '@/features/task-modal/useUnloadPrompt'

/**
 * Cloud mode only: closing or reloading the tab while writes are still being saved asks first.
 * Local writes are synchronous, so local mode never prompts. Separate from AppShell so sync
 * changes re-render only this null component.
 */
export function UnsavedWritesGuard() {
  const mode = useDataMode()
  const sync = useSyncState()
  useUnloadPrompt(mode === 'supabase' && sync.pending > 0)
  return null
}
