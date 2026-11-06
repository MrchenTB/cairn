/**
 * Pure helpers that turn List-view drag gestures (and their menu equivalents) into
 * `MoveTaskInput`s. Views only pass neighbours AS SEEN in the view (afterId / beforeId); the
 * store resolves the placement against the project's whole ordering space.
 *
 * Containers
 * - top-level tasks live in one container per outline group: `group:none` (no phase) and
 *   `group:<phaseId>`; dragging between them changes the phase (subtasks follow their parent);
 * - subtasks live in `parent:<taskId>` and are only reordered among their siblings
 *   (no cross-parent drag in V1 — the Task Modal changes the parent).
 *
 * A move into an EMPTY group has no neighbours in the view: the input then carries neither
 * afterId nor beforeId and the caller decides (the List view keeps the task's current place in
 * the project order, so other views such as the Board don't reshuffle).
 */
import type { MoveTaskInput } from '@/domain/types'

/** containerId → item ids in display order. */
export type Containers = Readonly<Record<string, readonly string[]>>

/** Pointer travel (px, either axis) needed after a preview container switch before the next. */
export const SWITCH_DISTANCE = 4

/**
 * May the drag preview switch container again? Only once the pointer itself travelled
 * `distance` px (either axis) from where the last switch happened (`last` = the drag offset
 * then; null = no switch yet). A switch moves rows, which can change what is under a still
 * pointer; following that would bounce the row between two groups forever.
 */
export function mayPreviewSwitch(
  last: { x: number; y: number } | null,
  delta: { x: number; y: number },
  distance = SWITCH_DISTANCE,
): boolean {
  if (!last) return true
  return Math.abs(delta.x - last.x) >= distance || Math.abs(delta.y - last.y) >= distance
}

const GROUP_PREFIX = 'group:'
const PARENT_PREFIX = 'parent:'
const NO_PHASE = 'none'

/** Container of a phase group's top-level tasks (`null` = "No phase"). */
export function groupContainerId(phaseId: string | null): string {
  return `${GROUP_PREFIX}${phaseId ?? NO_PHASE}`
}

/** Container of a parent's subtasks. */
export function subtaskContainerId(parentTaskId: string): string {
  return `${PARENT_PREFIX}${parentTaskId}`
}

export function isGroupContainerId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(GROUP_PREFIX)
}

/** The phase of a group container (`null` for "No phase"); undefined for other ids. */
export function phaseIdOfContainer(containerId: string): string | null | undefined {
  if (!isGroupContainerId(containerId)) return undefined
  const rest = containerId.slice(GROUP_PREFIX.length)
  return rest === NO_PHASE ? null : rest
}

/** The container holding `id`, or `id` itself when it IS a container; null when unknown. */
export function findContainer(
  containers: Containers,
  id: string | null | undefined,
): string | null {
  if (id === null || id === undefined) return null
  if (Object.hasOwn(containers, id)) return id
  for (const [containerId, items] of Object.entries(containers)) {
    if (items.includes(id)) return containerId
  }
  return null
}

/** Returns a copy of `items` with the element at `from` moved to index `to`. */
export function arrayMove<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/** The neighbours of `id` in `order`: afterId = the item before it, beforeId = the item after it. */
export function neighbours(
  order: readonly string[],
  id: string,
): { afterId: string | null; beforeId: string | null } {
  const index = order.indexOf(id)
  if (index < 0) return { afterId: null, beforeId: null }
  return { afterId: order[index - 1] ?? null, beforeId: order[index + 1] ?? null }
}

/** `items` after dropping `activeId` onto `overId` inside the same container (sortable semantics). */
export function reorderWithin(
  items: readonly string[],
  activeId: string,
  overId: string | null | undefined,
): string[] {
  const from = items.indexOf(activeId)
  const to = overId ? items.indexOf(overId) : -1
  if (from < 0 || to < 0 || from === to) return [...items]
  return arrayMove(items, from, to)
}

/**
 * Drag-over preview: `activeId` leaves its container and enters `toContainer` directly before
 * `overId` (after it when `placeAfter`), or at the end when `overId` is not an item there.
 * Returns `containers` unchanged when there is nothing to move.
 */
export function moveToContainer(
  containers: Containers,
  activeId: string,
  toContainer: string,
  overId: string | null,
  placeAfter: boolean,
): Containers {
  const from = findContainer(containers, activeId)
  if (
    !from ||
    from === activeId ||
    from === toContainer ||
    !Object.hasOwn(containers, toContainer)
  ) {
    return containers
  }
  const target = containers[toContainer].filter((id) => id !== activeId)
  const overIndex = overId ? target.indexOf(overId) : -1
  const index = overIndex >= 0 ? overIndex + (placeAfter ? 1 : 0) : target.length
  return {
    ...containers,
    [from]: containers[from].filter((id) => id !== activeId),
    [toContainer]: [...target.slice(0, index), activeId, ...target.slice(index)],
  }
}

function samePlace(before: readonly string[], after: readonly string[], id: string): boolean {
  const a = neighbours(before, id)
  const b = neighbours(after, id)
  return a.afterId === b.afterId && a.beforeId === b.beforeId
}

export interface TopLevelDropArgs {
  taskId: string
  /** Group containers as rendered before the drag started. */
  initial: Containers
  /** Group containers including drag-over preview moves (the task may already be elsewhere). */
  current: Containers
  /** What the task was dropped on: a task id, a group container id, or null (nowhere). */
  overId: string | null
}

/**
 * Drop of a top-level task → MoveTaskInput (`phaseId` only when the group changed), or null when
 * the task ends up exactly where it started (or was dropped nowhere).
 */
export function resolveTopLevelDrop({
  taskId,
  initial,
  current,
  overId,
}: TopLevelDropArgs): MoveTaskInput | null {
  if (overId === null) return null
  const fromContainer = findContainer(initial, taskId)
  let containers = current
  let container = findContainer(containers, taskId)
  if (!fromContainer || !container || container === taskId) return null

  // Dropped on another group (e.g. a collapsed one) or on an item that is still elsewhere.
  const overContainer = findContainer(containers, overId)
  if (overContainer && overContainer !== container && isGroupContainerId(overContainer)) {
    containers = moveToContainer(
      containers,
      taskId,
      overContainer,
      overId === overContainer ? null : overId,
      false,
    )
    container = overContainer
  }

  const order =
    overId === container
      ? [...containers[container]]
      : reorderWithin(containers[container], taskId, overId)
  if (fromContainer === container && samePlace(initial[container], order, taskId)) return null

  // Alone in its new group: there are no neighbours to place it by (see the module comment).
  const input: MoveTaskInput =
    order.length > 1 ? { taskId, ...neighbours(order, taskId) } : { taskId }
  if (fromContainer !== container) {
    const phaseId = phaseIdOfContainer(container)
    if (phaseId !== undefined) input.phaseId = phaseId
  }
  return input
}

/** Drop of a subtask among its siblings → MoveTaskInput, or null when nothing changes. */
export function resolveSubtaskDrop({
  taskId,
  siblings,
  overId,
}: {
  taskId: string
  siblings: readonly string[]
  overId: string | null
}): MoveTaskInput | null {
  if (!overId || !siblings.includes(taskId)) return null
  const order = reorderWithin(siblings, taskId, overId)
  if (samePlace(siblings, order, taskId)) return null
  return { taskId, ...neighbours(order, taskId) }
}

/**
 * Menu "Move up" (-1) / "Move down" (+1) among `order` (a group's top-level tasks, or a
 * parent's subtasks) → MoveTaskInput, or null at the edge.
 */
export function stepMove(
  order: readonly string[],
  taskId: string,
  delta: -1 | 1,
): MoveTaskInput | null {
  const from = order.indexOf(taskId)
  const to = from + delta
  if (from < 0 || to < 0 || to >= order.length) return null
  return { taskId, ...neighbours(arrayMove(order, from, to), taskId) }
}

/**
 * Menu "Move to phase": the task goes to the end of the target group's tasks (no placement
 * hints when that group is empty). Null when the task already is in that group.
 */
export function moveToGroupEnd(
  containers: Containers,
  taskId: string,
  phaseId: string | null,
): MoveTaskInput | null {
  const target = groupContainerId(phaseId)
  if (findContainer(containers, taskId) === target) return null
  const items = (containers[target] ?? []).filter((id) => id !== taskId)
  const last = items.at(-1)
  return last ? { taskId, phaseId, afterId: last, beforeId: null } : { taskId, phaseId }
}
