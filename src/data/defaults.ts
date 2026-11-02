import type { Preferences, WorkspaceData } from '@/domain/types'

export const EMPTY_WORKSPACE: WorkspaceData = Object.freeze({
  projects: {},
  phases: {},
  tasks: {},
  milestones: {},
  dependencies: {},
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
