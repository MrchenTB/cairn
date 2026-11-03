/**
 * View bar slot contract. ProjectLayout renders the 40px view bar (List / Board / Gantt tabs)
 * and exposes a slot on its right side; each project view puts its own controls there
 * (e.g. Gantt scale switcher, Today, Manual/Auto) with <ViewBarActions>.
 */
import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const ViewBarSlotContext = createContext<HTMLElement | null>(null)

/**
 * Used by ProjectLayout: `slot` is the DOM element (from a callback ref) where view controls are
 * portalled. Wrap the <Outlet /> with it.
 */
export function ViewBarSlotProvider({
  slot,
  children,
}: {
  slot: HTMLElement | null
  children: ReactNode
}) {
  return <ViewBarSlotContext.Provider value={slot}>{children}</ViewBarSlotContext.Provider>
}

/** Renders `children` into the project view bar (nothing until the slot is mounted). */
export function ViewBarActions({ children }: { children: ReactNode }) {
  const slot = useContext(ViewBarSlotContext)
  return slot ? createPortal(children, slot) : null
}
