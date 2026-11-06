/**
 * Presentation helpers for the search overlay: grouping the ranked results by kind and the URLs
 * a result opens. The matching and ranking itself lives in `@/domain/search`.
 */
import { taskLocation } from '@/app/taskModalRoute'
import { getProjectView } from '@/app/viewPrefs'
import type { SearchResult } from '@/domain/search'

export type ProjectHit = Extract<SearchResult, { kind: 'project' }>
export type TaskHit = Extract<SearchResult, { kind: 'task' }>
export type MilestoneHit = Extract<SearchResult, { kind: 'milestone' }>

export interface ResultGroups {
  projects: ProjectHit[]
  tasks: TaskHit[]
  milestones: MilestoneHit[]
}

/** Splits the ranked list by kind, keeping the rank order inside each group. */
export function groupResults(results: readonly SearchResult[]): ResultGroups {
  const groups: ResultGroups = { projects: [], tasks: [], milestones: [] }
  for (const result of results) {
    if (result.kind === 'project') groups.projects.push(result)
    else if (result.kind === 'task') groups.tasks.push(result)
    else groups.milestones.push(result)
  }
  return groups
}

/** `/projects/:id/<view>`: the view last used for that project on this device (default List). */
export function projectPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/${getProjectView(projectId)}`
}

/** Where a result opens: projects and tasks in their remembered view, milestones on the Gantt. */
export function resultLocation(result: SearchResult): { pathname: string; search: string } {
  switch (result.kind) {
    case 'project':
      return { pathname: projectPath(result.project.id), search: '' }
    case 'task':
      return taskLocation(projectPath(result.project.id), result.task.id)
    case 'milestone':
      return { pathname: `/projects/${encodeURIComponent(result.project.id)}/gantt`, search: '' }
  }
}
