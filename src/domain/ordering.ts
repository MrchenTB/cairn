/**
 * Manual ordering with fractional-index keys (package `fractional-indexing`).
 * Keys are compared with plain code-unit comparison (`<`), never `localeCompare`;
 * the database column uses COLLATE "C" so server ordering matches.
 */
import { notImplemented } from './_todo'

export interface Ordered {
  id: string
  sortOrder: string
}

/** -1 / 0 / 1 using code-unit comparison. */
export function compareSortKeys(a: string, b: string): number {
  return notImplemented('compareSortKeys' + a + b)
}
/** Comparator for Array.sort: by sortOrder, tie-break by id. */
export function bySortOrder(a: Ordered, b: Ordered): number {
  return notImplemented('bySortOrder' + a.id + b.id)
}
/** Returns a new array sorted by `bySortOrder`. */
export function sortByOrder<T extends Ordered>(items: readonly T[]): T[] {
  return notImplemented('sortByOrder' + items.length)
}
/** Key strictly between `before` and `after` (null = open end). */
export function keyBetween(before: string | null | undefined, after: string | null | undefined): string {
  return notImplemented('keyBetween' + before + after)
}
/** n sorted keys strictly between `before` and `after`. */
export function keysBetween(
  before: string | null | undefined,
  after: string | null | undefined,
  n: number,
): string[] {
  return notImplemented('keysBetween' + before + after + n)
}
/** Key that sorts after every item of `items` (any order). */
export function keyAtEnd(items: readonly Ordered[]): string {
  return notImplemented('keyAtEnd' + items.length)
}
/** Key that sorts before every item of `items` (any order). */
export function keyAtStart(items: readonly Ordered[]): string {
  return notImplemented('keyAtStart' + items.length)
}
/**
 * Key for placing an item among `siblings` (the destination list WITHOUT the moved item;
 * any order — it is sorted internally).
 * - afterId: sibling that must end up directly BEFORE the item (null = place first)
 * - beforeId: sibling that must end up directly AFTER the item (null = place last)
 * Unknown ids or contradictory hints fall back gracefully (prefer afterId, then beforeId,
 * then append at the end). Never throws.
 */
export function keyForPlacement(
  siblings: readonly Ordered[],
  placement: { afterId?: string | null; beforeId?: string | null },
): string {
  return notImplemented('keyForPlacement' + siblings.length + JSON.stringify(placement))
}
