/**
 * Route `handle` contract used by the shell. A route that should appear in the breadcrumb (and
 * the document title) declares `handle: { crumb }`.
 */
import type { Params, UIMatch } from 'react-router'
import type { WorkspaceData } from '@/domain/types'

export interface CrumbContext {
  params: Params
  data: WorkspaceData
}

export interface RouteHandle {
  /** Static label, or a label derived from params + workspace (null = skip this crumb). */
  crumb?: string | ((context: CrumbContext) => string | null | undefined)
}

export interface Crumb {
  label: string
  /** Pathname of the matched route (link target for ancestor crumbs). */
  to: string
}

function isRouteHandle(handle: unknown): handle is RouteHandle {
  return typeof handle === 'object' && handle !== null && 'crumb' in handle
}

/** Breadcrumb items for the current matches, outermost first. */
export function collectCrumbs(matches: readonly UIMatch[], data: WorkspaceData): Crumb[] {
  const crumbs: Crumb[] = []
  for (const match of matches) {
    if (!isRouteHandle(match.handle) || !match.handle.crumb) continue
    const { crumb } = match.handle
    const label = typeof crumb === 'function' ? crumb({ params: match.params, data }) : crumb
    if (label) crumbs.push({ label, to: match.pathname })
  }
  return crumbs
}
