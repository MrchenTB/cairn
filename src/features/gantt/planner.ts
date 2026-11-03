/**
 * Single entry point for changing task dates from ANY view (Gantt drag/resize, Task Modal,
 * List date fields) so the Manual/Auto dependency rules behave identically everywhere.
 *
 * Contract (implemented by the Gantt feature; this file starts as a minimal stub):
 * - Manual mode (project.scheduleMode === 'manual'): write the change; if it creates dependency
 *   conflicts, show a warning toast with a "Review" action that opens the auto-resolve preview.
 * - Auto mode: if the change requires moving successors (computeAutoSchedule), open the preview
 *   dialog (task, old → new dates, Δ days). Confirm → ONE atomic applySchedule([change, ...shifts]);
 *   "Only move this task" → applySchedule([change]); Cancel → nothing is written.
 * - Resolves `true` when something was written successfully, `false` when the user cancelled,
 *   validation failed (e.g. due < start) or the write failed (the store already toasted it).
 */
import { getWorkspaceActions } from '@/data/store'
import type { ScheduleChange } from '@/domain/types'

export type ScheduleChangeSource = 'gantt' | 'modal' | 'list' | 'board' | 'timeline'

export async function planScheduleChange(
  change: ScheduleChange,
  options: { source?: ScheduleChangeSource } = {},
): Promise<boolean> {
  void options
  const result = await getWorkspaceActions().applySchedule([change])
  return result.ok
}
