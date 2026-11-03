import { isValidTimeZone } from '@/domain/dates'
import type { Preferences, WorkspaceData } from '@/domain/types'

/** Shared by every reset: frozen all the way down so no code can mutate it by accident. */
export const EMPTY_WORKSPACE: WorkspaceData = Object.freeze({
  projects: Object.freeze({}),
  phases: Object.freeze({}),
  tasks: Object.freeze({}),
  milestones: Object.freeze({}),
  dependencies: Object.freeze({}),
}) as WorkspaceData

/** Time zone of a first run whose browser reports none the runtime can use (docs §5). */
export const FALLBACK_TIME_ZONE = 'Asia/Taipei'

function reportedTimeZone(): unknown {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

/**
 * The zone saved on the account's first run (so every device agrees on "today"): the browser's
 * when it is a real IANA zone, else Asia/Taipei. Browsers can report zones they cannot use
 * themselves (Chrome says "Etc/Unknown" when the OS zone is not one it knows).
 */
export function initialTimeZone(candidate: unknown = reportedTimeZone()): string {
  return typeof candidate === 'string' && isValidTimeZone(candidate)
    ? candidate
    : FALLBACK_TIME_ZONE
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  sidebarCollapsed: false,
  timezone: initialTimeZone(),
  weekStartsOn: 1,
}
