/**
 * Drag-and-drop settings shared by the Projects list and the List view (dnd-kit): pointer
 * activation distance, a short drop animation (off with reduced motion) and the screen-reader
 * instructions. Every drag also has a menu alternative (Move up / Move down / Move to phase).
 */
import { useSyncExternalStore } from 'react'
import {
  defaultDropAnimationSideEffects,
  type DropAnimation,
  type ScreenReaderInstructions,
} from '@dnd-kit/core'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const query = window.matchMedia(REDUCED_MOTION)
  query.addEventListener?.('change', onChange)
  return () => query.removeEventListener?.('change', onChange)
}

function readReducedMotion(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.(REDUCED_MOTION).matches)
}

/** True when the user asked the OS for reduced motion. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false)
}

/** The pointer has to move this far before a drag starts, so clicks stay clicks. */
export const POINTER_ACTIVATION = { distance: 4 } as const

/**
 * PointerSensor options. dnd-kit memoises sensors on the options' identity: a new object on every
 * render rebuilds every draggable's listeners (and re-renders every row), so share this one.
 */
export const POINTER_SENSOR_OPTIONS = { activationConstraint: POINTER_ACTIVATION } as const

const DROP_ANIMATION: DropAnimation = {
  duration: 160,
  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } }),
}

/** Drop animation for <DragOverlay> (null = none, for reduced motion). */
export function useDropAnimation(): DropAnimation | null {
  return usePrefersReducedMotion() ? null : DROP_ANIMATION
}

export const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    'To move this item, press Space or Enter, use the Up and Down arrow keys, then press Space or Enter again to drop it. Press Escape to cancel. The item’s menu also has Move up and Move down.',
}
