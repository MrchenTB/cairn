/**
 * App keyboard shortcuts (docs/architecture.md §7):
 * ⌘/Ctrl+K search · C new task · [ toggle sidebar · G then O/M/P/T navigate · ? shortcuts help.
 * Esc is handled by each overlay (Radix). Nothing fires while typing in a field or while a
 * dialog/menu owns focus — except ⌘K, which toggles search from anywhere.
 *
 * Features register view-scoped shortcuts with `useViewShortcut` (e.g. project views 1/2/3,
 * Gantt T = today); they are active while the component is mounted, win over global bindings,
 * and are listed under "Current view" in the shortcuts dialog.
 */
import { useMatch, useNavigate } from 'react-router'
import { useHotkeys, type HotkeyOptions } from '@/lib/keyboard'
import { useSetSidebarCollapsed, useSidebarCollapsed } from './uiPrefs'
import { useUIStore } from './uiStore'

/** Bindings used by the shell (also shown in tooltips). */
export const SHORTCUTS = {
  search: 'mod+k',
  newTask: 'c',
  toggleSidebar: '[',
  help: '?',
  goOverview: 'g o',
  goMyTasks: 'g m',
  goProjects: 'g p',
  goTimeline: 'g t',
} as const

/** The current project id when the URL is inside /projects/:projectId. */
export function useCurrentProjectId(): string | undefined {
  return useMatch('/projects/:projectId/*')?.params.projectId
}

/** Registers the global shortcuts. Mounted once by the AppShell. */
export function useGlobalShortcuts(): void {
  const navigate = useNavigate()
  const projectId = useCurrentProjectId()
  const collapsed = useSidebarCollapsed()
  const setCollapsed = useSetSidebarCollapsed()
  const searchOpen = useUIStore((s) => s.searchOpen)

  useHotkeys(
    SHORTCUTS.search,
    () => {
      const ui = useUIStore.getState()
      ui.setSearchOpen(!ui.searchOpen)
    },
    { allowInInput: true, allowInModal: true, description: 'Search', group: 'General' },
  )
  // Safety net while search is open: Radix overlays handle Esc themselves (and mark the event
  // handled, so this never runs twice); this only closes an overlay that did not.
  useHotkeys('escape', () => useUIStore.getState().setSearchOpen(false), {
    enabled: searchOpen,
    allowInInput: true,
    allowInModal: true,
  })
  useHotkeys(
    SHORTCUTS.newTask,
    () => useUIStore.getState().openNewTask(projectId ? { projectId } : {}),
    { description: 'New task', group: 'General' },
  )
  useHotkeys(SHORTCUTS.toggleSidebar, () => setCollapsed(!collapsed), {
    description: 'Toggle sidebar',
    group: 'General',
  })
  useHotkeys(SHORTCUTS.help, () => useUIStore.getState().setShortcutsOpen(true), {
    description: 'Keyboard shortcuts',
    group: 'General',
  })
  useHotkeys(SHORTCUTS.goOverview, () => navigate('/overview'), {
    description: 'Go to Overview',
    group: 'Navigation',
  })
  useHotkeys(SHORTCUTS.goMyTasks, () => navigate('/my-tasks'), {
    description: 'Go to My Tasks',
    group: 'Navigation',
  })
  useHotkeys(SHORTCUTS.goProjects, () => navigate('/projects'), {
    description: 'Go to Projects',
    group: 'Navigation',
  })
  useHotkeys(SHORTCUTS.goTimeline, () => navigate('/timeline'), {
    description: 'Go to Timeline',
    group: 'Navigation',
  })
}

export type ViewShortcutOptions = Omit<HotkeyOptions, 'group'> & {
  /** Shown in the shortcuts dialog under "Current view". */
  description: string
}

/**
 * Registers a shortcut for the lifetime of the calling component (a page or view). Same typing /
 * modal rules as global shortcuts; the most recently mounted registration wins.
 *
 *   useViewShortcut('t', scrollToToday, { description: 'Scroll to today' })
 */
export function useViewShortcut(
  keys: string | string[],
  handler: (event: KeyboardEvent) => void,
  options: ViewShortcutOptions,
): void {
  useHotkeys(keys, handler, { ...options, group: 'Current view' })
}
