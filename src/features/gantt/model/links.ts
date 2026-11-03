/**
 * Dependency lines for the SVG layer: which links are drawn (both tasks have a visible row and
 * a visual, and the link crosses the rendered rows) and their routes. Geometry comes from
 * row index × row height and the timeline geometry only — never from the DOM.
 */
import type { Dependency } from '@/domain/types'
import { linkRoute, rowCenterY, type LinkRoute, type SpanAnchors } from './geometry'

export interface LinkEndpoint {
  rowIndex: number
  anchors: SpanAnchors
}

export interface LinkView {
  id: string
  predecessorId: string
  successorId: string
  conflict: boolean
  route: LinkRoute
}

export interface BuildLinksOptions {
  dependencies: readonly Dependency[]
  /** Visible row + anchors of a task, or null when it has no row (collapsed) or no visual. */
  endpoint: (taskId: string) => LinkEndpoint | null
  /** Dependency ids currently in conflict (findConflicts). */
  conflictIds: ReadonlySet<string>
  /** Rendered rows (inclusive); links entirely above or below are skipped. */
  firstRow: number
  lastRow: number
}

export function buildLinkViews({
  dependencies,
  endpoint,
  conflictIds,
  firstRow,
  lastRow,
}: BuildLinksOptions): LinkView[] {
  const views: LinkView[] = []
  for (const dependency of dependencies) {
    const from = endpoint(dependency.predecessorId)
    if (!from) continue
    const to = endpoint(dependency.successorId)
    if (!to) continue
    const top = Math.min(from.rowIndex, to.rowIndex)
    const bottom = Math.max(from.rowIndex, to.rowIndex)
    if (bottom < firstRow || top > lastRow) continue
    views.push({
      id: dependency.id,
      predecessorId: dependency.predecessorId,
      successorId: dependency.successorId,
      conflict: conflictIds.has(dependency.id),
      route: linkRoute(
        { x: from.anchors.outX, y: rowCenterY(from.rowIndex) },
        { x: to.anchors.inX, y: rowCenterY(to.rowIndex) },
      ),
    })
  }
  return views
}
