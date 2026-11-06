/**
 * Where a project bar's name goes, in lane pixels (the lane's x = 0 is the timeline's first day).
 *
 * The name follows the scroll inside its bar (CSS sticky), so a milestone diamond on the same row
 * can pass under it at any scroll offset, not just where the bar starts. These helpers keep the
 * name clear of the diamonds for the CURRENT scroll position: pure, so they are unit-tested.
 */

/** Gap between the bar's inner edge (or the pane edge) and its name. */
export const LABEL_INSET = 8
/** Half the diamond's hit box. */
export const DIAMOND_HALF_WIDTH = 8
/** A name is only shortened (to end before a diamond) if this much of it stays readable. */
export const MIN_LABEL_WIDTH = 48
/** Air between a name and a diamond. */
const DIAMOND_GAP = 4
/** The bar's own 1px border: its name starts inside it. */
const BAR_BORDER = 1
/** Gap between a bar and the name drawn after it. */
export const OUTSIDE_LABEL_GAP = 6

/** `labelRoom` result: the whole name fits. */
export const FULL_LABEL = Number.POSITIVE_INFINITY
/** `labelRoom` result: leave the name out (a diamond covers where it would start). */
export const NO_LABEL = 0

export interface InsideLabelInput {
  /** The bar's left edge and width. */
  barLeft: number
  barWidth: number
  /** Chart's scrollLeft: the lane's first visible x (the pane covers the rest). */
  scrollLeft: number
  /** Natural width of the name (with its glyph). */
  labelWidth: number
  /** Diamond centres on this row, ascending. */
  diamondXs: readonly number[]
}

/** Lane x of a name that sits inside its bar: at the bar's start, or stuck at the visible edge. */
export function insideLabelLeft({
  barLeft,
  barWidth,
  scrollLeft,
  labelWidth,
}: Omit<InsideLabelInput, 'diamondXs'>): number {
  const natural = barLeft + BAR_BORDER + LABEL_INSET
  const stuck = scrollLeft + LABEL_INSET
  // Sticky never leaves its bar: near the bar's end the name stops against it.
  const farthest = Math.max(natural, barLeft + barWidth - BAR_BORDER - labelWidth)
  return Math.min(Math.max(natural, stuck), farthest)
}

/**
 * Width the name may use before the first diamond it would run under: `FULL_LABEL` when none is in
 * its way, `NO_LABEL` when a diamond covers its start or leaves less than MIN_LABEL_WIDTH (the
 * pane always has the full name), otherwise the room in whole px.
 */
export function insideLabelRoom(input: InsideLabelInput): number {
  const left = insideLabelLeft(input)
  const right = left + input.labelWidth
  for (const x of input.diamondXs) {
    const start = x - DIAMOND_HALF_WIDTH
    if (x + DIAMOND_HALF_WIDTH <= left) continue // already behind the name's start
    if (start >= right) break // this one and every later one is past the name
    const room = start - DIAMOND_GAP - left
    return room >= MIN_LABEL_WIDTH ? Math.floor(room) : NO_LABEL
  }
  return FULL_LABEL
}

/**
 * Lane x of a name drawn after a bar that is too narrow to hold it: right after the bar, and past
 * any diamond it would touch (a one-day project IS its diamond, so its name goes after that).
 */
export function outsideLabelLeft(
  barLeft: number,
  barWidth: number,
  labelWidth: number,
  diamondXs: readonly number[],
): number {
  let left = barLeft + barWidth + OUTSIDE_LABEL_GAP
  for (const x of diamondXs) {
    const start = x - DIAMOND_HALF_WIDTH
    const end = x + DIAMOND_HALF_WIDTH
    if (end + DIAMOND_GAP <= left) continue
    if (start >= left + labelWidth) break
    left = end + DIAMOND_GAP
  }
  return left
}
