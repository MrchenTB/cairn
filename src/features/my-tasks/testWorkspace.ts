/**
 * DOM-test helper for the Overview and My Tasks (never imported by app code): stores rows in the
 * local repository and loads them through the workspace store, so the views read real store
 * data and status changes go through the real actions (and `window.__cairnTest` can fail them).
 */
import { DEFAULT_PREFERENCES } from '@/data/defaults'
import { LOCAL_STORAGE_KEY } from '@/data/localRepository'
import { useWorkspaceStore } from '@/data/store'
import { addDays, todayInTimeZone } from '@/domain/dates'
import type { Milestone, Phase, Preferences, Project, Task } from '@/domain/types'

export const TEST_TIME_ZONE = 'Asia/Taipei'

/** Today in the test time zone, and a date `days` away from it. */
export function testToday(days = 0): string {
  return addDays(todayInTimeZone(TEST_TIME_ZONE), days)
}

function byId<T extends { id: string }>(rows: readonly T[] = []): Record<string, T> {
  return Object.fromEntries(rows.map((row) => [row.id, row]))
}

export async function seedWorkspace(
  rows: {
    projects?: Project[]
    phases?: Phase[]
    tasks?: Task[]
    milestones?: Milestone[]
  },
  preferences: Partial<Preferences> = {},
): Promise<void> {
  localStorage.setItem(
    LOCAL_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      projects: byId(rows.projects),
      phases: byId(rows.phases),
      tasks: byId(rows.tasks),
      milestones: byId(rows.milestones),
      dependencies: {},
      preferences: { ...DEFAULT_PREFERENCES, timezone: TEST_TIME_ZONE, ...preferences },
    }),
  )
  const result = await useWorkspaceStore.getState().actions.load()
  if (!result.ok) throw new Error(result.error.message)
}

/** Clears storage, the store and the local repository's test settings (beforeEach). */
export function resetWorkspace(): void {
  localStorage.clear()
  window.__cairnTest?.failNextWrites(0)
  window.__cairnTest?.setLatency(0)
  useWorkspaceStore.getState().actions.reset()
}
