/** Shared state of one List view (avoids threading the same props through every row). */
import { createContext, useContext } from 'react'
import type { ISODate, Phase, Project, Task } from '@/domain/types'
import type { TaskCommands } from './TaskRow'
import type { ListDragState } from './useListDnd'

export interface CreateTaskRequest {
  title: string
  phaseId: string | null
  parentTaskId: string | null
  /** The task to insert after (the group's / parent's last one); null = end of the project. */
  afterId: string | null
}

export interface PhaseCommands {
  /** Resolves an error message to show inline, or null when saved / reported by the store. */
  rename(phase: Phase, name: string): Promise<string | null>
  move(phase: Phase, delta: -1 | 1): void
  remove(phase: Phase): void
  addMilestone(phaseId: string | null): void
}

export interface ListContextValue {
  project: Project
  today: ISODate
  phases: readonly Phase[]
  /** Stable for the life of the view (rows are memoised on it). */
  commands: TaskCommands
  phaseCommands: PhaseCommands
  /** Whether "Move up" / "Move down" have somewhere to go among the task's siblings. */
  moveRange(task: Task): { canMoveUp: boolean; canMoveDown: boolean }
  /** Parents whose subtasks are shown. */
  expanded: ReadonlySet<string>
  /** Which inline "Add …" row is open (see addRowKey), if any. */
  editingRow: string | null
  setEditingRow(key: string | null): void
  /** Creates a task at the end of its group / parent; resolves an inline error or null. */
  createTask(request: CreateTaskRequest): Promise<string | null>
  openMilestone(milestoneId: string): void
  drag: ListDragState | null
  /** The OS asks for reduced motion: rows don't animate while they make room. */
  reducedMotion: boolean
}

export const ListContext = createContext<ListContextValue | null>(null)

export function useListContext(): ListContextValue {
  const value = useContext(ListContext)
  if (!value) throw new Error('useListContext must be used inside <ListContext.Provider>')
  return value
}

/** Keys of the inline add rows: a group's "Add task" or a parent's "Add subtask". */
export const addRowKey = {
  group: (containerId: string) => `task:${containerId}`,
  subtask: (parentTaskId: string) => `subtask:${parentTaskId}`,
  phase: 'phase',
} as const
