import { useLayoutEffect, useState, type RefObject } from 'react'
import { getFocusReturnTarget } from '@/lib/focus'

/**
 * Render inside overlay content (it mounts when the overlay opens): records into `targetRef`
 * what had focus just before, for `useFocusReturn` from '@/lib/focus'.
 */
export function FocusReturnRecorder({ targetRef }: { targetRef: RefObject<HTMLElement | null> }) {
  // Read during render — before this commit's autoFocus moves focus into the overlay.
  const [target] = useState(() => getFocusReturnTarget())
  useLayoutEffect(() => {
    targetRef.current = target
  }, [target, targetRef])
  return null
}
