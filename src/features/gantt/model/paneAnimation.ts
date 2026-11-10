/**
 * The outline pane's hide / show motion (UX-02): pure maths, no DOM. The chart animates the pane
 * width itself (every consumer keeps reading one `paneWidth`) and keeps the days where they are
 * by deriving the scroll position from the width, always from where the motion started (never
 * as accumulated deltas), so rounding cannot drift.
 */

/** Same as the --duration-slow motion token (sidebar collapse, modal). */
export const PANE_ANIMATION_MS = 200

/** A crisp ease-out: fast start, soft landing. No overshoot. */
export const PANE_EASING = [0.2, 0, 0, 1] as const

/** CSS-style cubic-bezier(x1, y1, x2, y2): maps linear time 0..1 to eased progress 0..1. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx
  return (t) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    // Newton's method for the curve parameter whose x is t, with a bisection fallback.
    let s = t
    for (let i = 0; i < 8; i++) {
      const error = sampleX(s) - t
      if (Math.abs(error) < 1e-6) return sampleY(s)
      const slope = slopeX(s)
      if (Math.abs(slope) < 1e-6) break
      s -= error / slope
    }
    let low = 0
    let high = 1
    s = t
    for (let i = 0; i < 24; i++) {
      const x = sampleX(s)
      if (Math.abs(x - t) < 1e-6) break
      if (x < t) low = s
      else high = s
      s = (low + high) / 2
    }
    return sampleY(s)
  }
}

const ease = cubicBezier(...PANE_EASING)

/**
 * The pane width `elapsed` ms into a motion from `from` to `to`: exactly `to` once the duration
 * has passed (and `from` before it starts), so the motion always lands on the target width.
 */
export function paneWidthAt(
  from: number,
  to: number,
  elapsed: number,
  duration: number = PANE_ANIMATION_MS,
): { width: number; done: boolean } {
  if (elapsed >= duration) return { width: to, done: true }
  if (elapsed <= 0) return { width: from, done: false }
  return { width: from + (to - from) * ease(elapsed / duration), done: false }
}

/**
 * Scroll position that keeps every day where it was on screen while the pane is `width` wide,
 * given the scroll position `startScroll` the motion began at with a pane of `startWidth`: the
 * pane's width change is taken out of (or put into) the scroll position one for one.
 */
export function anchoredPaneScroll(startScroll: number, startWidth: number, width: number): number {
  return Math.max(0, startScroll - (startWidth - width))
}
