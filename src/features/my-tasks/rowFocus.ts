/**
 * Focus helpers for cross-project task rows (TaskListRow): each row is marked with
 * `data-task-row="<id>"` and its open button with `data-row-open`; the status menu trigger is the
 * row's menu button (`aria-haspopup="menu"`, set by Radix).
 */
import type { KeyboardEvent } from 'react'

const OPEN = '[data-row-open]'

function rowElement(taskId: string, root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-task-row="${CSS.escape(taskId)}"]`)
}

/** The status menu trigger of a task's row (null when the row is not rendered). */
export function rowStatusButton(taskId: string, root: ParentNode = document): HTMLElement | null {
  return rowElement(taskId, root)?.querySelector<HTMLElement>('[aria-haspopup="menu"]') ?? null
}

/** The button that opens a task's row in the Task Modal. */
export function rowOpenButton(taskId: string, root: ParentNode = document): HTMLElement | null {
  return rowElement(taskId, root)?.querySelector<HTMLElement>(OPEN) ?? null
}

/**
 * Arrow Up / Down between the rows' open buttons inside the element the handler is attached to
 * (each row control stays one Tab stop; the arrows add quick vertical movement like a list).
 */
export function onRowListKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const target = event.target
  if (!(target instanceof HTMLElement) || !target.matches(OPEN)) return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(OPEN))
  const index = rows.indexOf(target)
  const next = index === -1 ? undefined : rows[index + (event.key === 'ArrowDown' ? 1 : -1)]
  if (!next) return
  event.preventDefault()
  next.focus()
}
