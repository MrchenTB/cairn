/**
 * Global search over projects, tasks and milestones (client-side, whole workspace).
 * Case-insensitive, NFKC-normalised, works for CJK text (substring matching, no word
 * segmentation needed). Every whitespace-separated term must match.
 */
import type { Milestone, Project, Task, WorkspaceData } from './types'
import { notImplemented } from './_todo'

export type SearchResult =
  | { kind: 'project'; id: string; score: number; project: Project }
  | { kind: 'task'; id: string; score: number; task: Task; project: Project; parent: Task | null }
  | { kind: 'milestone'; id: string; score: number; milestone: Milestone; project: Project }

/**
 * Ranking (higher first): exact title > title prefix > word-prefix > title substring >
 * description-only match. Open tasks rank above done ones; items of archived projects rank
 * lowest. Empty query → []. Default limit 50.
 */
export function searchWorkspace(
  data: WorkspaceData,
  query: string,
  options?: { limit?: number },
): SearchResult[] {
  return notImplemented('searchWorkspace' + Object.keys(data).length + query + options?.limit)
}
