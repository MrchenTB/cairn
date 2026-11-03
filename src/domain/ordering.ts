/**
 * Manual ordering with fractional-index keys (package `fractional-indexing`).
 * Keys are compared with plain code-unit comparison (`<`), never `localeCompare`;
 * the database column uses COLLATE "C" so server ordering matches.
 *
 * Robustness: keys written by hand or by another tool (e.g. 'a', 'b') are not valid
 * fractional-index keys and duplicate keys can appear after concurrent edits. Every helper
 * here still returns a key that sorts where requested (using a generic string midpoint
 * when the library rejects its input) and none of them throws for string keys.
 */
import { BASE_62_DIGITS, generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'

export interface Ordered {
  id: string
  sortOrder: string
}

/** Where to put an item among its siblings (see `keyForPlacement`). */
export interface Placement {
  afterId?: string | null
  beforeId?: string | null
}

/** -1 / 0 / 1 using code-unit comparison. */
export function compareSortKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
/** Comparator for Array.sort: by sortOrder, tie-break by id. */
export function bySortOrder(a: Ordered, b: Ordered): number {
  return compareSortKeys(a.sortOrder, b.sortOrder) || compareSortKeys(a.id, b.id)
}
/** Returns a new array sorted by `bySortOrder`. */
export function sortByOrder<T extends Ordered>(items: readonly T[]): T[] {
  return [...items].sort(bySortOrder)
}
/**
 * Key strictly between `before` and `after` (null = open end). Bounds may be passed in either
 * order. Equal bounds (duplicate keys) cannot be split: the result then sorts just after them.
 */
export function keyBetween(
  before: string | null | undefined,
  after: string | null | undefined,
): string {
  const [lo, hi] = normalizeBounds(before, after)
  return safeKeyBetween(lo, hi)
}
/** n sorted keys strictly between `before` and `after` (same bound rules as `keyBetween`). */
export function keysBetween(
  before: string | null | undefined,
  after: string | null | undefined,
  n: number,
): string[] {
  const count = Number.isFinite(n) ? Math.floor(n) : 0
  if (count <= 0) return []
  const [lo, hi] = normalizeBounds(before, after)
  try {
    const keys = generateNKeysBetween(lo, hi, count)
    if (keys.length === count && isSortedWithin(keys, lo, hi)) return keys
  } catch {
    // invalid keys: fall back to repeated midpoints
  }
  return bisectKeys(lo, hi, count)
}
/** Key that sorts after every item of `items` (any order). */
export function keyAtEnd(items: readonly Ordered[]): string {
  let max: string | null = null
  for (const item of items) if (max === null || item.sortOrder > max) max = item.sortOrder
  return safeKeyBetween(max, null)
}
/** Key that sorts before every item of `items` (any order). */
export function keyAtStart(items: readonly Ordered[]): string {
  let min: string | null = null
  for (const item of items) if (min === null || item.sortOrder < min) min = item.sortOrder
  return safeKeyBetween(null, min)
}
/**
 * Key for placing an item among `siblings` (the destination list WITHOUT the moved item;
 * any order — it is sorted internally).
 * - afterId: sibling that must end up directly BEFORE the item (null = place first)
 * - beforeId: sibling that must end up directly AFTER the item (null = place last)
 * The item is anchored to a KNOWN neighbour whenever one is given: directly after afterId if it
 * is found, else directly before beforeId if it is found, else first when afterId is null, else
 * last (unknown ids, nothing given). Contradictory hints therefore prefer afterId. Never throws.
 *
 * Hints usually come from a filtered subsequence (Board column, List phase group). Because the
 * item lands directly next to the resolved neighbour in the FULL sibling order, it lands between
 * the same neighbours in that subsequence, and the order elsewhere barely changes: a drop at the
 * top of a group (`{ afterId: null, beforeId: firstOfGroup }`) lands directly before that item
 * rather than at the top of the whole project.
 */
export function keyForPlacement(
  siblings: readonly Ordered[],
  placement: { afterId?: string | null; beforeId?: string | null },
): string {
  try {
    const [lo, hi] = placementBounds(siblings, placement)
    return safeKeyBetween(lo, hi)
  } catch {
    return lastResortKey(siblings)
  }
}
/** `n` sorted keys for a block of items placed like `keyForPlacement` (e.g. promoted subtasks). */
export function keysForPlacement(
  siblings: readonly Ordered[],
  placement: { afterId?: string | null; beforeId?: string | null },
  n: number,
): string[] {
  try {
    const [lo, hi] = placementBounds(siblings, placement)
    return keysBetween(lo, hi, n)
  } catch {
    return keysBetween(lastResortKey(siblings), null, n)
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function normalizeBounds(
  before: string | null | undefined,
  after: string | null | undefined,
): [string | null, string | null] {
  const lo = before ?? null
  const hi = after ?? null
  if (lo === null || hi === null) return [lo, hi]
  if (lo > hi) return [hi, lo]
  // Nothing sorts strictly between equal keys; aim just above them instead.
  if (lo === hi) return [lo, `${lo}1`]
  return [lo, hi]
}

function isBetween(key: string, lo: string | null, hi: string | null): boolean {
  return (lo === null || key > lo) && (hi === null || key < hi)
}

function isSortedWithin(keys: readonly string[], lo: string | null, hi: string | null): boolean {
  let previous = lo
  for (const key of keys) {
    if (!isBetween(key, previous, hi)) return false
    previous = key
  }
  return true
}

/** Requires lo < hi when both are set. */
function safeKeyBetween(lo: string | null, hi: string | null): string {
  try {
    const key = generateKeyBetween(lo, hi)
    if (isBetween(key, lo, hi)) return key
  } catch {
    // the library rejects keys it did not generate (e.g. 'a', 'b'): use the generic midpoint
  }
  return midString(lo ?? '', hi)
}

function bisectKeys(lo: string | null, hi: string | null, n: number): string[] {
  if (n <= 0) return []
  const mid = safeKeyBetween(lo, hi)
  const left = (n - 1) >> 1
  return [...bisectKeys(lo, mid, left), mid, ...bisectKeys(mid, hi, n - 1 - left)]
}

/**
 * A string strictly between `a` and `b` (b === null: no upper bound) in code-unit order, for
 * arbitrary strings. Prefers base-62 digits so results stay readable. Requests with no answer
 * (nothing sorts below '' or between x and x + '\u0000') get a best-effort key, never a throw.
 */
function midString(a: string, b: string | null): string {
  let prefix = ''
  let lo = a
  let hi = b !== null && a < b ? b : null
  if (hi !== null) {
    let n = 0
    while (n < lo.length && lo.charCodeAt(n) === hi.charCodeAt(n)) n++
    prefix = hi.slice(0, n)
    lo = lo.slice(n)
    hi = hi.slice(n)
  }
  for (;;) {
    const ca = lo.length > 0 ? lo.charCodeAt(0) : -1
    const cb = hi === null ? Number.POSITIVE_INFINITY : hi.charCodeAt(0)
    const digit = middleDigit(ca, cb)
    if (digit !== null) return prefix + digit
    // hi[0] alone is a proper prefix of hi (so smaller) and above lo[0] (so larger than lo).
    if (hi !== null && hi.length > 1) return prefix + hi[0]
    if (ca < 0) return prefix + (cb > 0 ? String.fromCharCode(cb - 1) : (hi ?? ''))
    // Keep lo's first char and find anything above the rest of lo.
    prefix += lo[0]
    lo = lo.slice(1)
    hi = null
  }
}

/** The middle base-62 digit with char code strictly between ca and cb, or null. */
function middleDigit(ca: number, cb: number): string | null {
  let first = -1
  let last = -1
  for (let i = 0; i < BASE_62_DIGITS.length; i++) {
    const code = BASE_62_DIGITS.charCodeAt(i)
    if (code > ca && code < cb) {
      if (first < 0) first = i
      last = i
    }
  }
  return first < 0 ? null : BASE_62_DIGITS[(first + last + 1) >> 1]
}

type Anchor = 'after' | 'before'

/** Resolves the placement hints to a gap index in `sorted` (0 = first, length = last). */
function resolveGap(sorted: readonly Ordered[], placement: Placement): [number, Anchor] {
  const { afterId, beforeId } = placement
  const indexOf = (id: unknown) =>
    typeof id === 'string' ? sorted.findIndex((item) => item.id === id) : -1
  const after = indexOf(afterId)
  if (after >= 0) return [after + 1, 'after']
  const before = indexOf(beforeId)
  if (before >= 0) return [before, 'before']
  if (afterId === null) return [0, 'before']
  return [sorted.length, 'after']
}

function placementBounds(
  siblings: readonly Ordered[],
  placement: Placement,
): [string | null, string | null] {
  const sorted = sortByOrder(siblings)
  const [gap, anchor] = resolveGap(sorted, placement ?? {})
  let lo = gap > 0 ? sorted[gap - 1].sortOrder : null
  let hi = gap < sorted.length ? sorted[gap].sortOrder : null
  if (lo !== null && hi !== null && lo >= hi) {
    // Duplicate keys around the gap: keep the anchored neighbour and widen the other side
    // to the nearest distinct key, so the item lands next to the whole run of equal keys.
    if (anchor === 'after') {
      let k = gap
      while (k < sorted.length && sorted[k].sortOrder <= lo) k++
      hi = k < sorted.length ? sorted[k].sortOrder : null
    } else {
      let k = gap - 1
      while (k >= 0 && sorted[k].sortOrder >= hi) k--
      lo = k >= 0 ? sorted[k].sortOrder : null
    }
  }
  return [lo, hi]
}

/** Append at the end over whatever well-formed siblings exist (corrupt input only). */
function lastResortKey(siblings: readonly Ordered[]): string {
  try {
    return keyAtEnd(siblings.filter((item) => typeof item?.sortOrder === 'string'))
  } catch {
    return generateKeyBetween(null, null)
  }
}
