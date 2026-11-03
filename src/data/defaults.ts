import type { Preferences, WorkspaceData } from '@/domain/types'

/** Shared by every reset: frozen all the way down so no code can mutate it by accident. */
export const EMPTY_WORKSPACE: WorkspaceData = Object.freeze({
  projects: Object.freeze({}),
  phases: Object.freeze({}),
  tasks: Object.freeze({}),
  milestones: Object.freeze({}),
  dependencies: Object.freeze({}),
}) as WorkspaceData

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Taipei'
  } catch {
    return 'Asia/Taipei'
  }
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  sidebarCollapsed: false,
  timezone: browserTimeZone(),
  weekStartsOn: 1,
}
