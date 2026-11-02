/**
 * Global UI state shared across features (dialogs and overlays that can be opened from
 * anywhere). Editing an EXISTING task is URL-driven (`?task=<id>`, see ./taskModalRoute.ts)
 * so refresh/back/deep links work; creating a task uses `openNewTask`.
 */
import { create } from 'zustand'
import type { ISODate, TaskPriority, TaskStatus } from '@/domain/types'

export interface NewTaskDefaults {
  /** Pre-selected project. When omitted the modal asks the user to pick one. */
  projectId?: string | null
  phaseId?: string | null
  /** Create as a subtask of this task. */
  parentTaskId?: string | null
  status?: TaskStatus
  priority?: TaskPriority
  startDate?: ISODate | null
  dueDate?: ISODate | null
  /** Position among siblings (default: end). */
  placement?: { afterId?: string | null; beforeId?: string | null }
}

export type ProjectDialogState = { mode: 'create' } | { mode: 'edit'; projectId: string }

export type MilestoneDialogState =
  | { mode: 'create'; projectId: string; phaseId?: string | null; date?: ISODate | null }
  | { mode: 'edit'; milestoneId: string }

interface UIState {
  searchOpen: boolean
  /** non-null → the Task Modal is open in "create" mode with these defaults */
  newTask: NewTaskDefaults | null
  projectDialog: ProjectDialogState | null
  milestoneDialog: MilestoneDialogState | null
  shortcutsOpen: boolean

  setSearchOpen(open: boolean): void
  openNewTask(defaults?: NewTaskDefaults): void
  closeNewTask(): void
  openProjectDialog(state: ProjectDialogState): void
  closeProjectDialog(): void
  openMilestoneDialog(state: MilestoneDialogState): void
  closeMilestoneDialog(): void
  setShortcutsOpen(open: boolean): void
}

export const useUIStore = create<UIState>()((set) => ({
  searchOpen: false,
  newTask: null,
  projectDialog: null,
  milestoneDialog: null,
  shortcutsOpen: false,

  setSearchOpen: (open) => set({ searchOpen: open }),
  openNewTask: (defaults = {}) => set({ newTask: defaults, searchOpen: false }),
  closeNewTask: () => set({ newTask: null }),
  openProjectDialog: (state) => set({ projectDialog: state, searchOpen: false }),
  closeProjectDialog: () => set({ projectDialog: null }),
  openMilestoneDialog: (state) => set({ milestoneDialog: state, searchOpen: false }),
  closeMilestoneDialog: () => set({ milestoneDialog: null }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
}))
